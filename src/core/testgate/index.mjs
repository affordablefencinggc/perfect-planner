// Test gate (Core Specs §5, §6a): a task cannot start until its acceptance test
// exists, has been shown to FAIL on current code, and is approved; it cannot
// finish until Perfect Planner itself has run that approved test in the
// worktree and again on the integration branch after merge.
//
// Ledger encoding. The evidence markers below are what this module reads back; the same
// facts also go in `data`, which is what the strict ledger's replay() and done gate read:
//   test.defined  data { command: "<display>", argv }      (ledger task.test.command)
//   test.passed / test.failed  data { where: phase, definition, exitCode, timedOut }
//                 (the ledger's done gate requires the last pass to have where "integration")
//   review.verdict is read from data { kind, outcome|verdict, confidence } when present
//                 (core/jev's encoding), falling back to the phase:/verdict:/confidence: markers.
//   test.defined   evidence: ["command:<JSON argv>"]                 refs: cited clauses
//   test.failed /  evidence: ["phase:<fails-first|worktree|integration>", "definition:<L-n>",
//   test.passed              "exit:<n|null>", "signal:<s|none>", "timed-out:<bool>", "duration-ms:<n>",
//                            "output-bytes:<n>", "output-sha256:<hex>", "output-truncated:<bool>",
//                            "error:<code>"?, "cleanup-complete:false"?, "fails-first-eligible:<bool>" (fails-first only)]
//                  Only entries written by TESTGATE_ACTOR count; anyone else's run claim is ignored.
//   test.approved  evidence: ["definition:<L-n>", "fails-first:<L-n>", "jev-verdict:<L-n>" | "jev-override:owner",
//                            "jev-confidence:<n>"?, "jev-model:<m>"?]   (an owner override carries a reason)
//   task.done      evidence: ["test-passed:<L-n>", "approved:<L-n>", "worktree-passed:<L-n>",
//                            "merge:<L-n>", "diff-review:<L-n>"]
// Subjects: a task's entries may use its base id ("T-14") or an attempt id
// ("T-14.a2"); both belong to the same task, matching the ledger and core/mcp.
// A correction entry (from a person or system) whose `corrects` names an entry
// removes that entry from the derived state.
import path from "node:path";
import { normalizeCommand, displayCommand, findSecretArgument } from "./command.mjs";
import { runTestCommand, DEFAULT_TIMEOUT_MS, DEFAULT_TAIL_BYTES } from "./runProcess.mjs";

export { parseCommandString, normalizeCommand, resolveCommand, displayCommand, findSecretArgument } from "./command.mjs";
export { runTestCommand, killProcessTree, killWindowsOrphans, scrubEnvironment, DEFAULT_TAIL_BYTES, DEFAULT_TIMEOUT_MS } from "./runProcess.mjs";

export const TESTGATE_ACTOR = Object.freeze({ kind: "system", id: "perfect-planner/testgate" });
export const DEFAULT_MIN_JEV_CONFIDENCE = 0.6;
const TASK_ID = /^T-[1-9]\d*(?:\.a[2-9]\d*|\.a[1-9]\d+)?$/;

/** "T-14.a2" -> "T-14". Same rule as core/mcp's relay and the ledger's parseTaskId. */
export const baseTaskId = (subject) => String(subject ?? "").replace(/\.a\d+$/, "");

const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const evidenceValue = (entry, key) => {
  const item = (entry.evidence || []).find((value) => typeof value === "string" && value.startsWith(key + ":"));
  return item === undefined ? undefined : item.slice(key.length + 1);
};
const entryNumber = (n) => { const match = /^L-(\d+)$/.exec(String(n ?? "")); return match ? Number(match[1]) : null; };
const isGateActor = (actor) => actor?.kind === TESTGATE_ACTOR.kind && actor?.id === TESTGATE_ACTOR.id;
const dataOf = (entry) => (entry?.data && typeof entry.data === "object" && !Array.isArray(entry.data) ? entry.data : {});
// review.verdict fields: core/jev writes data { kind, outcome (five-way), verdict (approve|reject), confidence, model }.
const reviewPhase = (entry) => (typeof dataOf(entry).kind === "string" ? dataOf(entry).kind : evidenceValue(entry, "phase"));
const reviewVerdict = (entry) => {
  const data = dataOf(entry);
  if (typeof data.outcome === "string") return data.outcome;
  return evidenceValue(entry, "verdict") ?? (typeof data.verdict === "string" ? data.verdict : undefined);
};
const reviewConfidence = (entry) => {
  const data = dataOf(entry);
  if (typeof data.confidence === "number") return data.confidence;
  const raw = evidenceValue(entry, "confidence");
  return raw === undefined ? NaN : Number(raw);
};

