import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { redactSecrets } from "../secrets/index";
import { WATCHER_ACTOR, type EntryDraft, type LedgerPort } from "../worktrees/ports";
import type { WorktreeInfo } from "../worktrees/types";
import { changedFiles } from "./changes";
import { commitFiles, commitsSince, type ObservedCommit } from "./commits";
import { compareTaskIds, fileSetKey, findCollisions, pairKey, type Collision } from "./collisions";

export interface GitWatcherOptions {
  ledger: LedgerPort;
  /** The live worktree list, usually from the worktree manager. */
  worktrees: () => Promise<WorktreeInfo[]> | WorktreeInfo[];
  /** A task whose commits and changed files have not moved for this long is reported as stalled. Default 15 minutes. */
  stallMs?: number;
  /** Clock, for tests. Milliseconds. */
  now?: () => number;
  /** Called with a tick that threw outside the per-worktree guard (for example the worktree list failed). Only used by start(). */
  onError?: (error: unknown) => void;
  /** Called once with each completed tick's result, whether the timer or a caller ran it. A throw goes to onError. */
  onTick?: (result: TickResult) => void;
  /** When it returns false a tick reads nothing and writes nothing (for example while the ledger is not the person's). Default: always. */
  shouldRun?: () => boolean;
}

export interface ObservedTaskCommit extends ObservedCommit {
  taskId: string;
}

export interface StalledTask {
  taskId: string;
  /** Clock time (from `now`) the task last showed progress, or was first seen. */
  since: number;
  idleMs: number;
}

export interface WatchError {
  taskId: string;
  path: string;
  message: string;
}

export interface TickResult {
  /** commit.observed entries written this tick. */
  observed: ObservedTaskCommit[];
  /** collision.detected entries written this tick. */
  collisions: Collision[];
  /** collision.resolved entries written this tick. */
  resolved: Collision[];
  /** Every task currently stalled (reported, not written to the ledger). */
  stalled: StalledTask[];
  /** Every collision currently open, whether new or not. */
  active: Collision[];
  /** Worktrees that could not be read, and ledger writes that failed. Retried next tick. */
  errors: WatchError[];
  /** True when `shouldRun` said no: nothing was read or written, and the empty lists above say nothing about the worktrees. */
  skipped?: boolean;
}

interface TaskProgress {
  fingerprint: string;
  since: number;
}

export const DEFAULT_STALL_MS = 15 * 60_000;
const MAX_FILE_EVIDENCE = 200;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function listFiles(files: string[], max = 3): string {
  if (files.length <= max) return files.join(", ");
  return `${files.slice(0, max).join(", ")} and ${files.length - max} more`;
}

function fileEvidence(files: string[]): string[] {
  const shown = files.slice(0, MAX_FILE_EVIDENCE).map((file) => `file:${file}`);
  if (files.length > MAX_FILE_EVIDENCE) shown.push(`files-omitted:${files.length - MAX_FILE_EVIDENCE}`);
  return shown;
}

function filesOf(evidence: string[] | undefined): string[] {
  return (evidence ?? []).filter((item) => item.startsWith("file:")).map((item) => item.slice(5));
}

/**
 * Reads every task worktree on a timer and writes what really happened into
 * the ledger: commit.observed and collision.detected / collision.resolved.
 * It never relies on agents reporting their own work.
 */
export class GitWatcher {
  private readonly ledger: LedgerPort;
  private readonly listWorktrees: GitWatcherOptions["worktrees"];
  private readonly stallMs: number;
  private readonly now: () => number;
  private readonly onError?: (error: unknown) => void;
  private readonly onTick?: (result: TickResult) => void;
  private readonly shouldRun?: () => boolean;

  private seeded = false;
  /** taskId -> commits already written, for tasks with a worktree; rebuilt from the ledger when a task comes back. */
  private readonly seen = new Map<string, Set<string>>();
  /** pair key -> open collision and its file-set key. */
  private readonly open = new Map<string, { collision: Collision; set: string }>();
  private readonly progress = new Map<string, TaskProgress>();

  private running?: Promise<TickResult>;
  private timer?: NodeJS.Timeout;
  private stopped = true;

  constructor(options: GitWatcherOptions) {
    this.ledger = options.ledger;
    this.listWorktrees = options.worktrees;
    this.stallMs = options.stallMs ?? DEFAULT_STALL_MS;
    this.now = options.now ?? Date.now;
    this.onError = options.onError;
    this.onTick = options.onTick;
    this.shouldRun = options.shouldRun;
  }

