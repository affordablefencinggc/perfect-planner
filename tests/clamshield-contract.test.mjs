import test from "node:test";
import assert from "node:assert/strict";
import { assessClamShieldReceipt, createClamShieldRequest } from "../src/engine/clamShieldContract.js";

const sha = (character) => character.repeat(64);
const request = () => createClamShieldRequest({
  requestId: "scan-001", workspaceId: "PP-CLEANROOM", canonicalRootDigest: sha("a"), censusDigest: sha("b"),
  requestedChecks: ["inventory", "delta", "malware"],
  limits: { maxFiles: 100_000, maxFileBytes: 64 * 1024 * 1024, maxTotalBytes: 20_000_000_000, timeoutMs: 600_000 },
});
const receipt = (bound) => ({
  schemaVersion: 1, requestId: bound.requestId, workspaceId: bound.workspaceId, canonicalRootDigest: bound.canonicalRootDigest,
  censusDigest: bound.censusDigest, requestDigest: bound.requestDigest, agentId: "clamshield-local-01", indexGeneration: "idx-42",
  engineDigest: sha("c"), policyDigest: sha("d"), completedChecks: ["inventory", "delta", "malware"],
  coverageComplete: true, security: "CLEAN", integrity: "CHANGED", ci: "NOT_RUN",
  counts: { observed: 100, hashed: 4, scanned: 4, cacheHits: 96, threats: 0, secretFindings: 0, codeRisks: 0, skipped: 0, errors: 0 },
});

test("creates an evidence-only bounded ClamShield request", () => {
  const value = request();
  assert.equal(value.authority, "EVIDENCE_ONLY");
  assert.match(value.requestDigest, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(value), true);
});

test("complete clean claims remain blocked without authenticated current evidence", () => {
  const bound = request();
  const result = assessClamShieldReceipt(bound, receipt(bound));
  assert.equal(result.securityGate, "BLOCKED");
  assert.equal(result.reportedSecurity, "CLEAN");
  assert.equal(result.security, "UNAVAILABLE");
  assert.equal(result.integrity, "UNKNOWN");
  assert.equal(result.ci, "NOT_RUN");
  assert.equal(result.authority, "UNTRUSTED_EXTERNAL_EVIDENCE");
  assert.equal(result.canApprove, false);
  assert.equal(result.canExecute, false);
  assert.equal(result.canMarkComplete, false);
});

test("refuses a receipt bound to a different repository census", () => {
  const bound = request();
  assert.throws(() => assessClamShieldReceipt(bound, { ...receipt(bound), censusDigest: sha("e") }), /identity mismatch: censusDigest/);
});

test("blocks skipped or incomplete security coverage", () => {
  const bound = request();
  const result = assessClamShieldReceipt(bound, { ...receipt(bound), coverageComplete: false, security: "INCOMPLETE", counts: { ...receipt(bound).counts, skipped: 2 } });
  assert.equal(result.securityGate, "BLOCKED");
  assert.deepEqual(result.problems, ["coverage incomplete", "2 skipped", "security incomplete", "external receipt authenticity and freshness are not verified"]);
});

test("refuses unknown checks and impossible counters", () => {
  assert.throws(() => createClamShieldRequest({ ...request(), requestedChecks: ["invented"] }), /registered check names/);
  const bound = request();
  assert.throws(() => assessClamShieldReceipt(bound, { ...receipt(bound), counts: { ...receipt(bound).counts, scanned: 101 } }), /exceed observed files/);
});

test("external CI and integrity claims cannot become Planner verdicts", () => {
  const bound = request();
  const result = assessClamShieldReceipt(bound, { ...receipt(bound), ci: "PASS", integrity: "UNCHANGED" });
  assert.equal(result.reportedCi, "PASS");
  assert.equal(result.reportedIntegrity, "UNCHANGED");
  assert.equal(result.ci, "NOT_RUN");
  assert.equal(result.integrity, "UNKNOWN");
  assert.equal(result.securityGate, "BLOCKED");
  assert.equal(Object.isFrozen(result.problems), true);
});
