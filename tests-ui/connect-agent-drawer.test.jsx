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

  test("a failed copy selects exactly that snippet, focuses it, and says so", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Connect agent" }));
    await user.click(screen.getByRole("button", { name: "Copy Run once in a terminal" }));
    const snippet = screen.getByLabelText("Run once in a terminal setup text");
    expect(window.getSelection().toString()).toBe(snippet.textContent);
    expect(document.activeElement).toBe(snippet);
    expect(screen.getByRole("alert").textContent).toMatch(/now selected: press Ctrl\+C/);
  });

  test("Ctrl+A or Cmd+A inside a snippet selects only that snippet, not the page", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Connect agent" }));
    const snippet = screen.getByLabelText("Run once in a terminal setup text");
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      window.getSelection().removeAllRanges();
      snippet.focus();
      const notPrevented = fireEvent.keyDown(snippet, { key: "a", ...modifier });
      expect(notPrevented).toBe(false);
      expect(window.getSelection().toString()).toBe(snippet.textContent);
    }
  });

  test("tabs follow the ARIA pattern for Home and End as well as the arrow keys", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Connect agent" }));
    const tabs = screen.getAllByRole("tab");
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "End" });
    expect(screen.getByRole("tab", { name: "VS Code / Cursor" }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement.textContent).toBe("VS Code / Cursor");
    fireEvent.keyDown(document.activeElement, { key: "Home" });
    expect(screen.getByRole("tab", { name: "Claude Code" }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement.textContent).toBe("Claude Code");
    fireEvent.keyDown(document.activeElement, { key: "ArrowLeft" });
    expect(document.activeElement.textContent).toBe("VS Code / Cursor");
  });

  test("points to the desktop pairing flow for agents that propose tasks", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Connect agent" }));
    expect(screen.getByText(/To let an agent propose tasks or report exchanges/).textContent).toMatch(/Runtime & connections → Connect your agent/);
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
    expect(within(dialog).getByLabelText("Run once in a terminal setup text").textContent).toContain("perfectPlannerMcpServer.mjs");
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

  test("without a build-time path it shows a placeholder and tells the user what to fill in", async () => {
    const user = userEvent.setup();
    render(<Harness setup={{ serverPath: "", registryRoot: "" }} />);
    await user.click(screen.getByRole("button", { name: "Connect agent" }));
    expect(screen.getByLabelText("Run once in a terminal setup text").textContent).toContain("<path-to-perfect-planner>/mcp/perfectPlannerMcpServer.mjs");
    expect(screen.getByText(/does not know where Perfect Planner is/)).toBeTruthy();
    expect(screen.getByText(/Replace the app data placeholder/)).toBeTruthy();
  });
});

describe("Connect agent drawer focus stability", () => {
  test("a parent re-render with a new inline onClose does not pull focus back to Close", async () => {
    const user = userEvent.setup();
    let bump;
    function Rerendering() {
      const [, setTick] = useState(0);
      bump = () => setTick((tick) => tick + 1);
      return <ConnectAgentDrawer open onClose={() => {}} setup={{ serverPath, registryRoot }} />;
    }
    render(<Rerendering />);
    const dialog = screen.getByRole("dialog", { name: "Connect agent" });
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" })));
    const codex = within(dialog).getByRole("tab", { name: "Codex" });
    await user.click(codex);
    expect(document.activeElement).toBe(codex);
    act(() => bump());
    act(() => bump());
    expect(document.activeElement).toBe(codex);
  });

  test("without a project it points to choosing an app folder instead of Build", async () => {
    const user = userEvent.setup();
    const onWorkspace = vi.fn();
    render(<ConnectAgentDrawer open onClose={() => {}} onWorkspace={onWorkspace} hasProject={false} setup={{ serverPath, registryRoot }} />);
    expect(screen.queryByRole("button", { name: /Open Build/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Choose an app folder/ }));
    expect(onWorkspace).toHaveBeenCalledWith("structure");
  });
});
