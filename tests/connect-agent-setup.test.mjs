import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_TOOLS, REGISTRY_PLACEHOLDER, SERVER_PATH_PLACEHOLDER, buildAgentSnippets, copyText, resolveAgentSetup } from "../src/project/connectAgentSetup.js";
import { defaultRegistryRoot, mcpServerPath } from "../mcp/agentSetupPaths.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const winPath = "C:\\Users\\dev\\perfect planner\\mcp\\perfectPlannerMcpServer.mjs";
const winRegistry = "C:\\Users\\dev\\AppData\\Roaming\\com.perfectplanner.desktop\\workspace-registry-v1";

test("listed agent tools match exactly what the MCP server registers", () => {
  const source = readFileSync(path.join(root, "mcp", "perfectPlannerMcpServer.mjs"), "utf8");
  const registered = [...source.matchAll(/registerTool\(\s*["']([a-z_]+)["']/g)].map((match) => match[1]).sort();
  assert.deepEqual(AGENT_TOOLS.map((tool) => tool.name).sort(), registered);
});

test("missing build paths fall back to visible placeholders, never a guess", () => {
  const setup = resolveAgentSetup({ serverPath: "", registryRoot: "  " });
  assert.equal(setup.serverPath, SERVER_PATH_PLACEHOLDER);
  assert.equal(setup.registryRoot, REGISTRY_PLACEHOLDER);
  assert.equal(setup.serverPathKnown, false);
  assert.equal(setup.registryKnown, false);
  assert.deepEqual(resolveAgentSetup(), resolveAgentSetup({}));
});

test("every snippet carries the server path and registry folder in its own format", () => {
  const setup = resolveAgentSetup({ serverPath: winPath, registryRoot: winRegistry });
  const tabs = buildAgentSnippets(setup);
  assert.deepEqual(tabs.map((tab) => tab.id), ["claude-code", "codex", "mcp-json"]);
  const claude = tabs[0].blocks[0].text;
  assert.match(claude, /^claude mcp add --transport stdio --env PERFECT_PLANNER_REGISTRY_ROOT="/);
  assert.ok(claude.endsWith(` perfect-planner -- node "${winPath}"`));
  const codex = tabs[1].blocks[0].text;
  assert.ok(codex.includes(`args = ['${winPath}']`), "TOML literal string keeps backslashes");
  assert.ok(codex.includes(`PERFECT_PLANNER_REGISTRY_ROOT = '${winRegistry}'`));
  const [vscode, cursor] = tabs[2].blocks.map((block) => JSON.parse(block.text));
  assert.deepEqual(vscode.servers["perfect-planner"], { type: "stdio", command: "node", args: [winPath], env: { PERFECT_PLANNER_REGISTRY_ROOT: winRegistry } });
  assert.deepEqual(cursor.mcpServers["perfect-planner"], { command: "node", args: [winPath], env: { PERFECT_PLANNER_REGISTRY_ROOT: winRegistry } });
});

test("TOML falls back to a basic string when a path contains a single quote", () => {
  const codex = buildAgentSnippets(resolveAgentSetup({ serverPath: "/home/o'neil/pp/mcp/perfectPlannerMcpServer.mjs", registryRoot: "/r" }))[1].blocks[0].text;
  assert.ok(codex.includes(`args = ["/home/o'neil/pp/mcp/perfectPlannerMcpServer.mjs"]`));
});

test("copy reports failure instead of pretending", async () => {
  assert.equal(await copyText("x", null), false);
  assert.equal(await copyText("x", { writeText: async () => { throw new Error("denied"); } }), false);
  let written; assert.equal(await copyText("x", { writeText: async (value) => { written = value; } }), true);
  assert.equal(written, "x");
});

test("build-time paths point at this checkout and the desktop app's registry folder", () => {
  assert.equal(mcpServerPath(), path.join(root, "mcp", "perfectPlannerMcpServer.mjs"));
  assert.equal(defaultRegistryRoot({ platform: "win32", env: { APPDATA: "C:\\Users\\a\\AppData\\Roaming" } }), "C:\\Users\\a\\AppData\\Roaming\\com.perfectplanner.desktop\\workspace-registry-v1");
  assert.equal(defaultRegistryRoot({ platform: "darwin", env: {}, home: "/Users/a" }), "/Users/a/Library/Application Support/com.perfectplanner.desktop/workspace-registry-v1");
  assert.equal(defaultRegistryRoot({ platform: "linux", env: {}, home: "/home/a" }), "/home/a/.local/share/com.perfectplanner.desktop/workspace-registry-v1");
  assert.equal(defaultRegistryRoot({ platform: "win32", env: {} }), null);
});

test("npm run mcp is wired to the launcher and keeps stdout free for the protocol", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts.mcp, "node scripts/run-perfect-planner-mcp.mjs");
  // An unreadable registry makes the server exit; the launcher must not print to stdout first.
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "run-perfect-planner-mcp.mjs")], { input: "", encoding: "utf8", timeout: 15000,
    env: { ...process.env, PERFECT_PLANNER_REGISTRY_ROOT: path.join(root, "does-not-exist-registry") } });
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Perfect Planner MCP reading registered apps from/);
});