/** Read the approved argv out of a test.defined entry. */
export function commandFromEntry(entry) {
  const raw = evidenceValue(entry, "command");
  if (raw === undefined) return null;
  try { return normalizeCommand(JSON.parse(raw)); } catch { return null; }
}

/** L-numbers voided by a correction from a person or Perfect Planner itself. */
function correctedNumbers(entries) {
  const voided = new Set();
  for (const entry of entries) {
    if (entry?.type === "correction" && entry.corrects && (entry.actor?.kind === "person" || entry.actor?.kind === "system")) voided.add(entry.corrects);
  }
  return voided;
}

function approvingDiffReview(entry, minConfidence) {
  if (reviewPhase(entry) !== "diff" || reviewVerdict(entry) !== "approve") return false;
  if (entry.actor?.kind === "person") return true;
  if (entry.actor?.kind !== "jev") return false;
  const confidence = reviewConfidence(entry);
  return Number.isFinite(confidence) && confidence >= minConfidence;
}

/** Derive the test-gate state of one task from ledger entries (pure). */
export function testGateState(entries, task, { minJevConfidence = DEFAULT_MIN_JEV_CONFIDENCE } = {}) {
  const base = baseTaskId(task);
  const state = {
    task, definition: null, command: null, failsFirst: null, approved: null, lastRun: null,
    lastWorktreeRun: null, lastCommit: null, diffReview: null, merge: null, worktree: null, done: null,
  };
  const voided = correctedNumbers(entries);
  for (const entry of entries) {
    if (!entry || baseTaskId(entry.subject) !== base || voided.has(entry.n)) continue;
    const def = state.definition?.n;
    switch (entry.type) {
      case "test.defined":
        state.definition = entry; state.command = commandFromEntry(entry);
        state.failsFirst = null; state.approved = null; state.lastRun = null;
        state.lastWorktreeRun = null; state.merge = null; break;
      case "test.passed": case "test.failed": {
        if (!isGateActor(entry.actor)) break; // only Perfect Planner's own runs count
        if (!def || evidenceValue(entry, "definition") !== def) break;
        const phase = evidenceValue(entry, "phase");
        if (phase === "fails-first") state.failsFirst = entry;
        else {
          state.lastRun = entry;
          if (phase === "worktree") { state.lastWorktreeRun = entry; state.merge = null; }
        }
        break;
      }
      case "test.approved":
        if (def && evidenceValue(entry, "definition") === def && (entry.actor?.kind === "person" || entry.actor?.kind === "system")) state.approved = entry;
        break;
      case "commit.observed":
        state.lastCommit = entry;
        // New code before the merge: the worktree pass and the diff review no longer describe it.
        if (!state.merge) { state.lastWorktreeRun = null; state.diffReview = null; }
        break;
      case "review.verdict":
        if (reviewPhase(entry) === "diff" && !state.merge) state.diffReview = approvingDiffReview(entry, minJevConfidence) ? entry : null;
        break;
      case "merge.done":
        if (state.lastWorktreeRun) state.merge = entry;
        break;
      case "worktree.created": state.worktree = entry; break;
      case "worktree.removed": state.worktree = null; break;
      case "task.done": state.done = entry; break;
      case "task.reopened":
        state.done = null; state.lastWorktreeRun = null; state.diffReview = null; state.merge = null; break;
      default: break;
    }
  }
  return state;
}

function checkTask(task) { if (typeof task !== "string" || !TASK_ID.test(task)) fail("TEST_TASK_INVALID", `Invalid task id: ${String(task)}`); }
function checkActor(actor) {
  if (!actor || typeof actor !== "object" || !["person", "agent", "jev", "system"].includes(actor.kind) || typeof actor.id !== "string" || !actor.id) fail("TEST_ACTOR_INVALID", "actor must be { kind: person|agent|jev|system, id }");
}
function checkPath(value, name) { if (typeof value !== "string" || !value) fail("TEST_CWD_INVALID", `${name} must be a path`); }
function oneLine(text, max = 200) { const flat = String(text).replace(/\s+/g, " ").trim(); return flat.length > max ? flat.slice(0, max - 1) + "…" : flat; }

