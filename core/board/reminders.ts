// Reminders and the dependency graph are pure projections over the work board.
// They read only the facts the board already holds: no disk, no clock of their own,
// no writes. A reminder is raised only when the supplied facts prove it, so an empty
// list means "nothing in these facts needs a person", not "the work is fine".
import type { BoardTask } from "../host/routes/board";

/** Mirrors STALL_MS in core/host/routes/board.ts, which owns the live board's threshold. */
export const STALL_MS = 15 * 60 * 1000;
/** Mirrors FRESH_MS in core/host/routes/board.ts. */
export const FRESH_MS = 10 * 60 * 1000;
/** A review that has waited this long is worth a nudge. */
export const REVIEW_WAIT_MS = 30 * 60 * 1000;

export type ReminderLevel = "stop" | "risk" | "info";

export type ReminderCode =
  | "claim-idle"
  | "check-failed"
  | "dependency-unmet"
  | "plan-changed"
  | "token-cap"
  | "model-conflict"
  | "no-owner"
  | "review-waiting"
  | "handover-waiting"
  | "stale-worktree";

export interface Reminder {
  code: ReminderCode;
  level: ReminderLevel;
  /** The attempt label the board shows ("T-14.a2"), not a second task identity. */
  task: string;
  /** The task's own title, as recorded. */
  title: string;
  owner: string | null;
  message: string;
  action: string;
  /** How long the fact behind the reminder has been true, when the board carries a timestamp. */
  ageMs?: number;
  /** For a quiet worker, when silence would become a stall. ISO time. */
  dueAt?: string;
}

export interface ReminderOptions {
  /** The moment to judge against. Defaults to Date.now(); pass it in tests and folds. */
  now?: number;
  stallMs?: number;
  freshMs?: number;
  reviewWaitMs?: number;
}

const LEVEL_RANK: Record<ReminderLevel, number> = { stop: 0, risk: 1, info: 2 };

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

function minutes(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

function reminder(
  task: BoardTask,
  code: ReminderCode,
  level: ReminderLevel,
  message: string,
  action: string,
  extra: { ageMs?: number | null; dueAt?: string | null } = {},
): Reminder {
  return {
    code,
    level,
    task: task.label,
    title: task.title,
    owner: task.owner ?? task.assignee ?? null,
    message,
    action,
    ...(extra.ageMs != null && Number.isFinite(extra.ageMs) ? { ageMs: Math.max(0, extra.ageMs) } : {}),
    ...(extra.dueAt ? { dueAt: extra.dueAt } : {}),
  };
}

/**
 * How long the task has been silent. An explicit timestamp wins over the board's
 * precomputed age so a caller that passes its own `now` gets a consistent number.
 */
function idleMs(task: BoardTask, now: number): number | null {
  const at = parseTime(task.updatedAt) ?? parseTime(task.progress?.at);
  if (at != null) return Math.max(0, now - at);
  if (task.progressAgeMs != null && Number.isFinite(task.progressAgeMs)) return Math.max(0, task.progressAgeMs);
  return null;
}

/** Dependency ids that are not done; an id that is not on the board counts as not done. */
function unmetIds(task: BoardTask, byId: ReadonlyMap<string, BoardTask>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of task.dependsOn) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (byId.get(id)?.status === "done") continue;
    out.push(id);
  }
  return out;
}

function claimIdle(task: BoardTask, now: number, stallMs: number, freshMs: number): Reminder | null {
  // "Claimed/building" means a worker is the active party. Review, ship, blocked,
  // failed and finished cards are waiting on a person, so another rule owns them.
  if (task.status !== "claimed" && task.column !== "building") return null;
  if (task.health !== "working" && task.health !== "quiet" && task.health !== "stalled") return null;
  const age = idleMs(task, now);
  if (age == null) {
    // The board can already know a claim is stalled (for example, the worker is no
    // longer checked in) even when no progress timestamp was ever written.
    if (task.health !== "stalled") return null;
    return reminder(
      task,
      "claim-idle",
      "stop",
      `${task.label} is claimed, but the board has no readable sign of life for it.`,
      "Release the claim, then hand the task over or dispatch a new worker. The worktree is kept.",
    );
  }
  if (age >= stallMs) {
    return reminder(
      task,
      "claim-idle",
      "stop",
      `${task.label} has shown no progress for ${minutes(age)} minutes.`,
      "Release the claim, then hand the task over or dispatch a new worker. The worktree is kept.",
      { ageMs: age },
    );
  }
  if (age > freshMs) {
    return reminder(
      task,
      "claim-idle",
      "risk",
      `${task.label} has been quiet for ${minutes(age)} minutes. That is not a stall yet, but it is close.`,
      "Ask the worker for a sign of life, or release the claim if it has stopped.",
      { ageMs: age, dueAt: new Date(now + (stallMs - age)).toISOString() },
    );
  }
  return null;
}

