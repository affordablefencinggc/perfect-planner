import { describe, expect, it } from "vitest";
import { FRESH_MS as BOARD_FRESH_MS, STALL_MS as BOARD_STALL_MS, type BoardTask } from "../host/routes/board";
import {
  FRESH_MS,
  REVIEW_WAIT_MS,
  STALL_MS,
  dependencyGraph,
  deriveReminders,
} from "./reminders";

// These tests use synthetic BoardTask facts, never a ledger or a worker. Each rule
// is exercised through the public fold so the ordering and dedupe are tested too.
const NOW = Date.parse("2026-11-19T04:00:00Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

function task(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    project: "board",
    projectLabel: "Board",
    id: "T-1",
    label: "T-1",
    title: "Add search",
    column: "building",
    stage: "building",
    status: "claimed",
    attempt: 1,
    phase: "core",
    owner: "codex",
    assignee: null,
    model: "gpt-5",
    requestedModel: "gpt-5",
    reportedModel: "gpt-5",
    modelConflict: false,
    health: "quiet",
    healthLabel: "Quiet",
    createdAt: ago(60 * 60_000),
    updatedAt: ago(2 * 60_000),
    ageMs: 60 * 60_000,
    progress: { text: "Working", at: ago(2 * 60_000) },
    progressAgeMs: 2 * 60_000,
    activity: null,
    proofs: 0,
    check: null,
    test: "npm test",
    merged: false,
    branch: "task/T-1",
    worktree: null,
    claims: [],
    staleClaims: null,
    dependsOn: [],
    waitingFor: null,
    attention: [],
    usage: { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0, unpricedTokens: 0 },
    ...overrides,
  };
}

describe("thresholds", () => {
  it("mirrors the board route's freshness windows", () => {
    expect(FRESH_MS).toBe(BOARD_FRESH_MS);
    expect(STALL_MS).toBe(BOARD_STALL_MS);
  });
});

describe("deriveReminders: claim-idle", () => {
  it("says nothing at exactly the fresh window", () => {
    expect(deriveReminders([task({ updatedAt: ago(FRESH_MS), progressAgeMs: FRESH_MS })], { now: NOW })).toEqual([]);
  });

  it("calls a quiet worker a risk just past the fresh window, and says when it becomes a stall", () => {
    const [item] = deriveReminders([task({ updatedAt: ago(FRESH_MS + 1), progressAgeMs: FRESH_MS + 1 })], { now: NOW });
    expect(item).toMatchObject({ code: "claim-idle", level: "risk", task: "T-1", ageMs: FRESH_MS + 1 });
    expect(item!.dueAt).toBe(new Date(NOW + (STALL_MS - FRESH_MS - 1)).toISOString());
  });

  it("is still a risk one millisecond before the stall window", () => {
    const [item] = deriveReminders([task({ updatedAt: ago(STALL_MS - 1), progressAgeMs: STALL_MS - 1 })], { now: NOW });
    expect(item).toMatchObject({ code: "claim-idle", level: "risk", ageMs: STALL_MS - 1 });
  });

  it("is a stop at exactly the stall window", () => {
    const [item] = deriveReminders([task({ updatedAt: ago(STALL_MS), progressAgeMs: STALL_MS })], { now: NOW });
    expect(item).toMatchObject({ code: "claim-idle", level: "stop", ageMs: STALL_MS });
    expect(item!.dueAt).toBeUndefined();
  });

  it("is a stop when the board already says stalled but carries no readable age", () => {
    const blind = task({ updatedAt: null, progress: null, progressAgeMs: null, health: "stalled" });
    const [item] = deriveReminders([blind], { now: NOW });
    expect(item).toMatchObject({ code: "claim-idle", level: "stop" });
    expect(item!.ageMs).toBeUndefined();
  });

  it("leaves a worker that reported finished alone", () => {
    expect(deriveReminders([task({ health: "finished", updatedAt: ago(STALL_MS * 2) })], { now: NOW })).toEqual([]);
  });

  it("leaves a task that is not claimed or building alone", () => {
    const open = task({ status: "open", column: "ready", health: "ready", owner: "person", updatedAt: ago(STALL_MS * 2) });
    expect(deriveReminders([open], { now: NOW })).toEqual([]);
  });
});