function runEvidence(phase, definition, result) {
  const evidence = [
    `phase:${phase}`, `definition:${definition}`,
    `exit:${result.exitCode === null || result.exitCode === undefined ? "null" : result.exitCode}`,
    `signal:${result.signal || "none"}`, `timed-out:${Boolean(result.timedOut)}`,
    `duration-ms:${Math.round(result.durationMs || 0)}`, `output-bytes:${result.outputBytes || 0}`,
    `output-sha256:${result.outputSha256 || "none"}`, `output-truncated:${Boolean(result.truncated)}`,
  ];
  if (result.error) evidence.push(`error:${result.error}`);
  if (result.cleanupComplete === false) evidence.push("cleanup-complete:false");
  return evidence;
}

// A run left processes behind (cleanupComplete false) does not count: leftover
// servers or watchers mean the test did not finish cleanly.
const passed = (result) => result.exitCode === 0 && !result.timedOut && !result.error && result.cleanupComplete !== false;

const samePath = (a, b) => {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

/**
 * createTestGate({ ledger, runner?, timeoutMs?, maxTailBytes?, repoRoot?, minJevConfidence? })
 * runner(argv, { cwd, timeoutMs, maxTailBytes }) -> result as runTestCommand; injectable for tests.
 * repoRoot resolves the relative `path:` that worktree.created records.
 */
export function createTestGate({ ledger, runner = runTestCommand, timeoutMs: defaultTimeout = DEFAULT_TIMEOUT_MS, maxTailBytes = DEFAULT_TAIL_BYTES, repoRoot, minJevConfidence = DEFAULT_MIN_JEV_CONFIDENCE } = {}) {
  if (!ledger || typeof ledger.append !== "function" || typeof ledger.entries !== "function") fail("TEST_LEDGER_REQUIRED", "createTestGate needs a ledger");
  if (typeof runner !== "function") fail("TEST_RUNNER_INVALID", "runner must be a function");
  if (!(Number.isFinite(minJevConfidence) && minJevConfidence >= 0 && minJevConfidence <= 1)) fail("TEST_CONFIG_INVALID", "minJevConfidence must be between 0 and 1");
  const inFlight = new Set();
  const state = (task) => testGateState(ledger.entries(), task, { minJevConfidence });

  async function exclusive(task, work) {
    const key = baseTaskId(task);
    if (inFlight.has(key)) fail("TEST_RUN_IN_PROGRESS", `A test run for ${key} is already in progress`);
    inFlight.add(key);
    try { return await work(); } finally { inFlight.delete(key); }
  }

  async function execute(task, phase, cwd, { timeoutMs = defaultTimeout } = {}) {
    const current = state(task);
    const result = await runner(current.command, { cwd, timeoutMs, maxTailBytes });
    const ok = passed(result);
    const evidence = runEvidence(phase, current.definition.n, result);
    if (phase === "fails-first") evidence.push(`fails-first-eligible:${!ok && !result.timedOut && !result.error && result.cleanupComplete !== false && Number.isInteger(result.exitCode)}`);
    const outcome = result.timedOut ? `timed out after ${timeoutMs}ms` : result.error ? `could not run (${result.error})` : result.cleanupComplete === false ? `exit ${result.exitCode}, left processes running` : `exit ${result.exitCode}`;
    const entry = await ledger.append({
      actor: TESTGATE_ACTOR, type: ok ? "test.passed" : "test.failed", subject: task,
      summary: oneLine(`${phase} run of ${task} test ${ok ? "passed" : "failed"}: ${outcome}`),
      evidence, refs: current.definition.refs || [],
      data: { where: phase, definition: current.definition.n, exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null, timedOut: Boolean(result.timedOut) },
    });
    return { passed: ok, entry, result };
  }

  /** Validate a Jev test review cited by L-number; returns the approval evidence. */
  function jevEvidence(task, current, jevVerdict) {
    const n = typeof jevVerdict === "string" ? jevVerdict : jevVerdict && typeof jevVerdict === "object" ? jevVerdict.entry : undefined;
    if (typeof n !== "string" || entryNumber(n) === null) fail("TEST_JEV_VERDICT_INVALID", "jevVerdict must cite the L-number of a Jev review.verdict entry ({ entry: \"L-n\" })");
    const entries = ledger.entries();
    const voided = correctedNumbers(entries);
    const review = entries.find((entry) => entry.n === n);
    if (!review || voided.has(n) || review.type !== "review.verdict" || review.actor?.kind !== "jev" || baseTaskId(review.subject) !== baseTaskId(task) || reviewPhase(review) !== "test") {
      fail("TEST_JEV_VERDICT_INVALID", `${n} is not a Jev test review of ${baseTaskId(task)}`);
    }
    if (entryNumber(n) <= entryNumber(current.definition.n)) fail("TEST_JEV_VERDICT_STALE", `${n} reviewed an earlier definition of the ${task} test`);
    const verdict = reviewVerdict(review);
    if (verdict !== "approve") fail("TEST_JEV_REJECTED", `Jev did not approve the ${task} test (${verdict ?? "no verdict"})${review.reason ? `: ${oneLine(review.reason)}` : ""}`);
    const confidence = reviewConfidence(review);
    if (!Number.isFinite(confidence) || confidence < minJevConfidence) fail("TEST_JEV_LOW_CONFIDENCE", `Jev's approval of the ${task} test has confidence ${Number.isFinite(confidence) ? confidence : "none"} (below ${minJevConfidence}); the owner must decide`);
    const model = (typeof dataOf(review).model === "string" ? dataOf(review).model : undefined) ?? evidenceValue(review, "model") ?? review.actor?.model;
    return [`jev-verdict:${n}`, `jev-confidence:${confidence}`, ...(model && model !== "none" ? [`jev-model:${model}`] : [])];
  }

  function worktreeCheck(task, current, worktreePath) {
    const created = current.worktree;
    if (!created) fail("TEST_WORKTREE_UNKNOWN", `${task} has no worktree.created entry; tests only run in the task's own worktree`);
    const recorded = evidenceValue(created, "path");
    if (!recorded) fail("TEST_WORKTREE_UNKNOWN", `${task} worktree.created (${created.n}) does not record a path`);
    let expected = recorded;
    if (!path.isAbsolute(recorded)) {
      if (typeof repoRoot !== "string" || !path.isAbsolute(repoRoot)) fail("TEST_REPO_ROOT_REQUIRED", "createTestGate needs an absolute repoRoot to resolve the recorded worktree path");
      expected = path.resolve(repoRoot, recorded);
    }
    if (!samePath(expected, worktreePath)) fail("TEST_WORKTREE_MISMATCH", `${worktreePath} is not ${task}'s worktree (${expected})`);
  }

  return {
    state,

    /** Define (or redefine) the acceptance test. A redefinition voids earlier approval. */
    async defineTest(task, command, actor, { refs = [], note } = {}) {
      checkTask(task); checkActor(actor);
      const argv = normalizeCommand(command);
      const secret = findSecretArgument(argv);
      if (secret !== null) fail("TEST_COMMAND_SECRET", `Test command argument ${secret + 1} looks like a credential; it would be stored in the ledger forever. Pass secrets through the environment of the test instead.`);
      if (note !== undefined && findSecretArgument([String(note)]) !== null) fail("TEST_COMMAND_SECRET", "The note looks like it contains a credential");
      if (state(task).done) fail("TEST_TASK_DONE", `${task} is done; reopen it before redefining its test`);
      return ledger.append({
        actor, type: "test.defined", subject: task,
        summary: oneLine(`Acceptance test for ${task}: ${displayCommand(argv)}${note ? ` (${note})` : ""}`),
        evidence: [`command:${JSON.stringify(argv)}`], refs,
        data: { command: displayCommand(argv), argv },
      });
    },

    /** Run the defined test on current (pre-work) code; it must FAIL to be approvable. */
    async confirmFailsFirst(task, cwd, options = {}) {
      checkTask(task); checkPath(cwd, "cwd");
      const current = state(task);
      if (!current.definition || !current.command) fail("TEST_NOT_DEFINED", `${task} has no defined test`);
      if (current.approved) fail("TEST_ALREADY_APPROVED", `${task} test is already approved`);
      return exclusive(task, async () => {
        const run = await execute(task, "fails-first", cwd, options);
        const eligible = evidenceValue(run.entry, "fails-first-eligible") === "true";
        return { ...run, failedFirst: eligible };
      });
    },

    /**
     * Approve the test. Requires a valid failing-first run for the current definition and either
     * jevVerdict: { entry: "L-n" } citing an approving, confident Jev test review written after the
     * definition, or (owner only) override: { reason } recording why Jev's review is set aside.
     */
    async approveTest(task, actor, { jevVerdict, override } = {}) {
      checkTask(task); checkActor(actor);
      if (actor.kind !== "person" && actor.kind !== "system") fail("TEST_APPROVER_REFUSED", `A ${actor.kind} cannot approve an acceptance test; Jev only reviews, agents never approve their own test`);
      const current = state(task);
      if (!current.definition) fail("TEST_NOT_DEFINED", `${task} has no defined test`);
      if (current.approved) fail("TEST_ALREADY_APPROVED", `${task} test is already approved`);
      if (!current.failsFirst) fail("TEST_NOT_CONFIRMED", `${task} test has not been run on current code yet (confirmFailsFirst)`);
      if (current.failsFirst.type === "test.passed") fail("TEST_NOT_FAILING", `${task} test already passes before any work; it proves nothing`);
      if (evidenceValue(current.failsFirst, "fails-first-eligible") !== "true") fail("TEST_FAILS_FIRST_INVALID", `${task} test did not fail cleanly before work (timeout or could not run)`);
      const evidence = [`definition:${current.definition.n}`, `fails-first:${current.failsFirst.n}`];
      let reason;
      if (override !== undefined) {
        if (jevVerdict !== undefined) fail("TEST_JEV_VERDICT_INVALID", "Pass either jevVerdict or override, not both");
        if (actor.kind !== "person") fail("TEST_OVERRIDE_REFUSED", "Only the owner (a person) can approve a test without Jev's approval");
        if (!override || typeof override.reason !== "string" || !override.reason.trim() || override.reason.trim().toUpperCase() === "TBD") fail("TEST_OVERRIDE_REASON_REQUIRED", "An owner override needs a reason");
        evidence.push("jev-override:owner");
        reason = override.reason.trim();
      } else if (jevVerdict === undefined) {
        fail("TEST_JEV_VERDICT_REQUIRED", `${task} test needs Jev's approving review (jevVerdict: { entry }) or an owner override with a reason`);
      } else {
        evidence.push(...jevEvidence(task, current, jevVerdict));
      }
      return ledger.append({ actor, type: "test.approved", subject: task, summary: oneLine(`Acceptance test for ${task} approved${reason ? " by owner override" : ""}`), ...(reason ? { reason } : {}), evidence, refs: current.definition.refs || [], data: { definition: current.definition.n, failsFirst: current.failsFirst.n, jevVerdict: override !== undefined ? null : evidence.find((e) => e.startsWith("jev-verdict:")).slice("jev-verdict:".length), override: override !== undefined } });
    },

    /** Run the approved command in the task worktree. Perfect Planner runs it; the agent's claim is never trusted. */
    async runInWorktree(task, worktreePath, options = {}) {
      checkTask(task); checkPath(worktreePath, "worktreePath");
      const current = state(task);
      if (!current.approved) fail("TEST_NOT_APPROVED", `${task} has no approved test`);
      worktreeCheck(task, current, worktreePath);
      return exclusive(task, () => execute(task, "worktree", worktreePath, options));
    },

    /** Rerun on the integration branch after merge; only a pass there leads to task.done. */
    async afterMerge(task, integrationPath, { actor = TESTGATE_ACTOR, ...options } = {}) {
      checkTask(task); checkPath(integrationPath, "integrationPath"); checkActor(actor);
      const current = state(task);
      if (!current.approved) fail("TEST_NOT_APPROVED", `${task} has no approved test`);
      if (current.done) fail("TEST_TASK_DONE", `${task} is already done`);
      if (current.lastWorktreeRun?.type !== "test.passed") fail("TEST_WORKTREE_NOT_PASSED", `${task} approved test has not passed in its worktree on its latest commit`);
      if (!current.diffReview) fail("TEST_DIFF_NOT_REVIEWED", `${task} has no approving diff review of its latest commit`);
      if (!current.merge) fail("TEST_NOT_MERGED", `${task} has no merge.done after its passing worktree run`);
      return exclusive(task, async () => {
        const run = await execute(task, "integration", integrationPath, options);
        if (!run.passed) return { ...run, done: null };
        // The ledger itself enforces "test.passed after last commit.observed"; a refusal propagates.
        const done = await ledger.append({
          actor, type: "task.done", subject: task,
          summary: oneLine(`${task} done: approved test passed on the integration branch`),
          evidence: [`test-passed:${run.entry.n}`, `approved:${current.approved.n}`, `worktree-passed:${current.lastWorktreeRun.n}`, `merge:${current.merge.n}`, `diff-review:${current.diffReview.n}`],
          refs: current.definition.refs || [],
        });
        return { ...run, done };
      });
    },
  };
}
