import test from "node:test";
import assert from "node:assert/strict";
import { buildBlueprintWorkspaceModel, currentRulebookInput, currentDebtSnapshot, currentViabilityInput } from "../src/engine/blueprintWorkspaceModel.js";

test("the current workspace stops before architecture with four independent gate truths", () => {
  const model = buildBlueprintWorkspaceModel(); assert.equal(model.canEnterPlan, false); assert.equal(model.verdict, "STOP BEFORE ARCHITECTURE"); assert.deepEqual(model.gates.map((gate) => gate.verdict), ["BLOCKED", "BLOCKED", "WITHIN_BUDGET", "BLOCKED"]);
});

test("unanswered rulebook contracts are stable, numbered, and actionable", () => {
  const model = buildBlueprintWorkspaceModel(); assert.equal(model.decisions.length, 22); assert.equal(model.decisions[0].id, "D-01"); assert.equal(model.nextAction, model.decisions[0].title); assert.ok(model.decisions.some((decision) => decision.key === "ai-autopilot:rollbackPolicy"));
});

test("evidence targets expose zero coverage instead of empty-state optimism", () => {
  const model = buildBlueprintWorkspaceModel(); assert.deepEqual(model.evidence.map((item) => [item.count, item.target]), [[0, 6], [0, 2], [0, 1], [0, 1]]);
});

test("exact native analyzer coverage makes the current bounded debt position honest", () => {
  const model = buildBlueprintWorkspaceModel(); const debt = model.gates.find((gate) => gate.id === "G-DEBT"); assert.equal(debt.status, "clear"); assert.equal(debt.metric, "4/4"); assert.deepEqual(model.debt.coverage.missing, []); assert.equal(model.debt.counts.medium, 2); assert.equal(model.debt.weightedOpen, 10); assert.equal(model.debt.verdict, "WITHIN_BUDGET");
});

test("the selected rulebook exposes the deterministic seven-stage top-down path", () => {
  const model = buildBlueprintWorkspaceModel(); assert.equal(model.rulebook.template.id, "ai-autopilot-control-plane"); assert.equal(model.rulebook.executionMap.direction, "top-down"); assert.equal(model.rulebook.executionMap.nodes.length, 7); assert.deepEqual(model.rulebook.scenarioCoverage, { required: 4, present: 0 }); assert.deepEqual(model.rulebook.decisionCoverage, { required: 5, present: 0 });
});

test("the model does not mutate canonical workspace inputs", () => {
  const before = JSON.stringify([currentRulebookInput, currentViabilityInput, currentDebtSnapshot]); buildBlueprintWorkspaceModel(); assert.equal(JSON.stringify([currentRulebookInput, currentViabilityInput, currentDebtSnapshot]), before);
});

test("the strict folder contract exposes reservations but blocks until architecture is exact", () => {
  const model = buildBlueprintWorkspaceModel(); const gate = model.gates.find((item) => item.id === "G-STRUCTURE"); assert.equal(gate.status, "blocked"); assert.equal(model.folderContract.ready, false); assert.match(model.folderContract.blockers.join(" "), /architectureContractDigest.*architectureRevision/); assert.equal(model.folderContract.nodes.length, 9); assert.equal(model.folderContract.reservations.length, 0);
});
