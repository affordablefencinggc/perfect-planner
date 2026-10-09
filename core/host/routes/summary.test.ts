import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostCall, startTestHost } from "../testing";

describe("summary route", () => {
  let ctx: Awaited<ReturnType<typeof startTestHost>>;
  const P = "?project=sum";
  beforeEach(async () => { ctx = await startTestHost(); });
  afterEach(async () => { await ctx.stop(); });

  it("is empty for a new project", async () => {
    const res = await hostCall(ctx.base, "GET", `/summary${P}`);
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({ project: "sum", started: false, people: { members: 0, ownerMissing: false }, agents: { checkedIn: 0, names: [] }, plan: { approved: false, tasks: 0 } });
  });

  it("counts the roster once people are added", async () => {
    await hostCall(ctx.base, "POST", `/people/members${P}`, { person: "owner", name: "Riley Owner", role: "owner" });
    await hostCall(ctx.base, "POST", `/people/members${P}`, { person: "sam", name: "Sam", role: "helper" });
    const res = (await hostCall(ctx.base, "GET", `/summary${P}`)).body.result;
    expect(res).toMatchObject({ started: true, people: { members: 2, owner: "Riley Owner", ownerMissing: false } });
  });
});
