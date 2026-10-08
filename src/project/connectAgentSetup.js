// Setup snippets for connecting an outside coding agent to the read-only stdio MCP server
// (mcp/perfectPlannerMcpServer.mjs). Pure: paths arrive from the build, never from a guess.
export const SERVER_NAME = "perfect-planner";
export const SERVER_PATH_PLACEHOLDER = "<path-to-perfect-planner>/mcp/perfectPlannerMcpServer.mjs";
export const REGISTRY_PLACEHOLDER = "<Perfect Planner app data>/com.perfectplanner.desktop/workspace-registry-v1";

// Mirrors the server's registerTool calls; tests/connect-agent-setup.test.mjs keeps them in step.
export const AGENT_TOOLS = Object.freeze([
  { name: "planner_list_registered_apps", label: "List the app folders you added to Perfect Planner" },
  { name: "planner_map_app", label: "Read a folder tree and architecture overview of one app" },
  { name: "planner_search_app", label: "Search text across one app's readable files" },
  { name: "planner_git_inventory", label: "List local branches and working copies" },
  { name: "planner_inspect_recovery", label: "Look at saved work kept for recovery (when set up)" },
  { name: "planner_prepare_task_draft", label: "Check a task proposal and return it for you to import in Ledger" },
  { name: "planner_prepare_computer_use", label: "Write a short context note before a separate computer-use tool runs" },
]);

const clean = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

export function resolveAgentSetup({ serverPath, registryRoot } = {}) {
  const server = clean(serverPath), registry = clean(registryRoot);
  return { serverPath: server ?? SERVER_PATH_PLACEHOLDER, registryRoot: registry ?? REGISTRY_PLACEHOLDER, serverPathKnown: Boolean(server), registryKnown: Boolean(registry) };
}

const shellQuote = (value) => `"${value.replaceAll('"', '\\"')}"`;
const tomlLiteral = (value) => (value.includes("'") ? JSON.stringify(value) : `'${value}'`);
const jsonEntry = (setup, extra = {}) => ({ ...extra, command: "node", args: [setup.serverPath], env: { PERFECT_PLANNER_REGISTRY_ROOT: setup.registryRoot } });

export function buildAgentSnippets(setup) {
  return [
    { id: "claude-code", label: "Claude Code", blocks: [{ id: "claude-code", title: "Run once in a terminal", language: "shell",
      text: `claude mcp add --transport stdio --env PERFECT_PLANNER_REGISTRY_ROOT=${shellQuote(setup.registryRoot)} ${SERVER_NAME} -- node ${shellQuote(setup.serverPath)}` }],
      note: "Then run /mcp inside Claude Code to check that perfect-planner is listed." },
    { id: "codex", label: "Codex", blocks: [{ id: "codex", title: "Add to ~/.codex/config.toml", language: "toml",
      text: [`[mcp_servers.${SERVER_NAME}]`, `command = "node"`, `args = [${tomlLiteral(setup.serverPath)}]`, `env = { PERFECT_PLANNER_REGISTRY_ROOT = ${tomlLiteral(setup.registryRoot)} }`].join("\n") }],
      note: "Restart Codex after saving so it picks up the new server." },
    { id: "mcp-json", label: "VS Code / Cursor", blocks: [
      { id: "vscode", title: "VS Code: .vscode/mcp.json", language: "json", text: JSON.stringify({ servers: { [SERVER_NAME]: jsonEntry(setup, { type: "stdio" }) } }, null, 2) },
      { id: "cursor", title: "Cursor: .cursor/mcp.json", language: "json", text: JSON.stringify({ mcpServers: { [SERVER_NAME]: jsonEntry(setup) } }, null, 2) },
    ], note: "If the file already lists servers, add only the perfect-planner entry and keep the others." },
  ];
}

export async function copyText(text, clipboard = globalThis.navigator?.clipboard) {
  if (!clipboard?.writeText) return false;
  try { await clipboard.writeText(text); return true; } catch { return false; }
}
