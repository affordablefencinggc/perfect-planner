import "./helpers/hermetic-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { runMutationCampaign } from "../src/engine/mutationEngine.js";

const mutation = (id, guarantee, apply, probe) => ({ id, guarantee, apply, probe });

test("empty mutation campaigns are blocked, never vacuously certified", async () => {
  const report = await runMutationCampaign({ baseline: {}, mutations: [], requiredGuarantees: ["proof"] }); assert.equal(report.verdict, "BLOCKED"); assert.equal(report.coverage.missing[0], "proof");
});

test("a focused probe kills a mutation only when it detects the broken promise", async () => {
  const report = await runMutationCampaign({ baseline: { journalValid: true }, mutations: [mutation("M1", "journal", (state) => { state.journalValid = false; }, (state) => state.journalValid === true)], requiredGuarantees: ["journal"] }); assert.equal(report.results[0].state, "KILLED"); assert.equal(report.verdict, "CERTIFIED");
});

test("a green probe after mutation is a survivor and blocks certification", async () => {
  const report = await runMutationCampaign({ baseline: { proof: true }, mutations: [mutation("M1", "proof", (state) => { state.proof = false; }, () => true)], requiredGuarantees: ["proof"] }); assert.equal(report.results[0].state, "SURVIVED"); assert.equal(report.verdict, "BLOCKED");
});

test("probe crashes are errors, not dishonest kills", async () => {
  const report = await runMutationCampaign({ baseline: {}, mutations: [mutation("M1", "proof", () => {}, () => { throw new Error("crash"); })], requiredGuarantees: ["proof"] }); assert.equal(report.results[0].state, "ERROR"); assert.equal(report.totals.killed, 0);
});

test("required guarantee coverage cannot be omitted", async () => {
  const report = await runMutationCampaign({ baseline: { a: true }, mutations: [mutation("M1", "a", (state) => { state.a = false; }, (state) => state.a)], requiredGuarantees: ["a", "b"] }); assert.deepEqual(report.coverage.missing, ["b"]); assert.equal(report.verdict, "BLOCKED");
});

test("duplicate or malformed mutations are refused", async () => {
  await assert.rejects(() => runMutationCampaign({ baseline: {}, mutations: [mutation("M", "a", () => {}, () => false), mutation("M", "b", () => {}, () => false)] }), /unique id/);
});

test("mutations operate on isolated clones and preserve the baseline", async () => {
  const baseline = { nested: { value: 1 } }; await runMutationCampaign({ baseline, mutations: [mutation("M", "isolation", (state) => { state.nested.value = 2; }, (state) => state.nested.value === 1)], requiredGuarantees: ["isolation"] }); assert.deepEqual(baseline, { nested: { value: 1 } });
});
