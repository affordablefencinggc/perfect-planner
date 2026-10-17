import { afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ConnectAgentDrawer } from "../src/components/ConnectAgentDrawer.jsx";
import { PerfectPlannerShell } from "../src/PerfectPlannerShell.jsx";
import { ProjectProvider } from "../src/project/ProjectProvider.jsx";
import { createMemoryStorage, createProjectRegistry } from "../src/project/projectRegistry.js";
import { createDemoProjectSession } from "../src/demo/demoProject.js";
import { diagnosticSessionFixture } from "./diagnosticSessionFixture.js";

const LINE = "node 'C:\\Program Files\\Perfect Planner\\core-host\\connect.mjs' http://127.0.0.1:5555 'C:\\Users\\dev\\pp\\tokens\\connect-C-1.token'";
const SKILL_LINE = "node 'C:\\Program Files\\Perfect Planner\\core-host\\connect.mjs' --skill-only";

function stubHost() {
  const ok = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
  vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
    const route = `${init.method ?? "GET"} ${String(url).split("?")[0].replace("/api/core", "")}`;
    if (route === "GET /agents") return ok({ bridge: { enabled: true, url: "http://127.0.0.1:5555" }, skillLine: SKILL_LINE, agents: [], connections: [] });
    if (route === "POST /agents/connect") return ok({ connection: "C-1", person: "owner", bridgeUrl: "http://127.0.0.1:5555", tokenFile: "C:\\Users\\dev\\pp\\tokens\\connect-C-1.token", agentPath: "x", agentBuilt: true, claudeCode: LINE, json: "{}" });
    return ok({});
  }));
}

function Harness({ onWorkspace = () => {} }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Connect agent</button>
      <button>Elsewhere</button>
      <ConnectAgentDrawer open={open} onClose={() => setOpen(false)} onWorkspace={onWorkspace} />
    </>
  );
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Connect agent drawer", () => {
  test("opens as a modal dialog, traps focus, and closes with Escape back to the opener", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Connect agent" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Connect agent" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    for (let index = 0; index < 25; index += 1) await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  test("close button and backdrop both close it", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Connect agent" }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Connect agent" }));
    await user.click(screen.getByRole("button", { name: "Close agent setup" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("shows only lines from the running app: no placeholder path anywhere, before or after Connect agent", async () => {
    stubHost();
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Connect agent" }));
    const dialog = screen.getByRole("dialog", { name: "Connect agent" });
    await within(dialog).findByText("Install the skill only");
    const noPlaceholder = () => {
      const text = dialog.textContent;
      expect(text).not.toMatch(/<[^>]*>|\{\{[^}]*\}\}/);
      expect(text).not.toMatch(/path-to-perfect-planner|perfectPlannerMcpServer|Read-only planning context/);
    };
    noPlaceholder();
    expect(within(dialog).getByLabelText("Skill install line").textContent).toBe(SKILL_LINE);
    await user.click(within(dialog).getAllByRole("button", { name: "Connect agent" })[0]);
    expect((await within(dialog).findByLabelText("Claude Code command")).textContent).toBe(LINE);
    noPlaceholder();
    expect(within(dialog).queryByRole("tab")).toBeNull();
  });

  test("points to Build and closes", async () => {
    const user = userEvent.setup();
    const onWorkspace = vi.fn();
    render(<Harness onWorkspace={onWorkspace} />);
    await user.click(screen.getByRole("button", { name: "Connect agent" }));
    await user.click(screen.getByRole("button", { name: /Open Build/ }));
    expect(onWorkspace).toHaveBeenCalledWith("build");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("the shell top bar opens the drawer in place, and MCP access points to it", async () => {
    window.history.replaceState({}, "", "/?workspace=structure");
    const registry = createProjectRegistry({ storage: createMemoryStorage() });
    const demo = registry.upsert(createDemoProjectSession(), { activate: true });
    window.history.replaceState({}, "", `/?workspace=structure&project=${demo.projectId}`);
    render(<ProjectProvider registry={registry}><PerfectPlannerShell diagnosticSession={diagnosticSessionFixture()} /></ProjectProvider>);
    const opener = screen.getByRole("button", { name: "Connect agent" });
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Connect agent" });
    expect(within(dialog).getByRole("heading", { name: "Connect an agent" })).toBeTruthy();
    expect(window.location.search).toContain("workspace=structure");
    // The drawer is lazy-loaded; its key handler attaches in the same effect that moves focus
    // into it, so wait for that before pressing Escape (slower runners, e.g. macOS, lag here).
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Connect agent" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("button", { name: /MCP access/ }));
    fireEvent.click(screen.getByRole("button", { name: /Set up an agent connection/ }));
    expect(await screen.findByRole("dialog", { name: "Connect agent" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "More actions" })).toBeNull();
    window.localStorage.clear();
  }, 20000);
});

describe("Connect agent drawer focus stability", () => {
  test("a parent re-render with a new inline onClose does not pull focus back to Close", async () => {
    stubHost();
    const user = userEvent.setup();
    let bump;
    function Rerendering() {
      const [, setTick] = useState(0);
      bump = () => setTick((tick) => tick + 1);
      return <ConnectAgentDrawer open onClose={() => {}} />;
    }
    render(<Rerendering />);
    const dialog = screen.getByRole("dialog", { name: "Connect agent" });
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" })));
    const connect = within(dialog).getAllByRole("button", { name: "Connect agent" })[0];
    connect.focus();
    expect(document.activeElement).toBe(connect);
    act(() => bump());
    act(() => bump());
    expect(document.activeElement).toBe(connect);
  });

  test("without a project it points to choosing an app folder instead of Build", async () => {
    stubHost();
    const user = userEvent.setup();
    const onWorkspace = vi.fn();
    render(<ConnectAgentDrawer open onClose={() => {}} onWorkspace={onWorkspace} hasProject={false} />);
    expect(screen.queryByRole("button", { name: /Open Build/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Choose an app folder/ }));
    expect(onWorkspace).toHaveBeenCalledWith("structure");
  });
});
