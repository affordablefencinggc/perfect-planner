import test from "node:test";
import assert from "node:assert/strict";
import { allocateConveyor, applyConveyorTransition, assessConveyorTransition, buildAllocationWorkspaceModel, canonicalWorkUnit } from "../src/engine/conveyorEngine.js";
import { deriveExecutionMap } from "../src/engine/executionEngine.js";

const canonical = canonicalWorkUnit({ planId: "PP-014", taskId: "B07", slug: "collision-engine", owner: "Agent A" }).unit;

test("branch and worktree identities are deterministic and structured", () => {
  assert.equal(canonical.branch, "pp/pp-014/b07-collision-engine"); assert.equal(canonical.worktree, "pp-worktrees/pp-014/b07");
  assert.equal(canonicalWorkUnit({ planId: "bad", taskId: "7", slug: "Bad Slug" }).valid, false);
});

test("workers cannot skip or reverse conveyor stations", () => {
  assert.equal(assessConveyorTransition(canonical, "BUILDING", {}).allowed, false);
  assert.match(assessConveyorTransition({ ...canonical, stage: "BUILDING" }, "CLAIMED", {}).blockers[0], /exactly one station/);
});

test("claims require an active session and collision truth", () => {
  const blocked = assessConveyorTransition(canonical, "CLAIMED", { sessionState: "stale", collisionClear: false }); assert.equal(blocked.allowed, false); assert.equal(blocked.blockers.length, 3);
  assert.equal(assessConveyorTransition(canonical, "CLAIMED", { sessionState: "active", collisionClear: true }).allowed, true);
});

test("building requires the exact branch, worktree, journalled claim, and dependencies", () => {
  const claimed = { ...canonical, stage: "CLAIMED" };
  const result = assessConveyorTransition(claimed, "BUILDING", { branch: canonical.branch, worktree: canonical.worktree, claimLedgered: true, dependenciesComplete: true }); assert.equal(result.allowed, true);
  assert.equal(assessConveyorTransition(claimed, "BUILDING", { branch: "wrong" }).blockers.length, 4);
});

test("UI review requires machine proof, diff, screenshot, and viewing attestation", () => {
  const proof = { ...canonical, stage: "PROOF" };
  assert.equal(assessConveyorTransition(proof, "REVIEW", { machineProofComplete: true, scopedDiffPresent: true, uiWork: true, screenshotPresent: true, screenshotViewed: false }).allowed, false);
  assert.equal(assessConveyorTransition(proof, "REVIEW", { machineProofComplete: true, scopedDiffPresent: true, uiWork: true, screenshotPresent: true, screenshotViewed: true }).allowed, true);
});

test("merge queue and merge remain gated by fresh merged truth and human approval", () => {
  const ci = { ...canonical, stage: "CI" }; assert.equal(assessConveyorTransition(ci, "MERGE_QUEUE", { mergedStateCI: "grey", collisionRescanClear: true, proofFresh: true }).allowed, false);
  const queued = { ...canonical, stage: "MERGE_QUEUE" }; assert.equal(assessConveyorTransition(queued, "MERGED", { targetHeadUnchanged: true, humanApproved: false, journalValid: true, releaseReportWritten: true }).allowed, false);
});

test("successful transitions preserve stage evidence and timestamps", () => {
  const result = applyConveyorTransition(canonical, "CLAIMED", { sessionState: "active", collisionClear: true, evidenceId: "J-42" }, { timestamp: "2026-09-02T00:00:00.000Z" }); assert.equal(result.unit.stage, "CLAIMED"); assert.equal(result.unit.stageEvidence.CLAIMED, "J-42");
});

