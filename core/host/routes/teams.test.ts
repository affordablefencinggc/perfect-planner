import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostCall, startTestHost } from "../testing";
import { registerTeamsRoutes } from "./teams";

// The Teams screen is a projection of the same roster the People screen writes,
// plus the two signed team records this module owns. These tests drive the real
// routes and read the same ledger the screen reads: nothing here fabricates a
// teammate, a claim or an acceptance.
describe("teams route", () => {
  let ctx: Awaited<ReturnType<typeof startTestHost>>;
  const P = "?project=teams";
  beforeEach(async () => {
    ctx = await startTestHost();
    // core/host/routes/index.ts registers this screen in the app; register it
    // here too when a host is started without it, so the test proves the route
    // itself either way.
    if (ctx.host.router.match("GET", "/teams") === null) registerTeamsRoutes(ctx.host.router);
  });
  afterEach(async () => { await ctx.stop(); });

  const claimOwner = () => hostCall(ctx.base, "POST", `/people/claim${P}`, { name: "Dana Lee" });
  const addMember = (person: string, name: string, role: "helper" | "viewer") =>
    hostCall(ctx.base, "POST", `/people/members${P}`, { person, name, role });
  const addTask = (title: string) => hostCall(ctx.base, "POST", `/planning/tasks${P}`, { title, phase: "core" });
  const teams = async () => (await hostCall(ctx.base, "GET", `/teams${P}`)).body.result;
  const ledgerOf = () => ctx.host.project("teams").entries();

  it("is empty for a new project, with the roles the screen offers", async () => {
    const res = await hostCall(ctx.base, "GET", `/teams${P}`);
    expect(res.status).toBe(200);
    expect(res.body.result.roles).toEqual(["owner", "maintainer", "builder", "reviewer", "release-manager", "observer"]);
    expect(res.body.result.members).toEqual([]);
    expect(res.body.result.generatedAt).toMatch(/Z$/);
  });

  it("builds the team from the roster and the board, inventing nobody", async () => {
    await claimOwner();
    await addMember("sam", "Sam Park", "helper");
    await addMember("vi", "Vi Kim", "viewer");
    await addTask("Build the login screen");
    const assigned = await hostCall(ctx.base, "POST", `/people/assign${P}`, { task: "T-1", person: "sam" });
    expect(assigned.status).toBe(200);

    const view = await teams();
    expect(view.members.map((member: { id: string }) => member.id)).toEqual(["owner", "sam", "vi"]);
    expect(view.members[1]).toMatchObject({
      id: "sam",
      name: "Sam Park",
      role: "builder",
      availability: "busy",
      assignments: ["T-1"],
      claims: [],
      activeTask: { id: "T-1", title: "Build the login screen", stage: "needs-test", health: "idle" },
    });
    expect(view.members[2]).toMatchObject({ id: "vi", name: "Vi Kim", role: "observer", assignments: [], activeTask: null });
    // Only the three people on the roster; no worker, agent or task owner is invented as a member.
    expect(view.members).toHaveLength(3);
  });

  it("changes a team role, keeps the People role honest and records the change", async () => {
    await claimOwner();
    await addMember("sam", "Sam Park", "helper");

    const changed = await hostCall(ctx.base, "POST", `/teams/sam/role${P}`, { role: "reviewer" });
    expect(changed.status).toBe(200);
    expect(changed.body.result.entry).toMatch(/^L-\d+$/);
    expect(changed.body.result.member).toMatchObject({ id: "sam", name: "Sam Park", role: "reviewer" });
    expect(changed.body.result).toMatchObject({ id: "sam", name: "Sam Park", role: "reviewer" });
    expect((await teams()).members.find((member: { id: string }) => member.id === "sam").role).toBe("reviewer");

    const record = ledgerOf().find((entry) => entry.data?.teams && (entry.data.teams as { op?: string }).op === "member.role.changed");
    expect(record).toMatchObject({
      type: "decision.made",
      actor: { kind: "person", id: "owner" },
      data: { teams: { op: "member.role.changed", person: "sam", role: "reviewer" } },
    });
    // A reviewer is still a helper: the People role did not need to move.
    const people = (await hostCall(ctx.base, "GET", `/people${P}`)).body.result.view;
    expect(people.members.find((member: { person: string }) => member.person === "sam").role).toBe("helper");

    // An observer is read-only, so the People role moves with it.
    const observer = await hostCall(ctx.base, "POST", `/teams/sam/role${P}`, { role: "observer" });
    expect(observer.status).toBe(200);
    expect(observer.body.result.member.role).toBe("observer");
    const after = (await hostCall(ctx.base, "GET", `/people${P}`)).body.result.view;
    expect(after.members.find((member: { person: string }) => member.person === "sam").role).toBe("viewer");
  });

  it("refuses an invalid role and an unknown member", async () => {
    await claimOwner();
    await addMember("sam", "Sam Park", "helper");
    const badRole = await hostCall(ctx.base, "POST", `/teams/sam/role${P}`, { role: "boss" });
    expect(badRole.status).toBe(400);
    expect(badRole.body.code).toBe("BAD_ROLE");
    const unknown = await hostCall(ctx.base, "POST", `/teams/nobody/role${P}`, { role: "builder" });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("UNKNOWN_MEMBER");
    // Neither refusal wrote a team record.
    expect(ledgerOf().filter((entry) => entry.data?.teams)).toEqual([]);
  });

  it("records the incoming person and the receipt digest when a handover is accepted", async () => {
    await claimOwner();
    await addTask("Build the login screen");
    const accepted = await hostCall(ctx.base, "POST", `/tasks/T-1/handover/accept${P}`, {
      note: "Taking over the cold-start brief; the test is not written yet.",
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.result).toMatchObject({ accepted: true, task: "T-1", incoming: "owner" });
    expect(accepted.body.result.receiptDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(accepted.body.result.at).toMatch(/Z$/);
    expect(accepted.body.result.nextAction).toMatch(/done-when test/i);

    const entry = ledgerOf().at(-1)!;
    const teamsData = entry.data?.teams as Record<string, unknown>;
    expect(entry).toMatchObject({ type: "decision.made", actor: { kind: "person", id: "owner" } });
    expect(teamsData).toMatchObject({
      op: "task.handover.accepted",
      task: "T-1",
      incoming: "owner",
      note: "Taking over the cold-start brief; the test is not written yet.",
      receiptDigest: accepted.body.result.receiptDigest,
    });
    expect(teamsData.receiptGeneratedAt).toBeTruthy();
    expect(Number.isFinite(Date.parse(String(teamsData.receiptGeneratedAt)))).toBe(true);
    // Accepting is not dispatching and not releasing: the task is still open and unheld.
    const board = (await hostCall(ctx.base, "GET", `/board${P}`)).body.result;
    expect(board.tasks[0]).toMatchObject({ id: "T-1", status: "open", owner: null, column: "needs-test" });
  });

  it("refuses an empty note and a missing task", async () => {
    await claimOwner();
    await addTask("Build the login screen");
    const empty = await hostCall(ctx.base, "POST", `/tasks/T-1/handover/accept${P}`, { note: "   " });
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe("EMPTY_NOTE");
    const short = await hostCall(ctx.base, "POST", `/tasks/T-1/handover/accept${P}`, { note: "brief" });
    expect(short.status).toBe(400);
    expect(short.body.code).toBe("BAD_NOTE");
    const missing = await hostCall(ctx.base, "POST", `/tasks/T-9/handover/accept${P}`, { note: "Taking over a task that is not here." });
    expect(missing.status).toBe(404);
    expect(ledgerOf().filter((entry) => entry.data?.teams)).toEqual([]);
  });

  it("lets the owner name an incoming member, but never someone off the roster", async () => {
    await claimOwner();
    await addMember("sam", "Sam Park", "helper");
    await addTask("Build the login screen");
    const accepted = await hostCall(ctx.base, "POST", `/tasks/T-1/handover/accept${P}`, {
      note: "Sam is taking this one over from here.",
      person: "sam",
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.result.incoming).toBe("sam");
    // The entry is signed by the person at this computer; `incoming` names who takes over.
    const entry = ledgerOf().at(-1)!;
    expect(entry.actor).toEqual({ kind: "person", id: "owner" });
    expect(entry.data?.teams).toMatchObject({ op: "task.handover.accepted", incoming: "sam" });

    const stranger = await hostCall(ctx.base, "POST", `/tasks/T-1/handover/accept${P}`, {
      note: "Someone who was never on the roster.",
      person: "stranger",
    });
    expect(stranger.status).toBe(404);
    expect(stranger.body.code).toBe("NOT_A_MEMBER");
  });

  it("gives a second acceptance its own receipt and its own ledger entry", async () => {
    await claimOwner();
    await addTask("Build the login screen");
    const first = await hostCall(ctx.base, "POST", `/tasks/T-1/handover/accept${P}`, { note: "First read of the brief." });
    const second = await hostCall(ctx.base, "POST", `/tasks/T-1/handover/accept${P}`, { note: "Second read of the brief." });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.result.receiptDigest).not.toBe(first.body.result.receiptDigest);
    const records = ledgerOf().filter((entry) => entry.data?.teams && (entry.data.teams as { op?: string }).op === "task.handover.accepted");
    expect(records).toHaveLength(2);
    expect(records[0]!.n).not.toBe(records[1]!.n);
    expect(records.map((entry) => (entry.data?.teams as { receiptDigest: string }).receiptDigest)).toEqual([
      first.body.result.receiptDigest,
      second.body.result.receiptDigest,
    ]);
  });
});
