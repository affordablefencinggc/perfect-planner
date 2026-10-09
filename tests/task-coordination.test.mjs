import "./helpers/hermetic-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { emptyTaskDraftLedger, updateTaskDraft } from "../src/project/taskDraftLedger.js";
import { allocationStatus, assignmentErrors, buildAllocationRecord, buildCollisionRecord, collisionStatus, confirmedAssignments, createResolution, evaluateTaskCollisions, ledgerOwnerProposals, normalizeAssignment, ownerKind, suggestedWaves, taskSnapshot, waveConflicts } from "../src/project/taskCoordination.js";
import { deriveWorkRecordReceipt } from "../src/project/workRecordReceipts.js";

const binding = { projectId: "pp_coord_test", rootIdentity: "a".repeat(64), censusDigest: "b".repeat(64) };
const project = { census: { digest: binding.censusDigest } };
const task = (title, claims = [], dependsOn = []) => ({ id: null, title, description: "", owner: "", acceptance: "", recovery: "", claims: claims.map(([access, path]) => ({ access, path })), dependsOn, archived: false });
function ledgerOf(...tasks) { return tasks.reduce((ledger, item) => updateTaskDraft(ledger, item, "2026-10-01T00:00:00.000Z"), emptyTaskDraftLedger(binding)); }
const sections = (collisions, allocation) => ({ sections: { ...(collisions ? { collisions: { revision: 1, data: collisions } } : {}), ...(allocation ? { allocation: { revision: 1, data: allocation } } : {}) } });

const ledger = ledgerOf(
  task("Login form", [["write", "src/auth/login.js"], ["read", "src/api/client.js"]]),
  task("Session store", [["write", "src/auth"]]),
  task("API client", [["write", "src/api/client.js"]]),
  task("Docs", []),
);

test("evaluates task overlaps per pair and lists tasks without files as not checked", () => {
  const result = evaluateTaskCollisions(ledger);
  assert.deepEqual(result.checkedTaskIds, ["T0001", "T0002", "T0003"]);
  assert.deepEqual(result.uncheckedTaskIds, ["T0004"]);
  assert.equal(result.collisions.length, 2);
  const [hard, ordered] = result.collisions;
  assert.equal(hard.key, "T0001|T0002");
  assert.equal(hard.severity, "hard-stop");
  assert.deepEqual(hard.files.map((file) => file.path), ["src/auth"]);
  assert.equal(ordered.key, "T0001|T0003");
  assert.equal(ordered.severity, "ordered");
  assert.equal(ordered.suggestedFirst, "T0001");
});

test("dependencies decide the suggested order and the default waves", () => {
  const withDeps = ledgerOf(task("A", [["write", "src/x.js"]], []), task("B", [["write", "src/x.js"]]));
  const reordered = updateTaskDraft(withDeps, { ...withDeps.tasks[0], dependsOn: ["T0002"] });
  const record = buildCollisionRecord({ ledger: reordered, censusDigest: binding.censusDigest });
  assert.equal(record.collisions[0].suggestedFirst, "T0002");
  assert.deepEqual(suggestedWaves(reordered, record).waves, { T0001: 2, T0002: 1 });
  const split = { ...record, resolutions: { [record.collisions[0].key]: createResolution(record.collisions[0], "split") } };
  assert.deepEqual(suggestedWaves(ledgerOf(task("A", [["write", "src/x.js"]]), task("B", [["write", "src/x.js"]])), split).waves, { T0001: 1, T0002: 1 });
});

test("decisions survive a re-check only while the overlap is unchanged", () => {
  const first = buildCollisionRecord({ ledger, censusDigest: binding.censusDigest, now: "2026-10-01T00:00:00.000Z" });
  const hard = first.collisions[0];
  const decided = { ...first, resolutions: { [hard.key]: createResolution(hard, "order", "T0002") } };
  assert.equal(collisionStatus(decided).openHardStops, 0);
  const again = buildCollisionRecord({ ledger, censusDigest: binding.censusDigest, previous: decided });
  assert.ok(again.resolutions[hard.key]);
  const changed = updateTaskDraft(ledger, { ...ledger.tasks[0], claims: [{ access: "write", path: "src/auth/login.js" }, { access: "write", path: "src/auth/token.js" }] });
  const after = buildCollisionRecord({ ledger: changed, censusDigest: binding.censusDigest, previous: decided });
  assert.equal(after.resolutions[hard.key], undefined);
  assert.notEqual(taskSnapshot(changed), taskSnapshot(ledger));
  assert.throws(() => createResolution(hard, "order", "T0009"));
});

