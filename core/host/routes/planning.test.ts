import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostCall, startTestHost } from "../testing";
import type { CoreHost } from "../index";

const IDEA = "Desktop invoice app with Stripe payments that works offline";
const P = "?project=plan";

describe("planning routes", () => {
  let base: string;
  let host: CoreHost;
  let stop: () => Promise<void>;
  beforeEach(async () => {
    ({ base, host, stop } = await startTestHost());
  });
  afterEach(async () => stop());

  async function start() {
    const res = await hostCall(base, "POST", `/planning/start${P}`, { idea: IDEA });
    expect(res.status).toBe(200);
    return res.body.result;
  }

  it("is empty before an idea is given", async () => {
    const res = await hostCall(base, "GET", `/planning${P}`);
    expect(res.body.result).toMatchObject({ started: false, idea: null, progress: { total: 0, blockingOpen: 0 }, research: { live: false } });
    expect(res.body.result.approval.canApprove).toBe(false);
  });

  it("refuses an empty idea", async () => {
    const res = await hostCall(base, "POST", `/planning/start${P}`, { idea: " " });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("EMPTY");
  });

  it("starts from an idea and lists question packs with recommendations", async () => {
    const result = await start();
    expect(result.asked.length).toBeGreaterThan(10);
    expect(result.signals).toEqual(expect.arrayContaining(["offline", "payments", "desktop"]));
    const view = result.overview;
    expect(view.started).toBe(true);
    expect(view.idea).toBe(IDEA);
    expect(view.areas.map((a: any) => a.area)[0]).toBe("stack");
    const q = view.areas[0].questions[0];
    expect(q).toMatchObject({ q: "Q-1", id: "stack.language", status: "open", blocking: true });
    expect(q.options.length).toBeGreaterThan(1);
    expect(q.recommendation.option).toBeTruthy();
    expect(typeof q.recommendation.confidence).toBe("number");
    expect(q.recommendation.sources).toEqual([]);
    expect(q.why).toBeTruthy();
    expect(q.entries.asked).toMatch(/^L-\d+/);
    expect(view.blockers.length).toBe(view.progress.blockingOpen);
    expect(view.progress.blockingOpen).toBeGreaterThan(0);

    // Starting again with the same idea asks nothing new.
    const again = await hostCall(base, "POST", `/planning/start${P}`, { idea: IDEA });
    expect(again.body.result.overview.progress.total).toBe(view.progress.total);
  });

  it("answers by recommendation, pick and free text, and refuses deferrals with the catcher's message", async () => {
    const view = (await start()).overview;
    const first = view.areas[0].questions[0];
    const one = await hostCall(base, "POST", `/planning/answer${P}`, { q: first.q, choice: first.recommendation.option });
    expect(one.body.result).toMatchObject({ status: "decided", decision: "D-1" });

    const second = view.areas[0].questions[1];
    const pick = await hostCall(base, "POST", `/planning/answer${P}`, { q: second.q, choice: second.options[1].id });
    expect(pick.body.result.answer).toBe(second.options[1].label);

    const third = view.areas[0].questions[2];
    const tbd = await hostCall(base, "POST", `/planning/answer${P}`, { q: third.q, text: "TBD" });
    expect(tbd.status).toBe(422);
    expect(tbd.body.code).toBe("DEFERRED");
    expect(tbd.body.message).toContain('"TBD" puts');
    const later = await hostCall(base, "POST", `/planning/answer${P}`, { q: third.q, text: "we will decide later" });
    expect(later.body.code).toBe("DEFERRED");

    const free = await hostCall(base, "POST", `/planning/answer${P}`, { q: third.q, text: "Fly.io, one small machine" });
    expect(free.body.result.status).toBe("decided");

    const twice = await hostCall(base, "POST", `/planning/answer${P}`, { q: third.q, text: "Vercel" });
    expect(twice.status).toBe(409);
    const unknown = await hostCall(base, "POST", `/planning/answer${P}`, { q: "Q-999", text: "x" });
    expect(unknown.status).toBe(404);
    const bad = await hostCall(base, "POST", `/planning/answer${P}`, { q: view.areas[1].questions[0].q, choice: "nope" });
    expect(bad.body.code).toBe("BAD_CHOICE");

    const after = (await hostCall(base, "GET", `/planning${P}`)).body.result;
    expect(after.progress.answered).toBe(3);
    const answered = after.areas[0].questions[0];
    expect(answered).toMatchObject({ status: "decided", decision: "D-1" });
    expect(answered.entries.decided).toMatch(/^L-/);
    expect(answered.entries.answered).toMatch(/^L-/);
  });

  it("turns a deferral into a dated spike", async () => {
    const view = (await start()).overview;
    const q = view.blockers[0].q;
    const due = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const bad = await hostCall(base, "POST", `/planning/answer${P}`, { q, text: "TBD", spike: { due: "2099-01-01", risk: "Wrong tax handling blocks EU sales." } });
    expect(bad.body.code).toBe("BAD_SPIKE");
    const res = await hostCall(base, "POST", `/planning/answer${P}`, { q, text: "TBD", spike: { due, risk: "Wrong tax handling blocks EU sales." } });
    expect(res.body.result).toMatchObject({ status: "spiked", due });
    expect(res.body.result.task).toMatch(/^T-\d+/);
  });

  it("refuses approval while blockers are open, then approves and writes the roadmap", async () => {
    const view = (await start()).overview;
    const refused = await hostCall(base, "POST", `/planning/approve${P}`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("BLOCKERS_OPEN");
    expect(refused.body.message).toMatch(/blocking questions are still open \(Q-/);
    expect(view.approval.message).toBe(refused.body.message);

    await hostCall(base, "POST", `/planning/accept${P}`, {});
    let current = (await hostCall(base, "GET", `/planning${P}`)).body.result;
    for (const b of current.blockers) {
      const choice = b.recommendation.option;
      const res = await hostCall(base, "POST", `/planning/answer${P}`, choice ? { q: b.q, choice } : { q: b.q, text: "Decided: keep it simple" });
      expect(res.status).toBe(200);
    }
    current = (await hostCall(base, "GET", `/planning${P}`)).body.result;
    expect(current.progress.blockingOpen).toBe(0);
    expect(current.approval.canApprove).toBe(true);

    const map = (await hostCall(base, "GET", `/planning/mindmap${P}`)).body.result;
    expect(map.map.nodes.root.label).toContain("Desktop invoice app");
    expect(map.map.nodes.root.children.length).toBeGreaterThan(0);
    expect(map.mermaid).toContain("graph TD");

    const draft = (await hostCall(base, "GET", `/planning/roadmap${P}`)).body.result;
    expect(draft.written).toBe(false);
    expect(draft.phases.map((p: any) => p.id)).toEqual(["foundation", "core", "integrations", "hardening", "release"]);

    // Approval is bound to the plan as shown: none, or a stale fingerprint, is refused.
    expect((await hostCall(base, "POST", `/planning/approve${P}`, {})).body.code).toBe("FINGERPRINT_REQUIRED");
    const stale = await hostCall(base, "POST", `/planning/approve${P}`, { fingerprint: view.fingerprint });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("STALE");
    const ok = await hostCall(base, "POST", `/planning/approve${P}`, { fingerprint: current.fingerprint });
    expect(ok.status).toBe(200);
    expect(ok.body.result.plan).toBe("P-1");
    expect(Object.values(ok.body.result.tasks).every((t) => /^T-\d+$/.test(String(t)))).toBe(true);
    expect(ok.body.result.overview.approval.approved[0]).toMatchObject({ plan: "P-1" });

    const written = (await hostCall(base, "GET", `/planning/roadmap${P}`)).body.result;
    expect(written.written).toBe(true);
    const release = written.phases.find((p: any) => p.id === "release").tasks.at(-1);
    expect(release.task).toMatch(/^T-\d+$/);
    expect(release.dependsOnTasks.every((d: string) => /^T-\d+$/.test(d))).toBe(true);

    // Approved and unchanged: nothing to approve again (trial F8).
    const after = (await hostCall(base, "GET", `/planning${P}`)).body.result;
    expect(after.approval).toMatchObject({ upToDate: true, canApprove: false });
    const same = await hostCall(base, "POST", `/planning/approve${P}`, { fingerprint: after.fingerprint });
    expect(same.status).toBe(409);
    expect(same.body.code).toBe("ALREADY_APPROVED");

    // A changed plan can be approved again: P-2, without writing the roadmap twice.
    const nonBlocking = after.areas.flatMap((a: any) => a.questions).find((q: any) => q.status === "open");
    expect(nonBlocking).toBeTruthy();
    const choice = nonBlocking.options?.[0]?.id;
    const ans = await hostCall(base, "POST", `/planning/answer${P}`, choice ? { q: nonBlocking.q, choice } : { q: nonBlocking.q, text: "Use the simplest option" });
    expect(ans.status).toBe(200);
    const changed = (await hostCall(base, "GET", `/planning${P}`)).body.result;
    expect(changed.approval).toMatchObject({ upToDate: false, changedSinceApproval: true, canApprove: true });
    const again = await hostCall(base, "POST", `/planning/approve${P}`, { fingerprint: changed.fingerprint });
    expect(again.body.result.plan).toBe("P-2");
    expect(again.body.result.tasks).toEqual({});
  });

  it("replays from the ledger after a restart of the project state", async () => {
    await start();
    host.project("plan").state.clear();
    const view = (await hostCall(base, "GET", `/planning${P}`)).body.result;
    expect(view.started).toBe(true);
    expect(view.idea).toBe(IDEA);
  });

  it("checks text for deferrals", async () => {
    const res = await hostCall(base, "POST", `/planning/check${P}`, { text: "not sure yet" });
    expect(res.body.result).toMatchObject({ deferred: true, matches: ["not sure"] });
  });
});
