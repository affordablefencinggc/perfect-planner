import test from "node:test";
import assert from "node:assert/strict";
import { runMutationCampaign } from "../src/engine/mutationEngine.js";
import { buildTruthGuaranteeCampaign, TRUTH_GUARANTEES } from "../src/engine/truthGuaranteeMatrix.js";

const propertyName = (guarantee) => guarantee.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
const complete = () => Object.fromEntries(TRUTH_GUARANTEES.map((guarantee) => [propertyName(guarantee), true]));

test("the truth matrix names every current critical invariant exactly once", () => { assert.equal(TRUTH_GUARANTEES.length, 22); assert.equal(new Set(TRUTH_GUARANTEES).size, 22); assert.ok(TRUTH_GUARANTEES.includes("autopilot-device-denial")); assert.ok(TRUTH_GUARANTEES.includes("rulebook-fail-closed")); assert.ok(TRUTH_GUARANTEES.includes("architecture-contract-tamper-refused")); assert.ok(TRUTH_GUARANTEES.includes("architecture-registry-linear-history")); assert.ok(TRUTH_GUARANTEES.includes("screenshot-unproven-without-viewing")); });
test("missing and already-broken guarantee baselines are refused", () => { const missing = complete(); delete missing.journalIntegrity; assert.throws(() => buildTruthGuaranteeCampaign(missing), /missing boolean predicates/); assert.throws(() => buildTruthGuaranteeCampaign({ ...complete(), ciHonesty: false }), /already broken/); });
test("one focused mutation is generated for every required guarantee", () => { const campaign = buildTruthGuaranteeCampaign(complete()); assert.equal(campaign.mutations.length, 22); assert.deepEqual(campaign.mutations.map((item) => item.guarantee), TRUTH_GUARANTEES); assert.equal(new Set(campaign.mutations.map((item) => item.id)).size, 22); });
test("the complete current truth predicate corpus kills every mutation", async () => { const report = await runMutationCampaign(buildTruthGuaranteeCampaign(complete())); assert.equal(report.verdict, "CERTIFIED"); assert.deepEqual(report.totals, { total: 22, killed: 22, survived: 0, errors: 0 }); assert.deepEqual(report.coverage, { required: 22, covered: 22, missing: [] }); });