describe("deriveReminders: check-failed", () => {
  it("stops on a failed check and names the commit", () => {
    const [item] = deriveReminders([task({ check: { passed: false, commit: "abc1234" } })], { now: NOW });
    expect(item).toMatchObject({ code: "check-failed", level: "stop" });
    expect(item!.message).toContain("abc1234");
  });

  it("says nothing when the check passed", () => {
    expect(deriveReminders([task({ check: { passed: true } })], { now: NOW })).toEqual([]);
  });
});

describe("deriveReminders: dependency-unmet", () => {
  const first = task({
    id: "T-1",
    label: "T-1",
    title: "Schema",
    status: "open",
    column: "ready",
    health: "ready",
    owner: "person",
    updatedAt: ago(60_000),
  });

  it("names every exact unmet dependency, including one not on the board", () => {
    const waiting = task({
      id: "T-2",
      label: "T-2",
      title: "Search",
      dependsOn: ["T-1", "T-9", "T-1"],
      waitingFor: "T-2 cannot start yet because it needs another task finished and merged first.",
    });
    const item = deriveReminders([first, waiting], { now: NOW }).find((reminder) => reminder.code === "dependency-unmet")!;
    expect(item.level).toBe("stop");
    expect(item.message).toContain("T-2");
    expect(item.message).toContain("T-1");
    expect(item.message).toContain("T-9");
    expect(item.message.match(/T-1/g)).toHaveLength(1);
  });

  it("is a risk when the waiting task is not being worked", () => {
    const idle = task({
      id: "T-3",
      label: "T-3",
      title: "Search",
      status: "open",
      column: "ready",
      health: "ready",
      owner: "person",
      dependsOn: ["T-1"],
      waitingFor: "T-3 cannot start yet.",
    });
    const item = deriveReminders([first, idle], { now: NOW }).find((reminder) => reminder.code === "dependency-unmet")!;
    expect(item.level).toBe("risk");
  });

  it("says nothing when every dependency is done", () => {
    const done = task({
      id: "T-1",
      label: "T-1",
      status: "done",
      column: "done",
      health: "done",
      owner: null,
      updatedAt: ago(60_000),
    });
    const waiting = task({ id: "T-2", label: "T-2", dependsOn: ["T-1"] });
    expect(deriveReminders([done, waiting], { now: NOW }).filter((reminder) => reminder.code === "dependency-unmet")).toEqual([]);
  });
});

describe("deriveReminders: board attention", () => {
  it("lifts plan-changed as a risk", () => {
    const changed = task({
      attention: [{ code: "plan-changed", level: "risk", message: "The plan was approved after T-1 was created.", action: "Re-read the plan." }],
    });
    expect(deriveReminders([changed], { now: NOW })).toEqual([
      expect.objectContaining({ code: "plan-changed", level: "risk", message: "The plan was approved after T-1 was created." }),
    ]);
  });

  it("lifts a token-budget attention as a stop", () => {
    const capped = task({
      attention: [{ code: "token-budget", level: "stop", message: "The token budget is spent.", action: "Raise the cap or hand the work over." }],
    });
    expect(deriveReminders([capped], { now: NOW })).toEqual([
      expect.objectContaining({ code: "token-cap", level: "stop", message: "The token budget is spent." }),
    ]);
  });

  it("lifts a handover attention as a risk", () => {
    const handed = task({
      attention: [{ code: "handover", level: "risk", message: "T-1 was handed over.", action: "Read the note." }],
    });
    expect(deriveReminders([handed], { now: NOW })).toEqual([
      expect.objectContaining({ code: "handover-waiting", level: "risk", message: "T-1 was handed over." }),
    ]);
  });
});

describe("deriveReminders: model-conflict", () => {
  it("names the requested and reported models", () => {
    const conflicted = task({ modelConflict: true, requestedModel: "claude-opus-5", reportedModel: "gpt-5.5" });
    const [item] = deriveReminders([conflicted], { now: NOW });
    expect(item).toMatchObject({ code: "model-conflict", level: "risk" });
    expect(item!.message).toContain("claude-opus-5");
    expect(item!.message).toContain("gpt-5.5");
  });
});

