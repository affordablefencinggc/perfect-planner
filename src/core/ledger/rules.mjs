// Strict ledger rules (Core Spec §2, §3, §5). validateEntry() is called with the
// current board (replayed state) and a fully formed candidate entry before it is
// written; any refusal throws an Error with code LEDGER_RULE and a .rule slug.
import { parseClauseSubject, parseEntryNumber, parseSeriesId, parseTaskId } from "./ids.mjs";

export const ENTRY_TYPES = Object.freeze([
  "plan.approved", "clause.added", "clause.changed", "clause.withdrawn",
  "task.created", "task.claimed", "task.progress", "task.blocked", "task.proof", "task.done", "task.reopened",
  "question.asked", "question.answered", "decision.made",
  "worktree.created", "commit.observed", "collision.detected", "collision.resolved", "merge.done", "worktree.removed",
  "test.defined", "test.approved", "test.passed", "test.failed", "review.verdict",
  "release.cut", "release.rollback",
  "correction", "budget.warning",
]);
const TYPE_SET = new Set(ENTRY_TYPES);
export const ACTOR_KINDS = Object.freeze(["person", "agent", "jev", "system"]);
const APPEND_KEYS = new Set(["actor", "type", "subject", "summary", "reason", "evidence", "refs", "corrects", "data"]);
// Jev reviews and recommends; it never writes code, merges or changes the plan (§6).
const JEV_TYPES = new Set(["review.verdict", "question.asked"]);

// Which actor kinds may write which entry types (§5, §6). Perfect Planner itself
// (system) runs tests, observes commits and worktrees and records results; an agent
// is never trusted to approve its own test, record its own pass or mark itself done.
// Only a person shapes or approves the plan.
const PERSON = "person";
const AGENT = "agent";
const JEV = "jev";
const SYSTEM = "system";
export const ACTOR_PERMISSIONS = Object.freeze({
  "plan.approved": [PERSON],
  "clause.added": [PERSON],
  "clause.changed": [PERSON],
  "clause.withdrawn": [PERSON],
  "task.created": [PERSON, AGENT, SYSTEM],
  "task.claimed": [PERSON, AGENT, SYSTEM],
  "task.progress": [PERSON, AGENT, SYSTEM],
  "task.blocked": [PERSON, AGENT, SYSTEM],
  "task.proof": [PERSON, AGENT, SYSTEM],
  "task.done": [PERSON, SYSTEM],
  "task.reopened": [PERSON, SYSTEM],
  "question.asked": [PERSON, AGENT, JEV, SYSTEM],
  "question.answered": [PERSON, SYSTEM],
  "decision.made": [PERSON, SYSTEM],
  "worktree.created": [SYSTEM],
  "worktree.removed": [SYSTEM],
  "commit.observed": [SYSTEM],
  "collision.detected": [SYSTEM],
  "collision.resolved": [PERSON, SYSTEM],
  "merge.done": [PERSON, SYSTEM],
  "test.defined": [PERSON, AGENT, SYSTEM],
  "test.approved": [PERSON, SYSTEM],
  "test.passed": [SYSTEM],
  "test.failed": [SYSTEM],
  "review.verdict": [JEV, PERSON],
  "release.cut": [PERSON, SYSTEM],
  "release.rollback": [PERSON, SYSTEM],
  "correction": [PERSON, SYSTEM],
  "budget.warning": [SYSTEM],
});

// Keys never go into the ledger (§6). Patterns for common credential shapes plus a
// generic long, mixed-alphabet, high-entropy token check. Pure hex (hashes, shas)
// is deliberately not treated as a secret.
const SECRET_PATTERNS = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/,
];
const TOKEN_CANDIDATE_RE = /[A-Za-z0-9_+=-]{32,}/g;

