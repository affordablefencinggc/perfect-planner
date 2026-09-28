import test from "node:test";
import assert from "node:assert/strict";
import { assessCompletion, auditProofPack } from "../src/engine/proofEngine.js";

const goodItem = {
  id: "B07-1", built: true, tested: true, ui: true,
  builtBy: { actor: "agent-a", at: "2026-09-02T08:00:00Z", commit: "abc123" },
  proof: { by: "local-runner", at: "2026-09-02T08:10:00Z", verify: "npm test", artifact: "b07.log", sha256: "hash-1", screenshot: "b07.png", viewedNote: "Shows the collision stop banner", environment: "node/windows", loc: { added: 20, removed: 2 }, tokensEstimate: 4000 },
};
const journal = [{ action: "prove", itemId: "B07-1", artifact: "b07.log", sha256: "hash-1", exit: 0 }];
const artifacts = { "b07.log": { sha256: "hash-1" } };

test("accepts a complete machine-captured UI proof pack", () => {
  assert.deepEqual(auditProofPack(goodItem, journal, artifacts), { ok: true, fatal: [], weak: [], state: "proven" });
});

test("refuses a typed or unjournaled proof even when tested is true", () => {
  const forged = structuredClone(goodItem);
  forged.proof = { by: "model-note", at: "2026-09-02T08:10:00Z", note: "looks good" };
  const result = auditProofPack(forged, [], {});
  assert.equal(result.ok, false);
  assert.ok(result.fatal.some((reason) => reason.includes("provenance")));
});

test("refuses UI proof without a screenshot viewing attestation", () => {
  const unviewed = structuredClone(goodItem);
  delete unviewed.proof.viewedNote;
  assert.ok(auditProofPack(unviewed, journal, artifacts).fatal.some((reason) => reason.includes("viewing attestation")));
});

test("completion fails closed on approval, gates, truth core, merged CI, completeness, and item proof", () => {
  const result = assessCompletion({ approved: false, openGates: 1, ciTier3: "grey", truthCoreValid: false, completenessReview: false, items: [goodItem, { id: "B08-1", built: false, tested: false }] }, journal, artifacts);
  assert.equal(result.ready, false);
  assert.equal(result.reasons.length, 6);
  assert.equal(result.proven, 1);
});
