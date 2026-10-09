import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import TasksScreen from "../../src/core-screens/TasksScreen.jsx";
import { ViewModeContext } from "../../src/project/viewMode.js";

// Built at run time so the repository's own push scan does not read it as a real token.
const TOKEN = ["pp_w", "secret".repeat(4)].join("_");
const REPO = { ok: true, root: "/work/notes" };
const base = { id: "T-1", label: "T-1", title: "Save notes", status: "open", stage: "needs-test", owner: null, attempt: 1, clauses: ["P-1 §1"], lastProgress: null, proofs: [], test: null, approval: null, baseline: null, check: null, diffApproval: null, merged: null, worktree: null, dispatch: null, history: [] };
const task = (over) => ({ ...base, ...over });
const view = (tasks, repo = REPO) => ({ repo, tasks });
const ok = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
const refused = (message) => ({ ok: false, status: 409, json: async () => ({ ok: false, code: "REFUSED", message }) });

function routeFetch(routes) {
  const fn = vi.fn(async (url, init = {}) => {
    const path = String(url).split("?")[0].replace("/api/core", "");
    if (path === "/session") return ok({ person: true });
    const handler = routes[`${init.method ?? "GET"} ${path}`];
    if (!handler) throw new Error(`unexpected ${init.method ?? "GET"} ${path}`);
    return handler(init);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const renderScreen = (mode = "simple") =>
  render(
    <ViewModeContext.Provider value={{ mode, isAdvanced: mode === "advanced", setMode: () => {} }}>
      <TasksScreen />
    </ViewModeContext.Provider>,
  );

const card = async (name) => screen.findByRole("article", { name });

beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("TasksScreen", () => {
  test("shows the empty state when no plan has been approved yet", async () => {
    routeFetch({ "GET /tasks": async () => ok(view([])) });
    renderScreen();
    expect(await screen.findByText(/No tasks yet/)).toBeTruthy();
  });

  test("asks for the git folder when the project folder is not a repository, and saves it", async () => {
    let repo = { ok: false, reason: "Workers need your project's git folder (with at least one commit) to branch from. Choose it below." };
    const fetch = routeFetch({
      "GET /tasks": async () => ok(view([task()], repo)),
      "POST /tasks/repo": async (init) => { repo = { ok: true, root: JSON.parse(init.body).root }; return ok(view([task()], repo)); },
    });
    renderScreen();
    expect(await screen.findByText(/need your project's git folder/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Git folder"), { target: { value: "/work/notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
    await waitFor(() => expect(fetch.mock.calls.some(([u, i]) => String(u).includes("/tasks/repo") && i?.method === "POST")).toBe(true));
    expect(await screen.findByText("/work/notes")).toBeTruthy();
  });

  test("Start worker dispatches with the model and shows the brief and commands once", async () => {
    let tasks = [task()];
    const fetch = routeFetch({
      "GET /tasks": async () => ok(view(tasks)),
      "POST /tasks/T-1/dispatch": async (init) => {
        expect(JSON.parse(init.body)).toEqual({ model: "claude-sonnet-4-5" });
        tasks = [task({ worktree: { path: "/work/notes/.perfect-planner/worktrees/T-1", branch: "pp/T-1", base: "main", port: 5200 }, dispatch: { issuedAt: "now", model: "claude-sonnet-4-5" } })];
        return ok({ task: "T-1", title: "Save notes", worktree: "/work/notes/.perfect-planner/worktrees/T-1", branch: "pp/T-1", tokenFile: "/p/.perfect-planner/tokens/T-1.token", brief: "You are a Perfect Planner worker on T-1: Save notes.\n2. Test first: … propose_test", setup: `cd "/w" && claude mcp add perfect-planner-core --env 'PP_AGENT_TOKEN_FILE=/p/.perfect-planner/tokens/T-1.token' -- node '/a'`, start: 'claude "$(cat "/b/T-1.md")"', json: "{}", shell: "Terminal", agentBuilt: true });
      },
    });
    renderScreen();
    const t1 = await card("T-1 Save notes");
    expect(within(t1).getByText("Needs a test")).toBeTruthy();
    fireEvent.change(within(t1).getByLabelText("Worker model"), { target: { value: "claude-sonnet-4-5" } });
    fireEvent.click(within(t1).getByRole("button", { name: "Start worker" }));
    const setup = await screen.findByLabelText("Set-up command for T-1");
    expect(setup.textContent).toContain("PP_AGENT_TOKEN_FILE=");
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(screen.getByLabelText("Brief for T-1").textContent).toContain("propose_test");
    expect(screen.getByLabelText("Start command for T-1").textContent).toContain("claude");
    expect(fetch.mock.calls.filter(([u]) => String(u).includes("/dispatch"))).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Hide command" }));
    expect(screen.queryByLabelText("Set-up command for T-1")).toBeNull();
  });

  test("a proposed test shows its command and who wrote it; Approve test runs it and reports that it fails first", async () => {
    let tasks = [task({ stage: "test-proposed", worktree: { path: "/w", branch: "pp/T-1", base: "main", port: 5200 }, test: { command: "node tests/save.check.mjs", files: ["tests/save.check.mjs"], entry: "L-000007", by: { kind: "agent", id: "worker-1", model: "claude-sonnet-4-5" } } })];
    tasks[0].stage = "test-proposed";
    routeFetch({
      "GET /tasks": async () => ok(view(tasks)),
      "POST /tasks/T-1/approve-test": async (init) => {
        // The approval names the exact test the person read.
        expect(JSON.parse(init.body)).toEqual({ test: "L-000007" });
        tasks = [{ ...tasks[0], stage: "ready-to-claim", approval: { by: { kind: "person", id: "owner" } }, baseline: { passed: false } }];
        return ok({ approved: true, failsFirst: true, output: "save.js missing", ...view(tasks) });
      },
    });
    renderScreen();
    const t1 = await card("T-1 Save notes");
    expect(within(t1).getByText("node tests/save.check.mjs")).toBeTruthy();
    expect(within(t1).getByText(/Proposed by worker-1/)).toBeTruthy();
    fireEvent.click(within(t1).getByRole("button", { name: "Approve test" }));
    expect(await screen.findByText(/fails on today's code, as it should/)).toBeTruthy();
    expect(within(await card("T-1 Save notes")).getByText("Waiting for the worker to claim")).toBeTruthy();
  });

  test("review: Check the work, show the diff, Approve diff, then Merge", async () => {
    const tree = { path: "/w", branch: "pp/T-1", base: "main", port: 5200 };
    let tasks = [task({ status: "claimed", owner: "worker-1", stage: "building", worktree: tree, lastProgress: "Saved to disk", proofs: [{ kind: "commit", link: "abc123" }] })];
    const fetch = routeFetch({
      "GET /tasks": async () => ok(view(tasks)),
      "POST /tasks/T-1/check": async () => { tasks = [{ ...tasks[0], stage: "review-diff", check: { passed: true, commit: "abc123" } }]; return ok({ passed: true, commit: "abc123", ...view(tasks) }); },
      "GET /tasks/T-1/diff": async () => ok({ task: "T-1", files: ["src/save.js"], text: "+export const save = 1;", commit: "abc123" }),
      "POST /tasks/T-1/approve-diff": async (init) => {
        expect(JSON.parse(init.body)).toEqual({ commit: "abc123" });
        tasks = [{ ...tasks[0], stage: "ready-to-merge", diffApproval: { commit: "abc123" } }];
        return ok(view(tasks));
      },
      "POST /tasks/T-1/merge": async (init) => {
        expect(JSON.parse(init.body)).toEqual({ commit: "abc123" }); tasks = [{ ...tasks[0], status: "done", stage: "done", worktree: null, merged: { commit: "def456" } }]; return ok({ merged: true, commit: "def456", into: "main", ...view(tasks) }); },
    });
    renderScreen();
    let t1 = await card("T-1 Save notes");
    expect(within(t1).getByText("Saved to disk")).toBeTruthy();
    fireEvent.click(within(t1).getByRole("button", { name: "Check the work" }));
    expect(await screen.findByText(/passes in the worktree/)).toBeTruthy();
    t1 = await card("T-1 Save notes");
    // Approve diff waits until the person has read the diff, and names that commit.
    expect(within(t1).getByRole("button", { name: "Approve diff" }).disabled).toBe(true);
    fireEvent.click(within(t1).getByRole("button", { name: "Show diff" }));
    expect(await screen.findByText("+export const save = 1;")).toBeTruthy();
    fireEvent.click(within(await card("T-1 Save notes")).getByRole("button", { name: "Approve diff at abc123" }));
    const merge = await within(await card("T-1 Save notes")).findByRole("button", { name: "Merge into main" });
    fireEvent.click(merge);
    expect(await screen.findByText(/Merged into main/)).toBeTruthy();
    expect(within(await card("T-1 Save notes")).getByText("Done")).toBeTruthy();
    expect(fetch.mock.calls.filter(([, i]) => i?.method === "POST").map(([u]) => String(u).split("?")[0].replace("/api/core", ""))).toEqual(["/tasks/T-1/check", "/tasks/T-1/approve-diff", "/tasks/T-1/merge"]);
  });

  test("a refused merge shows the gate's reason", async () => {
    routeFetch({
      "GET /tasks": async () => ok(view([task({ status: "claimed", stage: "ready-to-merge", worktree: { path: "/w", branch: "pp/T-1", base: "main", port: 5200 } })])),
      "POST /tasks/T-1/merge": async () => refused("The test fails after the merge (exit 1); main was left untouched."),
    });
    renderScreen();
    fireEvent.click(within(await card("T-1 Save notes")).getByRole("button", { name: "Merge into main" }));
    expect(await screen.findByText(/main was left untouched/)).toBeTruthy();
  });

  test("Send back needs notes and reopens the task as the next attempt", async () => {
    let tasks = [task({ status: "claimed", stage: "review-diff", worktree: { path: "/w", branch: "pp/T-1", base: "main", port: 5200 } })];
    routeFetch({
      "GET /tasks": async () => ok(view(tasks)),
      "POST /tasks/T-1/reject": async (init) => {
        expect(JSON.parse(init.body)).toEqual({ notes: "Use a real file" });
        tasks = [{ ...tasks[0], status: "open", stage: "ready-to-claim", attempt: 2, label: "T-1.a2", worktree: null }];
        return ok({ reopenedAs: "T-1.a2", ...view(tasks) });
      },
    });
    renderScreen();
    const t1 = await card("T-1 Save notes");
    fireEvent.click(within(t1).getByRole("button", { name: "Send back" }));
    const send = await screen.findByRole("button", { name: "Send back to the worker" });
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("What should change"), { target: { value: "Use a real file" } });
    fireEvent.click(send);
    expect(await screen.findByText(/Reopened as T-1.a2/)).toBeTruthy();
  });
});
