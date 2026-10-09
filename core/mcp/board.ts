// The task board as the agent tools see it: a pure fold over the ledger
// (spec §2.1, the board is a view rebuilt by replaying the ledger).
import type { LedgerEntry } from "../ledger/index";

export type TaskStatus = "open" | "claimed" | "blocked" | "done";

export interface TaskView {
  id: string;
  title: string;
  status: TaskStatus;
  owner: string | null;
  attempt: number;
  clauses: string[];
  testApproved: boolean;
  proofs: { kind: string; link: string; n: string }[];
  lastProgress: string | null;
  lastEntry: string;
}

const TASK_ID = /^T-\d+$/;

export function isTaskId(value: string): boolean {
  return TASK_ID.test(value);
}

/** "T-14" on attempt 2 is shown as "T-14.a2" (spec §3.1). */
export function attemptLabel(task: Pick<TaskView, "id" | "attempt">): string {
  return task.attempt > 1 ? `${task.id}.a${task.attempt}` : task.id;
}

export function foldBoard(entries: readonly LedgerEntry[]): Map<string, TaskView> {
  const board = new Map<string, TaskView>();
  for (const entry of entries) {
    if (!isTaskId(entry.subject)) continue;
    if (entry.type === "task.created") {
      board.set(entry.subject, {
        id: entry.subject,
        title: typeof entry.data?.title === "string" ? entry.data.title : entry.summary,
        status: "open",
        owner: null,
        attempt: 1,
        clauses: [...entry.refs],
        testApproved: false,
        proofs: [],
        lastProgress: null,
        lastEntry: entry.n,
      });
      continue;
    }
    const task = board.get(entry.subject);
    if (!task) continue;
    task.lastEntry = entry.n;
    switch (entry.type) {
      case "task.claimed":
        task.status = "claimed";
        task.owner = entry.actor.id;
        break;
      case "task.progress":
        task.lastProgress = entry.summary;
        if (entry.data?.released === true) {
          task.status = "open";
          task.owner = null;
        } else if (entry.data?.resumeAll === true && task.status === "blocked") {
          task.status = task.owner ? "claimed" : "open";
        }
        break;
      case "task.blocked":
        task.status = "blocked";
        if (entry.data?.released === true) task.owner = null;
        break;
      case "task.proof":
        task.proofs.push({ kind: String(entry.data?.kind ?? "link"), link: String(entry.data?.link ?? ""), n: entry.n });
        break;
      case "test.approved":
        task.testApproved = true;
        break;
      case "task.done":
        task.status = "done";
        break;
      case "task.reopened":
        task.status = "open";
        task.owner = null;
        task.attempt += 1;
        task.proofs = [];
        break;
      default:
        break;
    }
  }
  return board;
}
