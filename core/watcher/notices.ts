// Turns what the git watcher saw into short plain-language notices for the main chat's inbox.
//
// The watcher writes the durable facts to the ledger. This turns each tick's result into at most one
// notice per event: a collision is announced once per pair and file set (and again only when the shared
// files change), a stall once per quiet spell, a problem once until it clears. A tick that sees the same
// thing again says nothing. Pure and in memory: no git, no ledger, no clock of its own.
import { fileSetKey, pairKey } from "./collisions";
import type { TickResult } from "./watcher";

export type WatchNoticeKind = "collision" | "collision-cleared" | "stalled" | "moving-again" | "commits" | "problem" | "problem-cleared";

export interface WatchNotice {
  kind: WatchNoticeKind;
  tasks: string[];
  text: string;
}

export interface ConsumeContext {
  /** Task ids that have a worktree right now. A stalled task that left the list is dropped quietly. */
  listed?: ReadonlySet<string>;
  /** A task that is idle because it waits for the person (a test to approve, a diff to read) is not a worker stall. */
  waitingOnPerson?: (taskId: string) => boolean;
}

const MAX_SUBJECT = 80;
const MAX_FILE = 80;

/** Text from a worktree (commit subjects, file names) is data: one line, no control or direction-changing characters, clipped. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const quoted = (text: string, max: number): string => `"${oneLine(text, max).replace(/"/g, "'")}"`;

function fileList(files: readonly string[], shown = 3): string {
  const names = files.slice(0, shown).map((file) => oneLine(file, MAX_FILE));
  return files.length <= shown ? names.join(", ") : `${names.join(", ")} and ${files.length - shown} more`;
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

/** "15 minutes", "1 hour 5 minutes", "under a minute". */
export function describeSpan(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${plural(hours, "hour")} ${plural(rest, "minute")}` : plural(hours, "hour");
}

export class WatchNotifier {
  /** pair key -> file-set key of the collision last announced for that pair */
  private readonly collisions = new Map<string, { set: string; tasks: [string, string]; files: string[] }>();
  private readonly stalled = new Set<string>();
  /** problem key -> the task it concerns ("*" for the ledger) */
  private readonly problems = new Map<string, string>();

  /** The notices this tick adds. Calling it again with the same result adds none. */
  consume(result: TickResult, context: ConsumeContext = {}): WatchNotice[] {
    // A skipped tick looked at nothing, and one that could not read the ledger (task "*") saw no worktrees:
    // their empty lists mean "unknown", never "all collisions are over".
    if (result.skipped) return [];
    if (result.errors.some((error) => error.taskId === "*")) return this.problemNotices(result, true);
    return [...this.commits(result), ...this.collisionNotices(result), ...this.stallNotices(result, context), ...this.problemNotices(result)];
  }

  private commits(result: TickResult): WatchNotice[] {
    const byTask = new Map<string, TickResult["observed"]>();
    for (const commit of result.observed) byTask.set(commit.taskId, [...(byTask.get(commit.taskId) ?? []), commit]);
    const notices: WatchNotice[] = [];
    for (const [taskId, commits] of byTask) {
      const latest = commits[commits.length - 1]!;
      const subject = latest.subject ? quoted(latest.subject, MAX_SUBJECT) : "with no message";
      const text =
        commits.length === 1
          ? `${taskId} committed ${subject} (${latest.sha.slice(0, 7)}).`
          : `${taskId} made ${commits.length} new commits; the latest is ${subject} (${latest.sha.slice(0, 7)}).`;
      notices.push({ kind: "commits", tasks: [taskId], text });
    }
    return notices;
  }

  private collisionNotices(result: TickResult): WatchNotice[] {
    const notices: WatchNotice[] = [];
    const current = new Set<string>();
    for (const collision of result.active) {
      const pair = pairKey(collision.tasks);
      current.add(pair);
      const set = fileSetKey(collision.files);
      if (this.collisions.get(pair)?.set === set) continue;
      this.collisions.set(pair, { set, tasks: collision.tasks, files: collision.files });
      notices.push({ kind: "collision", tasks: [...collision.tasks], text: `${collision.tasks[0]} and ${collision.tasks[1]} both changed ${fileList(collision.files)}.` });
    }
    for (const [pair, known] of [...this.collisions]) {
      if (current.has(pair)) continue;
      this.collisions.delete(pair);
      notices.push({ kind: "collision-cleared", tasks: [...known.tasks], text: `${known.tasks[0]} and ${known.tasks[1]} no longer both change ${fileList(known.files)}.` });
    }
    return notices;
  }

  private stallNotices(result: TickResult, context: ConsumeContext): WatchNotice[] {
    const notices: WatchNotice[] = [];
    const quiet = new Set<string>();
    for (const stall of result.stalled) {
      if (context.waitingOnPerson?.(stall.taskId)) continue;
      quiet.add(stall.taskId);
      if (this.stalled.has(stall.taskId)) continue;
      this.stalled.add(stall.taskId);
      notices.push({ kind: "stalled", tasks: [stall.taskId], text: `${stall.taskId} has not changed anything for ${describeSpan(stall.idleMs)}.` });
    }
    const unreadable = new Set(result.errors.map((error) => error.taskId));
    for (const taskId of [...this.stalled]) {
      if (quiet.has(taskId) || unreadable.has(taskId)) continue;
      this.stalled.delete(taskId);
      if (context.listed && !context.listed.has(taskId)) continue;
      notices.push({ kind: "moving-again", tasks: [taskId], text: `${taskId} has changed something again after being quiet.` });
    }
    return notices;
  }

  private problemNotices(result: TickResult, blind = false): WatchNotice[] {
    const notices: WatchNotice[] = [];
    const now = new Map<string, { taskId: string; message: string }>();
    for (const error of result.errors) now.set(`${error.taskId}|${error.message}`, { taskId: error.taskId, message: error.message });
    for (const [key, { taskId, message }] of now) {
      if (this.problems.has(key)) continue;
      this.problems.set(key, taskId);
      const why = oneLine(message, 200);
      const text =
        taskId === "*"
          ? `Perfect Planner is not watching the workers right now (${why}). It keeps trying, and nothing was written.`
          : /^ledger write failed/.test(message)
            ? `Perfect Planner saw something about ${taskId} but could not record it (${why}). It keeps trying.`
            : `Perfect Planner cannot read ${taskId}'s work folder (${why}), so it is not watching that task. Nothing was changed or removed.`;
      notices.push({ kind: "problem", tasks: taskId === "*" ? [] : [taskId], text });
    }
    for (const [key, taskId] of [...this.problems]) {
      if (now.has(key)) continue;
      // Blind to the worktrees this tick: only the ledger problem itself can be judged.
      if (blind && taskId !== "*") continue;
      this.problems.delete(key);
      // A different message for the same task replaces the old one; only say "again" when nothing is wrong any more.
      if ([...now.values()].some((item) => item.taskId === taskId)) continue;
      notices.push({ kind: "problem-cleared", tasks: taskId === "*" ? [] : [taskId], text: taskId === "*" ? "Perfect Planner is watching the workers again." : `Perfect Planner can read ${taskId}'s work folder again.` });
    }
    return notices;
  }
}
