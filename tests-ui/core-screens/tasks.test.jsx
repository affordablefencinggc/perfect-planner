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

  describe("the contract", () => {
    const contract = (over = {}) => ({
      status: "signed",
      clauses: ["Make saving work."],
      doneWhen: "the approved test passes",
      listed: ["src/notes/**"],
      allowedFiles: ["src/notes/**"],
      sizeCap: { maxFiles: 3, maxLines: 40 },
      flags: [],
      flagsAccepted: false,
      widened: [],
      check: null,
      ...over,
    });

    test("shows a collapsed Contract with the files and the limit, and says plainly when a task has none", async () => {
      routeFetch({ "GET /tasks": async () => ok(view([task({ contract: contract() }), task({ id: "T-2", label: "T-2", title: "Open notes", contract: null })])) });
      renderScreen();
      const t1 = await card("T-1 Save notes");
      const details = t1.querySelector("details.core-contract");
      expect(details.open).toBe(false);
      expect(within(t1).getByText(/Contract/, { selector: "summary" }).textContent).toMatch(/1 file or folder · up to 3 files and 40 lines/);
      expect(within(t1).getByText("src/notes/**")).toBeTruthy();
      expect(within(t1).getByText(/Anything else is refused, including dependency files/)).toBeTruthy();
      const t2 = await card("T-2 Open notes");
      expect(t2.querySelector("details.core-contract")).toBeNull();
      expect(within(t2).getByText(/None\. This task is not limited to any files\./)).toBeTruthy();
    });

    test("shows what the last check said, what the owner allowed, and a contract that is not the signed one", async () => {
      routeFetch({
        "GET /tasks": async () => ok(view([
          task({ contract: contract({ allowedFiles: ["package.json", "src/notes/**"], widened: [{ decision: "D-4", files: ["package.json"], by: "owner", reason: "it needs left-pad" }], check: { ok: false, commit: "a".repeat(40), files: 2, lines: 5, reason: "T-1's contract does not allow this work. It changes a file that is not on its list: src/other/other.js." } }) }),
          task({ id: "T-2", label: "T-2", title: "Open notes", contract: contract({ status: "unsigned", problem: "The contract on T-2 is not the one you approved with P-1: its digest differs." }) }),
        ])),
      });
      renderScreen();
      const t1 = await card("T-1 Save notes");
      expect(within(t1).getByText(/You allowed package\.json \(D-4\): it needs left-pad/)).toBeTruthy();
      expect(within(t1).getByText(/not on its list: src\/other\/other\.js/)).toBeTruthy();
      const t2 = await card("T-2 Open notes");
      expect(within(t2).getByRole("alert").textContent).toMatch(/not the one you approved with P-1.*Nothing is started or checked until it is/);
      // An unsigned contract cannot be widened.
      expect(within(t2).queryByRole("button", { name: "Allow more files" })).toBeNull();
    });

    test("the person allows more files with a reason; nothing is sent until they submit", async () => {
      let tasks = [task({ contract: contract() })];
      const fetch = routeFetch({
        "GET /tasks": async () => ok(view(tasks)),
        "POST /tasks/T-1/widen": async (init) => {
          expect(JSON.parse(init.body)).toEqual({ files: ["package.json", "docs/notes.md"], reason: "it needs left-pad" });
          tasks = [task({ contract: contract({ allowedFiles: ["docs/notes.md", "package.json", "src/notes/**"], widened: [{ decision: "D-4", files: ["docs/notes.md", "package.json"], by: "owner", reason: "it needs left-pad" }] }) })];
          return ok({ widened: { decision: "D-4", entry: "L-000030", files: ["docs/notes.md", "package.json"] }, ...view(tasks) });
        },
      });
      renderScreen();
      const t1 = await card("T-1 Save notes");
      fireEvent.click(within(t1).getByRole("button", { name: "Allow more files" }));
      const submit = within(t1).getByRole("button", { name: "Allow these files" });
      expect(submit.disabled).toBe(true);
      fireEvent.change(within(t1).getByLabelText(/Files or folders to allow/), { target: { value: "package.json\n docs/notes.md\n" } });
      fireEvent.change(within(t1).getByLabelText("Why"), { target: { value: "it needs left-pad" } });
      expect(fetch.mock.calls.some(([u]) => String(u).includes("/widen"))).toBe(false);
      fireEvent.click(within(t1).getByRole("button", { name: "Allow these files" }));
      expect(await screen.findByText(/Allowed docs\/notes\.md, package\.json\./)).toBeTruthy();
      await waitFor(() => expect(within(t1).getByText(/You allowed docs\/notes\.md, package\.json \(D-4\)/)).toBeTruthy());
    });

    test("a refused check is shown in plain words, naming the files", async () => {
      const reason = "T-1's contract does not allow this work. It changes a file that is not on its list: src/other/other.js. Nothing was approved.";
      routeFetch({
        "GET /tasks": async () => ok(view([task({ status: "claimed", owner: "worker-1", stage: "building", contract: contract() })])),
        "POST /tasks/T-1/check": async () => ok({ passed: false, contractRefused: true, commit: "a".repeat(40), reason, ...view([task({ status: "claimed", owner: "worker-1", stage: "building", contract: contract() })]) }),
      });
      renderScreen();
      const t1 = await card("T-1 Save notes");
      fireEvent.click(within(t1).getByRole("button", { name: "Check the work" }));
      expect(await screen.findByText(/not on its list: src\/other\/other\.js/, { selector: "p.core-tasks-notice" })).toBeTruthy();
    });
  });
});
