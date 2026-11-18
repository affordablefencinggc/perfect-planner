import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import WorkBoardScreen from "../../src/core-screens/WorkBoardScreen.jsx";
import { ViewModeContext } from "../../src/project/viewMode.js";

const ok = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });

const baseTask = {
  project: "default", projectLabel: "nova-notes", id: "T-1", label: "T-1", title: "Add note search",
  column: "building", stage: "building", status: "claimed", attempt: 1, phase: "core",
  owner: "claude-code-1", assignee: null, model: "claude-sonnet-4", requestedModel: "claude-sonnet-4",
  reportedModel: "claude-sonnet-4", modelConflict: false, health: "working", healthLabel: "Working",
  createdAt: "2026-11-18T10:00:00Z", updatedAt: "2026-11-18T10:05:00Z", ageMs: 300000,
  progress: { text: "Reading src/store.js", at: "2026-11-18T10:05:00Z" }, progressAgeMs: 60000,
  activity: "working", proofs: 1, check: null, test: "node --test test/search.test.js", merged: false,
  branch: "pp/T-1", worktree: "/tmp/wt", claims: [], staleClaims: null, dependsOn: [], waitingFor: null,
  attention: [], usage: { calls: 1, inputTokens: 900, outputTokens: 120, usd: 0, unpricedTokens: 1020 },
};

const board = (over = {}) => ({
  generatedAt: "2026-11-18T10:06:00Z",
  project: "default",
  projects: [{ key: "default", label: "nova-notes", active: true, readable: true, tasks: 2, done: 0 }],
  columns: [
    { id: "needs-test", label: "Needs a test", hint: "Write it" },
    { id: "ready", label: "Ready", hint: "Can start" },
    { id: "building", label: "Building", hint: "A worker holds it" },
    { id: "review", label: "Review", hint: "Check it" },
    { id: "ship", label: "Ready to ship", hint: "Merge it" },
    { id: "blocked", label: "Blocked", hint: "Needs a person" },
    { id: "done", label: "Shipped", hint: "Merged" },
  ],
  tasks: [baseTask],
  totals: { tasks: 1, working: 1, needsYou: 0, blocked: 0, ship: 0, done: 0, failed: 0, stalled: 0, attention: 0 },
  attention: [],
  plan: { approved: true, latest: "P-1", at: "2026-11-18T09:00:00Z", count: 1, entry: "L-000004" },
  budget: { tokenBudget: null, tokensSpent: 1020, state: "uncapped" },
  guards: { containment: "not-contained", prePush: "installed", secretScan: "installed", malware: "not-assessed", dependencyAudit: "not-run", ledger: { ok: true, entries: 12 } },
  ...over,
});

const receipt = {
  version: 1, generatedAt: "2026-11-18T10:06:00Z", digest: "a".repeat(64), project: "default",
  task: { id: "T-1", label: "T-1", title: "Add note search", repo: "main", stage: "building", status: "claimed", attempt: 1, owner: "claude-code-1", assignee: null, model: "claude-sonnet-4", requestedModel: "claude-sonnet-4", reportedModel: "claude-sonnet-4", modelConflict: false },
  plan: { approved: true, latest: "P-1", at: "2026-11-18T09:00:00Z", count: 1, changedSince: false },
  work: { branch: "pp/T-1", worktree: "/tmp/wt", base: "main", port: 5200, claims: [], staleClaims: null, lastProgress: "Reading src/store.js", progressAt: "2026-11-18T10:05:00Z", proofs: [{ kind: "commit", link: "abc" }] },
  checks: { test: "node --test test/search.test.js", approval: "L-2 by owner", baseline: { passed: false }, check: null, diffApproval: null, merged: null },
  usage: { calls: 1, inputTokens: 900, outputTokens: 120, usd: 0, unpricedTokens: 1020, tokenBudget: null, tokensSpent: 1020 },
  history: [{ n: "L-1", at: "", type: "task.created", summary: "Add note search" }],
  openRisks: ["No worker progress for 15 minutes or more: the worker may have stopped or lost its model."],
  nextAction: "Read the diff and the proof, then approve the diff or send it back.",
  text: "Handover receipt · T-1 · Add note search\nNext action: Read the diff.",
};