test("allocation serializes shared owners and lanes while exposing day ranges", () => {
  const result = allocateConveyor([{ taskId: "B01", owner: "A", wave: 1, lane: "L1", estimateHours: 6 }, { taskId: "B02", owner: "A", wave: 1, lane: "L2", estimateHours: 6 }, { taskId: "B03", owner: "B", wave: 1, lane: "L1", estimateHours: 4 }], { developerCapacityHours: { A: 6, B: 4 } });
  const byId = Object.fromEntries(result.allocations.map((item) => [item.taskId, item])); assert.deepEqual([byId.B01.startHour, byId.B01.finishHour], [0,6]); assert.deepEqual([byId.B02.startHour, byId.B02.finishHour], [6,12]); assert.deepEqual([byId.B03.startHour, byId.B03.finishHour], [6,10]); assert.equal(byId.B02.finishDay, 2);
});

test("allocation honors dependency finish time even across owners and lanes", () => {
  const result = allocateConveyor([{ taskId: "B01", owner: "A", wave: 1, lane: "L1", estimateHours: 4, dependsOn: [] }, { taskId: "B02", owner: "B", wave: 2, lane: "L2", estimateHours: 2, dependsOn: ["B01"] }], { developerCapacityHours: { A: 4, B: 4 } });
  assert.equal(result.allocations[1].startHour, 4);
});

test("allocation cannot start a task before a dependency sorted later by lane or task ID", () => {
  const tasks = [{ taskId: "B01", owner: "A", wave: 1, lane: "L1", estimateHours: 2, dependsOn: ["B09"] }, { taskId: "B09", owner: "B", wave: 1, lane: "L9", estimateHours: 4 }];
  const options = { developerCapacityHours: { A: 4, B: 4 } };
  const result = allocateConveyor(tasks, options);
  assert.deepEqual(result.allocations.map((item) => [item.taskId, item.startHour]), [["B09", 0], ["B01", 4]]);
  assert.deepEqual(allocateConveyor([...tasks].reverse(), options), result);
});

test("allocation waits for the entire preceding wave while preserving parallel lanes", () => {
  const tasks = [
    { taskId: "B01", owner: "A", wave: 1, lane: "L1", estimateHours: 1 },
    { taskId: "B02", owner: "B", wave: 1, lane: "L2", estimateHours: 10 },
    { taskId: "B03", owner: "C", wave: 2, lane: "L1", estimateHours: 1, dependsOn: ["B01"] },
    { taskId: "B04", owner: "D", wave: 2, lane: "L2", estimateHours: 2 },
    { taskId: "B05", owner: "E", wave: 4, lane: "L1", estimateHours: 1 },
  ];
  const options = { developerCapacityHours: { A: 8, B: 8, C: 8, D: 8, E: 8 } };
  const result = allocateConveyor(tasks, options);
  assert.deepEqual(result.allocations.map(item => [item.taskId, item.startHour, item.finishHour]), [
    ["B01", 0, 1], ["B02", 0, 10], ["B03", 10, 11], ["B04", 10, 12], ["B05", 12, 13],
  ]);
  assert.deepEqual(allocateConveyor([...tasks].reverse(), options), result);
});

test("allocation refuses invalid waves and dependencies on later waves", () => {
  const base = { taskId: "B01", owner: "A", wave: 1, lane: "L1", estimateHours: 1 };
  const options = { developerCapacityHours: { A: 8 } };
  for (const wave of [undefined, null, 0, -1, 1.5, "1", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => allocateConveyor([{ ...base, wave }], options), /positive safe integer wave/);
  }
  assert.throws(() => allocateConveyor([
    { ...base, dependsOn: ["B02"] }, { ...base, taskId: "B02", wave: 2 },
  ], options), /backwards-wave dependency/);
  assert.throws(() => allocateConveyor([
    { ...base, dependsOn: ["B02"] }, { ...base, taskId: "B02", dependsOn: ["B01"] },
    { ...base, taskId: "B03", wave: 2 },
  ], options), /cycle/);
});