test("collision receipts stay unanswered when nothing is recorded and never claim clearance early", () => {
  assert.equal(deriveWorkRecordReceipt("COL-EVALUATION", sections(), { project }), null);
  assert.equal(deriveWorkRecordReceipt("ALLOC-CLEARANCE", sections(), { project }), null);
  const record = buildCollisionRecord({ ledger, censusDigest: binding.censusDigest });
  const evaluation = deriveWorkRecordReceipt("COL-EVALUATION", sections(record), { project });
  assert.equal(evaluation.state, "review");
  assert.match(evaluation.detail, /1 task could not be checked/);
  const clearance = deriveWorkRecordReceipt("BUILD-CLEARANCE", sections(record), { project });
  assert.equal(clearance.state, "review");
  assert.match(clearance.detail, /2 of 2 overlaps still need a decision/);
  const stale = deriveWorkRecordReceipt("COL-EVALUATION", sections(record), { project: { census: { digest: "c".repeat(64) } } });
  assert.equal(stale.state, "stale");
});

test("clearance is recorded once every hard stop has a decision and every task was checked", () => {
  const full = ledgerOf(task("A", [["write", "src/x.js"]]), task("B", [["write", "src/x.js"]]));
  const record = buildCollisionRecord({ ledger: full, censusDigest: binding.censusDigest });
  const decided = { ...record, resolutions: { [record.collisions[0].key]: createResolution(record.collisions[0], "order", "T0001") } };
  assert.equal(deriveWorkRecordReceipt("COL-EVALUATION", sections(decided), { project }).state, "recorded");
  assert.equal(deriveWorkRecordReceipt("ALLOC-CLEARANCE", sections(decided), { project }).state, "recorded");
  const none = buildCollisionRecord({ ledger: ledgerOf(task("A")), censusDigest: binding.censusDigest });
  assert.equal(deriveWorkRecordReceipt("ALLOC-CLEARANCE", sections(none), { project }).state, "review");
});

test("owner receipts need an owner and wave for every task in the checked task list", () => {
  const record = buildCollisionRecord({ ledger, censusDigest: binding.censusDigest });
  const partial = buildAllocationRecord({ ledger, censusDigest: binding.censusDigest, collisionData: record, assignments: { T0001: { owner: "Ana", wave: 1 }, T0002: { owner: "agent: builder", wave: "2" } } });
  assert.equal(deriveWorkRecordReceipt("ALLOC-OWNERS", sections(record, partial), { project }).state, "review");
  assert.match(deriveWorkRecordReceipt("ALLOC-OWNERS", sections(record, partial), { project }).detail, /2 of 4 tasks still need an owner/);
  const full = buildAllocationRecord({ ledger, censusDigest: binding.censusDigest, collisionData: record, assignments: Object.fromEntries(ledger.tasks.map((item, index) => [item.id, { owner: `Owner ${index}`, wave: index + 1 }])) });
  const owners = deriveWorkRecordReceipt("BUILD-ALLOCATION", sections(record, full), { project });
  assert.equal(owners.state, "recorded");
  assert.match(owners.detail, /All 4 tasks have an owner, in 4 waves/);
  const other = buildCollisionRecord({ ledger: ledgerOf(task("Other", [["write", "a.js"]])), censusDigest: binding.censusDigest });
  assert.equal(deriveWorkRecordReceipt("ALLOC-OWNERS", sections(other, full), { project }).state, "stale");
  assert.equal(deriveWorkRecordReceipt("ALLOC-OWNERS", sections(), { project }), null);
});

test("one rule: an undecided 'needs an order' pair counts as undecided and keeps clearance in review", () => {
  const record = buildCollisionRecord({ ledger: ledgerOf(task("A", [["write", "src/x.js"]]), task("B", [["read", "src/x.js"]])), censusDigest: binding.censusDigest });
  assert.equal(record.collisions[0].severity, "ordered");
  const status = collisionStatus(record);
  assert.equal(status.openHardStops, 0);
  assert.equal(status.open, 1);
  const clearance = deriveWorkRecordReceipt("BUILD-CLEARANCE", sections(record), { project });
  assert.equal(clearance.state, "review");
  assert.match(clearance.detail, /1 of 1 overlap still needs a decision/);
  const decided = { ...record, resolutions: { [record.collisions[0].key]: createResolution(record.collisions[0], "order", "T0001") } };
  assert.equal(collisionStatus(decided).open, 0);
  assert.equal(deriveWorkRecordReceipt("BUILD-CLEARANCE", sections(decided), { project }).state, "recorded");
});