function checkFailed(task: BoardTask): Reminder | null {
  if (task.check?.passed !== false) return null;
  const commit = task.check.commit ? ` at ${task.check.commit}` : "";
  return reminder(
    task,
    "check-failed",
    "stop",
    `${task.label}'s approved test failed${commit}.`,
    "Read the failure, fix the cause, then run the check again.",
  );
}

function dependencyUnmet(task: BoardTask, byId: ReadonlyMap<string, BoardTask>): Reminder | null {
  if (!task.dependsOn.length || task.waitingFor == null) return null;
  if (task.status === "done" || task.column === "done") return null;
  const unmet = unmetIds(task, byId);
  const level = task.status === "claimed" || task.column === "building" ? "stop" : "risk";
  if (!unmet.length) {
    // The board says it waits, but the supplied tasks do not name an unfinished
    // dependency. Keep the board's own sentence rather than inventing an id.
    return reminder(
      task,
      "dependency-unmet",
      level,
      task.waitingFor,
      "Finish the blocking task first, or change the plan so this task no longer depends on it.",
    );
  }
  const names = unmet.map((id) => {
    const dependency = byId.get(id);
    if (!dependency) return `${id} (not on the board)`;
    return dependency.title ? `${id} (${dependency.title})` : id;
  });
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0]!;
  return reminder(
    task,
    "dependency-unmet",
    level,
    `${task.label} is waiting on ${list}; ${unmet.length === 1 ? "that task is" : "those tasks are"} not done yet.`,
    "Finish the blocking task first, or change the plan so this task no longer depends on it.",
  );
}

function planChanged(task: BoardTask): Reminder | null {
  const attention = task.attention.find((item) => item.code === "plan-changed");
  if (!attention) return null;
  return reminder(task, "plan-changed", "risk", attention.message, attention.action);
}

function tokenCap(task: BoardTask): Reminder | null {
  const attention = task.attention.find((item) => item.code === "token-budget");
  if (!attention) return null;
  return reminder(task, "token-cap", "stop", attention.message, attention.action);
}

function modelConflict(task: BoardTask): Reminder | null {
  if (!task.modelConflict) return null;
  const attention = task.attention.find((item) => item.code === "model-conflict");
  const message = task.requestedModel && task.reportedModel
    ? `${task.label} asked for ${task.requestedModel}, but the worker reported ${task.reportedModel}.`
    : attention?.message ?? `${task.label} reports a different model from the one that was requested.`;
  return reminder(
    task,
    "model-conflict",
    "risk",
    message,
    attention?.action ?? "Check which model actually worked before accepting the result.",
  );
}

function noOwner(task: BoardTask): Reminder | null {
  if (task.column !== "ready" && task.column !== "review" && task.column !== "ship") return null;
  if (task.owner || task.assignee) return null;
  const state = task.column === "ready" ? "ready to start" : task.column === "review" ? "waiting for review" : "ready to ship";
  return reminder(
    task,
    "no-owner",
    "risk",
    `${task.label} is ${state} but has no owner.`,
    "Assign it to a person or dispatch a worker so it does not sit unattended.",
  );
}

function reviewWaiting(task: BoardTask, now: number, waitMs: number): Reminder | null {
  if (task.column !== "review") return null;
  const at = parseTime(task.updatedAt);
  if (at == null) return null;
  const age = Math.max(0, now - at);
  if (age <= waitMs) return null;
  return reminder(
    task,
    "review-waiting",
    "risk",
    `${task.label} has been waiting for review for ${minutes(age)} minutes.`,
    "Open the diff and the proof, then approve it or send it back.",
    { ageMs: age },
  );
}

function handoverWaiting(task: BoardTask): Reminder | null {
  const attention = task.attention.find((item) => /handover/i.test(item.code) || /handover/i.test(item.message));
  const progress = task.progress?.text ?? "";
  const blockedByHandover = task.health === "blocked" && /handover/i.test(progress);
  if (!attention && !blockedByHandover) return null;
  const message = attention?.message
    ?? `${task.label} is blocked after a handover${progress ? `: ${progress}` : "."}`;
  return reminder(
    task,
    "handover-waiting",
    "risk",
    message,
    attention?.action ?? "Read the handover note, then dispatch a worker or release the claim.",
  );
}

