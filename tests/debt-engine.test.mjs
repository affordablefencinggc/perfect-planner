import "./helpers/hermetic-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { assessTechnicalDebt } from "../src/engine/debtEngine.js";

const options = { requiredSurfaces: ["ui", "engine", "storage"] };
const base = { scanId: "DEBT-1", capturedAt: "2026-09-02T00:00:00.000Z", coveredSurfaces: ["ui", "engine", "storage"], budget: { critical: 0, high: 1, medium: 3, low: 10 }, maxAgeDays: { critical: 0, high: 30, medium: 90, low: 180 }, findings: [{ id: "D1", severity: "medium", surface: "ui", category: "maintainability", introducedAt: "2026-08-20T00:00:00.000Z", status: "open", owner: "Mira", evidence: "src/App.jsx:1" }] };

test("missing scan coverage is UNKNOWN, never zero debt", () => {
  const result = assessTechnicalDebt({ scanId: "D", capturedAt: base.capturedAt, coveredSurfaces: [], findings: [] }, {}, options); assert.equal(result.verdict, "UNKNOWN"); assert.equal(result.coverage.missing.length, 3);
});

test("critical debt and exceeded budgets block release", () => {
  const result = assessTechnicalDebt({ ...base, findings: [{ ...base.findings[0], id: "C", severity: "critical" }] }, {}, options); assert.equal(result.verdict, "BLOCKED"); assert.ok(result.blockers.some((item) => item.includes("Critical")));
});

test("open debt requires ownership and evidence", () => {
  const result = assessTechnicalDebt({ ...base, findings: [{ ...base.findings[0], owner: null, evidence: null }] }, {}, options); assert.ok(result.blockers.some((item) => item.includes("no owner"))); assert.ok(result.blockers.some((item) => item.includes("no evidence")));
});

test("aged findings breach severity-specific ratchets", () => {
  const result = assessTechnicalDebt({ ...base, findings: [{ ...base.findings[0], severity: "high", introducedAt: "2026-01-01T00:00:00.000Z" }] }, {}, options); assert.ok(result.blockers.some((item) => item.includes("30-day")));
});

test("findings cannot disappear without resolution evidence", () => {
  const result = assessTechnicalDebt({ ...base, findings: [] }, { findings: base.findings }, options); assert.ok(result.delta.removedWithoutResolution.includes("D1")); assert.equal(result.verdict, "BLOCKED");
});

test("new, resolved, and regressed debt is reported as a stable delta", () => {
  const previous = { findings: [{ ...base.findings[0], severity: "low" }, { ...base.findings[0], id: "D2", status: "open" }] };
  const current = { ...base, findings: [{ ...base.findings[0], severity: "medium" }, { ...base.findings[0], id: "D2", status: "resolved" }, { ...base.findings[0], id: "D3" }] };
  const result = assessTechnicalDebt(current, previous, options); assert.deepEqual(result.delta.added, ["D3"]); assert.deepEqual(result.delta.resolved, ["D2"]); assert.deepEqual(result.delta.regressed, ["D1"]);
});

test("complete covered debt within budget can advance", () => {
  const result = assessTechnicalDebt(base, {}, options); assert.equal(result.ready, true); assert.equal(result.verdict, "WITHIN_BUDGET"); assert.equal(result.weightedOpen, 5);
});