test("allocation refuses missing, duplicate, cyclic and non-finite inputs instead of inventing immediate readiness", () => {
  const base = { taskId: "B01", owner: "A", wave: 1, lane: "L1", estimateHours: 2 };
  const options = { developerCapacityHours: { A: 4 } };
  assert.throws(() => allocateConveyor([{ ...base, dependsOn: ["B99"] }], options), /missing dependencies/);
  assert.throws(() => allocateConveyor([base, base], options), /unique/);
  assert.throws(() => allocateConveyor([{ ...base, dependsOn: ["B02"] }, { ...base, taskId: "B02", dependsOn: ["B01"] }], options), /cycle/);
  assert.throws(() => allocateConveyor([{ ...base, estimateHours: Infinity }], options), /finite/);
  assert.throws(() => allocateConveyor([base], { developerCapacityHours: { A: Infinity } }), /finite/);
});

test("allocation workspace model derives rows, forecasts, dependencies, and reserved identities", () => {
  const manifest = { schemaVersion: 1, planId: "PP-014", tasks: [{ taskId: "B01", title: "Brief contract", estimateMinutes: 120, dependsOn: [], claims: [{ kind: "file", surface: "docs/brief.md", access: "write" }] }, { taskId: "B02", title: "Build shell", estimateMinutes: 180, dependsOn: ["B01"], claims: [{ kind: "file", surface: "src/app.js", access: "write" }] }] };
  const model = buildAllocationWorkspaceModel(manifest, deriveExecutionMap(manifest), { ready: true, unresolved: 0 }, { roster: [{ name: "Agent A", role: "Builder", type: "agent", capacityHours: 6 }, { name: "Danie", role: "Orchestrator", type: "human", capacityHours: 6 }], ownerByTask: { B01: "Danie", B02: "Agent A" } });
  assert.equal(model.ready, true); assert.equal(model.metrics.dependencyCount, 1); assert.deepEqual(model.dependencies.criticalPath, ["B01", "B02"]); assert.equal(model.rows.flatMap((row) => row.assignments).length, 2); assert.match(model.rows.flatMap((row) => row.assignments)[0].branch, /^pp\//); assert.equal(model.gitCreation.available, false);
});

test("collision uncertainty keeps derived allocation visible but blocked", () => {
  const manifest = { schemaVersion: 1, planId: "PP-014", tasks: [{ taskId: "B01", title: "Brief", estimateMinutes: 60, dependsOn: [], claims: [{ kind: "file", surface: "brief.md", access: "write" }] }] };
  const model = buildAllocationWorkspaceModel(manifest, deriveExecutionMap(manifest), { ready: false, unresolved: 2 }, { roster: [{ name: "Agent A", capacityHours: 6 }] });
  assert.equal(model.ready, false); assert.equal(model.rows[0].assignments[0].status, "blocked"); assert.match(model.blockers[0], /2 collision/);
});

test("derived workspace allocation separates shared writers across dependency waves", () => {
  const task = (taskId, estimateMinutes, surface, dependsOn = []) => ({
    taskId, title: taskId, estimateMinutes, dependsOn, claims: [{ kind: "file", surface, access: "write" }],
  });
  const manifest = { schemaVersion: 1, planId: "PP-014", tasks: [
    task("B01", 60, "src/independent.js"),
    task("B02", 600, "src/shared.js"),
    task("B03", 60, "src/shared.js", ["B01"]),
  ] };
  const execution = deriveExecutionMap(manifest);
  assert.equal(execution.valid, true);
  assert.deepEqual(execution.waves.map(wave => wave.lanes.flatMap(lane => lane.tasks.map(task => task.taskId))), [["B01", "B02"], ["B03"]]);
  const model = buildAllocationWorkspaceModel(manifest, execution, { ready: true, unresolved: 0 }, {
    roster: ["A", "B", "C"].map(name => ({ name, capacityHours: 1 })),
    ownerByTask: { B01: "A", B02: "B", B03: "C" },
  });
  assert.equal(model.ready, true);
  const byId = Object.fromEntries(model.rows.flatMap(row => row.assignments).map(item => [item.id, item]));
  assert.equal(byId.B01.start, 1);
  assert.deepEqual([byId.B02.start, byId.B02.span], [1, 10]);
  assert.equal(byId.B03.start, 11);
  assert.equal(model.metrics.p50Days, 11);
});
