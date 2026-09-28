import test from "node:test";
import assert from "node:assert/strict";
import { blueprintRulebookBoundary, evaluateBlueprint, recommendTemplates } from "../src/engine/blueprintEngine.js";

const completeTauri = {
  templateId: "desktop-tauri", platform: "tauri", motive: "hobby", publicUsers: false, autopilot: false,
  answers: { targetUsers: "local developers", osTargets: ["windows"], nativeCapabilities: ["filesystem-scoped"], capabilityPolicy: "deny by default", updateSigning: "signed stable channel", dataClassification: "internal", exitStrategy: "export JSON", threatModel: "local attacker" },
  mustHaves: [{ title: "Plan", acceptance: "a valid manifest opens" }], dependencies: [{ name: "Tauri", purpose: "desktop shell", critical: true, fallback: "PWA reduced mode", license: "Apache-2.0/MIT" }], debtBudget: "zero critical; three medium", contingencyTrigger: "native bundle exceeds P80",
};

test("planning cannot start without selecting a registered template", () => {
  const result = evaluateBlueprint({ brief: { localFirst: true } }); assert.equal(result.ready, false); assert.match(result.blockers[0], /Select one registered/); assert.ok(result.alternatives.length > 0);
});

test("PWA selection blocks impossible unrestricted native capabilities", () => {
  const result = evaluateBlueprint({ templateId: "pwa-offline", platform: "pwa", nativeCapabilities: ["unrestricted-filesystem"], answers: {}, mustHaves: [], dependencies: [] });
  assert.ok(result.blockers.some((blocker) => blocker.includes("PWA"))); assert.ok(result.alternatives.some((item) => item.platform === "tauri"));
});

test("Tauri selection blocks a mandatory unrestricted Node runtime", () => {
  const result = evaluateBlueprint({ ...completeTauri, nodeRuntimeNeed: true }); assert.ok(result.blockers.some((blocker) => blocker.includes("Node runtime")));
});

test("autopilot and public-risk questions are mandatory, not deferred", () => {
  const result = evaluateBlueprint({ ...completeTauri, autopilot: true, publicUsers: true, answers: { ...completeTauri.answers, dataClassification: "restricted" } });
  for (const question of ["collisionPolicy", "proofPolicy", "rollbackPolicy", "humanStopPolicy", "accessibilityTarget", "privacyBasis", "abuseModel"]) assert.ok(result.requiredQuestions.includes(question));
});

test("critical dependencies require fallback and license evidence", () => {
  const result = evaluateBlueprint({ ...completeTauri, dependencies: [{ name: "Vendor SDK", purpose: "payments", critical: true }] });
  assert.ok(result.requiredQuestions.includes("fallback:Vendor SDK")); assert.ok(result.requiredQuestions.includes("license:Vendor SDK"));
});

test("a fully answered compatible blueprint becomes ready for planning", () => {
  const result = evaluateBlueprint(completeTauri); assert.equal(result.ready, true); assert.equal(result.verdict, "READY_FOR_PLANNING"); assert.equal(result.requiredQuestions.length, 0);
});

test("template recommendations explain their ranking deterministically", () => {
  const results = recommendTemplates({ localFirst: true, nativeCapabilities: ["filesystem"] }); assert.equal(results[0].id, "local-collaboration"); assert.ok(results[0].reasons.includes("local-first handoff"));
});

test("blueprint owns intake feasibility and cannot accept an architecture rulebook template", () => {
  const result = evaluateBlueprint({ templateId: "ai-autopilot-control-plane", templateVersion: 1 });
  assert.equal(result.verdict, "BLOCKED");
  assert.equal(result.planningBoundary, blueprintRulebookBoundary);
  assert.equal(blueprintRulebookBoundary.blueprintTerminalVerdict, "READY_FOR_PLANNING");
  assert.equal(blueprintRulebookBoundary.freezeOwner, "rulebookEngine");
});