function routeFetch(routes) {
  const fn = vi.fn(async (url, init = {}) => {
    const path = String(url).split("?")[0].replace("/api/core", "");
    const handler = routes[`${init.method ?? "GET"} ${path}`];
    if (!handler) throw new Error(`unexpected ${init.method ?? "GET"} ${path}`);
    return handler(init);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const renderBoard = () => render(
  <ViewModeContext.Provider value={{ mode: "simple", isAdvanced: false, setMode: () => {} }}>
    <WorkBoardScreen onWorkspace={() => {}} />
  </ViewModeContext.Provider>,
);

beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("WorkBoardScreen", () => {
  test("draws every workflow column and the task on it", async () => {
    routeFetch({ "GET /board": () => ok(board()) });
    renderBoard();
    expect(await screen.findByRole("heading", { name: /Needs a test/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Ready to ship/ })).toBeTruthy();
    expect(screen.getByText("Add note search")).toBeTruthy();
    expect(screen.getByLabelText("Board totals").textContent).toMatch(/1 working/);
  });

  test("puts a stalled worker in the attention rail with the action to take", async () => {
    const stalled = { ...baseTask, health: "stalled", healthLabel: "Stalled" };
    routeFetch({
      "GET /board": () => ok(board({
        tasks: [stalled],
        attention: [{ code: "stalled", level: "stop", message: "T-1 has had no worker sign of life for 15 minutes.", action: "Release the claim, then hand the task over.", task: "T-1", project: "default", title: "Add note search" }],
        totals: { ...board().totals, stalled: 1, attention: 1 },
      })),
    });
    renderBoard();
    expect(await screen.findByText(/has had no worker sign of life/)).toBeTruthy();
    expect(screen.getByText(/Release the claim, then hand the task over/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "T-1" })).toBeTruthy();
  });

  test("shows the token cap as a project item and jumps to the cap control", async () => {
    const fetchFn = routeFetch({
      "GET /board": () => ok(board({
        attention: [{ code: "token-budget", level: "stop", message: "The token budget is spent (1,200 of 1,000 reported tokens).", action: "Raise the cap below.", task: "project", project: "default", title: "Token budget" }],
        budget: { tokenBudget: 1000, tokensSpent: 1200, state: "reached" },
      })),
      "POST /tasks/settings": () => ok(board({ budget: { tokenBudget: 5000, tokensSpent: 1200, state: "ok" } })),
    });
    renderBoard();
    expect(await screen.findByText(/The token budget is spent/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Raise the cap" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Token cap for new workers/i), { target: { value: "5000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchFn.mock.calls.some(([url, init]) => String(url).includes("/tasks/settings") && init.method === "POST")).toBe(true));
  });

  test("opens a task, reads its receipt and records a handover", async () => {
    const fetchFn = routeFetch({
      "GET /board": () => ok(board()),
      "GET /tasks/T-1/receipt": () => ok(receipt),
      "GET /people": () => ok({ view: { members: [{ person: "owner", name: "Danie", role: "owner" }, { person: "sam", name: "Sam", role: "helper" }] } }),
      "POST /tasks/T-1/handover": () => ok({ handover: "L-9", receipt }),
    });
    renderBoard();
    fireEvent.click(await screen.findByRole("button", { name: /T-1: Add note search/ }));
    expect(await screen.findByRole("heading", { name: "Handover receipt" })).toBeTruthy();
    expect(screen.getByText(/No worker progress for 15 minutes/)).toBeTruthy();
    expect(await screen.findByRole("option", { name: /Sam · helper/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/What the next person must know/i), { target: { value: "Worker dropped out; nothing in src changed." } });
    fireEvent.change(screen.getByLabelText(/Give it to/i), { target: { value: "sam" } });
    fireEvent.click(screen.getByRole("button", { name: /Record handover/i }));
    await waitFor(() => expect(fetchFn.mock.calls.some(([url, init]) => String(url).includes("/tasks/T-1/handover") && init.method === "POST")).toBe(true));
    const posted = JSON.parse(fetchFn.mock.calls.find(([url]) => String(url).includes("/handover"))[1].body);
    expect(posted.note).toMatch(/dropped out/);
    expect(posted.nextAction).toMatch(/Read the diff/);
    expect(posted.to).toBe("sam");
  });

  test("closes the drawer with Escape and a backdrop click", async () => {
    routeFetch({
      "GET /board": () => ok(board()),
      "GET /tasks/T-1/receipt": () => ok(receipt),
      "GET /people": () => ok({ view: { members: [] } }),
    });
    renderBoard();
    fireEvent.click(await screen.findByRole("button", { name: /T-1: Add note search/ }));
    expect(await screen.findByRole("heading", { name: "Handover receipt" })).toBeTruthy();
    // The drawer is portalled to the body, so it must not live inside the screen subtree.
    const dialog = document.querySelector(".wb-drawer");
    expect(dialog).toBeTruthy();
    expect(document.querySelector(".wb-backdrop")).toBeTruthy();
    expect(dialog.closest(".core-screen-board")).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.querySelector(".wb-drawer")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /T-1: Add note search/ }));
    fireEvent.click(document.querySelector(".wb-backdrop"));
    expect(document.querySelector(".wb-drawer")).toBeNull();
  });

  test("says nothing needs a decision when the rail is clear", async () => {
    routeFetch({ "GET /board": () => ok(board()) });
    renderBoard();
    expect(await screen.findByText(/Nothing needs a decision right now/)).toBeTruthy();
  });
});