test("assignment validation refuses bad waves, over-long owners and a bare 'agent:'", () => {
  for (const wave of ["0", "-3", "1.5", "1000", "abc"]) assert.match(assignmentErrors({ owner: "Ana", wave }).wave, /whole number from 1 to 999/, wave);
  assert.deepEqual(assignmentErrors({ owner: "Ana", wave: "3" }), {});
  assert.deepEqual(assignmentErrors({ owner: "", wave: "" }), {}, "empty fields stay 'missing', they are not errors");
  assert.match(assignmentErrors({ owner: "x".repeat(5000) }).owner, /at most 120 characters \(this one is 5000\)/);
  assert.match(assignmentErrors({ owner: "agent:" }).owner, /Name the agent/);
  assert.match(assignmentErrors({ owner: " Agent :  " }).owner, /Name the agent/);
  assert.equal(normalizeAssignment({ owner: "agent:" }).owner, "");
  assert.equal(ownerKind("agent:"), null);
  assert.equal(ownerKind("agent: builder"), "agent");
  assert.equal(allocationStatus({ taskIds: ["T0001"], assignments: { T0001: { owner: "agent:", wave: 1 } } }).missing, 1, "older saved 'agent:' rows are not owners");
});

test("waves that contradict a dependency or a recorded order are reported", () => {
  const base = ledgerOf(task("A", [["write", "src/x.js"]]), task("B", [["write", "src/x.js"]]), task("C", []));
  const withDep = updateTaskDraft(base, { ...base.tasks[2], dependsOn: ["T0001"] });
  const record = buildCollisionRecord({ ledger: withDep, censusDigest: binding.censusDigest });
  const decided = { ...record, resolutions: { [record.collisions[0].key]: createResolution(record.collisions[0], "order", "T0002") } };
  const conflicts = waveConflicts(withDep, decided, { T0001: { wave: "1" }, T0002: { wave: "1" }, T0003: { wave: "1" } });
  assert.deepEqual(conflicts.map((item) => `${item.before}>${item.taskId}`).sort(), ["T0001>T0003", "T0002>T0001"]);
  assert.deepEqual(waveConflicts(withDep, decided, { T0001: { wave: "2" }, T0002: { wave: "1" }, T0003: { wave: "3" } }), []);
  assert.deepEqual(waveConflicts(withDep, decided, { T0001: { wave: "" }, T0002: { wave: "1" } }), [], "a missing wave is not a contradiction");
});

test("Ledger owners are offered as proposals only for tasks without an allocated owner", () => {
  const owned = ledgerOf({ ...task("Login form"), owner: "  Dana  " }, { ...task("Session store"), owner: "Eli" }, task("Docs"), { ...task("Old"), owner: "Fay", archived: true });
  assert.deepEqual(ledgerOwnerProposals(owned), { T0001: "Dana", T0002: "Eli" });
  const allocation = { assignments: { T0002: { owner: "agent: builder", wave: 1 }, T0001: { owner: "", wave: 1 } } };
  // An owner already allocated is kept: no proposal replaces it.
  assert.deepEqual(ledgerOwnerProposals(owned, allocation), { T0001: "Dana" });
});

test("unconfirmed Ledger proposals are never recorded as assignments", () => {
  const form = { T0001: { owner: "Dana", wave: "1", fromLedger: true }, T0002: { owner: "Eli", wave: "2", fromLedger: false }, T0003: { owner: "", wave: "" } };
  assert.deepEqual(confirmedAssignments(form), { T0001: { owner: "", wave: "1" }, T0002: { owner: "Eli", wave: "2" }, T0003: { owner: "", wave: "" } });
});

test("glob claims are compared, not reported as uncomparable, and paths keep their case", () => {
  const globs = ledgerOf(
    task("Core", [["write", "src/Core/**"]]),
    task("Core file", [["write", "src/Core/Engine.js"]]),
    task("Core tests", [["write", "tests/core-*.test.mjs"]]),
    task("UI tests", [["write", "tests/ui-*.test.mjs"]]),
    task("MCP", [["write", "mcp/**"]]),
  );
  const result = evaluateTaskCollisions(globs);
  assert.deepEqual(result.invalid, []);
  assert.deepEqual(result.checkedTaskIds, ["T0001", "T0002", "T0003", "T0004", "T0005"]);
  assert.deepEqual(result.collisions.map((item) => item.key), ["T0001|T0002"]);
  assert.deepEqual(result.collisions[0].files.map((file) => file.path), ["src/Core/**"]);
  assert.deepEqual(result.collisions[0].files[0].paths, ["src/Core/**", "src/Core/Engine.js"]);
  assert.deepEqual(suggestedWaves(globs, buildCollisionRecord({ ledger: globs, censusDigest: binding.censusDigest })).waves, { T0001: 1, T0002: 2, T0003: 1, T0004: 1, T0005: 1 });
});

test("decision signatures ignore letter case so earlier decisions still match", () => {
  const lower = buildCollisionRecord({ ledger: ledgerOf(task("A", [["write", "src/x.js"]]), task("B", [["write", "src/x.js"]])), censusDigest: binding.censusDigest });
  const upper = buildCollisionRecord({ ledger: ledgerOf(task("A", [["write", "src/X.js"]]), task("B", [["write", "SRC/x.js"]])), censusDigest: binding.censusDigest });
  assert.equal(upper.collisions[0].signature, lower.collisions[0].signature);
});
