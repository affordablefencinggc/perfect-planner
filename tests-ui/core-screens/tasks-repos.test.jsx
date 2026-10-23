import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import TasksScreen from "../../src/core-screens/TasksScreen.jsx";
import { ViewModeContext } from "../../src/project/viewMode.js";

const MAIN = { name: "main", ok: true, root: "/work/api", worktrees: 0 };
const WEB = { name: "web", ok: true, root: "/work/web", worktrees: 0 };
const base = { label: "T-1", status: "open", stage: "needs-test", owner: null, attempt: 1, clauses: [], lastProgress: null, proofs: [], test: null, approval: null, baseline: null, check: null, diffApproval: null, merged: null, worktree: null, dispatch: null, history: [], group: null };
const task = (over) => ({ ...base, ...over });
const ok = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
const refused = (message) => ({ ok: false, status: 409, json: async () => ({ ok: false, code: "REPO_IN_USE", message }) });
const emptyCost = { project: { calls: 0, usd: 0 }, byRepo: [], byTask: [], byModel: [], ignored: 0, prices: {} };

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

const renderScreen = () =>
  render(
    <ViewModeContext.Provider value={{ mode: "simple", isAdvanced: false, setMode: () => {} }}>
      <TasksScreen />
    </ViewModeContext.Provider>,
  );

beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("repos on the Tasks screen", () => {
  test("lists each repo, tags tasks with their repo, and adds a repo by name and folder", async () => {
    let repos = [MAIN];
    const fetch = routeFetch({
      "GET /tasks": async () => ok({ repo: MAIN, repos, tasks: [task({ id: "T-1", title: "API route", repo: "main" }), task({ id: "T-2", label: "T-2", title: "Web page", repo: repos.length > 1 ? "web" : "main" })], groups: [] }),
      "GET /cost": async () => ok(emptyCost),
      "POST /repos": async (init) => { expect(JSON.parse(init.body)).toEqual({ name: "web", root: "/work/web" }); repos = [MAIN, WEB]; return ok({ repo: MAIN, repos, tasks: [], groups: [] }); },
    });
    renderScreen();
    const bar = await screen.findByRole("region", { name: "Repos in this project" });
    expect(within(bar).getByText("/work/api")).toBeTruthy();
    fireEvent.click(within(bar).getByText("Add another repo to this project"));
    fireEvent.change(within(bar).getByLabelText("Name"), { target: { value: "web" } });
    fireEvent.change(within(bar).getByLabelText("Git folder"), { target: { value: "/work/web" } });
    fireEvent.click(within(bar).getByRole("button", { name: "Add repo" }));
    await waitFor(() => expect(fetch.mock.calls.some(([u, i]) => String(u).includes("/repos") && i?.method === "POST")).toBe(true));
    const t2 = await screen.findByRole("article", { name: /T-2 Web page/ });
    expect(within(t2).getByText("web")).toBeTruthy();
  });

  test("a refused add shows the reason and keeps the form", async () => {
    routeFetch({
      "GET /tasks": async () => ok({ repo: MAIN, repos: [MAIN], tasks: [task({ id: "T-1", title: "API route", repo: "main" })], groups: [] }),
      "GET /cost": async () => ok(emptyCost),
      "POST /repos": async () => refused("Another project on this computer (beta) already uses this git folder."),
    });
    renderScreen();
    const bar = await screen.findByRole("region", { name: "Repos in this project" });
    fireEvent.click(within(bar).getByText("Add another repo to this project"));
    fireEvent.change(within(bar).getByLabelText("Name"), { target: { value: "web" } });
    fireEvent.change(within(bar).getByLabelText("Git folder"), { target: { value: "/work/web" } });
    fireEvent.click(within(bar).getByRole("button", { name: "Add repo" }));
    expect((await within(bar).findByRole("alert")).textContent).toContain("beta");
  });

  test("a repo that cannot be used says why, and an extra repo can be removed", async () => {
    const fetch = routeFetch({
      "GET /tasks": async () => ok({ repo: MAIN, repos: [MAIN, { ...WEB, ok: false, root: undefined, reason: "The folder of repo \"web\" is no longer a git repository." }], tasks: [task({ id: "T-1", title: "API route", repo: "main" })], groups: [] }),
      "GET /cost": async () => ok(emptyCost),
      "POST /repos/remove": async (init) => { expect(JSON.parse(init.body)).toEqual({ name: "web" }); return ok({ repo: MAIN, repos: [MAIN], tasks: [], groups: [] }); },
    });
    renderScreen();
    expect(await screen.findByText(/no longer a git repository/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove repo main" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove repo web" }));
    await waitFor(() => expect(fetch.mock.calls.some(([u]) => String(u).includes("/repos/remove"))).toBe(true));
  });

  test("merge together is off until every part is ready, then sends the approved commit of each part", async () => {
    const commit = (c) => ({ commit: c.repeat(40) });
    let ready = false;
    const fetch = routeFetch({
      "GET /tasks": async () => ok({
        repo: MAIN,
        repos: [MAIN, WEB],
        tasks: [task({ id: "T-1", title: "Sync (main)", repo: "main", group: "g1", stage: "ready-to-merge", diffApproval: commit("a") }), task({ id: "T-2", label: "T-2", title: "Sync (web)", repo: "web", group: "g1", stage: ready ? "ready-to-merge" : "review-diff", diffApproval: ready ? commit("b") : null })],
        groups: [{ group: "g1", tasks: ["T-1", "T-2"], ready, done: false }],
      }),
      "GET /cost": async () => ok(emptyCost),
      "POST /tasks/groups/g1/merge": async (init) => { expect(JSON.parse(init.body)).toEqual({ commits: { "T-1": "a".repeat(40), "T-2": "b".repeat(40) } }); return ok({ merged: [{ task: "T-1", repo: "main", commit: "x" }, { task: "T-2", repo: "web", commit: "y" }], repo: MAIN, repos: [MAIN, WEB], tasks: [], groups: [] }); },
    });
    const view = renderScreen();
    const group = await screen.findByRole("group", { name: /merge together/ });
    expect(within(group).getByRole("button", { name: "Merge together" }).disabled).toBe(true);
    expect(group.textContent).toContain("T-1 (main) + T-2 (web)");
    ready = true;
    view.unmount();
    renderScreen();
    const button = await screen.findByRole("button", { name: "Merge together" });
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(fetch.mock.calls.some(([u, i]) => String(u).includes("/groups/g1/merge") && i?.method === "POST")).toBe(true));
  });
});

