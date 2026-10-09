import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ConnectAgentDrawer } from "../src/components/ConnectAgentDrawer.jsx";
import { PerfectPlannerShell } from "../src/PerfectPlannerShell.jsx";
import { ProjectProvider } from "../src/project/ProjectProvider.jsx";
import { createMemoryStorage, createProjectRegistry } from "../src/project/projectRegistry.js";
import { createDemoProjectSession } from "../src/demo/demoProject.js";
import { diagnosticSessionFixture } from "./diagnosticSessionFixture.js";

const serverPath = "C:\\repos\\perfect-planner\\mcp\\perfectPlannerMcpServer.mjs";
const registryRoot = "C:\\Users\\dev\\AppData\\Roaming\\com.perfectplanner.desktop\\workspace-registry-v1";

function Harness({ setup = { serverPath, registryRoot }, onWorkspace = () => {} }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Connect agent</button>
      <button>Elsewhere</button>
      <ConnectAgentDrawer open={open} onClose={() => setOpen(false)} onWorkspace={onWorkspace} setup={setup} />
    </>
  );
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

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

  test("each agent tab shows a snippet with this checkout's server path, and Copy copies it", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Connect agent" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Claude Code", "Codex", "VS Code / Cursor"]);
    const claude = within(dialog).getByLabelText("Run once in a terminal setup text").textContent;
    expect(claude).toContain(`node "${serverPath}"`);
    expect(claude).toContain(registryRoot);
    await user.click(within(dialog).getByRole("button", { name: "Copy Run once in a terminal" }));
    expect(writeText).toHaveBeenCalledWith(claude);
    expect(within(dialog).getByText("Copied")).toBeTruthy();

    await user.click(within(dialog).getByRole("tab", { name: "Codex" }));
    expect(within(dialog).getByRole("tab", { name: "Codex" }).getAttribute("aria-selected")).toBe("true");
    expect(within(dialog).getByLabelText("Add to ~/.codex/config.toml setup text").textContent).toContain(`'${serverPath}'`);

    await user.click(within(dialog).getByRole("tab", { name: "VS Code / Cursor" }));
    const vscode = JSON.parse(within(dialog).getByLabelText("VS Code: .vscode/mcp.json setup text").textContent);
    expect(vscode.servers["perfect-planner"].args).toEqual([serverPath]);
    const cursor = JSON.parse(within(dialog).getByLabelText("Cursor: .cursor/mcp.json setup text").textContent);
    expect(cursor.mcpServers["perfect-planner"].args).toEqual([serverPath]);
  });

  test("a failed copy says so and asks for a manual copy", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Connect agent" }));
    await user.click(screen.getByRole("button", { name: "Copy Run once in a terminal" }));
    expect(screen.getByRole("alert").textContent).toMatch(/Copy did not work/);
    expect(screen.queryByText("Copied")).toBeNull();
  });

  test("lists the read-only tools, stays honest about what it cannot do, and points to Build", async () => {
    const user = userEvent.setup();
    const onWorkspace = vi.fn();
    render(<Harness onWorkspace={onWorkspace} />);
    await user.click(screen.getByRole("button", { name: "Connect agent" }));
    const tools = screen.getByRole("region", { name: "What your agent can do" });
    expect(within(tools).getAllByRole("listitem")).toHaveLength(7);
    expect(within(tools).getByText("planner_map_app")).toBeTruthy();
    expect(screen.getByText(/cannot change Perfect Planner/)).toBeTruthy();
    expect(screen.getByText(/node_modules/)).toBeTruthy();
    expect(screen.queryByText(/does not know where Perfect Planner is/)).toBeNull();
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
    expect(within(dialog).queryByText(/<path-to-perfect-planner>|<Perfect Planner app data>/)).toBeNull();
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

  test("without both build-time paths it shows Connect agent only, never a line with placeholders", async () => {
    const user = userEvent.setup();
    for (const setup of [{ serverPath: "", registryRoot: "" }, { serverPath: "/home/dev/perfect-planner/mcp/perfectPlannerMcpServer.mjs", registryRoot: "" }]) {
      const view = render(<Harness setup={setup} />);
      await user.click(screen.getByRole("button", { name: "Connect agent" }));
      const dialog = screen.getByRole("dialog", { name: "Connect agent" });
      expect(within(dialog).queryByLabelText("Run once in a terminal setup text")).toBeNull();
      expect(within(dialog).queryByRole("tablist")).toBeNull();
      expect(dialog.textContent).not.toMatch(/<[^>]{1,80}>|\{\{[^}]*\}\}/);
      expect(dialog.textContent).not.toMatch(/does not know where Perfect Planner is|Replace the app data placeholder/);
      view.unmount();
    }
  });
});
