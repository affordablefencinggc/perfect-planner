// Test gate (Core Specs §5, §6a): a task cannot start until its acceptance test
// exists, has been shown to FAIL on current code, and is approved; it cannot
// finish until Perfect Planner itself has run that approved test in the
// worktree and again on the integration branch after merge.
//
// Ledger encoding (the ledger has no payload field, so state lives in evidence):
//   test.defined   evidence: ["command:<JSON argv>"]                 refs: cited clauses
//   test.failed /  evidence: ["phase:<fails-first|worktree|integration>", "definition:<L-n>",
//   test.passed              "exit:<n|null>", "signal:<s|none>", "timed-out:<bool>", "duration-ms:<n>",
//                            "output-bytes:<n>", "output-sha256:<hex>", "output-truncated:<bool>",
//                            "error:<code>"?, "fails-first-eligible:<bool>" (fails-first only)]
//   test.approved  evidence: ["definition:<L-n>", "fails-first:<L-n>", "jev-verdict:<id>"?]
//   task.done      evidence: ["test-passed:<L-n>", "approved:<L-n>"]
// Every entry for a task uses that task id (e.g. "T-14") as subject.
import { normalizeCommand, displayCommand } from "./command.mjs";
import { runTestCommand, DEFAULT_TIMEOUT_MS, DEFAULT_TAIL_BYTES } from "./runProcess.mjs";

export { parseCommandString, normalizeCommand, resolveCommand, displayCommand } from "./command.mjs";
export { runTestCommand, killProcessTree, scrubEnvironment, DEFAULT_TAIL_BYTES, DEFAULT_TIMEOUT_MS } from "./runProcess.mjs";

export const TESTGATE_ACTOR = Object.freeze({ kind: "system", id: "perfect-planner/testgate" });
const TASK_ID = /^T-[1-9]\d*(?:\.a[2-9]\d*|\.a[1-9]\d+)?$/;

const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const evidenceValue = (entry, key) => {
  const item = (entry.evidence || []).find((value) => typeof value === "string" && value.startsWith(key + ":"));
  return item === undefined ? undefined : item.slice(key.length + 1);
};

/** Read the approved argv out of a test.defined entry. */
export function commandFromEntry(entry) {
  const raw = evidenceValue(entry, "command");
  if (raw === undefined) return null;
  try { return normalizeCommand(JSON.parse(raw)); } catch { return null; }
}