function shannonEntropy(text) {
  const counts = new Map();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Returns a short description of the first secret-looking value in text, or null. */
export function findSecret(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  for (const pattern of SECRET_PATTERNS) if (pattern.test(text)) return "a known credential pattern";
  for (const token of text.match(TOKEN_CANDIDATE_RE) ?? []) {
    if (/^[0-9a-fA-F]+$/.test(token)) continue;
    if (!/[A-Z]/.test(token) || !/[a-z]/.test(token) || !/[0-9]/.test(token)) continue;
    if (shannonEntropy(token) >= 4.2) return "a long high-entropy token";
  }
  return null;
}

const TASK_SUBJECT_TYPES = new Set([
  "task.created", "task.claimed", "task.progress", "task.blocked", "task.proof", "task.done", "task.reopened",
  "test.defined", "test.approved", "test.passed", "test.failed", "review.verdict",
  "worktree.created", "worktree.removed", "commit.observed", "merge.done",
]);

const ALLOWED_FROM = {
  "task.claimed": ["created", "reopened", "blocked", "released"],
  "task.progress": ["claimed", "in-progress", "blocked", "proof"],
  "task.blocked": ["created", "claimed", "in-progress", "proof", "reopened", "released"],
  "task.proof": ["claimed", "in-progress", "proof"],
  "task.done": ["claimed", "in-progress", "proof", "blocked"],
  "task.reopened": ["claimed", "in-progress", "blocked", "proof", "done", "released"],
};

export function ledgerError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

const refuse = (rule, message) => { throw ledgerError("LEDGER_RULE", message, { rule }); };

function collectStrings(value, out) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value && typeof value === "object") for (const key of Object.keys(value)) { out.push(key); collectStrings(value[key], out); }
  return out;
}

