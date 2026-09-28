import test from "node:test";
import assert from "node:assert/strict";
import { assessViability } from "../src/engine/viabilityEngine.js";

const evidence = ["market", "competition", "build-benchmark", "security", "liability", "redundancy"].map((kind) => ({ kind, source: `https://evidence.invalid/${kind}`, observedAt: "2026-08-01T00:00:00.000Z", confidence: "medium" }));
const complete = {
  brief: { goal: "Stop unsafe agent builds", business: "Local planning control plane", motive: "money", targetAudience: "small software teams", geography: "Australia and global English" }, evidence,
  competitors: [{ name: "A", audience: "teams", price: "$20", strength: "integration", gap: "weak proof", source: "https://a.invalid" }, { name: "B", audience: "developers", price: "$30", strength: "automation", gap: "weak collision", source: "https://b.invalid" }],
  buildBenchmarks: [{ source: "https://benchmark.invalid", developers: 3, calendarDays: 90, cost: 120000 }],
  costs: { build: { low: 50000, high: 90000 }, monthlyFixed: { low: 1000, high: 1800 }, monthlyVariableAtTarget: { low: 500, high: 1500 } },
  revenue: { monthlyAtTarget: { low: 12000, high: 22000 }, pricePerCustomer: { low: 20, high: 40 }, customersAtTarget: { low: 400, high: 600 } },
  risks: ["security", "liability", "redundancy"].map((category) => ({ category, scenario: `${category} event`, mitigation: "fail closed", trigger: "evidence changes", owner: "Danie" })),
  assumptions: [{ statement: "Teams pay for avoided rework", owner: "Danie", validateBy: "2026-10-01", fallback: "internal tool" }],
  team: { developers: 3, hoursPerDay: 6, focusFactor: 0.7 }, work: [{ id: "P1", hours: 126 }, { id: "P2", hours: 126 }], scheduleRiskMultiplier: 1.5, availableCapital: 150000,
};

test("a vague first-stage brief is blocked with concrete omissions", () => {
  const result = assessViability({}); assert.equal(result.ready, false); assert.ok(result.blockers.some((item) => item.includes("goal"))); assert.ok(result.blockers.some((item) => item.includes("Evidence is missing")));
});

test("money-motivated plans require revenue ranges", () => {
  const result = assessViability({ ...complete, revenue: {} }, { now: Date.parse("2026-09-02T00:00:00.000Z") }); assert.ok(result.blockers.some((item) => item.includes("revenue range")));
});

test("competition and historical build comparison cannot be omitted", () => {
  const result = assessViability({ ...complete, competitors: [], buildBenchmarks: [] }, { now: Date.parse("2026-09-02T00:00:00.000Z") }); assert.ok(result.blockers.some((item) => item.includes("two named competitors"))); assert.ok(result.blockers.some((item) => item.includes("historical build")));
});

test("security, liability, redundancy, and assumptions require owners and contingencies", () => {
  const result = assessViability({ ...complete, risks: [], assumptions: [{ statement: "guess" }] }, { now: Date.parse("2026-09-02T00:00:00.000Z") }); assert.ok(result.blockers.some((item) => item.includes("security"))); assert.ok(result.blockers.some((item) => item.includes("assumption")));
});

test("stale evidence is exposed as a warning", () => {
  const result = assessViability(complete, { now: Date.parse("2028-09-02T00:00:00.000Z") }); assert.ok(result.warnings.some((item) => item.includes("stale")));
});

test("economics and team pace are calculated at P50 and P80", () => {
  const result = assessViability(complete, { now: Date.parse("2026-09-02T00:00:00.000Z") });
  assert.equal(result.economics.buildP50, 70000); assert.equal(result.economics.buildP80, 90000); assert.equal(result.delivery.calendarDaysP50, 20); assert.equal(result.delivery.calendarDaysP80, 30); assert.equal(result.economics.monthlyCostP80, 3300);
});

test("a complete evidence-backed case advances only to architecture review", () => {
  const result = assessViability(complete, { now: Date.parse("2026-09-02T00:00:00.000Z") }); assert.equal(result.ready, true); assert.equal(result.verdict, "VIABLE_FOR_ARCHITECTURE_REVIEW"); assert.equal(result.evidence.present, 6);
});
