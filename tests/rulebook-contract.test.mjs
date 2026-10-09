import "./helpers/hermetic-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { architecturePolicyVersion, freezeArchitectureContract, verifyArchitectureContract } from "../src/engine/rulebookEngine.js";

const scenario = (kind) => ({ kind, trigger: "named threshold", detection: "machine signal", owner: "owner", immediateAction: "stop", recovery: "fallback", verification: "proof rerun" });
const decision = (kind) => ({ kind, choice: `${kind} choice`, rationale: "evidence-backed fit", evidence: "ADR source", alternatives: [{ choice: "other", rejectionReason: "fails a stated constraint" }] });
const complete = {
  templateId: "ai-autopilot-control-plane", templateVersion: 1, platform: "tauri", brief: { autopilot: true, localFirst: true }, useCases: ["ai-autopilot", "desktop-distribution"],
  answers: { collisionPolicy: "fail closed", proofPolicy: "paired proof", rollbackPolicy: "restore checkpoint", capabilityPolicy: "deny by default", humanStopPolicy: "explicit gate", costCeiling: "$5/run", osTargets: ["windows"], updateSigning: "signed", rollbackChannel: "stable previous" },
  capabilities: [{ id: "filesystem-scoped", necessity: "mandatory" }, { id: "native-process", necessity: "mandatory", mitigation: "reviewed bounded sidecar", proof: "capability test" }],
  scenarios: ["security-breach", "data-loss", "critical-dependency-failure", "vendor-exit"].map(scenario),
  dependencies: [{ name: "Tauri", purpose: "desktop shell", license: "MIT/Apache-2.0", pinnedVersion: "2.x exact lock", maintenanceEvidence: "release history", securityEvidence: "advisory review", critical: true, fallback: "PWA reduced mode", switchTrigger: "native proof fails", dependsOn: [] }],
  decisions: ["platform", "data", "identity-auth", "state-sync", "deployment-distribution"].map(decision),
  nonFunctional: { performanceBudget: "startup P80 <2s", securityTarget: "zero critical", accessibilityTarget: "WCAG 2.2 AA", operatingCostCeiling: "$100/month", recoveryTarget: "RPO 0 local ledger", observabilityProof: "hashed run report" },
};
const approval = { planId: "PP-014", actor: "danie", approvedAt: "2026-09-02T00:00:00.000Z" };

test("blocked rulebooks cannot be frozen into a misleading architecture contract", async () => {
  await assert.rejects(() => freezeArchitectureContract({ templateId: "ai-autopilot-control-plane", templateVersion: 1, platform: "tauri" }, approval), /cannot freeze/);
});

test("complete rulebooks freeze deterministically with the exact policy and stage path", async () => {
  const first = await freezeArchitectureContract(complete, approval); const second = await freezeArchitectureContract(structuredClone(complete), approval);
  assert.equal(first.digest, second.digest); assert.equal(first.policyVersion, architecturePolicyVersion); assert.equal(first.executionMap.nodes.length, 7); assert.equal((await verifyArchitectureContract(first)).valid, true); assert.equal(Object.isFrozen(first.input), true);
  assert.equal(first.planningBoundaryVersion, "2026.09.1");
});

test("any approved answer or stage mutation invalidates the frozen contract", async () => {
  const frozen = await freezeArchitectureContract(complete, approval); const changed = structuredClone(frozen); changed.input.answers.costCeiling = "$500/run";
  const verification = await verifyArchitectureContract(changed); assert.equal(verification.valid, false); assert.ok(verification.reasons.some((reason) => reason.includes("changed after approval")));
});

test("policy versions never auto-upgrade underneath an approved plan", async () => {
  const frozen = await freezeArchitectureContract(complete, approval); const oldPolicy = structuredClone(frozen); oldPolicy.policyVersion = "2026.08.9";
  const verification = await verifyArchitectureContract(oldPolicy); assert.equal(verification.valid, false); assert.ok(verification.reasons.some((reason) => reason.includes("explicit migration")));
});
