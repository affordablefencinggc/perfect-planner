import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { surfacesOverlap } from "../../src/engine/collisionEngine.js";
import { ensureRequiredIgnores, privatePaths } from "./ignores";
import { INSTALL_SCRIPTS_HINT, NPM_CONFIG_HINT, runNpm } from "./npm";
import { git, GitError, runGit } from "./git";
import { directorySize, folderNote, isListed, keepReasons, parseWorktreeList, readFacts, type FolderState, type FolderStatus, type ListedWorktree, type Reconciled, type WorktreeFacts } from "./hygiene";
import { isWithin, lines, realDir, samePath, toRepoPath } from "./platform";
import { type Actor, type LedgerPort, WORKTREES_ACTOR } from "./ports";
import { copyLocalSettings, placeholderSecrets } from "./settings";
import { branchFor, TASK_ID, type WorktreeInfo } from "./types";

export type Installer = (worktreePath: string) => Promise<void>;

export interface WorktreeManagerOptions {
  repoRoot: string;
  ledger: LedgerPort;
  /** Worktrees live here, relative to the repo root (spec 5.3). */
  worktreeDir?: string;
  /** Cap on parallel worktrees to protect disk and CPU (spec 5.6). */
  maxParallel?: number;
  /** Inclusive dev-server port range handed out one per worktree. */
  ports?: [number, number];
  /**
   * "auto" runs `npm ci --prefer-offline --ignore-scripts` when the worktree has a package-lock.json,
   * through Node with no shell and an npm never taken from the project; false skips; a function replaces it.
   */
  install?: "auto" | false | Installer;
  /** Let "auto" run packages' install scripts. Only a person turns this on; default false. */
  allowInstallScripts?: boolean;
  /** Shared npm cache directory, passed as npm_config_cache. */
  npmCache?: string;
  /** Install the commit-time secret scan in each worktree (default true). */
  secretScan?: boolean;
  now?: () => Date;
}

export interface CreateOptions {
  taskId: string;
  actor: Actor;
  /** Ref to branch from and merge back into. Defaults to the main checkout's current branch. */
  baseRef?: string;
  claims?: string[];
}

export interface ClaimConflict {
  taskId: string;
  mine: string;
  theirs: string;
}

export interface RemoveResult {
  taskId: string;
  branchDeleted: boolean;
  /** Why the branch was kept (unmerged work is never deleted). */
  branchKeptReason?: string;
}

/** What a sweep asks about each registered task folder: is its task still being worked on, finished or released, or unclear. */
export type FolderClass = "active" | "finished" | "released" | { keep: string };

export interface SweepOptions {
  classify: (info: WorktreeInfo) => FolderClass;
  actor?: Actor;
  /** Only report what a sweep would do; remove nothing. */
  dryRun?: boolean;
}

/** A task folder that is still on disk (or missing) although nobody is working in it. */
export interface Leftover {
  taskId: string;
  branch: string;
  path: string;
  state: FolderState;
  /** Who started the folder (a ledger actor id). */
  launchedBy: string;
  sizeBytes: number;
  sizeApproximate: boolean;
  /** Plain-words reasons it is kept. */
  why: string[];
  /** The person may choose to remove it: nothing uncommitted, nothing that would be lost with the folder. */
  removable: boolean;
}

export interface SweepResult {
  removed: (RemoveResult & { path: string })[];
  kept: Leftover[];
}

export interface RecreateResult {
  info: WorktreeInfo;
  /** Set when the ledger refused or could not take the entry; the folder is back all the same. */
  ledgerNote?: string;
}

interface Registry {
  schemaVersion: 1;
  worktrees: WorktreeInfo[];
}

const HOOK_SOURCE = fileURLToPath(new URL("./hooks/secret-scan.mjs", import.meta.url));

/**
 * The pre-commit hook git runs in a task worktree. The desktop app ships its own Node
 * (PP_NODE_BINARY), so the hook calls that one; git's sh wants forward slashes on Windows.
 */