  /** One pass over every worktree. Concurrent calls share the pass already running. */
  tick(): Promise<TickResult> {
    if (!this.running) {
      this.running = this.runTick()
        .then((result) => {
          try {
            this.onTick?.(result);
          } catch (error) {
            this.onError?.(error);
          }
          return result;
        })
        .finally(() => {
          this.running = undefined;
        });
    }
    return this.running;
  }

  /** Tick every `intervalMs` (default 3s). The timer does not keep the process alive and ticks never overlap. */
  start(intervalMs = 3000): void {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = (): void => {
      if (this.stopped) return;
      this.tick()
        .catch((error) => this.onError?.(error))
        .finally(() => {
          if (this.stopped) return;
          this.timer = setTimeout(loop, intervalMs);
          this.timer.unref?.();
        });
    };
    loop();
  }

  /** Stop the timer and wait for a tick in flight to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }

  private seenFor(taskId: string): Set<string> {
    let shas = this.seen.get(taskId);
    if (!shas) {
      shas = new Set();
      for (const entry of this.ledger.bySubject(taskId)) {
        if (entry.type !== "commit.observed") continue;
        const sha = entry.data?.sha;
        if (typeof sha === "string" && sha) shas.add(sha);
        for (const item of entry.evidence ?? []) if (item.startsWith("commit:")) shas.add(item.slice(7));
      }
      this.seen.set(taskId, shas);
    }
    return shas;
  }

  /** Rebuild dedupe state from the ledger so a restart never writes the same fact twice. */
  private seed(): void {
    for (const entry of this.ledger.entries()) {
      if (entry.type === "collision.detected" || entry.type === "collision.resolved") {
        const tasks = (entry.evidence ?? []).filter((item) => item.startsWith("task:")).map((item) => item.slice(5));
        const pair = tasks.length === 2 ? pairKey(tasks) : pairKey(entry.subject.split("+"));
        if (entry.type === "collision.resolved") {
          this.open.delete(pair);
          continue;
        }
        const files = filesOf(entry.evidence);
        const [a, b] = pair.split("+");
        this.open.set(pair, { collision: { tasks: [a, b], files }, set: fileSetKey(files) });
      }
    }
    this.seeded = true;
  }

  private write(entry: EntryDraft, errors: WatchError[], info?: WorktreeInfo): boolean {
    try {
      this.ledger.append(entry);
      return true;
    } catch (error) {
      errors.push({ taskId: info?.taskId ?? entry.subject, path: info?.path ?? "", message: `ledger write failed: ${message(error)}` });
      return false;
    }
  }

  private async runTick(): Promise<TickResult> {
    const result: TickResult = { observed: [], collisions: [], resolved: [], stalled: [], active: [], errors: [] };
    if (this.shouldRun && !this.shouldRun()) return { ...result, skipped: true };
    if (!this.seeded) {
      try {
        this.seed();
      } catch (error) {
        // Without the ledger's history every write could be a duplicate; skip this pass.
        result.errors.push({ taskId: "*", path: "", message: `could not read the ledger: ${message(error)}` });
        return result;
      }
    }

    const worktrees = [...(await this.listWorktrees())].sort((a, b) => compareTaskIds(a.taskId, b.taskId));
    const listed = new Set(worktrees.map((info) => info.taskId));
    const read = new Map<string, string[]>();
    const failed = new Set<string>();

    for (const info of worktrees) {
      try {
        if (!existsSync(info.path)) throw new Error("worktree folder is missing");
        const [files, commits] = await Promise.all([changedFiles(info.path, info.baseSha), commitsSince(info.path, info.baseSha)]);
        read.set(info.taskId, files);
        await this.observeCommits(info, commits, result);
        this.trackProgress(info, files, commits, result);
      } catch (error) {
        failed.add(info.taskId);
        result.errors.push({ taskId: info.taskId, path: info.path, message: message(error) });
      }
    }
    for (const taskId of [...this.progress.keys()]) if (!listed.has(taskId)) this.progress.delete(taskId);
    // Memory stays bounded by the running tasks; a task that comes back is re-read from the ledger.
    for (const taskId of [...this.seen.keys()]) if (!listed.has(taskId)) this.seen.delete(taskId);

    await this.reconcileCollisions(read, listed, failed, result);
    return result;
  }