/** Derive the test-gate state of one task from ledger entries (pure). */
export function testGateState(entries, task) {
  const state = { task, definition: null, command: null, failsFirst: null, approved: null, lastRun: null, lastWorktreeRun: null, lastCommit: null, done: null };
  for (const entry of entries) {
    if (entry.subject !== task) continue;
    const def = state.definition?.n;
    switch (entry.type) {
      case "test.defined":
        state.definition = entry; state.command = commandFromEntry(entry);
        state.failsFirst = null; state.approved = null; state.lastRun = null; state.lastWorktreeRun = null; break;
      case "test.passed": case "test.failed": {
        if (!def || evidenceValue(entry, "definition") !== def) break;
        const phase = evidenceValue(entry, "phase");
        if (phase === "fails-first") state.failsFirst = entry;
        else { state.lastRun = entry; if (phase === "worktree") state.lastWorktreeRun = entry; }
        break;
      }
      case "test.approved":
        if (def && evidenceValue(entry, "definition") === def) state.approved = entry; break;
      case "commit.observed": state.lastCommit = entry; break;
      case "task.done": state.done = entry; break;
      case "task.reopened": state.done = null; state.lastWorktreeRun = null; break;
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
    `output-sha256:${result.outputSha256 || ""}`, `output-truncated:${Boolean(result.truncated)}`,
  ];
  if (result.error) evidence.push(`error:${result.error}`);
  if (result.cleanupComplete === false) evidence.push("cleanup-complete:false");
  return evidence;
}

const passed = (result) => result.exitCode === 0 && !result.timedOut && !result.error;

/**
 * createTestGate({ ledger, runner?, timeoutMs?, maxTailBytes? })
 * runner(argv, { cwd, timeoutMs, maxTailBytes }) -> result as runTestCommand; injectable for tests.
 */
export function createTestGate({ ledger, runner = runTestCommand, timeoutMs: defaultTimeout = DEFAULT_TIMEOUT_MS, maxTailBytes = DEFAULT_TAIL_BYTES } = {}) {
  if (!ledger || typeof ledger.append !== "function" || typeof ledger.entries !== "function") fail("TEST_LEDGER_REQUIRED", "createTestGate needs a ledger");
  if (typeof runner !== "function") fail("TEST_RUNNER_INVALID", "runner must be a function");
  const inFlight = new Set();
  const state = (task) => testGateState(ledger.entries(), task);

  async function exclusive(task, work) {
    if (inFlight.has(task)) fail("TEST_RUN_IN_PROGRESS", `A test run for ${task} is already in progress`);
    inFlight.add(task);
    try { return await work(); } finally { inFlight.delete(task); }
  }

  async function execute(task, phase, cwd, { timeoutMs = defaultTimeout } = {}) {
    const current = state(task);
    const result = await runner(current.command, { cwd, timeoutMs, maxTailBytes });
    const ok = passed(result);
    const evidence = runEvidence(phase, current.definition.n, result);
    if (phase === "fails-first") evidence.push(`fails-first-eligible:${!ok && !result.timedOut && !result.error && Number.isInteger(result.exitCode)}`);
    const outcome = result.timedOut ? `timed out after ${timeoutMs}ms` : result.error ? `could not run (${result.error})` : `exit ${result.exitCode}`;
    const entry = await ledger.append({
      actor: TESTGATE_ACTOR, type: ok ? "test.passed" : "test.failed", subject: task,
      summary: oneLine(`${phase} run of ${task} test ${ok ? "passed" : "failed"}: ${outcome}`),
      evidence, refs: current.definition.refs || [],
    });
    return { passed: ok, entry, result };
  }

  return {
    state,

    /** Define (or redefine) the acceptance test. A redefinition voids earlier approval. */
    async defineTest(task, command, actor, { refs = [], note } = {}) {
      checkTask(task); checkActor(actor);
      const argv = normalizeCommand(command);
      if (state(task).done) fail("TEST_TASK_DONE", `${task} is done; reopen it before redefining its test`);
      return ledger.append({
        actor, type: "test.defined", subject: task,
        summary: oneLine(`Acceptance test for ${task}: ${displayCommand(argv)}${note ? ` (${note})` : ""}`),
        evidence: [`command:${JSON.stringify(argv)}`], refs,
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

    /** Approve the test. Requires a valid failing-first run for the current definition. */
    async approveTest(task, actor, { jevVerdict } = {}) {
      checkTask(task); checkActor(actor);
      if (actor.kind === "agent") fail("TEST_APPROVER_REFUSED", "A building agent cannot approve its own acceptance test");
      const current = state(task);
      if (!current.definition) fail("TEST_NOT_DEFINED", `${task} has no defined test`);
      if (current.approved) fail("TEST_ALREADY_APPROVED", `${task} test is already approved`);
      if (!current.failsFirst) fail("TEST_NOT_CONFIRMED", `${task} test has not been run on current code yet (confirmFailsFirst)`);
      if (current.failsFirst.type === "test.passed") fail("TEST_NOT_FAILING", `${task} test already passes before any work; it proves nothing`);
      if (evidenceValue(current.failsFirst, "fails-first-eligible") !== "true") fail("TEST_FAILS_FIRST_INVALID", `${task} test did not fail cleanly before work (timeout or could not run)`);
      const evidence = [`definition:${current.definition.n}`, `fails-first:${current.failsFirst.n}`];
      if (jevVerdict !== undefined) {
        if (!jevVerdict || typeof jevVerdict !== "object") fail("TEST_JEV_VERDICT_INVALID", "jevVerdict must be an object");
        if (jevVerdict.verdict !== "approve") fail("TEST_JEV_REJECTED", `Jev did not approve the ${task} test${jevVerdict.reason ? `: ${oneLine(jevVerdict.reason)}` : ""}`);
        evidence.push(`jev-verdict:${jevVerdict.entry || jevVerdict.id || "approve"}`);
      }
      return ledger.append({ actor, type: "test.approved", subject: task, summary: oneLine(`Acceptance test for ${task} approved`), evidence, refs: current.definition.refs || [] });
    },

    /** Run the approved command in the task worktree. Perfect Planner runs it; the agent's claim is never trusted. */
    async runInWorktree(task, worktreePath, options = {}) {
      checkTask(task); checkPath(worktreePath, "worktreePath");
      const current = state(task);
      if (!current.approved) fail("TEST_NOT_APPROVED", `${task} has no approved test`);
      return exclusive(task, () => execute(task, "worktree", worktreePath, options));
    },

    /** Rerun on the integration branch after merge; only a pass there leads to task.done. */
    async afterMerge(task, integrationPath, { actor = TESTGATE_ACTOR, ...options } = {}) {
      checkTask(task); checkPath(integrationPath, "integrationPath"); checkActor(actor);
      const current = state(task);
      if (!current.approved) fail("TEST_NOT_APPROVED", `${task} has no approved test`);
      if (current.done) fail("TEST_TASK_DONE", `${task} is already done`);
      if (current.lastWorktreeRun?.type !== "test.passed") fail("TEST_WORKTREE_NOT_PASSED", `${task} approved test has not passed in its worktree yet`);
      return exclusive(task, async () => {
        const run = await execute(task, "integration", integrationPath, options);
        if (!run.passed) return { ...run, done: null };
        // The ledger itself enforces "test.passed after last commit.observed"; a refusal propagates.
        const done = await ledger.append({
          actor, type: "task.done", subject: task,
          summary: oneLine(`${task} done: approved test passed on the integration branch`),
          evidence: [`test-passed:${run.entry.n}`, `approved:${current.approved.n}`], refs: current.definition.refs || [],
        });
        return { ...run, done };
      });
    },
  };
}