function staleWorktree(task: BoardTask): Reminder | null {
  if (!task.worktree) return null;
  // A person named on the card is responsibility enough; "no owner" here means
  // neither a worker nor an assignee holds it.
  if (task.owner || task.assignee) return null;
  if (task.status === "claimed" || task.status === "blocked") return null;
  // A done task keeps its worktree as evidence by design; it is not stale work.
  if (task.status === "done" || task.column === "done") return null;
  return reminder(
    task,
    "stale-worktree",
    "info",
    `${task.label} has a worktree at ${task.worktree} but nobody owns it.`,
    "Claim it if the work should continue, or hand it over. Keep the worktree until you have checked that nothing in it is needed.",
  );
}

/**
 * Every reminder the supplied facts prove, deduplicated by (task, code) and ordered
 * stop, risk, info; oldest first inside a level, then by task label and code so the
 * result is stable. Returns [] when nothing is wrong.
 */
export function deriveReminders(tasks: readonly BoardTask[], options: ReminderOptions = {}): Reminder[] {
  const now = options.now ?? Date.now();
  const stallMs = options.stallMs ?? STALL_MS;
  const freshMs = options.freshMs ?? FRESH_MS;
  const reviewWaitMs = options.reviewWaitMs ?? REVIEW_WAIT_MS;
  // Sort a copy: the caller's array is never reordered, and a duplicate id resolves
  // the same way whatever order the input arrived in.
  const ordered = [...tasks].sort((left, right) => {
    if (left.id !== right.id) return left.id < right.id ? -1 : 1;
    return left.label < right.label ? -1 : left.label > right.label ? 1 : 0;
  });
  const byId = new Map<string, BoardTask>();
  for (const task of ordered) if (!byId.has(task.id)) byId.set(task.id, task);

  const out: Reminder[] = [];
  const seen = new Set<string>();
  const add = (item: Reminder | null): void => {
    if (!item) return;
    const key = `${item.task}\u0000${item.code}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };

  for (const task of ordered) {
    add(claimIdle(task, now, stallMs, freshMs));
    add(checkFailed(task));
    add(dependencyUnmet(task, byId));
    add(planChanged(task));
    add(tokenCap(task));
    add(modelConflict(task));
    add(noOwner(task));
    add(reviewWaiting(task, now, reviewWaitMs));
    add(handoverWaiting(task));
    add(staleWorktree(task));
  }

  out.sort((left, right) => {
    const level = LEVEL_RANK[left.level] - LEVEL_RANK[right.level];
    if (level) return level;
    const leftAge = left.ageMs ?? -1;
    const rightAge = right.ageMs ?? -1;
    if (leftAge !== rightAge) return rightAge - leftAge;
    if (left.task !== right.task) return left.task < right.task ? -1 : 1;
    return left.code < right.code ? -1 : left.code > right.code ? 1 : 0;
  });
  return out;
}

/** The facts the graph needs. A full BoardTask satisfies this without conversion. */
export type DependencyTask = Pick<BoardTask, "id" | "title" | "status" | "dependsOn">;

export interface DependencyNode {
  id: string;
  title: string;
  status: BoardTask["status"];
  /** A copy of the task's dependency ids, deduplicated and sorted. */
  dependsOn: string[];
}

export interface DependencyEdge {
  /** The task that must finish first. */
  from: string;
  /** The task that waits for `from`. */
  to: string;
}

/** Named apart from core/mcp's UnmetDependency so a shared barrel cannot collide. */
export interface GraphUnmetDependency {
  /** The task that is waiting. */
  task: string;
  /** The dependency ids that are not done (or not on the board). */
  dependsOn: string[];
}

export interface DependencyGraph {
  nodes: DependencyNode[];
  /** Only edges whose two ends are supplied tasks. An unknown dependency is in `unmet`. */
  edges: DependencyEdge[];
  /** Each cycle in traversal order, without repeating the first id; deterministic. */
  cycles: string[][];
  /**
   * The longest chain that can be fully ordered. A task in a cycle, or one that
   * waits on a cycle, is left out because its order is not computable.
   */
  criticalPath: string[];
  unmet: GraphUnmetDependency[];
}

function compareIdLists(left: readonly string[], right: readonly string[]): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index++) {
    if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1;
  }
  return left.length - right.length;
}

/** Rotate a cycle so its smallest id is first; the direction is kept. */
function canonicalCycle(cycle: readonly string[]): string[] {
  if (cycle.length <= 1) return [...cycle];
  let first = 0;
  for (let index = 1; index < cycle.length; index++) {
    if (cycle[index]! < cycle[first]!) first = index;
  }
  return [...cycle.slice(first), ...cycle.slice(0, first)];
}

function findCycles(ids: readonly string[], depsOf: ReadonlyMap<string, string[]>): string[][] {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const found: string[][] = [];
  const seen = new Set<string>();

  const visit = (id: string): void => {
    state.set(id, "visiting");
    stack.push(id);
    for (const dependency of depsOf.get(id) ?? []) {
      if (!depsOf.has(dependency)) continue;
      const dependencyState = state.get(dependency);
      if (dependencyState === "visiting") {
        const start = stack.indexOf(dependency);
        if (start < 0) continue;
        const cycle = canonicalCycle(stack.slice(start));
        const key = cycle.join("\u0000");
        if (!seen.has(key)) {
          seen.add(key);
          found.push(cycle);
        }
      } else if (dependencyState === undefined) {
        visit(dependency);
      }
    }
    stack.pop();
    state.set(id, "done");
  };

  for (const id of ids) if (state.get(id) === undefined) visit(id);
  return found.sort(compareIdLists);
}

function longestChain(ids: readonly string[], depsOf: ReadonlyMap<string, string[]>): string[] {
  const state = new Map<string, "visiting" | "safe" | "unsafe">();
  const memo = new Map<string, string[]>();

  const chain = (id: string): string[] | null => {
    const known = state.get(id);
    if (known === "visiting" || known === "unsafe") return null;
    if (known === "safe") return memo.get(id)!;
    state.set(id, "visiting");
    let best: string[] = [id];
    for (const dependency of depsOf.get(id) ?? []) {
      if (!depsOf.has(dependency)) continue;
      const prefix = chain(dependency);
      if (prefix == null) {
        // This task is in a cycle, or waits on one: no honest order exists for it.
        state.set(id, "unsafe");
        memo.delete(id);
        return null;
      }
      const candidate = [...prefix, id];
      if (candidate.length > best.length || (candidate.length === best.length && compareIdLists(candidate, best) < 0)) {
        best = candidate;
      }
    }
    state.set(id, "safe");
    memo.set(id, best);
    return best;
  };

  let best: string[] = [];
  for (const id of ids) {
    const candidate = chain(id);
    if (candidate && (candidate.length > best.length || (candidate.length === best.length && compareIdLists(candidate, best) < 0))) {
      best = candidate;
    }
  }
  return best;
}

/**
 * The dependency graph of the supplied tasks. Nodes and edges are copies, the input
 * is never mutated, and every list is sorted so the result does not depend on the
 * order the tasks arrived in.
 */
export function dependencyGraph(tasks: readonly DependencyTask[]): DependencyGraph {
  const byId = new Map<string, DependencyTask>();
  for (const task of tasks) if (!byId.has(task.id)) byId.set(task.id, task);
  const ids = [...byId.keys()].sort();

  const depsOf = new Map<string, string[]>();
  for (const id of ids) {
    const task = byId.get(id)!;
    const dependencies = [...new Set(task.dependsOn.filter((dependency) => dependency !== ""))].sort();
    depsOf.set(id, dependencies);
  }

  const nodes: DependencyNode[] = ids.map((id) => {
    const task = byId.get(id)!;
    return { id, title: task.title, status: task.status, dependsOn: [...depsOf.get(id)!] };
  });

  const edges: DependencyEdge[] = [];
  for (const id of ids) {
    for (const dependency of depsOf.get(id)!) {
      if (byId.has(dependency)) edges.push({ from: dependency, to: id });
    }
  }
  edges.sort((left, right) => {
    if (left.from !== right.from) return left.from < right.from ? -1 : 1;
    return left.to < right.to ? -1 : left.to > right.to ? 1 : 0;
  });

  const unmet: GraphUnmetDependency[] = [];
  for (const id of ids) {
    const waiting = depsOf.get(id)!.filter((dependency) => byId.get(dependency)?.status !== "done");
    if (waiting.length) unmet.push({ task: id, dependsOn: waiting });
  }

  return {
    nodes,
    edges,
    cycles: findCycles(ids, depsOf),
    criticalPath: longestChain(ids, depsOf),
    unmet,
  };
}