  private async observeCommits(info: WorktreeInfo, commits: ObservedCommit[], result: TickResult): Promise<void> {
    const seen = this.seenFor(info.taskId);
    for (const commit of commits) {
      if (seen.has(commit.sha)) continue;
      let files: string[] = [];
      try {
        files = await commitFiles(info.path, commit.sha);
      } catch {
        files = [];
      }
      // A worker's commit message is its own text and the ledger is permanent: a pasted key never goes in.
      const subject = redactSecrets(commit.subject || "(no commit message)");
      const ok = this.write(
        {
          type: "commit.observed",
          actor: WATCHER_ACTOR,
          subject: info.taskId,
          summary: `${info.taskId} committed ${commit.sha.slice(0, 7)}: ${subject}`,
          reason: `The watcher read a new commit on ${info.branch}.`,
          evidence: [`commit:${commit.sha}`, `branch:${info.branch}`, `author:${commit.author}`, `at:${commit.at}`, ...fileEvidence(files)],
          refs: commit.refs,
          data: { sha: commit.sha, files },
        },
        result.errors,
        info,
      );
      if (!ok) continue;
      seen.add(commit.sha);
      result.observed.push({ ...commit, taskId: info.taskId });
    }
  }

  private trackProgress(info: WorktreeInfo, files: string[], commits: ObservedCommit[], result: TickResult): void {
    const head = commits.at(-1)?.sha ?? "";
    // Saving an already-changed file moves its mtime, which counts as progress too.
    let newest = 0;
    for (const file of files) {
      try {
        newest = Math.max(newest, statSync(path.join(info.path, ...file.split("/"))).mtimeMs);
      } catch {
        // Deleted files have no mtime.
      }
    }
    const fingerprint = `${head}\n${newest}\n${files.join("\n")}`;
    const now = this.now();
    const previous = this.progress.get(info.taskId);
    if (!previous || previous.fingerprint !== fingerprint) {
      this.progress.set(info.taskId, { fingerprint, since: now });
      return;
    }
    const idleMs = now - previous.since;
    if (idleMs >= this.stallMs) result.stalled.push({ taskId: info.taskId, since: previous.since, idleMs });
  }

  private async reconcileCollisions(read: Map<string, string[]>, listed: Set<string>, failed: Set<string>, result: TickResult): Promise<void> {
    const current = findCollisions([...read].map(([taskId, files]) => ({ taskId, files })));
    const currentPairs = new Set<string>();

    for (const collision of current) {
      const pair = pairKey(collision.tasks);
      currentPairs.add(pair);
      const set = fileSetKey(collision.files);
      const previous = this.open.get(pair);
      if (previous?.set === set) {
        this.open.set(pair, { collision, set });
        continue;
      }
      const [a, b] = collision.tasks;
      const ok = this.write(
        {
          type: "collision.detected",
          actor: WATCHER_ACTOR,
          subject: pair,
          summary: `${a} and ${b} both changed ${listFiles(collision.files)}`,
          reason: previous
            ? `The files both tasks changed are now different from the last report.`
            : `The watcher found the same file changed in two task worktrees.`,
          evidence: [`task:${a}`, `task:${b}`, ...fileEvidence(collision.files)],
        },
        result.errors,
      );
      if (!ok) continue;
      this.open.set(pair, { collision, set });
      result.collisions.push(collision);
    }

    for (const [pair, { collision }] of [...this.open]) {
      if (currentPairs.has(pair)) continue;
      const [a, b] = collision.tasks;
      // Unreadable this tick: we do not know, so keep it open.
      if (failed.has(a) || failed.has(b)) continue;
      const gone = [a, b].filter((taskId) => !listed.has(taskId));
      const ok = this.write(
        {
          type: "collision.resolved",
          actor: WATCHER_ACTOR,
          subject: pair,
          summary: gone.length ? `${a} and ${b} no longer collide: ${gone.join(" and ")} has no worktree` : `${a} and ${b} no longer change any same file`,
          reason: gone.length ? `The worktree was removed.` : `The watcher found no file changed by both tasks.`,
          evidence: [`task:${a}`, `task:${b}`, ...fileEvidence(collision.files)],
        },
        result.errors,
      );
      if (!ok) continue;
      this.open.delete(pair);
      result.resolved.push(collision);
    }

    result.active = [...this.open.values()].map((item) => item.collision).sort((x, y) => pairKey(x.tasks).localeCompare(pairKey(y.tasks), "en", { numeric: true }));
  }
}
