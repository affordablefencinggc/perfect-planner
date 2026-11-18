import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STALL_MS, stillInsideClaimWindow } from "./board";
import { hostCall, startTestHost } from "../testing";

// The work board is a projection, not a store: these tests drive the real routes and read
// the same ledger the Tasks screen reads. Nothing here fabricates a worker or a check.
describe("work board route", () => {
  let ctx: Awaited<ReturnType<typeof startTestHost>>;
  const P = "?project=board";
  beforeEach(async () => { ctx = await startTestHost(); });
  afterEach(async () => { await ctx.stop(); });

  const addTask = (title: string, phase = "core") => hostCall(ctx.base, "POST", `/planning/tasks${P}`, { title, phase });

  it("puts a new task in Needs a test and says nothing is wrong", async () => {
    await addTask("Add note search");
    const board = (await hostCall(ctx.base, "GET", `/board${P}`)).body.result;
    expect(board.totals).toMatchObject({ tasks: 1, working: 0, blocked: 0, done: 0, attention: 0 });
    expect(board.tasks[0]).toMatchObject({ id: "T-1", column: "needs-test", stage: "needs-test", health: "idle" });
    expect(board.columns.map((column: { id: string }) => column.id)).toEqual(["needs-test", "ready", "building", "review", "ship", "blocked", "done"]);
  });

  it("lists the tasks of every phase on one board", async () => {
    await addTask("Search", "core");
    await addTask("Restore", "hardening");
    const board = (await hostCall(ctx.base, "GET", `/board${P}`)).body.result;
    expect(board.totals.tasks).toBe(2);
    expect(board.tasks.map((task: { phase: string }) => task.phase).sort()).toEqual(["core", "hardening"]);
  });

  it("flags every open task when the plan is approved again after it was created", async () => {
    await addTask("Search");
    const approved = await hostCall(ctx.base, "POST", `/plan/approve${P}`, { tasks: [{ id: "T-1", title: "Search" }] });
    expect(approved.status).toBe(200);
    const board = (await hostCall(ctx.base, "GET", `/board${P}`)).body.result;
    expect(board.plan).toMatchObject({ approved: true, latest: "P-1" });
    expect(board.attention).toEqual([expect.objectContaining({ code: "plan-changed", task: "T-1", level: "risk" })]);
  });

  it("keeps the token cap on the project, not on every card", async () => {
    await addTask("Search");
    await addTask("Edit");
    const saved = await hostCall(ctx.base, "POST", `/tasks/settings${P}`, { tokenBudget: 1000 });
    expect(saved.status).toBe(200);
    const board = (await hostCall(ctx.base, "GET", `/board${P}`)).body.result;
    expect(board.budget).toMatchObject({ tokenBudget: 1000, state: "ok" });
    expect(board.attention).toEqual([]);
  });

  it("refuses a token cap that is not a positive whole number", async () => {
    const refused = await hostCall(ctx.base, "POST", `/tasks/settings${P}`, { tokenBudget: -5 });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/whole number above 0/);
  });

  it("writes a cold-start receipt for a task, and refuses a handover with no note", async () => {
    await addTask("Search");
    const receipt = (await hostCall(ctx.base, "GET", `/tasks/T-1/receipt${P}`)).body.result;
    expect(receipt.task).toMatchObject({ id: "T-1", label: "T-1", stage: "needs-test" });
    expect(receipt.nextAction).toMatch(/done-when test/i);
    expect(receipt.text).toContain("Handover receipt · T-1 · Search");
    expect(receipt.digest).toMatch(/^[a-f0-9]{64}$/);

    const noNote = await hostCall(ctx.base, "POST", `/tasks/T-1/handover${P}`, { nextAction: "Write the test" });
    expect(noNote.status).toBe(400);
    expect(noNote.body.message).toMatch(/without a note/i);
    const noNext = await hostCall(ctx.base, "POST", `/tasks/T-1/handover${P}`, { note: "Nothing started." });
    expect(noNext.status).toBe(400);
  });

  it("records a handover as a signed entry and keeps it in the receipt", async () => {
    await addTask("Search");
    const handed = await hostCall(ctx.base, "POST", `/tasks/T-1/handover${P}`, {
      note: "The worker dropped out before touching src.",
      nextAction: "Dispatch a worker, then run the approved test.",
    });
    expect(handed.status).toBe(200);
    expect(handed.body.result.handover).toMatch(/^L-\d+$/);
    const receipt = (await hostCall(ctx.base, "GET", `/tasks/T-1/receipt${P}`)).body.result;
    expect(receipt.history.some((entry: { type: string; summary: string }) => entry.type === "task.progress" && /Handover for T-1/.test(entry.summary))).toBe(true);
    // A handover on an unclaimed task still leaves it open and ready, never done.
    const board = (await hostCall(ctx.base, "GET", `/board${P}`)).body.result;
    expect(board.tasks[0]).toMatchObject({ column: "needs-test", status: "open", owner: null });
  });

  it("lists another project on this computer without opening its ledger", async () => {
    await addTask("Search");
    await hostCall(ctx.base, "POST", "/planning/tasks?project=other", { title: "Other project task" });
    const board = (await hostCall(ctx.base, "GET", `/board${P}`)).body.result;
    expect(board.projects.find((project: { key: string }) => project.key === "other")).toMatchObject({ tasks: 1, active: false, readable: true });
    expect(board.tasks.every((task: { project: string }) => task.project === "board")).toBe(true);
  });

  it("gives a fresh claim its grace window before calling it stalled", () => {
    const now = Date.parse("2026-11-19T04:00:00Z");
    // A worker that claimed seconds or minutes ago has not stalled, even with no report yet.
    expect(stillInsideClaimWindow("2026-11-19T03:59:44Z", now)).toBe(true);
    expect(stillInsideClaimWindow(new Date(now - STALL_MS + 1000).toISOString(), now)).toBe(true);
    // At and past the window, silence is a stall.
    expect(stillInsideClaimWindow(new Date(now - STALL_MS).toISOString(), now)).toBe(false);
    expect(stillInsideClaimWindow("2026-11-19T03:20:00Z", now)).toBe(false);
    // No readable claim time cannot earn a grace window.
    expect(stillInsideClaimWindow(null, now)).toBe(false);
  });
});
