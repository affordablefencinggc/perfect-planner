import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendNumbered } from "../../numbering/index";
import { hostCall, startTestHost } from "../testing";
import type { CoreHost } from "../index";

const P = "?project=plan";
const IDEA = "Desktop invoice app with Stripe payments that works offline";

describe("plan approval routes", () => {
  let base: string;
  let host: CoreHost;
  let stop: () => Promise<void>;
  beforeEach(async () => {
    ({ base, host, stop } = await startTestHost());
  });
  afterEach(async () => stop());

  async function settleBlockers() {
    await hostCall(base, "POST", `/planning/start${P}`, { idea: IDEA });
    await hostCall(base, "POST", `/planning/accept${P}`, {});
    const current = (await hostCall(base, "GET", `/planning${P}`)).body.result;
    for (const b of current.blockers) {
      const choice = b.recommendation.option;
      await hostCall(base, "POST", `/planning/answer${P}`, choice ? { q: b.q, choice } : { q: b.q, text: "Decided: keep it simple" });
    }
  }

  it("says not approved before anyone approves", async () => {
    const res = await hostCall(base, "GET", `/plan${P}`);
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ approved: false, latest: null, count: 0, tasks: [] });
  });

  it("reports the Deep planning approval as the plan approval", async () => {
    await settleBlockers();
    const ok = await hostCall(base, "POST", `/planning/approve${P}`, {});
    expect(ok.status).toBe(200);
    const res = (await hostCall(base, "GET", `/plan${P}`)).body.result;
    expect(res.approved).toBe(true);
    expect(res.latest).toMatchObject({ plan: "P-1", entry: ok.body.result.entry, by: "owner", source: "planning" });
    expect(res.latest.at).toBeTruthy();
    expect(res.count).toBe(1);
    expect(res.tasks.length).toBe(Object.keys(ok.body.result.tasks).length);
    expect(res.tasks.every((t: string) => /^T-\d+$/.test(t))).toBe(true);
  });

  it("counts only plan approvals a person wrote", async () => {
    const ledger = host.project("plan").ledger;
    // A system-signed approval is authoritative for the system, but the plan is the person's call.
    appendNumbered(ledger, { actor: { kind: "system", id: "gate" }, type: "plan.approved", summary: "System approval" });
    const res = (await hostCall(base, "GET", `/plan${P}`)).body.result;
    expect(res).toMatchObject({ approved: false, latest: null, count: 0 });
  });

  it("approves from the Plan page through the same ledger entry, as the person only", async () => {
    const agent = await hostCall(base, "POST", `/plan/approve${P}`, { tasks: [{ id: "T0001", title: "Add login form" }] }, { asAgent: true });
    expect(agent.status).toBe(401);
    expect(agent.body.code).toBe("PERSON_REQUIRED");

    const ok = await hostCall(base, "POST", `/plan/approve${P}`, { tasks: [{ id: "T0001", title: "Add login form" }, { id: "x", title: 3 }] });
    expect(ok.status).toBe(200);
    expect(ok.body.result).toMatchObject({ plan: "P-1", approval: { approved: true, latest: { plan: "P-1", by: "owner", source: "plan-page" } } });
    const entry = host.project("plan").entries().find((e) => e.type === "plan.approved")!;
    expect(entry.data).toMatchObject({ source: "plan-page", tasks: [{ id: "T0001", title: "Add login form" }] });
    expect((entry.data!.tasks as unknown[]).length).toBe(1);

    // Deep planning sees the same approval.
    const view = (await hostCall(base, "GET", `/planning${P}`)).body.result;
    expect(view.approval.approved[0]).toMatchObject({ plan: "P-1" });
  });

  it("refuses to approve an empty plan: no tasks and no Deep planning", async () => {
    const refused = await hostCall(base, "POST", `/plan/approve${P}`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("NOTHING_TO_APPROVE");
    expect((await hostCall(base, "GET", `/plan${P}`)).body.result.approved).toBe(false);
  });

  it("refuses a Plan page approval while a blocking planning question is open", async () => {
    await hostCall(base, "POST", `/planning/start${P}`, { idea: IDEA });
    const refused = await hostCall(base, "POST", `/plan/approve${P}`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("BLOCKERS_OPEN");
    expect(refused.body.message).toMatch(/blocking questions? (is|are) still open \(Q-/);
    expect((await hostCall(base, "GET", `/plan${P}`)).body.result.approved).toBe(false);
  });
});