export function preCommitHook(env: NodeJS.ProcessEnv = process.env): string {
  // Single quotes, so nothing in the path ($, backticks) is expanded by sh.
  const node = env.PP_NODE_BINARY ? `'${env.PP_NODE_BINARY.replaceAll("\\", "/").replaceAll("'", `'\\''`)}'` : "node";
  return `#!/bin/sh\nexec ${node} "$(dirname "$0")/secret-scan.mjs"\n`;
}

export class WorktreeError extends Error {}

/**
 * One git worktree per task (spec 5.3 and 5.6). Each gets branch pp/T-n, a folder under
 * .perfect-planner/worktrees, a free dev-server port, local settings with placeholder
 * secrets, dependencies from the shared cache and a commit-time secret scan.
 * Work is never discarded: removal refuses a dirty worktree and keeps unmerged branches.
 */
export class WorktreeManager {
  readonly repoRoot: string;
  readonly worktreeRoot: string;
  private readonly ledger: LedgerPort;
  private readonly maxParallel: number;
  private readonly portRange: [number, number];
  private readonly install: "auto" | false | Installer;
  private readonly npmCache?: string;
  private readonly allowInstallScripts: boolean;
  private readonly secretScan: boolean;
  private readonly now: () => Date;
  private commonDir?: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: WorktreeManagerOptions) {
    this.repoRoot = realDir(options.repoRoot);
    this.worktreeRoot = path.join(this.repoRoot, ...(options.worktreeDir ?? ".perfect-planner/worktrees").split("/"));
    this.ledger = options.ledger;
    this.maxParallel = options.maxParallel ?? 4;
    this.portRange = options.ports ?? [5200, 5999];
    this.install = options.install ?? "auto";
    this.npmCache = options.npmCache;
    this.allowInstallScripts = options.allowInstallScripts ?? false;
    this.secretScan = options.secretScan ?? true;
    this.now = options.now ?? (() => new Date());
  }

  /** Mutations run one at a time so two launches can't take the same port or slot. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async list(): Promise<WorktreeInfo[]> {
    return (await this.readRegistry()).worktrees;
  }

  async get(taskId: string): Promise<WorktreeInfo | undefined> {
    return (await this.list()).find((info) => info.taskId === taskId);
  }

  create(options: CreateOptions): Promise<WorktreeInfo> {
    return this.serial(() => this.createNow(options));
  }

  private async createNow({ taskId, actor, baseRef, claims = [] }: CreateOptions): Promise<WorktreeInfo> {
    if (!TASK_ID.test(taskId)) throw new WorktreeError(`"${taskId}" is not a task id like T-14 or T-14.a2.`);
    const registry = await this.readRegistry();
    if (registry.worktrees.some((info) => info.taskId === taskId)) throw new WorktreeError(`${taskId} already has a worktree.`);
    if (registry.worktrees.length >= this.maxParallel) throw new WorktreeError(`${this.maxParallel} worktrees are already running; finish or remove one first.`);

    const branch = branchFor(taskId);
    const worktreePath = path.join(this.worktreeRoot, taskId);
    const base = baseRef ?? (await git(this.repoRoot, ["symbolic-ref", "--short", "HEAD"]));
    const baseSha = await git(this.repoRoot, ["rev-parse", "--verify", `${base}^{commit}`]).catch(() => {
      throw new WorktreeError(`Base "${base}" is not a commit in this repo.`);
    });
    if ((await runGit(this.repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0) {
      throw new WorktreeError(`Branch ${branch} already exists. Use the next attempt id instead of reusing it.`);
    }
    if (existsSync(worktreePath)) throw new WorktreeError(`${toRepoPath(path.relative(this.repoRoot, worktreePath))} already exists on disk.`);
    const conflicts = this.conflictsWith(registry.worktrees, taskId, claims);
    if (conflicts.length) throw new WorktreeError(`${taskId} claims files already claimed: ${conflicts.map((c) => `${c.mine} (${c.taskId})`).join(", ")}.`);

    await this.excludeWorktreeDir();
    mkdirSync(this.worktreeRoot, { recursive: true });
    // git itself refuses a branch already checked out in another worktree; -b also refuses an existing branch.
    await git(this.repoRoot, ["worktree", "add", "-b", branch, worktreePath, baseSha]);
    try {
      const realPath = realDir(worktreePath);
      if (!isWithin(realDir(this.worktreeRoot), realPath)) throw new WorktreeError("Worktree folder was redirected outside .perfect-planner/worktrees.");
      const port = await this.freePort(registry.worktrees);
      const tracked = new Set(lines(await git(this.repoRoot, ["ls-files", "--", ".env*"])));
      const settings = copyLocalSettings(this.repoRoot, realPath, tracked);
      if (this.secretScan) await this.installSecretScan(realPath);
      await this.installDependencies(realPath);
      const info: WorktreeInfo = { taskId, branch, path: realPath, baseSha, baseRef: base, port, actor: actor.id, createdAt: this.now().toISOString(), claims: claims.map(toRepoPath).sort() };
      registry.worktrees.push(info);
      await this.writeRegistry(registry);
      this.ledger.append({
        type: "worktree.created",
        // Agents may not write git entries; the manager records the launch and names who asked.
        actor: WORKTREES_ACTOR,
        subject: taskId,
        summary: `Worktree for ${taskId} on ${branch}, port ${port}`,
        data: { launchedBy: actor, branch, baseRef: base, baseSha, port, path: toRepoPath(path.relative(this.repoRoot, realPath)), claims: info.claims },
        evidence: [`branch:${branch}`, `base:${base}`, `commit:${baseSha}`, `port:${port}`, `path:${toRepoPath(path.relative(this.repoRoot, realPath))}`, ...settings.map((name) => `settings:${name}`), ...info.claims.map((file) => `claim:${file}`)],
      });
      return info;
    } catch (error) {
      // Nothing has been written in a worktree this young, so a forced rollback discards no one's work.
      await runGit(this.repoRoot, ["worktree", "remove", "--force", worktreePath]);
      await runGit(this.repoRoot, ["branch", "-D", branch]);
      throw error;
    }
  }

  /** Add file claims to a running task. Returns the conflicts and records nothing if there are any. */
  claim(taskId: string, files: string[]): Promise<ClaimConflict[]> {
    return this.serial(async () => {
      const registry = await this.readRegistry();
      const info = registry.worktrees.find((item) => item.taskId === taskId);
      if (!info) throw new WorktreeError(`${taskId} has no worktree.`);
      const conflicts = this.conflictsWith(registry.worktrees, taskId, files);
      if (conflicts.length) return conflicts;
      info.claims = [...new Set([...info.claims, ...files.map(toRepoPath)])].sort();
      await this.writeRegistry(registry);
      return [];
    });
  }

  private conflictsWith(worktrees: WorktreeInfo[], taskId: string, files: string[]): ClaimConflict[] {
    const conflicts: ClaimConflict[] = [];
    for (const other of worktrees) {
      if (other.taskId === taskId) continue;
      for (const mine of files) for (const theirs of other.claims) {
        if (surfacesOverlap({ kind: "file", surface: mine }, { kind: "file", surface: theirs })) conflicts.push({ taskId: other.taskId, mine: toRepoPath(mine), theirs });
      }
    }
    return conflicts;
  }

  /**
   * Remove a finished task's worktree (spec 5.6). Refuses if it holds uncommitted work.
   * The branch is deleted only when it is fully merged into its base; otherwise it is kept.
   */
  remove(taskId: string, actor: Actor = WORKTREES_ACTOR): Promise<RemoveResult> {
    return this.serial(() => this.removeNow(taskId, actor));
  }

  /** The body of remove(), for callers that already hold the one-at-a-time slot (the sweep). */
  private async removeNow(taskId: string, actor: Actor): Promise<RemoveResult> {
    const registry = await this.readRegistry();
    const info = registry.worktrees.find((item) => item.taskId === taskId);
    if (!info) throw new WorktreeError(`${taskId} has no worktree.`);
    if (existsSync(info.path)) {
      const dirty = await git(info.path, ["status", "--porcelain=v1", "--untracked-files=all"]);
      if (dirty) throw new WorktreeError(`${taskId} has uncommitted changes; commit or move them before removing the worktree.`);
      // git worktree remove also deletes ignored files, which can be real work (notes, data, edited settings).
      const kept = await this.ignoredWork(info.path);
      if (kept.length) throw new WorktreeError(`${taskId} has ignored files that would be deleted with the worktree; move them first: ${kept.slice(0, 10).join(", ")}`);
      await git(this.repoRoot, ["worktree", "remove", info.path]);
    } else {
      await git(this.repoRoot, ["worktree", "prune"]);
    }
    let branchDeleted = false;
    let branchKeptReason: string | undefined;
    const merged = await runGit(this.repoRoot, ["merge-base", "--is-ancestor", info.branch, info.baseRef]);
    if (merged.code === 0) {
      await git(this.repoRoot, ["branch", "-D", info.branch]);
      branchDeleted = true;
    } else {
      branchKeptReason = `${info.branch} is not merged into ${info.baseRef}, so it was kept.`;
    }
    registry.worktrees = registry.worktrees.filter((item) => item.taskId !== taskId);
    await this.writeRegistry(registry);
    this.ledger.append({
      type: "worktree.removed",
      actor: WORKTREES_ACTOR,
      subject: taskId,
      summary: branchDeleted ? `Removed worktree and merged branch ${info.branch}` : `Removed worktree; kept unmerged branch ${info.branch}`,
      reason: branchKeptReason,
      evidence: [`branch:${info.branch}`, `port:${info.port}`],
      data: { removedBy: actor, branch: info.branch, branchDeleted },
    });
    return { taskId, branchDeleted, branchKeptReason };
  }

  /**
   * Ignored files in a worktree that removal would destroy. Dependencies (node_modules) can be
   * reinstalled, and settings copied in at launch that still match what the copy produced are
   * placeholders; anything else counts as work.
   */
  private async ignoredWork(worktreePath: string): Promise<string[]> {
    const ignored = lines(await git(worktreePath, ["status", "--porcelain=v1", "--ignored=matching", "--untracked-files=all"]))
      .filter((line) => line.startsWith("!! "))
      .map((line) => line.slice(3).replace(/^"(.*)"$/, "$1"));
    return ignored.filter((file) => {
      if (/(^|\/)node_modules(\/|$)/.test(file)) return false;
      if (!/^\.env(?:\..+)?$/.test(file)) return true;
      const source = path.join(this.repoRoot, file);
      return !existsSync(source) || readFileSync(path.join(worktreePath, file), "utf8") !== placeholderSecrets(readFileSync(source, "utf8"));
    });
  }

  /** Compare the registry with git's own worktree list: entries git no longer knows, and pp worktrees we don't track. */
  async reconcile(): Promise<{ missing: string[]; untracked: string[] }> {
    const listed = lines(await git(this.repoRoot, ["worktree", "list", "--porcelain"]))
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
    const registry = await this.readRegistry();
    const missing = registry.worktrees.filter((info) => !listed.some((item) => samePath(item, info.path))).map((info) => info.taskId);
    const untracked = listed
      .filter((item) => isWithin(this.worktreeRoot, path.resolve(item)) || isWithin(realDir(this.worktreeRoot), path.resolve(item)))
      .filter((item) => !registry.worktrees.some((info) => samePath(item, info.path)))
      .map((item) => path.basename(item));
    return { missing, untracked };
  }

  // ---- keeping the registry, git and the disk in step (lane L10). New methods; reconcile() above keeps its older shape. ----

  /**
   * Compares the registry with git's worktree list and the disk. Each registered folder is "ok", "missing"
   * (deleted outside the app, branch still there: can be recreated), "gone" (folder and branch both deleted:
   * only a stale record is left) or "unlinked" (folder there, git does not track it: never touched). pp
   * worktrees git lists under our folder that the registry lacks come back as `untracked`. With `forget`, the
   * stale record of a "gone" folder is dropped (bookkeeping only; there is nothing left to preserve). Never
   * deletes a folder or a branch.
   */
  async reconcileWithDisk(options: { forget?: boolean; actor?: Actor } = {}): Promise<Reconciled> {
    const run = async (): Promise<Reconciled> => {
      const registry = await this.readRegistry();
      const listed = parseWorktreeList(await git(this.repoRoot, ["worktree", "list", "--porcelain"]));
      const folders: FolderStatus[] = [];
      for (const info of registry.worktrees) folders.push(await this.statusOf(info, listed));
      const untracked = listed
        .filter((item) => this.underWorktreeRoot(item.path) && !registry.worktrees.some((info) => samePath(item.path, info.path)))
        .map((item) => ({ name: path.basename(item.path), path: item.path, ...(item.branch ? { branch: item.branch } : {}) }));
      const forgotten: string[] = [];
      if (options.forget) {
        const stale = folders.filter((item) => item.state === "gone").map((item) => registry.worktrees.find((info) => info.taskId === item.taskId)!);
        if (stale.length) {
          registry.worktrees = registry.worktrees.filter((info) => !stale.includes(info));
          await this.writeRegistry(registry);
          for (const info of stale) {
            forgotten.push(info.taskId);
            this.ledger.append({
              type: "worktree.removed",
              actor: WORKTREES_ACTOR,
              subject: info.taskId,
              summary: `Forgot the record of ${info.taskId}'s folder: the folder and ${info.branch} were both deleted outside Perfect Planner`,
              evidence: [`branch:${info.branch}`, `port:${info.port}`],
              data: { removedBy: options.actor ?? WORKTREES_ACTOR, branch: info.branch, branchDeleted: false, forgotten: true },
            });
          }
        }
      }
      return { folders, untracked, forgotten };
    };
    return options.forget ? this.serial(run) : run();
  }

  /** Is this path inside the planner's own worktree folder (as written or as a real path)? */
  private underWorktreeRoot(folder: string): boolean {
    const resolved = path.resolve(folder);
    return isWithin(this.worktreeRoot, resolved) || isWithin(realDir(this.worktreeRoot), resolved);
  }

  private async statusOf(info: WorktreeInfo, listed: ListedWorktree[]): Promise<FolderStatus> {
    const make = (state: FolderState, outside = false): FolderStatus => ({ taskId: info.taskId, branch: info.branch, path: info.path, state, note: folderNote(state, info.taskId, info.branch, info.path, outside) });
    // The registry lives in .git, which any program on this PC can write: a record naming some other folder is never acted on.
    if (!this.underWorktreeRoot(info.path)) return make("unlinked", true);
    if (existsSync(info.path)) return make(isListed(listed, info.path) ? "ok" : "unlinked");
    const branch = await runGit(this.repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${info.branch}`]);
    return make(branch.code === 0 ? "missing" : "gone");
  }

  /**
   * Brings back a folder that was deleted outside the app, from its branch pp/T-n, with every commit on it.
   * Only for a "missing" folder (record present, folder gone, branch present). Never creates or deletes a
   * branch, never overwrites a folder that exists. If setting the folder up fails, the fresh checkout (committed
   * files only) is taken away again and the branch is left exactly as it was.
   */
  recreate(taskId: string, actor: Actor = WORKTREES_ACTOR): Promise<RecreateResult> {
    return this.serial(async () => {
      const registry = await this.readRegistry();
      const info = registry.worktrees.find((item) => item.taskId === taskId);
      if (!info) throw new WorktreeError(`${taskId} has no worktree record.`);
      const listed = parseWorktreeList(await git(this.repoRoot, ["worktree", "list", "--porcelain"]));
      const status = await this.statusOf(info, listed);
      if (status.state === "ok") throw new WorktreeError(`${taskId}'s folder is already there; nothing to recreate.`);
      if (status.state !== "missing") throw new WorktreeError(status.note);
      const target = path.join(this.worktreeRoot, taskId);
      if (existsSync(target)) throw new WorktreeError(`${toRepoPath(path.relative(this.repoRoot, target))} already exists on disk.`);
      const holder = listed.find((item) => item.branch === info.branch && !samePath(item.path, target) && existsSync(item.path));
      if (holder) throw new WorktreeError(`${info.branch} is already checked out in ${holder.path}.`);
      await this.excludeWorktreeDir();
      mkdirSync(this.worktreeRoot, { recursive: true });
      // --force only steps over git's note that this very folder was registered and then deleted; the holder check above stands in for its other guard.
      await git(this.repoRoot, ["worktree", "add", "--force", target, info.branch]);
      try {
        const realPath = realDir(target);
        if (!isWithin(realDir(this.worktreeRoot), realPath)) throw new WorktreeError("Worktree folder was redirected outside .perfect-planner/worktrees.");
        const others = registry.worktrees.filter((item) => item.taskId !== taskId);
        const port = !others.some((item) => item.port === info.port) && (await portIsFree(info.port)) ? info.port : await this.freePort(others);
        const tracked = new Set(lines(await git(this.repoRoot, ["ls-files", "--", ".env*"])));
        const settings = copyLocalSettings(this.repoRoot, realPath, tracked);
        if (this.secretScan) await this.installSecretScan(realPath);
        await this.installDependencies(realPath);
        info.path = realPath;
        info.port = port;
        await this.writeRegistry(registry);
        const where = toRepoPath(path.relative(this.repoRoot, realPath));
        let ledgerNote: string | undefined;
        try {
          this.ledger.append({
            type: "worktree.created",
            actor: WORKTREES_ACTOR,
            subject: taskId,
            summary: `Recreated the folder for ${taskId} from ${info.branch}, port ${port}`,
            data: { launchedBy: actor, recreated: true, branch: info.branch, baseRef: info.baseRef, baseSha: info.baseSha, port, path: where, claims: info.claims },
            evidence: [`branch:${info.branch}`, `base:${info.baseRef}`, `commit:${info.baseSha}`, `port:${port}`, `path:${where}`, ...settings.map((name) => `settings:${name}`), ...info.claims.map((file) => `claim:${file}`)],
          });
        } catch (error) {
          // The folder is back and registered; a ledger rule (for example the month's budget) refusing a new-run entry must not undo that.
          ledgerNote = (error as Error).message;
        }
        return { info, ...(ledgerNote ? { ledgerNote } : {}) };
      } catch (error) {
        // Only committed files were checked out, so nothing in this folder is anyone's work. The branch is never touched.
        await runGit(this.repoRoot, ["worktree", "remove", "--force", target]);
        throw error;
      }
    });
  }

  /** Facts about one task folder: what stands between it and a safe removal. Only reads. */
  async assess(info: WorktreeInfo, listed?: ListedWorktree[]): Promise<WorktreeFacts> {
    const known = listed ?? parseWorktreeList(await git(this.repoRoot, ["worktree", "list", "--porcelain"]));
    return readFacts({ repoRoot: this.repoRoot, folder: info.path, branch: info.branch, baseRef: info.baseRef, locked: Boolean(isListed(known, info.path)?.locked), ignoredWork: (folder) => this.ignoredWork(folder) });
  }

  /**
   * The safe sweep. `classify` says, per folder, whether its task is still being worked on ("active": left alone and not
   * listed), finished or released, or unclear (`{ keep }`: listed, never removed by the sweep). A finished or released
   * folder is removed only when nothing in it can be lost: tree clean (no uncommitted, untracked or ignored work), every
   * commit merged into its base or pushed to a remote, git not holding it locked. A released task's folder also needs its
   * branch merged, because the branch goes with it and a branch is used once. Everything else comes back in `kept`
   * with the reasons, its owner and its disk size, for the person to decide. Branches are only ever deleted by the
   * same rule as remove(): fully merged. One at a time with every other change, so a dispatch cannot interleave.
   */
  sweep(options: SweepOptions): Promise<SweepResult> {
    return options.dryRun ? this.sweepNow(options) : this.serial(() => this.sweepNow(options));
  }

  private async sweepNow({ classify, actor = WORKTREES_ACTOR, dryRun = false }: SweepOptions): Promise<SweepResult> {
    const registry = await this.readRegistry();
    const listed = parseWorktreeList(await git(this.repoRoot, ["worktree", "list", "--porcelain"]));
    const result: SweepResult = { removed: [], kept: [] };
    for (const info of [...registry.worktrees]) {
      const kind = classify(info);
      if (kind === "active") continue;
      const status = await this.statusOf(info, listed);
      if (status.state !== "ok") {
        result.kept.push(await this.leftover(info, status.state, [status.note], false));
        continue;
      }
      const facts = await this.assess(info, listed);
      const { hard, soft } = keepReasons(facts, info.branch, info.baseRef, { needMerged: kind !== "finished" });
      const why = typeof kind === "object" ? [kind.keep, ...hard, ...soft] : [...hard, ...soft];
      if (typeof kind === "string" && !why.length && !dryRun) {
        try {
          result.removed.push({ ...(await this.removeNow(info.taskId, actor)), path: info.path });
        } catch (error) {
          result.kept.push(await this.leftover(info, "ok", [(error as Error).message], false));
        }
        continue;
      }
      result.kept.push(await this.leftover(info, "ok", why.length ? why : ["Finished, and nothing in it would be lost: the next clean-up removes it."], hard.length === 0));
    }
    return result;
  }

  private async leftover(info: WorktreeInfo, state: FolderState, why: string[], removable: boolean): Promise<Leftover> {
    const size = state === "missing" || state === "gone" || !existsSync(info.path) ? { bytes: 0, approximate: false } : await directorySize(info.path);
    return { taskId: info.taskId, branch: info.branch, path: info.path, state, launchedBy: info.actor, sizeBytes: size.bytes, sizeApproximate: size.approximate, why, removable };
  }

  /**
   * The person's own choice to remove a folder the sweep kept. Checked again, and removed, in one step:
   * `decide` (the caller's view of the task) may refuse outright, or say the task is still open
   * (`needMerged`: the branch goes with the folder, so it must be fully merged); the hard reasons from
   * keepReasons stop it with a plain message. Commits only on the branch stay there; the branch is
   * deleted only when fully merged (remove()'s rule).
   */
  removeChecked(taskId: string, actor: Actor, decide: (info: WorktreeInfo) => { refuse?: string; needMerged?: boolean }): Promise<RemoveResult> {
    return this.serial(async () => {
      const registry = await this.readRegistry();
      const info = registry.worktrees.find((item) => item.taskId === taskId);
      if (!info) throw new WorktreeError(`${taskId} has no worktree.`);
      const verdict = decide(info);
      if (verdict.refuse) throw new WorktreeError(verdict.refuse);
      const listed = parseWorktreeList(await git(this.repoRoot, ["worktree", "list", "--porcelain"]));
      const status = await this.statusOf(info, listed);
      if (status.state !== "ok") throw new WorktreeError(status.note);
      const { hard } = keepReasons(await this.assess(info, listed), info.branch, info.baseRef, { needMerged: verdict.needMerged });
      if (hard.length) throw new WorktreeError(`${taskId} was not removed: ${hard.join(" ")}`);
      return this.removeNow(taskId, actor);
    });
  }

  private async gitCommonDir(): Promise<string> {
    if (!this.commonDir) this.commonDir = path.resolve(this.repoRoot, await git(this.repoRoot, ["rev-parse", "--git-common-dir"]));
    return this.commonDir;
  }

  private async registryFile(): Promise<string> {
    return path.join(await this.gitCommonDir(), "perfect-planner", "worktrees.json");
  }

  private async readRegistry(): Promise<Registry> {
    const file = await this.registryFile();
    if (!existsSync(file)) return { schemaVersion: 1, worktrees: [] };
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Registry;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.worktrees)) throw new WorktreeError(`${file} is not a worktree registry this version understands.`);
    return parsed;
  }

  private async writeRegistry(registry: Registry): Promise<void> {
    const file = await this.registryFile();
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`);
    // Windows can briefly lock the target (indexers, antivirus); retry the atomic swap.
    for (let attempt = 0; ; attempt += 1) {
      try {
        renameSync(temp, file);
        return;
      } catch (error) {
        if (attempt >= 10 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  }

  /** Keep task worktrees, the ledger and worker tokens out of the main checkout's status without touching the tracked .gitignore. */
  private async excludeWorktreeDir(): Promise<void> {
    // The whole planner folder (ledger, worker tokens) is always excluded; a custom worktree folder too.
    const relative = toRepoPath(path.relative(this.repoRoot, this.worktreeRoot));
    const custom = relative.startsWith("..") || privatePaths([relative]).length ? [] : [`/${relative}/`];
    await ensureRequiredIgnores(this.repoRoot, custom);
  }

  private async freePort(taken: WorktreeInfo[]): Promise<number> {
    const used = new Set(taken.map((info) => info.port));
    for (let port = this.portRange[0]; port <= this.portRange[1]; port += 1) {
      if (!used.has(port) && (await portIsFree(port))) return port;
    }
    throw new WorktreeError(`No free dev-server port between ${this.portRange[0]} and ${this.portRange[1]}.`);
  }

  /**
   * Per-worktree hooksPath, so only task worktrees get the scan and the user's own
   * hooks in the main checkout are untouched. Needs git's worktreeConfig extension.
   */
  private async installSecretScan(worktreePath: string): Promise<void> {
    const hooksDir = path.join(await this.gitCommonDir(), "perfect-planner", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    copyFileSync(HOOK_SOURCE, path.join(hooksDir, "secret-scan.mjs"));
    const hook = path.join(hooksDir, "pre-commit");
    writeFileSync(hook, preCommitHook());
    if (process.platform !== "win32") chmodSync(hook, 0o755);
    if ((await runGit(this.repoRoot, ["config", "--get", "extensions.worktreeConfig"])).stdout.trim() !== "true") {
      const version = (await runGit(this.repoRoot, ["config", "--get", "core.repositoryformatversion"])).stdout.trim();
      if (!version || version === "0") await git(this.repoRoot, ["config", "core.repositoryformatversion", "1"]);
      await git(this.repoRoot, ["config", "extensions.worktreeConfig", "true"]);
    }
    await git(worktreePath, ["config", "--worktree", "core.hooksPath", toRepoPath(hooksDir)]);
  }

  private async installDependencies(worktreePath: string): Promise<void> {
    if (this.install === false) return;
    if (typeof this.install === "function") return this.install(worktreePath);
    if (!existsSync(path.join(worktreePath, "package-lock.json"))) return;
    // npm comes from beside Node or PATH, never from the project or its worktrees, and runs without a shell.
    const { code, output } = await runNpm(["ci", "--prefer-offline", "--no-audit", "--no-fund"], {
      cwd: worktreePath,
      protect: [this.repoRoot, this.worktreeRoot, worktreePath],
      env: this.npmCache ? { npm_config_cache: this.npmCache } : {},
      allowInstallScripts: this.allowInstallScripts,
    }).catch((error: Error) => ({ code: -1, output: error.message }));
    if (code !== 0) {
      const hint = `${this.allowInstallScripts ? "" : ` ${INSTALL_SCRIPTS_HINT}`} ${NPM_CONFIG_HINT}`;
      throw new WorktreeError(`npm ci failed in ${path.basename(worktreePath)} (exit ${code}): ${output.trim().split(/\r?\n/).slice(-3).join(" ")}${hint}`);
    }
  }
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => server.close(() => resolve(true)));
  });
}

export { GitError };
