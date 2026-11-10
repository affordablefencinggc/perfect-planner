import { describe, expect, test } from "vitest";
import { deriveLiveWorkerState, workerIdentityFor } from "../../src/core-screens/liveWorkerSpine.js";
const now = Date.parse("2026-11-04T05:00:00Z");
const at = new Date(now - 1000).toISOString();
const worker = { id: "codex-worker", model: "gpt-5.6", lastSeen: at };
const task = { id: "T-1", label: "T-1", status: "claimed", owner: worker.id, stage: "review-diff", check: { passed: true, commit: "old" }, proofs: [{ kind: "commit", link: "old" }], lastProgress: { text: "Editing", at }, workerActivity: { entry: "L-9", worker: worker.id, activity: "working", at, afterCheck: true } };
describe("explicit rework state", () => {
  test("working after a passed check resumes motion while preserving the old check", () => {
    expect(deriveLiveWorkerState(task, worker, now)).toMatchObject({ state: "reworking", animated: true });
    expect(task.check).toEqual({ passed: true, commit: "old" });
  });
  test.each(["waiting", "finished"])("%s after a check remains stopped", activity => {
    expect(deriveLiveWorkerState({ ...task, workerActivity: { ...task.workerActivity, activity } }, worker, now).animated).toBe(false);
  });
  test.each([
    { workerActivity: null },
    { status: "open" },
    { workerActivity: { ...task.workerActivity, worker: "other" } },
    { workerActivity: { ...task.workerActivity, afterCheck: false } },
    { workerActivity: { ...task.workerActivity, at: "2020-01-01T00:00:00Z" } },
    { stage: "ready-to-merge" }, { stage: "done" }, { status: "blocked" },
  ])("does not animate an ineligible report %j", over => {
    expect(deriveLiveWorkerState({ ...task, ...over }, worker, now).animated).toBe(false);
  });
  test("reconnect, another worker, or stale presence alone never animate", () => {
    for (const changed of [null, { ...worker, id: "other" }, { ...worker, quiet: true }, { ...worker, lastSeen: "2020-01-01T00:00:00Z" }]) {
      expect(deriveLiveWorkerState(task, changed, now).animated).toBe(false);
    }
    expect(deriveLiveWorkerState({ ...task, stage: "building", check: null, workerActivity: null }, worker, now).animated).toBe(false);
  });
  test("durable reported and requested identities stay distinct without restoring liveness", () => {
    const value = workerIdentityFor({ ...task, workerDispatch: { requestedModel: "gpt-requested" }, workerReport: { worker: worker.id, reportedModel: "gpt-reported" } });
    expect(value).toMatchObject({ requestedModel: "gpt-requested", reportedModel: "gpt-reported", modelConflict: true, modelReported: true });
    expect(value.lastSeen).toBeUndefined();
    expect(deriveLiveWorkerState(task, value, now).animated).toBe(false);
    expect(workerIdentityFor({ ...task, label: "T-1.a2" }, [{ ...worker, role: "worker", task: "T-1.a1" }]).lastSeen).toBeUndefined();
  });
});