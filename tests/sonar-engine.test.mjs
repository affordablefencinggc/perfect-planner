import "./helpers/hermetic-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { assessNameCandidates, assessRepositorySonar, generateUnverifiedNames } from "../src/engine/sonarEngine.js";

const candidate = { id: "repo-a", title: "Planner core", sourceUrl: "https://github.com/example/planner", commitSha: "a".repeat(40), licenseSpdx: "MIT", licenseSource: "LICENSE@sha", updatedAt: "2026-08-01T00:00:00.000Z", archived: false, securityAdvisories: [], sbomAvailable: true, provenanceAttested: true, capabilities: ["ledger", "collision"], maintainers: 3, testEvidence: true, documentationEvidence: true, releaseEvidence: true };

test("repository search cannot start from a vague purpose", () => {
  const result = assessRepositorySonar({ candidates: [candidate] }); assert.equal(result.verdict, "BLOCKED"); assert.match(result.blockers[0], /explicit capabilities/);
});

test("eligible candidates require pinned source, approved licence, SBOM, and provenance", () => {
  const result = assessRepositorySonar({ requiredCapabilities: ["ledger"], candidates: [{ ...candidate, commitSha: "main", licenseSpdx: "UNKNOWN", sbomAvailable: false, provenanceAttested: false }] }, { now: Date.parse("2026-09-02T00:00:00.000Z") });
  assert.equal(result.candidates[0].eligible, false); assert.equal(result.candidates[0].blockers.length, 4);
});

test("unresolved serious advisories and archived repositories are blocked", () => {
  const result = assessRepositorySonar({ requiredCapabilities: ["ledger"], candidates: [{ ...candidate, archived: true, securityAdvisories: [{ severity: "high", status: "open" }] }] }, { now: Date.parse("2026-09-02T00:00:00.000Z") }); assert.equal(result.candidates[0].eligible, false); assert.equal(result.candidates[0].blockers.length, 2);
});

test("ranking recommends shortlist only, never automatic import", () => {
  const result = assessRepositorySonar({ requiredCapabilities: ["ledger", "collision"], candidates: [candidate, { ...candidate, id: "repo-b", capabilities: ["ledger"], maintainers: 1 }] }, { now: Date.parse("2026-09-02T00:00:00.000Z") });
  assert.equal(result.verdict, "SHORTLIST_READY"); assert.equal(result.recommendation.candidateId, "repo-a"); assert.equal(result.recommendation.action, "SHORTLIST_ONLY"); assert.ok(result.candidates.every((item) => item.action === "SHORTLIST_ONLY"));
});

test("generated names are explicitly unverified and deterministic", () => {
  const first = generateUnverifiedNames(["perfect", "planner"]); const second = generateUnverifiedNames(["perfect", "planner"]); assert.deepEqual(first, second); assert.ok(first.every((item) => item.status === "UNVERIFIED"));
});

test("name availability requires sourced, current checks across every surface", () => {
  const result = assessNameCandidates([{ id: "N", name: "planforge", evidence: [{ kind: "domain", source: "registrar", checkedAt: "2026-09-01", available: true }] }], { now: Date.parse("2026-09-02T00:00:00.000Z") }); assert.equal(result[0].status, "UNVERIFIED"); assert.deepEqual(result[0].missing, ["package", "repository", "trademark"]);
});

test("even fully checked names retain time-bound legal caveats", () => {
  const evidence = ["domain", "package", "repository", "trademark"].map((kind) => ({ kind, source: `${kind}-source`, checkedAt: "2026-09-01", available: true })); const result = assessNameCandidates([{ id: "N", name: "planforge", evidence }], { now: Date.parse("2026-09-02T00:00:00.000Z") }); assert.equal(result[0].status, "AVAILABLE_AT_CHECK_TIME"); assert.match(result[0].caveat, /not legal clearance/);
});
