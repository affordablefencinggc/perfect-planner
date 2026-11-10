import test from "node:test";
import assert from "node:assert/strict";
import { deriveLiveWorkerState, liveWorkerFor, providerOf } from "../src/core-screens/liveWorkerSpine.js";
const now = Date.parse("2026-11-04T01:00:00.000Z"), fresh = new Date(now - 30_000).toISOString(), old = new Date(now - 700_000).toISOString();
const worker = (extra = {}) => ({ id: "codex-d23a34ad", task: "T-1.a2", role: "worker", model: "gpt-5.6-terra", lastSeen: fresh, ...extra });
const task = (extra = {}) => ({ id: "T-1", label: "T-1.a2", owner: "codex-d23a34ad", workerActivity: { worker: "codex-d23a34ad", activity: "working", at: fresh }, stage: "building", status: "claimed", lastProgress: { text: "Editing task", at: fresh }, proofs: [], ...extra });
test("uses actual Codex identity before a conflicting historical model label", () => { assert.equal(providerOf(worker({ model: "claude-sonnet-4-5" })), "codex"); assert.equal(providerOf(worker({ id: "mystery", model: "" })), "unknown"); });
test("derives working only from fresh reported task activity", () => { assert.equal(deriveLiveWorkerState(task(), worker(), now).state, "working"); assert.equal(deriveLiveWorkerState(task({ lastProgress: null }), worker(), now).state, "waiting"); assert.equal(deriveLiveWorkerState(task({ lastProgress: { text: "old", at: old } }), worker(), now).state, "stale"); });
test("distinguishes testing, proof, blocked, stale and completed outcomes", () => { assert.equal(deriveLiveWorkerState(task({ check: { passed: false } }), worker(), now).state, "test-failed"); assert.equal(deriveLiveWorkerState(task({ check: { passed: true }, proofs: [{ kind: "commit" }] }), worker(), now).state, "awaiting-review"); assert.equal(deriveLiveWorkerState(task({ status: "blocked" }), worker(), now).state, "blocked"); assert.equal(deriveLiveWorkerState(task(), worker({ quiet: true }), now).state, "stale"); assert.equal(deriveLiveWorkerState(task({ stage: "done", status: "done" }), worker(), now).state, "done"); });
test("keeps paused or unreported work waiting and never invents a provider", () => { assert.equal(deriveLiveWorkerState(task({ stage: "test-approved", status: "open", lastProgress: null }), worker(), now).state, "waiting"); assert.equal(providerOf({ id: "worker-unknown", model: "local-model" }), "unknown"); });
test("never crosses project attempts when matching workers", () => { assert.equal(liveWorkerFor(task({ owner: "codex-correct" }), [worker({ task: "T-1" }), worker({ task: "T-1.a2", id: "codex-correct" })]).id, "codex-correct"); });

test("legacy prose, finished, wrong owner and reconnect without activity stay stopped", () => {
  for (const extra of [
    { workerActivity: null },
    { workerActivity: { worker: worker().id, activity: "finished", at: fresh } },
    { workerActivity: { worker: "foreign-worker", activity: "working", at: fresh } },
    { owner: "different-owner" },
  ]) assert.equal(deriveLiveWorkerState(task(extra), worker(), now).animated, false);
  assert.equal(deriveLiveWorkerState(task({ workerActivity: null }), worker({ lastSeen: new Date(now).toISOString() }), now).animated, false);
});
