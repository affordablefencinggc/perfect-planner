import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import TasksScreen from "../../src/core-screens/TasksScreen.jsx";
import CoreSpine from "../../src/core-screens/CoreSpine.jsx";
import { ViewModeContext } from "../../src/project/viewMode.js";

const task = (extra = {}) => ({ id: "T-6", label: "T-6", title: "Retain setup", status: "open", stage: "needs-test", owner: null, clauses: [], proofs: [], lastProgress: null, test: null, approval: null, baseline: null, check: null, diffApproval: null, merged: null, worktree: null, dispatch: null, history: [], ...extra });
const ok = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });

function Harness() {
  const [workspace, setWorkspace] = useState("tasks");
  const [dispatches, setDispatches] = useState({});
  return <ViewModeContext.Provider value={{ mode: "simple", isAdvanced: false, setMode: () => {} }}>
    {workspace === "tasks"
      ? <TasksScreen onWorkspace={setWorkspace} pendingDispatches={dispatches} onPendingDispatchesChange={setDispatches} />
      : <CoreSpine onWorkspace={setWorkspace} actions accountAll pendingDispatches={dispatches} />}
  </ViewModeContext.Provider>;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test("accepted dispatch retains its exact setup panel through Build until the person returns", async () => {
  let rows = [task()];
  const fetch = vi.fn(async (url, init = {}) => {
    const path = String(url).split("?")[0].replace("/api/core", "");
    if (path === "/session") return ok({ person: true });
    if (path === "/agents") return ok({ agents: [] });
    if (path === "/tasks") return ok({ repo: { ok: true, root: "/repo" }, tasks: rows });
    if (path === "/tasks/T-6/dispatch") {
      rows = [task({ dispatch: { model: "gpt-5.6-terra" }, worktree: { path: "/repo/.perfect-planner/worktrees/T-6" } })];
      return ok({ task: "T-6", model: "gpt-5.6-terra", brief: "brief", json: "{}", shell: "PowerShell", agents: { codex: { setup: "connect codex", start: "start codex", note: "one setup" } } });
    }
    throw new Error(`unexpected ${path}`);
  });
  vi.stubGlobal("fetch", fetch);
  render(<Harness />);
  const card = await screen.findByRole("article", { name: "T-6 Retain setup" });
  fireEvent.change(within(card).getByLabelText("Worker model"), { target: { value: "gpt-5.6-terra" } });
  fireEvent.click(within(card).getByRole("button", { name: "Start worker" }));
  expect(await screen.findByRole("button", { name: "Finish connecting worker" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Finish connecting worker" }));
  expect((await screen.findByLabelText("Set-up command for T-6")).textContent).toContain("connect codex");
  expect(fetch.mock.calls.filter(([url]) => String(url).includes("/dispatch"))).toHaveLength(1);
});

test("a refused dispatch stays actionable on Tasks and never offers retained setup", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const path = String(url).split("?")[0].replace("/api/core", "");
    if (path === "/session") return ok({ person: true });
    if (path === "/tasks") return ok({ repo: { ok: true, root: "/repo" }, tasks: [task()] });
    if (path === "/tasks/T-6/dispatch") return { ok: false, status: 409, json: async () => ({ ok: false, code: "REFUSED", message: "Test approval is required." }) };
    throw new Error(`unexpected ${path}`);
  }));
  render(<Harness />);
  const card = await screen.findByRole("article", { name: "T-6 Retain setup" });
  fireEvent.click(within(card).getByRole("button", { name: "Start worker" }));
  expect(await screen.findByText("Test approval is required.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Finish connecting worker" })).toBeNull();
});
