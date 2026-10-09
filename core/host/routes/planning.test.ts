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
    expect(one.body.result).toMatchObject({ status: "decided", decision: expect.stringMatching(/^D-\d+$/) });

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
    // Three answers here, plus the two the idea itself settles ("Stripe", "works offline").
    expect(after.progress.answered).toBe(3 + view.description.settled.length);
    expect(view.description.settled.map((s: any) => s.id).sort()).toEqual(["money.payments", "offline.required"]);
    const answered = after.areas[0].questions[0];
    expect(answered).toMatchObject({ status: "decided", decision: one.body.result.decision });
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

    // The plan as shown is approved: no second approval of the same plan, and the screen says so.
    const approvedView = (await hostCall(base, "GET", `/planning${P}`)).body.result;
    expect(approvedView.approval).toMatchObject({ current: true, canApprove: false });
    const same = await hostCall(base, "POST", `/planning/approve${P}`, { fingerprint: approvedView.fingerprint });
    expect(same.status).toBe(409);
    expect(same.body.code).toBe("ALREADY_APPROVED");

    // A changed plan can be approved again: P-2, without writing the roadmap twice.
    const open = approvedView.areas.flatMap((a: any) => a.questions).find((q: any) => q.status === "open");
    expect(open, "an open question to answer").toBeTruthy();
    expect((await hostCall(base, "POST", `/planning/answer${P}`, { q: open.q, text: "Decided: export to PDF only" })).status).toBe(200);
    const changed = (await hostCall(base, "GET", `/planning${P}`)).body.result;
    expect(changed.approval).toMatchObject({ current: false, canApprove: true, message: expect.stringMatching(/changed since it was approved/) });
    expect(changed.approval).toMatchObject({ upToDate: false, changedSinceApproval: true });
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

  describe("the person's own description", () => {
    const HABITS = "A personal habit tracker for one person on one phone. No accounts, no login, no cloud sync.";

    it("settles what the idea says: no sign-in questions open and no Sign-in tasks", async () => {
      const res = await hostCall(base, "POST", `/planning/start${P}`, { idea: HABITS });
      expect(res.status).toBe(200);
      const view = res.body.result.overview;
      const auth = view.areas.find((a: any) => a.area === "auth");
      expect(auth.questions.length).toBeGreaterThan(0);
      for (const q of auth.questions) expect(q).toMatchObject({ status: "decided", source: "description" });
      expect(view.blockers.some((b: any) => b.area === "auth")).toBe(false);
      expect(view.description.ruledOut.map((r: any) => r.id)).toEqual(expect.arrayContaining(["accounts", "single-user", "sync"]));
      const signin = view.description.settled.find((s: any) => s.id === "auth.signin");
      expect(signin).toMatchObject({ answer: "No sign-in", phrase: "No accounts, no login", areaTitle: "Users and auth" });
      expect(signin.q).toMatch(/^Q-\d+$/);
      expect(res.body.result.described.length).toBe(view.description.settled.length);
      expect(view.signals).not.toContain("offline");

      await hostCall(base, "POST", `/planning/accept${P}`, { minConfidence: 0.5 });
      let current = (await hostCall(base, "GET", `/planning${P}`)).body.result;
      for (const b of current.blockers) await hostCall(base, "POST", `/planning/answer${P}`, b.recommendation.option ? { q: b.q, choice: b.recommendation.option } : { q: b.q, text: "Decided: keep it simple" });
      current = (await hostCall(base, "GET", `/planning${P}`)).body.result;
      expect(current.approval.canApprove).toBe(true);
      const draft = (await hostCall(base, "GET", `/planning/roadmap${P}`)).body.result;
      const titles = draft.phases.flatMap((p: any) => p.tasks.map((t: any) => t.title));
      expect(titles.some((t: string) => /sign[- ]?in|login|account/i.test(t))).toBe(false);

      // Starting again settles nothing twice.
      const again = await hostCall(base, "POST", `/planning/start${P}`, { idea: HABITS });
      expect(again.body.result.described).toEqual([]);
      expect(again.body.result.overview.progress.total).toBe(current.progress.total);
    });

    it("reopens a question the description settled, as a person only", async () => {
      const view = (await hostCall(base, "POST", `/planning/start${P}`, { idea: HABITS })).body.result.overview;
      const signin = view.description.settled.find((s: any) => s.id === "auth.signin");
      const asAgent = await hostCall(base, "POST", `/planning/reopen${P}`, { q: signin.q }, { asAgent: true });
      expect(asAgent.status).toBe(401);
      const res = await hostCall(base, "POST", `/planning/reopen${P}`, { q: signin.q });
      expect(res.status).toBe(200);
      expect(res.body.result.q).not.toBe(signin.q);
      const after = res.body.result.overview;
      const auth = after.areas.find((a: any) => a.area === "auth").questions;
      // Only the newest question per id is listed; the reopened one is open and blocking again.
      expect(auth.filter((q: any) => q.id === "auth.signin")).toEqual([expect.objectContaining({ q: res.body.result.q, status: "open" })]);
      expect(after.blockers.map((b: any) => b.q)).toContain(res.body.result.q);
      expect(after.description.settled.find((s: any) => s.id === "auth.signin")).toBeUndefined();
      const twice = await hostCall(base, "POST", `/planning/reopen${P}`, { q: signin.q });
      expect(twice.status).toBe(409);
      // Only description answers reopen here.
      const stack = after.areas[0].questions[0];
      await hostCall(base, "POST", `/planning/answer${P}`, { q: stack.q, choice: stack.recommendation.option });
      const mine = await hostCall(base, "POST", `/planning/reopen${P}`, { q: stack.q });
      expect(mine.status).toBe(409);
      expect(mine.body.code).toBe("NOT_FROM_DESCRIPTION");
    });

    it("records what the person names instead of asking it", async () => {
      const view = (await hostCall(base, "POST", `/planning/start${P}`, { idea: "A React Native app for dog walkers that uses SQLite" })).body.result.overview;
      const settled = Object.fromEntries(view.description.settled.map((s: any) => [s.id, s]));
      expect(settled["platforms.mobile-stack"]).toMatchObject({ answer: "React Native", phrase: "React Native" });
      expect(settled["data.store"]).toMatchObject({ phrase: "SQLite" });
    });
  });

  describe("the person's own tasks", () => {
    it("adds a task as a person-signed T-n that the roadmap, GET /planning and the agent board see", async () => {
      await start();
      const empty = await hostCall(base, "POST", `/planning/tasks${P}`, { title: "  " });
      expect(empty.status).toBe(400);
      expect(empty.body.code).toBe("EMPTY");
      const asAgent = await hostCall(base, "POST", `/planning/tasks${P}`, { title: "Sneaky" }, { asAgent: true });
      expect(asAgent.status).toBe(401);
      const badPhase = await hostCall(base, "POST", `/planning/tasks${P}`, { title: "x", phase: "someday" });
      expect(badPhase.status).toBe(400);

      const res = await hostCall(base, "POST", `/planning/tasks${P}`, { title: "Export invoices to CSV", doneWhen: "a test exports two invoices", clause: "C-1", phase: "integrations" });
      expect(res.status).toBe(200);
      const { task, entry } = res.body.result;
      expect(task).toMatch(/^T-\d+$/);
      expect(entry).toMatch(/^L-/);
      expect(res.body.result.overview.tasks.own).toEqual([expect.objectContaining({ task, title: "Export invoices to CSV", phase: "integrations", doneWhen: "a test exports two invoices", refs: ["C-1"] })]);

      const written = host.project("plan").ledger.bySubject(task)[0]!;
      expect(written).toMatchObject({ type: "task.created", actor: { kind: "person" }, refs: ["C-1"] });
      const { foldBoard } = await import("../../mcp/board");
      expect(foldBoard(host.project("plan").entries()).get(task)).toMatchObject({ title: "Export invoices to CSV", status: "open" });

      const roadmap = (await hostCall(base, "GET", `/planning/roadmap${P}`)).body.result;
      const integrations = roadmap.phases.find((p: any) => p.id === "integrations");
      expect(integrations.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ task, title: "Export invoices to CSV", own: true })]));
      const overview = (await hostCall(base, "GET", `/planning${P}`)).body.result;
      expect(overview.tasks.own.map((t: any) => t.task)).toEqual([task]);
    });

    it("leaves a draft roadmap task out before approval, puts it back, and never writes it", async () => {
      await start();
      await hostCall(base, "POST", `/planning/accept${P}`, { minConfidence: 0.5 });
      let current = (await hostCall(base, "GET", `/planning${P}`)).body.result;
      for (const b of current.blockers) await hostCall(base, "POST", `/planning/answer${P}`, b.recommendation.option ? { q: b.q, choice: b.recommendation.option } : { q: b.q, text: "Decided: keep it simple" });
      const draft = (await hostCall(base, "GET", `/planning/roadmap${P}`)).body.result;
      const victim = draft.phases.flatMap((p: any) => p.tasks).find((t: any) => t.key !== "K-first-release" && !t.own);
      const release = await hostCall(base, "POST", `/planning/roadmap/drop${P}`, { key: "K-first-release" });
      expect(release.status).toBe(409);
      const unknown = await hostCall(base, "POST", `/planning/roadmap/drop${P}`, { key: "K-nope" });
      expect(unknown.status).toBe(404);
      const asAgent = await hostCall(base, "POST", `/planning/roadmap/drop${P}`, { key: victim.key }, { asAgent: true });
      expect(asAgent.status).toBe(401);

      const dropped = await hostCall(base, "POST", `/planning/roadmap/drop${P}`, { key: victim.key, reason: "Not in v1" });
      expect(dropped.status).toBe(200);
      expect(dropped.body.result.decision).toMatch(/^D-\d+$/);
      let roadmap = (await hostCall(base, "GET", `/planning/roadmap${P}`)).body.result;
      expect(roadmap.phases.flatMap((p: any) => p.tasks).map((t: any) => t.key)).not.toContain(victim.key);
      expect(roadmap.dropped).toEqual([expect.objectContaining({ key: victim.key, title: victim.title })]);
      await hostCall(base, "POST", `/planning/roadmap/restore${P}`, { key: victim.key });
      roadmap = (await hostCall(base, "GET", `/planning/roadmap${P}`)).body.result;
      expect(roadmap.dropped).toEqual([]);
      await hostCall(base, "POST", `/planning/roadmap/drop${P}`, { key: victim.key });

      const ok = await hostCall(base, "POST", `/planning/approve${P}`, { fingerprint: (await hostCall(base, "GET", `/planning${P}`)).body.result.fingerprint });
      expect(ok.status).toBe(200);
      expect(ok.body.result.tasks[victim.key]).toBeUndefined();
      const late = await hostCall(base, "POST", `/planning/roadmap/drop${P}`, { key: draft.phases.flatMap((p: any) => p.tasks).find((t: any) => t.key !== victim.key && t.key !== "K-first-release").key });
      expect(late.status).toBe(409);
      expect(late.body.code).toBe("ROADMAP_WRITTEN");
      // Own tasks can still be added after approval.
      const after = await hostCall(base, "POST", `/planning/tasks${P}`, { title: "Write the user guide" });
      expect(after.status).toBe(200);
    });
  });

  it("checks text for deferrals", async () => {
    const res = await hostCall(base, "POST", `/planning/check${P}`, { text: "not sure yet" });
    expect(res.body.result).toMatchObject({ deferred: true, matches: ["not sure"] });
  });
});