describe("deriveReminders: no-owner", () => {
  it.each(["ready", "review", "ship"] as const)("asks for an owner on a %s task", (column) => {
    const unowned = task({
      column,
      status: "open",
      health: column === "ready" ? "ready" : column === "review" ? "review" : "ship",
      owner: null,
      assignee: null,
      updatedAt: ago(60_000),
    });
    expect(deriveReminders([unowned], { now: NOW })).toEqual([
      expect.objectContaining({ code: "no-owner", level: "risk", task: "T-1" }),
    ]);
  });

  it("says nothing when a person is assigned", () => {
    const assigned = task({
      column: "ready",
      status: "open",
      health: "ready",
      owner: null,
      assignee: "daniel",
      updatedAt: ago(60_000),
    });
    expect(deriveReminders([assigned], { now: NOW })).toEqual([]);
  });

  it("does not nag a task a worker is building", () => {
    expect(deriveReminders([task({ owner: null, assignee: null })], { now: NOW })).toEqual([]);
  });
});

describe("deriveReminders: review-waiting", () => {
  const review = (updatedAt: string | null) => task({
    column: "review",
    status: "claimed",
    health: "review",
    owner: "codex",
    updatedAt,
    progressAgeMs: updatedAt ? NOW - Date.parse(updatedAt) : null,
  });

  it("does not nudge at exactly 30 minutes", () => {
    expect(deriveReminders([review(ago(REVIEW_WAIT_MS))], { now: NOW })).toEqual([]);
  });

  it("nudges after 30 minutes and carries the age", () => {
    const [item] = deriveReminders([review(ago(REVIEW_WAIT_MS + 1))], { now: NOW });
    expect(item).toMatchObject({ code: "review-waiting", level: "risk", ageMs: REVIEW_WAIT_MS + 1 });
  });

  it("does not guess when there is no update time", () => {
    expect(deriveReminders([review(null)], { now: NOW })).toEqual([]);
  });
});

describe("deriveReminders: handover-waiting", () => {
  it("treats a blocked task whose last progress is a handover as waiting", () => {
    const handed = task({
      column: "blocked",
      status: "blocked",
      health: "blocked",
      owner: null,
      assignee: null,
      progress: { text: "Handover for T-1: the worker dropped out.", at: ago(5 * 60_000) },
      updatedAt: ago(5 * 60_000),
    });
    const item = deriveReminders([handed], { now: NOW }).find((reminder) => reminder.code === "handover-waiting")!;
    expect(item).toMatchObject({ code: "handover-waiting", level: "risk" });
    expect(item.message).toContain("Handover for T-1");
  });

  it("does not call every blocked task a handover", () => {
    const blocked = task({
      column: "blocked",
      status: "blocked",
      health: "blocked",
      owner: null,
      assignee: null,
      progress: { text: "Waiting on the design decision.", at: ago(5 * 60_000) },
      updatedAt: ago(5 * 60_000),
    });
    expect(deriveReminders([blocked], { now: NOW }).filter((reminder) => reminder.code === "handover-waiting")).toEqual([]);
  });
});

describe("deriveReminders: stale-worktree", () => {
  const stale = task({
    column: "needs-test",
    stage: "needs-test",
    status: "open",
    health: "idle",
    owner: null,
    assignee: null,
    worktree: "C:\\worktrees\\T-1",
  });

  it("marks an unowned worktree as information, not a stop", () => {
    expect(deriveReminders([stale], { now: NOW })).toEqual([
      expect.objectContaining({ code: "stale-worktree", level: "info" }),
    ]);
  });

  it("does not call a claimed worktree stale", () => {
    expect(deriveReminders([task({ ...stale, status: "claimed", owner: null, assignee: null })], { now: NOW })).toEqual([]);
  });

  it("does not call a blocked worktree stale", () => {
    expect(deriveReminders([task({ ...stale, status: "blocked", column: "blocked", health: "blocked" })], { now: NOW })).toEqual([]);
  });

  it("does not call a done task's kept worktree stale", () => {
    const done = task({ ...stale, status: "done", column: "done", health: "done" });
    expect(deriveReminders([done], { now: NOW })).toEqual([]);
  });
});

