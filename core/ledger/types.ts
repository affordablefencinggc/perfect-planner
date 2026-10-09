export const ENTRY_TYPES = [
  // Plan
  "plan.approved",
  "clause.added",
  "clause.changed",
  "clause.withdrawn",
  // Task
  "task.created",
  "task.claimed",
  "task.progress",
  "task.blocked",
  "task.proof",
  "task.done",
  "task.reopened",
  // Relay
  "question.asked",
  "question.answered",
  "decision.made",
  // Git (from the watcher)
  "worktree.created",
  "commit.observed",
  "collision.detected",
  "collision.resolved",
  "merge.done",
  "worktree.removed",
  // Proof
  "test.defined",
  "test.approved",
  "test.passed",
  "test.failed",
  "review.verdict",
  // Release
  "release.cut",
  "release.rollback",
  // Housekeeping
  "correction",
  "budget.warning",
  "chain.acknowledged",
] as const;

export type EntryType = (typeof ENTRY_TYPES)[number];

export const REASON_REQUIRED_TYPES: ReadonlySet<EntryType> = new Set<EntryType>([
  "decision.made",
  "correction",
  "release.rollback",
  "clause.changed",
  "clause.withdrawn",
  "chain.acknowledged",
  "task.reopened",
]);

export const ACTOR_KINDS = ["person", "agent", "jev", "system"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export interface Actor {
  kind: ActorKind;
  id: string;
  model?: string;
}

/** What a caller supplies; the ledger fills in n, at, prev and hash. */
export interface EntryDraft {
  actor: Actor;
  type: EntryType;
  subject: string;
  summary: string;
  reason?: string;
  evidence?: string[];
  refs?: string[];
  corrects?: string;
  data?: Record<string, unknown>;
}

export interface LedgerEntry {
  n: string;
  at: string;
  actor: Actor;
  type: EntryType;
  subject: string;
  summary: string;
  reason?: string;
  evidence: string[];
  refs: string[];
  corrects?: string;
  data?: Record<string, unknown>;
  prev: string;
  hash: string;
}

export type ChainProblem = "hash" | "prev" | "number" | "parse" | "truncated";

export type ChainResult =
  | { ok: true }
  | { ok: false; firstBad: string; problem: ChainProblem; detail: string };

export interface LedgerStatus {
  ok: boolean;
  writable: boolean;
  entries: number;
  head?: string;
  brokenAt?: string;
  problem?: ChainProblem;
  detail?: string;
  acknowledged: string[];
}

export type LedgerErrorCode =
  | "EMPTY_FIELD"
  | "REASON_REQUIRED"
  | "UNKNOWN_TYPE"
  | "BAD_ACTOR"
  | "BAD_CORRECTS"
  | "DONE_WITHOUT_PASS"
  | "CHAIN_BROKEN"
  | "READ_ONLY"
  | "NOT_PERMITTED"
  | "RULE";

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}

/**
 * Which entry types each kind of actor may write. A person may write
 * anything (core/people narrows that per role); the system actors (the gate
 * and the git watcher) write test results, merges and done. Agents only
 * claim, report, ask and attach proof; the main chat's relay answers are
 * agent writes too (spec §4.1). Jev only records verdicts. Everything else,
 * approvals, test results, done, releases, is refused to agents and Jev.
 */
export type PermissionTable = Readonly<Record<ActorKind, "any" | readonly EntryType[]>>;

export const DEFAULT_PERMISSIONS: PermissionTable = {
  person: "any",
  system: "any",
  agent: [
    "task.claimed",
    "task.progress",
    "task.blocked",
    "task.proof",
    "test.defined",
    "question.asked",
    "question.answered",
    "decision.made",
  ],
  jev: ["review.verdict", "question.asked"],
};

export const GENESIS_PREV = "0".repeat(64);
