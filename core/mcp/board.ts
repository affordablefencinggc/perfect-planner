// The task board as the agent tools see it: a pure fold over the ledger
// (spec §2.1, the board is a view rebuilt by replaying the ledger).
import { isAuthoritative, type LedgerEntry } from "../ledger/index";

export type TaskStatus = "open" | "claimed" | "blocked" | "done";

export interface TaskView {
  id: string;
  title: string;
  status: TaskStatus;
  owner: string | null;
  attempt: number;
  clauses: string[];
  /** Task numbers that must be done before this one starts, from its signed task.created (planning writes them). */
  dependsOn: string[];
  /** The repo the signed task.created names (a registered repo's name), or null for the project's first repo. */
  repo: string | null;
  /** Tasks split from one roadmap task over several repos share this key; null for a task on its own. */
  group: string | null;
  testApproved: boolean;
  proofs: { kind: string; link: string; n: string }[];
  lastProgress: string | null;
  lastEntry: string;
}

const TASK_ID = /^T-\d+$/;
const ATTEMPT = /^(T-\d+)\.a\d+$/;

export function isTaskId(value: string): boolean {
  return TASK_ID.test(value);
}

/**
 * The dependencies a task.created carries. Anything that is not a clean task number is kept as written, so an
 * unreadable dependency still blocks (it can never be "done") instead of being dropped from the check.
 */
function dependencyIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim().slice(0, 40));
  return [...new Set(ids)];
}

/** A repo name or group key from a signed task.created: short plain text, or null. */
function shortName(raw: unknown): string | null {
  return typeof raw === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(raw) ? raw : null;
}

export interface UnmetDependency {
  id: string;
  /** The task's title, or empty when the number is not on the board. */
  title: string;
  /** "unknown" when the number is not a task on the board. */
  status: TaskStatus | "unknown";
}

/** The dependencies of `task` that are not done yet. A dependency that is not on the board counts as not done. */
export function unmetDependencies(board: ReadonlyMap<string, TaskView>, task: Pick<TaskView, "dependsOn">): UnmetDependency[] {
  const unmet: UnmetDependency[] = [];
  for (const id of task.dependsOn) {
    const dependency = board.get(id);
    if (dependency?.status === "done") continue;
    unmet.push(dependency ? { id, title: dependency.title, status: dependency.status } : { id, title: "", status: "unknown" });
  }
  return unmet;
}

const STATE_WORDS: Record<TaskStatus | "unknown", string> = { open: "not started", claimed: "being worked on", blocked: "blocked", done: "done", unknown: "not on the board" };

/** Plain words for why a task cannot start yet, naming each blocking task. Empty when nothing blocks it. */
export function waitingMessage(label: string, unmet: readonly UnmetDependency[]): string {
  if (!unmet.length) return "";
  if (unmet.some((dependency) => dependency.id === label || dependency.id === label.replace(/\.a\d+$/, ""))) {
    return `${label} lists itself as something it must wait for, so it can never start. The plan needs correcting.`;
  }
  const names = unmet.map((dependency) => `${dependency.id}${dependency.title ? ` (${dependency.title})` : ""} is ${STATE_WORDS[dependency.status]}`);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0]!;
  return `${label} cannot start yet because it needs ${unmet.length === 1 ? "another task" : "other tasks"} finished and merged first: ${list}. Start it once ${unmet.length === 1 ? "that one is" : "they are"} done.`;
}

/** "T-14" on attempt 2 is shown as "T-14.a2" (spec §3.1). */
export function attemptLabel(task: Pick<TaskView, "id" | "attempt">): string {
  return task.attempt > 1 ? `${task.id}.a${task.attempt}` : task.id;
}

/** Signed by a person or the system, and verified by the ledger. */
const signed = (entry: LedgerEntry) => isAuthoritative(entry);
/** An agent's own entry (agents hold no keys), or a signed one. Unsigned person/system/jev entries never count. */
const agentOrSigned = (entry: LedgerEntry) => entry.actor?.kind === "agent" || signed(entry);

/**
 * Every entry is weighed by who could have written it: creating, approving,
 * finishing, reopening and Pause all count only when signed; claims, progress,
 * proof and releases come from the agent holding the task (or are signed).
 * A forged entry on disk changes nothing on the board.
 */
export function foldBoard(entries: readonly LedgerEntry[]): Map<string, TaskView> {
  const board = new Map<string, TaskView>();
  for (const entry of entries) {
    // Entries about one attempt ("T-14.a2": the gate's runs, a claim on a retry) belong to the task.
    const id = ATTEMPT.exec(entry.subject)?.[1] ?? entry.subject;
    if (!isTaskId(id)) continue;
    if (entry.type === "task.created") {
      if (!signed(entry) || board.has(entry.subject)) continue;
      board.set(entry.subject, {
        id: entry.subject,
        title: typeof entry.data?.title === "string" ? entry.data.title : entry.summary,
        status: "open",
        owner: null,
        attempt: 1,
        clauses: [...entry.refs],
        dependsOn: dependencyIds(entry.data?.dependsOn),
        repo: shortName(entry.data?.repo),
        group: shortName(entry.data?.group),
        testApproved: false,
        proofs: [],
        lastProgress: null,
        lastEntry: entry.n,
      });
      continue;
    }
    const task = board.get(id);
    if (!task) continue;
    const holder = entry.actor?.kind === "agent" && entry.actor.id === task.owner;
    switch (entry.type) {
      case "task.claimed":
        // An agent claims a free task; a claim on a held or finished task is ignored.
        if (entry.actor?.kind !== "agent" || task.status === "done" || (task.owner !== null && !holder)) continue;
        task.status = "claimed";
        task.owner = entry.actor.id;
        break;
      case "task.progress":
        if (entry.data?.resumeAll === true) {
          if (!signed(entry)) continue;
          if (task.status === "blocked") task.status = task.owner ? "claimed" : "open";
        } else if (entry.data?.released === true) {
          if (!holder && !signed(entry)) continue;
          // A worker letting go of a finished task frees it but leaves it done.
          if (task.status !== "done") task.status = "open";
          task.owner = null;
        } else if (!agentOrSigned(entry)) {
          continue;
        }
        task.lastProgress = entry.summary;
        break;
      case "task.blocked":
        if (entry.data?.pauseAll === true ? !signed(entry) : !holder && !signed(entry)) continue;
        if (task.status !== "done") task.status = "blocked";
        if (entry.data?.released === true) task.owner = null;
        break;
      case "task.proof":
        if (!holder && !signed(entry)) continue;
        task.proofs.push({ kind: String(entry.data?.kind ?? "link"), link: String(entry.data?.link ?? ""), n: entry.n });
        break;
      case "test.approved":
        if (!isAuthoritative(entry, { personOnly: true })) continue;
        task.testApproved = true;
        break;
      case "task.done":
        if (!signed(entry)) continue;
        task.status = "done";
        break;
      case "task.reopened":
        if (!signed(entry)) continue;
        task.status = "open";
        task.owner = null;
        task.attempt += 1;
        task.proofs = [];
        break;
      default:
        break;
    }
    task.lastEntry = entry.n;
  }
  return board;
}