export function requiresReason(type) {
  return type === "decision.made" || type === "correction" || /\.(blocked|reopened|rejected)$/.test(type);
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;

/** Validates and normalizes the caller's append() input (shape only, no state). */
export function normalizeAppendInput(input) {
  if (!isPlainObject(input)) refuse("input-shape", "append() requires a plain entry object");
  for (const key of Object.keys(input)) {
    if (!APPEND_KEYS.has(key)) refuse("input-unknown-field", `append() does not accept field "${key}" (n, at, prev and hash are assigned by the ledger)`);
  }
  const { actor, type, subject, summary } = input;
  if (!isPlainObject(actor)) refuse("actor-required", "actor must be an object { kind, id, model? }");
  if (!ACTOR_KINDS.includes(actor.kind)) refuse("actor-kind", `actor.kind must be one of ${ACTOR_KINDS.join(", ")}`);
  if (!nonEmpty(actor.id)) refuse("actor-id", "actor.id must be a non-empty string");
  if (actor.model !== undefined && actor.model !== null && !nonEmpty(actor.model)) refuse("actor-model", "actor.model must be a non-empty string when given");
  for (const key of Object.keys(actor)) if (!["kind", "id", "model"].includes(key)) refuse("actor-unknown-field", `actor does not accept field "${key}"`);
  if (!TYPE_SET.has(type)) refuse("type-unknown", `unknown entry type "${type}"`);
  if (!nonEmpty(subject) || /[\r\n]/.test(subject)) refuse("subject-required", "subject must be a non-empty single-line string");
  if (!nonEmpty(summary)) refuse("summary-required", "summary must be a non-empty string");
  if (/[\r\n]/.test(summary)) refuse("summary-one-line", "summary must be one line");
  if (summary.trim().toUpperCase() === "TBD") refuse("summary-tbd", 'summary must not be "TBD"');
  const reason = input.reason ?? null;
  if (reason !== null && typeof reason !== "string") refuse("reason-type", "reason must be a string");
  if (requiresReason(type) && !nonEmpty(reason)) refuse("reason-required", `${type} requires a non-empty reason`);
  if (reason !== null && reason.trim().toUpperCase() === "TBD") refuse("reason-tbd", 'reason must not be "TBD"');
  const evidence = input.evidence ?? [];
  const refs = input.refs ?? [];
  for (const [name, values] of [["evidence", evidence], ["refs", refs]]) {
    if (!Array.isArray(values) || values.some((value) => !nonEmpty(value))) refuse(`${name}-shape`, `${name} must be an array of non-empty strings`);
  }
  const corrects = input.corrects ?? null;
  if (corrects !== null && parseEntryNumber(corrects) === null) refuse("corrects-shape", "corrects must be an L-number such as L-000012 or null");
  if (input.data !== undefined && !isPlainObject(input.data)) refuse("data-shape", "data must be a plain JSON object when given");
  const normalizedActor = { kind: actor.kind, id: actor.id };
  if (nonEmpty(actor.model)) normalizedActor.model = actor.model;
  const normalized = {
    actor: normalizedActor,
    type,
    subject,
    summary,
    reason: reason === null ? null : reason,
    evidence: evidence.slice(),
    refs: refs.slice(),
    corrects,
  };
  if (input.data !== undefined) normalized.data = JSON.parse(JSON.stringify(input.data));
  for (const text of collectStrings(normalized, [])) {
    const found = findSecret(text);
    if (found) refuse("secret-detected", `entry looks like it contains a secret (${found}); keys never go into the ledger`);
  }
  return normalized;
}

function nextSeriesId(board, series) {
  return `${series}-${board.sequence[series] + 1}`;
}

function requireNewId(board, subject, series, type) {
  const expected = nextSeriesId(board, series);
  if (subject !== expected) refuse("number-sequence", `${type} must create ${expected} (numbers are never reused or skipped); got "${subject}"`);
}

const numberOf = (n) => (n ? parseEntryNumber(n) : null);

/** The §5 / §2 done gate. Returns null when the task may be marked done, else the refusal message. */
export function doneBlocker(task) {
  if (!task.test.command) return `${task.id} has no acceptance test defined`;
  if (!task.test.approved || !task.test.approvedEntry) return `${task.id} acceptance test is not approved`;
  const result = numberOf(task.test.lastResultEntry);
  if (task.test.lastResult !== "passed" || result === null) return `${task.id} has no passing run of its approved test`;
  if (result < numberOf(task.test.approvedEntry)) return `${task.id} last pass predates the approval of its current test`;
  const commit = numberOf(task.lastCommitEntry);
  if (commit !== null && result < commit) return `${task.id} test must pass after its last observed commit (${task.lastCommitEntry})`;
  const reopened = numberOf(task.reopenedEntry);
  if (reopened !== null && result < reopened) return `${task.id} test must pass again after it was reopened`;
  const merged = numberOf(task.merged?.entry);
  if (merged === null) return `${task.id} has not been merged; its test must pass after merge`;
  if (result < merged) return `${task.id} test must pass after its merge (${task.merged.entry})`;
  if (task.test.lastRunWhere !== "integration") return `${task.id} passing run after merge must be on the integration branch (data.where = "integration")`;
  return null;
}

function latestPlanId(board) {
  let best = null;
  for (const id of Object.keys(board.plans)) {
    const parsed = parseSeriesId(id);
    if (parsed && (!best || parsed.number > best.number)) best = parsed;
  }
  return best ? best.id : null;
}

const VERDICTS = new Set(["approve", "reject"]);

/** §6: every Jev call records model, provider, cost, confidence and reason; a reject always says why. */
function validateVerdict(entry, task) {
  const data = entry.data ?? {};
  if (data.verdict !== undefined && !VERDICTS.has(data.verdict)) refuse("verdict-shape", 'review.verdict data.verdict must be "approve" or "reject"');
  if (data.verdict === "reject" && !nonEmpty(entry.reason)) refuse("reason-required", "a reject verdict requires a non-empty reason");
  if (entry.actor.kind !== "jev") return;
  if (!VERDICTS.has(data.verdict)) refuse("verdict-shape", 'Jev review.verdict requires data.verdict "approve" or "reject"');
  if (!nonEmpty(entry.reason)) refuse("reason-required", "Jev review.verdict requires a non-empty reason");
  if (!nonEmpty(data.model)) refuse("verdict-model", "Jev review.verdict requires data.model");
  if (!nonEmpty(data.provider)) refuse("verdict-provider", "Jev review.verdict requires data.provider");
  if (typeof data.cost !== "number" || !Number.isFinite(data.cost) || data.cost < 0) refuse("verdict-cost", "Jev review.verdict requires a non-negative numeric data.cost");
  if (typeof data.confidence !== "number" || !(data.confidence >= 0 && data.confidence <= 1)) refuse("verdict-confidence", "Jev review.verdict requires data.confidence between 0 and 1");
  if (task.claimedModel && data.model === task.claimedModel) refuse("verdict-same-model", `Jev must not review with the builder's model (${data.model})`);
}

export function validateEntry(board, entry) {
  const { type, subject, actor } = entry;
  if (actor.kind === "jev" && !JEV_TYPES.has(type)) refuse("jev-scope", `Jev may only write ${[...JEV_TYPES].join(", ")}; refused ${type}`);
  const permitted = ACTOR_PERMISSIONS[type];
  if (permitted && !permitted.includes(actor.kind)) refuse("actor-not-permitted", `${type} may only be written by ${permitted.join(" or ")}; refused for ${actor.kind} ${actor.id}`);

  if (entry.corrects !== null) {
    const target = parseEntryNumber(entry.corrects);
    const current = parseEntryNumber(entry.n);
    if (target >= current) refuse("corrects-future", "corrects must reference an earlier entry");
    if (target > (parseEntryNumber(board.lastEntry) ?? 0)) refuse("corrects-unknown", `corrects references unknown entry ${entry.corrects}`);
  }

  if (TASK_SUBJECT_TYPES.has(type)) {
    const parsed = parseTaskId(subject);
    if (!parsed) refuse("subject-task", `${type} subject must be a task id such as T-3; got "${subject}"`);
    if (type === "task.created") {
      if (parsed.attempt) refuse("subject-task", "task.created subject must not carry an attempt suffix");
      requireNewId(board, subject, "T", type);
      return;
    }
    const task = board.tasks[parsed.id];
    if (!task) refuse("task-unknown", `${parsed.id} does not exist`);
    if (parsed.attempt && parsed.attempt !== task.attempt) refuse("task-attempt", `${subject} is not the current attempt (${task.attemptId})`);
    const allowed = ALLOWED_FROM[type];
    if (allowed && !allowed.includes(task.state)) refuse("task-state", `${type} is not allowed while ${parsed.id} is ${task.state}`);
    switch (type) {
      case "task.claimed":
        if (!task.test.command || !task.test.approved) refuse("task-test-not-approved", `${parsed.id} cannot start until its acceptance test exists and is approved`);
        break;
      case "task.done": {
        const blocker = doneBlocker(task);
        if (blocker) refuse("task-done-gate", blocker);
        break;
      }
      case "test.defined": {
        const command = entry.data?.command ?? entry.summary;
        if (!nonEmpty(command)) refuse("test-command", "test.defined requires a runnable command");
        if (task.state === "done") refuse("task-state", `cannot redefine the test of done task ${parsed.id}; reopen it first`);
        break;
      }
      case "test.approved":
        if (!task.test.command) refuse("test-undefined", `${parsed.id} has no defined test to approve`);
        if (task.test.approved) refuse("test-already-approved", `${parsed.id} test is already approved`);
        break;
      case "test.passed":
      case "test.failed":
        if (!task.test.command) refuse("test-undefined", `${parsed.id} has no defined test`);
        break;
      case "worktree.removed":
        if (!task.worktree) refuse("worktree-missing", `${parsed.id} has no worktree to remove`);
        break;
      case "merge.done":
        if (!task.test.approved) refuse("test-undefined", `${parsed.id} cannot merge without an approved test`);
        break;
      case "review.verdict":
        validateVerdict(entry, task);
        break;
      default:
        break;
    }
    return;
  }

  switch (type) {
    case "plan.approved": {
      const parsed = parseSeriesId(subject);
      if (!parsed || parsed.series !== "P") refuse("subject-plan", `plan.approved subject must be a plan id such as P-2; got "${subject}"`);
      const existing = board.plans[subject];
      if (existing && existing.state === "approved") refuse("plan-already-approved", `${subject} is already approved`);
      if (!existing) requireNewId(board, subject, "P", type);
      return;
    }
    case "clause.added":
    case "clause.changed":
    case "clause.withdrawn": {
      const parsed = parseClauseSubject(subject);
      if (!parsed) refuse("subject-clause", `${type} subject must look like "P-2 §3.1"; got "${subject}"`);
      const plan = board.plans[parsed.plan];
      if (!plan) {
        // A clause entry naming the next plan number starts a new draft version that
        // inherits the previous version's clauses (see replay ensurePlan).
        if (parseSeriesId(parsed.plan).number !== board.sequence.P + 1) refuse(type === "clause.added" ? "number-sequence" : "plan-unknown", `${parsed.plan} does not exist; a new plan version must be ${nextSeriesId(board, "P")}`);
        if (type !== "clause.added") {
          const basedOn = entry.data?.basedOn === null ? null : entry.data?.basedOn ?? latestPlanId(board);
          const inherited = basedOn ? board.plans[basedOn]?.clauses[parsed.clause] : null;
          if (!inherited) refuse("clause-unknown", `${subject} does not exist in ${basedOn ?? "any earlier plan"}`);
          if (inherited.state === "withdrawn") refuse("clause-withdrawn", `${subject} is withdrawn`);
        }
        return;
      }
      if (plan.state === "approved") refuse("plan-approved-immutable", `${parsed.plan} is approved and cannot change; start a new plan version (${nextSeriesId(board, "P")})`);
      const clause = plan.clauses[parsed.clause];
      if (type === "clause.added" && clause) refuse("clause-exists", `${subject} is already published; numbers never move (insert as a sub-clause such as ${parsed.clause}.1)`);
      if (type !== "clause.added" && !clause) refuse("clause-unknown", `${subject} does not exist`);
      if (type !== "clause.added" && clause.state === "withdrawn") refuse("clause-withdrawn", `${subject} is withdrawn`);
      return;
    }
    case "question.asked": {
      const parsed = parseSeriesId(subject);
      if (!parsed || parsed.series !== "Q") refuse("subject-question", `question.asked subject must be a question id such as Q-2; got "${subject}"`);
      requireNewId(board, subject, "Q", type);
      const task = entry.data?.task;
      if (task !== undefined && task !== null && !board.tasks[parseTaskId(task)?.id]) refuse("task-unknown", `question.asked names unknown task ${task}`);
      return;
    }
    case "question.answered": {
      const question = board.questions[subject];
      if (!question) refuse("question-unknown", `${subject} does not exist`);
      if (question.state !== "open") refuse("question-answered", `${subject} is already answered`);
      return;
    }
    case "decision.made": {
      const parsed = parseSeriesId(subject);
      if (!parsed || parsed.series !== "D") refuse("subject-decision", `decision.made subject must be a decision id such as D-3; got "${subject}"`);
      requireNewId(board, subject, "D", type);
      const question = entry.data?.question;
      if (question !== undefined && question !== null && !board.questions[question]) refuse("question-unknown", `decision.made names unknown question ${question}`);
      return;
    }
    case "release.cut": {
      const parsed = parseSeriesId(subject);
      if (!parsed || parsed.series !== "R") refuse("subject-release", `release.cut subject must be a release id such as R-1; got "${subject}"`);
      requireNewId(board, subject, "R", type);
      const plan = entry.data?.plan;
      if (plan !== undefined && plan !== null && board.plans[plan]?.state !== "approved") refuse("plan-unknown", `release.cut names plan ${plan}, which is not approved`);
      return;
    }
    case "release.rollback": {
      const release = board.releases[subject];
      if (!release) refuse("release-unknown", `${subject} does not exist`);
      if (release.state === "rolled-back") refuse("release-rolled-back", `${subject} is already rolled back`);
      return;
    }
    case "collision.resolved": {
      const open = board.collisions.some((collision) => collision.state === "open" && (collision.id === entry.data?.collision || collision.subject === subject));
      if (!open) refuse("collision-unknown", `no open collision matches ${entry.data?.collision ?? subject}`);
      return;
    }
    default:
      return;
  }
}
