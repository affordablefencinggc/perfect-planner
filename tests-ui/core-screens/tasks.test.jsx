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
    expect((await screen.findAllByText("/work/notes")).length).toBeGreaterThan(0);
  });

  test("B1: with no folder suggested by the host, the box starts with the folder the person imported, and never one they typed over", async () => {
    routeFetch({
      "GET /tasks": async () => ok(view([task()], { ok: false, reason: "Choose it below." })),
      "GET /api/launch-folder": async () => ({ ok: true, status: 200, json: async () => ({ available: true, name: "old", path: "/work/old" }) }),
    });
    renderScreen();
    await waitFor(() => expect(screen.getByLabelText("Git folder").value).toBe("/work/old"));
  });

  test("B1: a folder the person already typed is not replaced by the imported folder", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    routeFetch({
      "GET /tasks": async () => ok(view([task()], { ok: false, reason: "Choose it below." })),
      "GET /api/launch-folder": async () => { await gate; return { ok: true, status: 200, json: async () => ({ available: true, name: "old", path: "/work/old" }) }; },
    });
    renderScreen();
    fireEvent.change(await screen.findByLabelText("Git folder"), { target: { value: "/mine" } });
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByLabelText("Git folder").value).toBe("/mine");
  });

  test("the git folder box starts with the folder already imported", async () => {
    routeFetch({ "GET /tasks": async () => ok(view([task()], { ok: false, reason: "Choose it below.", suggested: "/work/imported" })) });
    renderScreen();
    expect((await screen.findByLabelText("Git folder")).value).toBe("/work/imported");
  });

  test("Start worker dispatches with the model and shows the brief and commands once", async () => {
    let tasks = [task()];
    const fetch = routeFetch({
      "GET /tasks": async () => ok(view(tasks)),
      "POST /tasks/T-1/dispatch": async (init) => {
        expect(JSON.parse(init.body)).toEqual({ model: "claude-sonnet-4-5" });
        tasks = [task({ worktree: { path: "/work/notes/.perfect-planner/worktrees/T-1", branch: "pp/T-1", base: "main", port: 5200 }, dispatch: { issuedAt: "now", model: "claude-sonnet-4-5" } })];
        return ok({ task: "T-1", title: "Save notes", worktree: "/work/notes/.perfect-planner/worktrees/T-1", branch: "pp/T-1", tokenFile: "/p/.perfect-planner/tokens/T-1.token", brief: "You are a Perfect Planner worker on T-1: Save notes.\n2. Test first: … propose_test", setup: `cd "/w" && claude mcp add perfect-planner-core --env 'PP_AGENT_TOKEN_FILE=/p/.perfect-planner/tokens/T-1.token' -- node '/a'`, start: 'claude "$(cat "/b/T-1.md")"', json: "{}", agents: { gemini: { setup: "cd /w && node connect.mjs --agent gemini", start: "gemini --approval-mode auto_edit -i brief", note: "Choose Trust folder first." }, codex: { setup: "cd /w && node connect.mjs --agent codex", start: "codex -s workspace-write -a on-request brief", note: "One connection per computer." } }, shell: "Terminal", agentBuilt: true });
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
    expect(screen.getByLabelText("gemini start for T-1").textContent).toContain("auto_edit");
    expect(screen.getByLabelText("codex set-up for T-1").textContent).toContain("--agent codex");
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

  test("a diff that changes files able to run code needs its own confirmation before Approve", async () => {
    const tree = { path: "/w", branch: "pp/T-1", base: "main", port: 5200 };
    const tasks = [task({ status: "claimed", owner: "worker-1", stage: "review-diff", worktree: tree, check: { passed: true, commit: "abc123" } })];
    const sensitive = [".github/workflows/ci.yml", "package.json"];
    let approvedWith = null;
    routeFetch({
      "GET /tasks": async () => ok(view(tasks)),
      "GET /tasks/T-1/diff": async () => ok({ task: "T-1", files: [...sensitive, "src/save.js"], sensitive, text: '+  "postinstall": "node setup.js"', commit: "abc123" }),
      "POST /tasks/T-1/approve-diff": async (init) => { approvedWith = JSON.parse(init.body); return ok(view(tasks)); },
    });
    renderScreen();
    fireEvent.click(within(await card("T-1 Save notes")).getByRole("button", { name: "Show diff" }));
    const block = await screen.findByRole("alert", { name: "Files that can run code in T-1" });
    expect(block.textContent).toMatch(/can run code on your computer/);
    expect(block.textContent).toMatch(/Test files are listed too/);
    expect(within(block).getByText("package.json")).toBeTruthy();
    expect(within(block).getByText(".github/workflows/ci.yml")).toBeTruthy();
    const approve = within(await card("T-1 Save notes")).getByRole("button", { name: "Approve diff at abc123" });
    expect(approve.disabled).toBe(true);
    fireEvent.click(within(block).getByRole("checkbox", { name: /safe to run on my computer/ }));
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    await waitFor(() => expect(approvedWith).toEqual({ commit: "abc123", confirmSensitive: sensitive }));
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

  test("Release claim is offered only while a worker holds the task, says the work is kept, and frees it", async () => {
    const tree = { path: "/w", branch: "pp/T-1", base: "main", port: 5200 };
    let tasks = [
      task({ status: "claimed", owner: "worker-1", stage: "building", worktree: tree }),
      task({ id: "T-2", label: "T-2", title: "Open notes", stage: "ready-to-claim" }),
      task({ id: "T-3", label: "T-3", title: "Sync notes", status: "done", stage: "done" }),
    ];
    const fetch = routeFetch({
      "GET /tasks": async () => ok(view(tasks)),
      "POST /tasks/T-1/release": async (init) => {
        expect(JSON.parse(init.body)).toEqual({ owner: "worker-1", reason: "Its window was closed" });
        tasks = [{ ...tasks[0], status: "open", owner: null, stage: "ready-to-claim" }, tasks[1], tasks[2]];
        return ok({ released: "T-1", from: "worker-1", entry: "L-000020", ...view(tasks) });
      },
    });
    renderScreen();
    const t1 = await card("T-1 Save notes");
    expect(within(await card("T-2 Open notes")).queryByRole("button", { name: "Release claim" })).toBeNull();
    expect(within(await card("T-3 Sync notes")).queryByRole("button", { name: "Release claim" })).toBeNull();
    fireEvent.click(within(t1).getByRole("button", { name: "Release claim" }));
    expect(within(t1).getByText(/Release this task so another worker can take it\. Its worktree and commits are kept\./)).toBeTruthy();
    // Nothing is sent until the person confirms.
    expect(fetch.mock.calls.some(([u]) => String(u).includes("/release"))).toBe(false);
    fireEvent.change(within(t1).getByLabelText("Why (optional)"), { target: { value: "Its window was closed" } });
    fireEvent.click(within(t1).getByRole("button", { name: "Release T-1" }));
    expect(await screen.findByText(/Released T-1 from worker-1\. Its worktree and commits are kept/)).toBeTruthy();
    const after = await card("T-1 Save notes");
    expect(within(after).queryByRole("button", { name: "Release claim" })).toBeNull();
    expect(within(after).getByRole("button", { name: "Start worker" })).toBeTruthy();
  });

  test("a stalled worker's task shows the stalled flag beside the Release button", async () => {
    const tree = { path: "/w", branch: "pp/T-1", base: "main", port: 5200 };
    routeFetch({ "GET /tasks": async () => ok(view([task({ status: "claimed", owner: "worker-1", stage: "building", worktree: tree, stalled: true })])) });
    renderScreen();
    const t1 = await card("T-1 Save notes");
    const flag = within(t1).getByText("stalled");
    const release = within(t1).getByRole("button", { name: "Release claim" });
    expect(flag.nextElementSibling).toBe(release);
  });

  const jevTree = { path: "/w", branch: "pp/T-1", base: "main", port: 5200 };
  const jevTest = { entry: "L-000007", command: "npm test", files: ["save.test.js"], by: "worker-1" };

  test("with a Jev key saved, a task waiting on Jev says so and Ask Jev again asks it about the same test", async () => {
    let tasks = [task({
      status: "open", stage: "waiting-for-jev", worktree: jevTree, test: jevTest, approval: { by: "you" }, baseline: { passed: false },
      jev: { required: true, test: { state: "unavailable", message: "Jev could not be reached, so nothing was approved.", reasons: [], canRetry: true }, diff: null },
    })];
    let sent = null;
    routeFetch({
      "GET /tasks": async () => ok(view(tasks)),
      "POST /tasks/T-1/approve-test": async (init) => {
        sent = JSON.parse(init.body);
        const line = { state: "approved", message: "Jev read the test and found no gaps.", reasons: [], canRetry: false };
        tasks = [{ ...tasks[0], stage: "ready-to-claim", jev: { required: true, test: line, diff: null } }];
        return ok({ failsFirst: true, jev: line, ...view(tasks) });
      },
    });
    renderScreen();
    const t1 = await card("T-1 Save notes");
    expect(within(t1).getByText("Waiting for Jev")).toBeTruthy();
    expect(within(t1).getByText(/Jev could not be reached, so nothing was approved/)).toBeTruthy();
    fireEvent.click(within(t1).getByRole("button", { name: "Ask Jev again" }));
    expect(await screen.findByText(/Jev found no gaps, so the worker can claim the task now/)).toBeTruthy();
    expect(sent).toEqual({ test: "L-000007" });
    const after = await card("T-1 Save notes");
    expect(within(after).queryByRole("button", { name: "Ask Jev again" })).toBeNull();
    expect(within(after).getByText(/Jev read the test and found no gaps/)).toBeTruthy();
  });

  test("when Jev finds gaps in the test, the reasons are shown to the person with no retry button", async () => {
    routeFetch({
      "GET /tasks": async () => ok(view([task({
        stage: "jev-found-gaps", worktree: jevTree, test: jevTest, approval: { by: "you" }, baseline: { passed: false },
        jev: { required: true, test: { state: "gaps", message: "Jev found gaps in the test.", reasons: ["It never checks the saved file contents."], canRetry: false }, diff: null },
      })])),
    });
    renderScreen();
    const t1 = await card("T-1 Save notes");
    expect(within(t1).getByText("Jev found gaps")).toBeTruthy();
    expect(within(t1).getByText("It never checks the saved file contents.")).toBeTruthy();
    expect(within(t1).queryByRole("button", { name: "Ask Jev again" })).toBeNull();
  });

  test("a diff Jev sends back is not approved: the person is told why and the task shows as reopened", async () => {
    let tasks = [task({
      status: "claimed", owner: "worker-1", stage: "review-diff", worktree: jevTree, check: { passed: true, commit: "abc123" },
      jev: { required: true, test: { state: "approved", message: "Jev read the test and found no gaps.", reasons: [], canRetry: false }, diff: null },
    })];
    routeFetch({
      "GET /tasks": async () => ok(view(tasks)),
      "GET /tasks/T-1/diff": async () => ok({ task: "T-1", files: ["src/save.js"], sensitive: [], text: "+export const save = 1;", commit: "abc123" }),
      "POST /tasks/T-1/approve-diff": async () => {
        tasks = [{ ...tasks[0], status: "open", owner: null, stage: "ready-to-claim", attempt: 2, label: "T-1.a2", worktree: null }];
        return ok({ approved: false, reopenedAs: "T-1.a2", jev: { state: "gaps", message: "Jev found problems in the change.", reasons: ["It writes outside the notes folder."], canRetry: false }, ...view(tasks) });
      },
    });
    renderScreen();
    fireEvent.click(within(await card("T-1 Save notes")).getByRole("button", { name: "Show diff" }));
    expect(await screen.findByText("+export const save = 1;")).toBeTruthy();
    fireEvent.click(within(await card("T-1 Save notes")).getByRole("button", { name: "Approve diff at abc123" }));
    const note = await screen.findByText(/Jev sent the change back, so it was not approved/);
    expect(note.textContent).toMatch(/It writes outside the notes folder\./);
    expect(note.textContent).toMatch(/Reopened as T-1\.a2/);
    // The sent-back change is no longer on the card.
    expect(screen.queryByText("+export const save = 1;")).toBeNull();
  });

  test("without a Jev key nothing about Jev is shown", async () => {
    routeFetch({ "GET /tasks": async () => ok(view([task({ stage: "ready-to-claim", worktree: jevTree, test: jevTest, approval: { by: "you" }, baseline: { passed: false }, jev: null })])) });
    renderScreen();
    const t1 = await card("T-1 Save notes");
    expect(within(t1).queryByText(/Jev/)).toBeNull();
    expect(within(t1).queryByRole("button", { name: /Jev/ })).toBeNull();
  });
});

describe("TasksScreen: waiting on other tasks, updating from main, releasing file claims", () => {
  const tree = { path: "/w", branch: "pp/T-2", base: "main", port: 5201 };

  test("a task that waits for another says why and cannot be started", async () => {
    const message = "T-2 cannot start yet because it needs another task finished and merged first: T-1 (Save notes) is not started. Start it once that one is done.";
    routeFetch({ "GET /tasks": async () => ok(view([task({ id: "T-2", label: "T-2", title: "Export notes", waitingFor: { tasks: ["T-1"], message } }), task({ title: "Save notes" })])) });
    renderScreen();
    const t2 = await card("T-2 Export notes");
    expect(within(t2).getByText(message)).toBeTruthy();
    expect(within(t2).getByRole("button", { name: "Start worker" }).disabled).toBe(true);
    expect(within(await card("T-1 Save notes")).getByRole("button", { name: "Start worker" }).disabled).toBe(false);
  });

  test("Bring this task up to date with main is offered with a worktree, sends nothing else, and shows the plain answer", async () => {
    let calls = 0;
    const fetch = routeFetch({
      "GET /tasks": async () => ok(view([task({ id: "T-2", label: "T-2", title: "Export notes", stage: "building", status: "claimed", owner: "w", worktree: tree }), task({ title: "Save notes" })])),
      "POST /tasks/T-2/update-from-main": async (init) => {
        calls += 1;
        expect(JSON.parse(init.body)).toEqual({});
        return ok({ updated: true, message: "T-2 now has the 2 new changes from main, merged with its own work. Its own files were not touched. The work changed, so run Check the work again and approve the diff again.", tasks: [] });
      },
    });
    renderScreen();
    const t2 = await card("T-2 Export notes");
    expect(within(await card("T-1 Save notes")).queryByRole("button", { name: /up to date with/ })).toBeNull();
    fireEvent.click(within(t2).getByRole("button", { name: "Bring this task up to date with main" }));
    expect(await screen.findByText(/T-2 now has the 2 new changes from main/)).toBeTruthy();
    expect(calls).toBe(1);
    expect(fetch.mock.calls.filter(([u, i]) => i?.method === "POST").length).toBe(1);
  });

  test("a refused update shows the reason in plain words", async () => {
    routeFetch({
      "GET /tasks": async () => ok(view([task({ id: "T-2", label: "T-2", title: "Export notes", stage: "building", status: "claimed", owner: "w", worktree: tree })])),
      "POST /tasks/T-2/update-from-main": async () => refused("T-2 has changes that are not committed yet (src/a.ts). Let the worker commit them, or move them aside, then update again. Nothing in T-2's folder was changed."),
    });
    renderScreen();
    const t2 = await card("T-2 Export notes");
    fireEvent.click(within(t2).getByRole("button", { name: "Bring this task up to date with main" }));
    expect(await screen.findByText(/not committed yet \(src\/a\.ts\)\. .* Nothing in T-2's folder was changed\./)).toBeTruthy();
  });

  test("Release file claims appears only for stale claims, names the reason, and posts once", async () => {
    let tasks = [
      task({ id: "T-2", label: "T-2", title: "Export notes", worktree: tree, claims: ["src/a.ts", "docs/**"], staleClaims: "T-2 has no worker on it" }),
      task({ title: "Save notes", worktree: { ...tree, branch: "pp/T-1" }, claims: ["src/b.ts"], staleClaims: null }),
    ];
    const fetch = routeFetch({
      "GET /tasks": async () => ok(view(tasks)),
      "POST /tasks/T-2/release-claims": async () => {
        tasks = [{ ...tasks[0], claims: [], staleClaims: null }, tasks[1]];
        return ok({ released: ["src/a.ts", "docs/**"], message: "Released src/a.ts, docs/**. Other tasks can claim them now.", ...view(tasks) });
      },
    });
    renderScreen();
    const t2 = await card("T-2 Export notes");
    expect(within(t2).getByText(/src\/a\.ts, docs\/\*\* \(T-2 has no worker on it, so these can be released\)/)).toBeTruthy();
    expect(within(await card("T-1 Save notes")).queryByRole("button", { name: "Release file claims" })).toBeNull();
    fireEvent.click(within(t2).getByRole("button", { name: "Release file claims" }));
    expect(await screen.findByText(/Other tasks can claim them now/)).toBeTruthy();
    expect(fetch.mock.calls.filter(([u, i]) => String(u).includes("release-claims") && i?.method === "POST").length).toBe(1);
    await waitFor(() => expect(within(t2).queryByRole("button", { name: "Release file claims" })).toBeNull());
  });
});

describe("TasksScreen queue and batch", () => {
  const queueOf = (over) => ({ limit: 2, running: [], notStarted: [], waitingForYou: [], readyToMerge: [], done: 0, ...over });
  const withQueue = (tasks, queue, settings = { limit: 2, autoMerge: false }) => ({ repo: REPO, tasks, queue, settings });
  const diffOf = (id, commit, files, sensitive = []) => ({ task: id, base: "b", commit, files, sensitive, text: "+x", truncated: false });

  test("shows the line: running of limit, what waits and why, and Start all starts only what can start", async () => {
    let started = false;
    const fetch = routeFetch({
      "GET /tasks": async () => ok(withQueue([task({ id: "T-1", label: "T-1" }), task({ id: "T-2", label: "T-2", title: "Share" }), task({ id: "T-3", label: "T-3", title: "Export" })], queueOf({ notStarted: [{ id: "T-1", why: "Can start now." }, { id: "T-2", why: "Waiting for a free worker (limit 2)." }, { id: "T-3", why: "T-3 cannot start yet because it needs T-1." }] }))),
      "POST /tasks/start-all": async (init) => {
        started = true;
        expect(JSON.parse(init.body)).toEqual({ model: "claude-sonnet-4-5" });
        return ok({ ...withQueue([task()], queueOf()), started: [{ task: "T-1", title: "Save notes", worktree: "/w", branch: "pp/T-1", tokenFile: "/t", brief: "b", setup: "cd /w", start: "claude x", json: "{}", shell: "Terminal" }], refused: [] });
      },
    });
    renderScreen();
    const queue = await screen.findByRole("region", { name: "Worker queue" });
    expect(within(queue).getByText(/0 of 2 workers running · 3 not started/)).toBeTruthy();
    expect(within(queue).getByText("Waiting for a free worker (limit 2).")).toBeTruthy();
    expect(within(queue).getByText(/cannot start yet/)).toBeTruthy();
    fireEvent.click(within(queue).getByRole("button", { name: /Start all \(1\)/ }));
    await waitFor(() => expect(started).toBe(true));
    expect(await within(queue).findByText(/Started 1 worker; the commands are on each card/)).toBeTruthy();
    expect(fetch.mock.calls.some(([u]) => String(u).includes("/tasks/start-all"))).toBe(true);
  });

  test("changing the limit and the auto-merge switch are saved", async () => {
    const bodies = [];
    routeFetch({
      "GET /tasks": async () => ok(withQueue([task()], queueOf())),
      "POST /tasks/settings": async (init) => { bodies.push(JSON.parse(init.body)); return ok(withQueue([task()], queueOf())); },
    });
    renderScreen();
    const queue = await screen.findByRole("region", { name: "Worker queue" });
    fireEvent.change(within(queue).getByLabelText("Workers at once"), { target: { value: "5" } });
    await waitFor(() => expect(bodies).toEqual([{ limit: 5 }]));
    fireEvent.click(within(queue).getByLabelText(/Merge right after I approve a diff with no flagged files/));
    await waitFor(() => expect(bodies[1]).toEqual({ autoMerge: true }));
  });

  test("batch: clean diffs are offered together, a flagged one is only listed, and the result says what happened per task", async () => {
    const t = (n, stage, extra = {}) => task({ id: `T-${n}`, label: `T-${n}`, title: `Task ${n}`, stage, status: "claimed", ...extra });
    const tasks = [t(1, "review-diff"), t(2, "review-diff"), t(3, "review-diff"), t(4, "ready-to-merge", { diffApproval: { commit: "d".repeat(40) } })];
    let sent;
    routeFetch({
      "GET /tasks": async () => ok(withQueue(tasks, queueOf({ waitingForYou: ["T-1", "T-2", "T-3"], readyToMerge: ["T-4"] }))),
      "GET /tasks/T-1/diff": async () => ok(diffOf("T-1", "a".repeat(40), ["src/a.js", "tests/a.test.js"])),
      "GET /tasks/T-2/diff": async () => ok(diffOf("T-2", "b".repeat(40), ["src/b.js"])),
      "GET /tasks/T-3/diff": async () => ok(diffOf("T-3", "c".repeat(40), ["package.json"], ["package.json"])),
      "POST /tasks/batch": async (init) => {
        sent = JSON.parse(init.body);
        return ok({ ...withQueue([], queueOf()), results: [{ id: "T-1", outcome: "merged", message: "Approved and merged." }, { id: "T-2", outcome: "failed", message: "The test fails after the merge (exit code 1).\n\nEnd of the test output:\nexpected 2 got 3" }, { id: "T-4", outcome: "merged", message: "Merged." }] });
      },
    });
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Review 4 finished tasks together" }));
    const panel = await screen.findByRole("region", { name: "Approve together" });
    expect(within(panel).getByText("3 with no flagged files")).toBeTruthy();
    expect(within(panel).getByText("1 to read yourself")).toBeTruthy();
    expect(within(panel).getByText(/flagged: package.json/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Approve and merge these 3" }));
    await waitFor(() => expect(sent).toBeTruthy());
    expect(sent.items).toEqual([{ id: "T-1", commit: "a".repeat(40) }, { id: "T-2", commit: "b".repeat(40) }, { id: "T-4", commit: "d".repeat(40) }]);
    const result = await screen.findByRole("status", { name: "Batch result" });
    expect(within(result).getByText(/T-1 Merged\./)).toBeTruthy();
    expect(within(result).getByText(/T-2 Failed\./)).toBeTruthy();
    expect(result.textContent).toContain("expected 2 got 3");
  });

  test("a merge refused after the test failed shows the end of the test output", async () => {
    const t = task({ id: "T-1", label: "T-1", stage: "ready-to-merge", status: "claimed", diffApproval: { commit: "a".repeat(40) }, worktree: { path: "/w", branch: "pp/T-1", base: "main", port: 5200 } });
    routeFetch({
      "GET /tasks": async () => ok(view([t])),
      "POST /tasks/T-1/merge": async () => refused("The test fails after the merge (exit code 1); main was left untouched.\n\nEnd of the test output:\nexpected 2 got 3"),
    });
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: /Merge into main/ }));
    const notice = await screen.findByText(/main was left untouched/);
    expect(notice.textContent).toContain("expected 2 got 3");
  });
});