describe("cost on the Tasks screen", () => {
  const row = (over) => ({ calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reportedUsd: 0, measuredUsd: 0, estimatedUsd: 0, unpricedTokens: 0, usd: 0, ...over });

  test("says where each figure came from, and shows no dollars for work that reported none", async () => {
    routeFetch({
      "GET /tasks": async () => ok({ repo: MAIN, repos: [MAIN], tasks: [task({ id: "T-1", title: "API route", repo: "main" })], groups: [] }),
      "GET /cost": async () => ok({
        project: row({ calls: 3, inputTokens: 1_200_000, outputTokens: 80_000, reportedUsd: 0.25, estimatedUsd: 4.5, unpricedTokens: 3000, usd: 4.75 }),
        byRepo: [],
        byTask: [{ ...row({ calls: 3, reportedUsd: 0.25, estimatedUsd: 4.5, usd: 4.75 }), key: "T-1", repo: "main", runs: [] }, { ...row(), key: "T-2", repo: "main", runs: [] }],
        byModel: [],
        ignored: 2,
        prices: { "claude-x": { inputPerMillion: 3, outputPerMillion: 15 } },
      }),
    });
    renderScreen();
    const panel = (await screen.findByText(/^Cost: \$4\.75/)).closest("details");
    expect(panel.textContent).toContain("$0.25 reported by the agent");
    expect(panel.textContent).toContain("$4.50 estimated from your prices");
    expect(panel.textContent).toContain("3.0k tokens with no price");
    expect(panel.textContent).toContain("no usage reported");
    expect(panel.textContent).toContain("2 usage lines with impossible numbers were left out");
    expect(panel.textContent).toContain("claude-x $3 in / $15 out");
    expect(panel.textContent).not.toContain("$0.00");
  });

  test("saves a price along with the ones already there", async () => {
    const fetch = routeFetch({
      "GET /tasks": async () => ok({ repo: MAIN, repos: [MAIN], tasks: [task({ id: "T-1", title: "API route", repo: "main" })], groups: [] }),
      "GET /cost": async () => ok({ ...emptyCost, prices: { "claude-x": { inputPerMillion: 3, outputPerMillion: 15 } } }),
      "POST /cost/prices": async (init) => { expect(JSON.parse(init.body)).toEqual({ "claude-x": { inputPerMillion: 3, outputPerMillion: 15 }, "claude-y": { inputPerMillion: 1, outputPerMillion: 5 } }); return ok(emptyCost); },
    });
    renderScreen();
    const form = await screen.findByRole("form", { name: "Your prices per million tokens" });
    fireEvent.change(within(form).getByLabelText("Model"), { target: { value: "claude-y" } });
    fireEvent.change(within(form).getByLabelText("$ per million in"), { target: { value: "1" } });
    fireEvent.change(within(form).getByLabelText("$ per million out"), { target: { value: "5" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save price" }));
    await waitFor(() => expect(fetch.mock.calls.some(([u, i]) => String(u).includes("/cost/prices") && i?.method === "POST")).toBe(true));
  });
});