describe("deriveReminders: dedupe and order", () => {
  it("keeps one reminder per task and code", () => {
    const changed = task({
      attention: [
        { code: "plan-changed", level: "risk", message: "first", action: "a" },
        { code: "plan-changed", level: "risk", message: "second", action: "b" },
      ],
    });
    const items = deriveReminders([changed, changed], { now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ code: "plan-changed", message: "first" });
  });

  it("orders stop, then risk, then info; oldest first inside a level", () => {
    const info = task({
      id: "T-1",
      label: "T-1",
      column: "needs-test",
      stage: "needs-test",
      status: "open",
      health: "idle",
      owner: null,
      assignee: null,
      worktree: "C:\\worktrees\\T-1",
      updatedAt: ago(60_000),
    });
    const riskYoung = task({ id: "T-2", label: "T-2", updatedAt: ago(FRESH_MS + 1), progressAgeMs: FRESH_MS + 1 });
    const stop = task({
      id: "T-3",
      label: "T-3",
      status: "open",
      column: "ready",
      health: "ready",
      owner: "person",
      check: { passed: false },
      updatedAt: ago(60_000),
    });
    const riskOld = task({
      id: "T-4",
      label: "T-4",
      updatedAt: ago(FRESH_MS + 3 * 60_000),
      progressAgeMs: FRESH_MS + 3 * 60_000,
    });
    const items = deriveReminders([info, riskYoung, stop, riskOld], { now: NOW });
    expect(items.map((item) => `${item.task}:${item.code}`)).toEqual([
      "T-3:check-failed",
      "T-4:claim-idle",
      "T-2:claim-idle",
      "T-1:stale-worktree",
    ]);
  });

  it("returns nothing for an empty board", () => {
    expect(deriveReminders([], { now: NOW })).toEqual([]);
  });
});

describe("dependencyGraph", () => {
  const node = (id: string, dependsOn: string[] = [], status: BoardTask["status"] = "open") => ({
    id,
    title: `Task ${id}`,
    status,
    dependsOn,
  });

  it("returns an empty graph for no tasks", () => {
    expect(dependencyGraph([])).toEqual({ nodes: [], edges: [], cycles: [], criticalPath: [], unmet: [] });
  });

  it("draws edges from the prerequisite to the task that waits", () => {
    const graph = dependencyGraph([node("T-1"), node("T-2", ["T-1"]), node("T-3", ["T-2"])]);
    expect(graph.edges).toEqual([
      { from: "T-1", to: "T-2" },
      { from: "T-2", to: "T-3" },
    ]);
    expect(graph.criticalPath).toEqual(["T-1", "T-2", "T-3"]);
    expect(graph.cycles).toEqual([]);
  });

  it("finds a two-node cycle once and leaves it off the critical path", () => {
    const graph = dependencyGraph([node("T-2", ["T-1"]), node("T-1", ["T-2"])]);
    expect(graph.cycles).toEqual([["T-1", "T-2"]]);
    expect(graph.criticalPath).toEqual([]);
  });

  it("does not put a task that waits on a cycle on the critical path", () => {
    const graph = dependencyGraph([node("T-1", ["T-2"]), node("T-2", ["T-1"]), node("T-3", ["T-2"])]);
    expect(graph.cycles).toEqual([["T-1", "T-2"]]);
    expect(graph.criticalPath).toEqual([]);
  });

  it("reports a self-dependency as a cycle", () => {
    const graph = dependencyGraph([node("T-1", ["T-1"])]);
    expect(graph.cycles).toEqual([["T-1"]]);
    expect(graph.criticalPath).toEqual([]);
    expect(graph.unmet).toEqual([{ task: "T-1", dependsOn: ["T-1"] }]);
  });

  it("names every dependency that is not done, including one not on the board", () => {
    const graph = dependencyGraph([node("T-1"), node("T-2", ["T-1", "T-3", "T-9"]), node("T-3", [], "done")]);
    expect(graph.unmet).toEqual([{ task: "T-2", dependsOn: ["T-1", "T-9"] }]);
  });

  it("picks the longest chain deterministically when two are the same length", () => {
    const graph = dependencyGraph([node("T-1"), node("T-2", ["T-1"]), node("T-3", ["T-1"])]);
    expect(graph.criticalPath).toEqual(["T-1", "T-2"]);
  });

  it("does not mutate the input and does not depend on input order", () => {
    const tasks = [node("T-3", ["T-2"]), node("T-2", ["T-1"]), node("T-1")];
    const before = JSON.parse(JSON.stringify(tasks)) as typeof tasks;
    const first = dependencyGraph(tasks);
    expect(tasks).toEqual(before);
    expect(dependencyGraph([...tasks].reverse())).toEqual(first);
  });
});
