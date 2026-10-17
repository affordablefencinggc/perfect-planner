import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CoreAgentConnect } from "../../src/core-screens/CoreAgentConnect.jsx";
import { ViewModeContext } from "../../src/project/viewMode.js";

// A made-up connect value, assembled so it never reads as a stored secret (core/release push scan).
const TOKEN = ["pp", "c", "f".repeat(24)].join("_");
const CONNECT = {
  connection: "C-1",
  person: "owner",
  bridgeUrl: "http://127.0.0.1:5555",
  token: TOKEN,
  agentPath: "/repo/dist/core-host/agent.mjs",
  agentBuilt: true,
  claudeCode: `claude mcp add perfect-planner-core --env PP_BRIDGE_URL=http://127.0.0.1:5555 --env PP_AGENT_TOKEN=${TOKEN} -- node "/repo/dist/core-host/agent.mjs"`,
  json: JSON.stringify({ mcpServers: { "perfect-planner-core": { command: "node", args: ["/repo/dist/core-host/agent.mjs"], env: { PP_BRIDGE_URL: "http://127.0.0.1:5555", PP_AGENT_TOKEN: TOKEN } } } }, null, 2),
};
const MAIN = { id: "claude-code-ab12cd", name: "Claude Code", model: "claude-opus", role: "main", person: "owner", connection: "C-1", connectedAt: "2026-10-09T10:00:00Z" };
const list = (agents = [], connections = []) => ({ bridge: { enabled: true, url: "http://127.0.0.1:5555" }, agents, connections });

const ok = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });

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

const renderWith = (mode = "simple") =>
  render(
    <ViewModeContext.Provider value={{ mode, isAdvanced: mode === "advanced", setMode: () => {} }}>
      <CoreAgentConnect />
    </ViewModeContext.Provider>,
  );

beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("CoreAgentConnect", () => {
  test("shows loading, then the empty state with the Connect agent button", async () => {
    let release;
    routeFetch({ "GET /agents": () => new Promise((resolve) => { release = () => resolve(ok(list())); }) });
    renderWith();
    expect(screen.getByRole("status", { name: "Loading connected agents" })).toBeTruthy();
    await act(async () => release());
    expect(await screen.findByText("No agents are connected yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Connect agent/ })).toBeTruthy();
  });

  test("shows an error when the local service is down, and Try again reloads", async () => {
    let up = false;
    routeFetch({ "GET /agents": async () => { if (!up) throw new TypeError("Failed to fetch"); return ok(list()); } });
    renderWith();
    expect(await screen.findByText("The local service is not answering.")).toBeTruthy();
    up = true;
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(await screen.findByText("No agents are connected yet.")).toBeTruthy();
  });

  test("Connect agent posts, shows the command with Copy, waits, then flips to Connected and drops the token", async () => {
    const writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    let current = list();
    const fetchMock = routeFetch({
      "GET /agents": async () => ok(current),
      "POST /agents/connect": async () => { current = list([], [{ id: "C-1", person: "owner", issuedAt: "x", revoked: false }]); return ok(CONNECT); },
    });
    renderWith();
    fireEvent.click(await screen.findByRole("button", { name: /Connect agent/ }));
    const command = await screen.findByLabelText("Claude Code command");
    expect(command.textContent).toBe(CONNECT.claudeCode);
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).startsWith("/api/core/agents/connect") && init.method === "POST")).toBe(true);
    expect(screen.getByText(/Waiting for the agent to check in/)).toBeTruthy();
    expect(screen.getByText(/Using another agent/)).toBeTruthy();
    expect(screen.getByLabelText("MCP settings").textContent).toContain('"mcpServers"');

    fireEvent.click(screen.getByRole("button", { name: "Copy the Claude Code command" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CONNECT.claudeCode));
    expect(await screen.findByText("Copied")).toBeTruthy();

    // The agent calls hello; the next poll sees it.
    current = list([MAIN], [{ id: "C-1", person: "owner", issuedAt: "x", revoked: false, agent: MAIN.id }]);
    expect(await screen.findByText("Connected: Claude Code (claude-opus) is your main chat.", {}, { timeout: 4000 })).toBeTruthy();
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(screen.queryByLabelText("Claude Code command")).toBeNull();
    const agents = screen.getByRole("list", { name: "Connected agents" });
    expect(within(agents).getByText("Main chat")).toBeTruthy();
    for (let i = 0; i < localStorage.length; i++) expect(localStorage.getItem(localStorage.key(i))).not.toContain(TOKEN);
  });

  test("lists agents with role badges and disconnects one", async () => {
    let current = list([MAIN, { id: "codex-1", name: "Codex", role: "observer", person: "owner", connection: "C-2" }]);
    const fetchMock = routeFetch({
      "GET /agents": async () => ok(current),
      "POST /agents/revoke": async (init) => { current = list([{ ...MAIN, revoked: true }]); return ok({ connection: "C-1", revoked: true, body: init.body }); },
    });
    renderWith();
    const agents = await screen.findByRole("list", { name: "Connected agents" });
    expect(within(agents).getByText("Main chat")).toBeTruthy();
    expect(within(agents).getByText("Read-only")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Claude Code" }));
    await waitFor(() => expect(screen.queryByText("Claude Code")).toBeNull());
    const revokeCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith("/api/core/agents/revoke"));
    expect(JSON.parse(revokeCall[1].body)).toEqual({ agent: MAIN.id });
  });

  test("Advanced view shows the bridge URL and agent ids; Simple view does not", async () => {
    routeFetch({ "GET /agents": async () => ok(list([MAIN])) });
    const { unmount } = renderWith("simple");
    await screen.findByRole("list", { name: "Connected agents" });
    expect(screen.queryByText(MAIN.id)).toBeNull();
    expect(screen.queryByText("http://127.0.0.1:5555")).toBeNull();
    unmount();
    renderWith("advanced");
    await screen.findByRole("list", { name: "Connected agents" });
    expect(screen.getByText(MAIN.id)).toBeTruthy();
    expect(screen.getByText("http://127.0.0.1:5555")).toBeTruthy();
  });

  test("shows the reason when connecting is refused", async () => {
    routeFetch({
      "GET /agents": async () => ok(list()),
      "POST /agents/connect": async () => ({ ok: false, status: 503, json: async () => ({ ok: false, code: "BRIDGE_OFF", message: "Agent connections are turned off for this app." }) }),
    });
    renderWith();
    fireEvent.click(await screen.findByRole("button", { name: /Connect agent/ }));
    expect(await screen.findByText("Agent connections are turned off for this app.")).toBeTruthy();
  });
});
