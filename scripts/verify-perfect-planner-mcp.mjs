import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const command = process.execPath;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.some((arg) => !["--fixture", "--data-only"].includes(arg))) throw new Error("Usage: verify-perfect-planner-mcp.mjs [--fixture] [--data-only]");
const fixtureMode = args.includes("--fixture");
const dataOnly = args.includes("--data-only");
let fixtureRoot;
async function createFixtureRegistry() {
  fixtureRoot = await realpath(await mkdtemp(path.join(tmpdir(), "perfect-planner-mcp-smoke-")));
  const registry = path.join(fixtureRoot, "registry");
  const workspace = path.join(fixtureRoot, "workspace");
  await mkdir(registry);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "mcp-smoke-fixture", dependencies: { react: "19.2.0" } }));
  await writeFile(path.join(workspace, "src", "PerfectPlannerShell.jsx"), "export function PerfectPlannerShell() { return null; }\n");
  const canonicalRoot = await realpath(workspace);
  await writeFile(path.join(registry, "smoke-fixture.json"), JSON.stringify({
    schemaVersion: 1,
    registryRevision: 1,
    workspaceId: "smoke-fixture",
    canonicalRoot,
    rootIdentity: createHash("sha256").update(canonicalRoot).digest("hex"),
    access: "metadata-read-only",
  }));
  return registry;
}
function requireStructured(result, toolName) {
  if (result?.isError || !result?.structuredContent) {
    const detail = result?.content?.find((item) => item.type === "text")?.text ?? "No structured result returned.";
    throw new Error(`${toolName} failed: ${detail}`);
  }
  return result.structuredContent;
}

let client;
try {
  const registryRootInput = fixtureMode ? await createFixtureRegistry() : process.env.PERFECT_PLANNER_REGISTRY_ROOT
    ?? path.join(process.env.APPDATA ?? "", "com.perfectplanner.desktop", "workspace-registry-v1");
  // Windows Store/MSIX processes can virtualize APPDATA. The MCP core intentionally
  // refuses redirected roots, so resolve the app-owned registry to its canonical
  // directory before handing it to the server.
  const registryRoot = await realpath(registryRootInput);
  const transport = new StdioClientTransport({
    command,
    args: [path.join(projectRoot, "mcp", "perfectPlannerMcpServer.mjs")],
    cwd: projectRoot,
    env: {
      ...process.env,
      PERFECT_PLANNER_REGISTRY_ROOT: registryRoot,
      PERFECT_PLANNER_COMPUTER_USE_AVAILABLE: fixtureMode || dataOnly ? "0" : process.env.PERFECT_PLANNER_COMPUTER_USE_AVAILABLE ?? "0",
    },
    stderr: "pipe",
  });
  client = new Client({ name: "perfect-planner-verifier", version: "0.1.0" });
  await client.connect(transport);
  const tools = await client.listTools();
  const registered = await client.callTool({ name: "planner_list_registered_apps", arguments: {} });
  const inventory = requireStructured(registered, "planner_list_registered_apps");
  const workspaces = inventory.workspaces ?? [];
  const registryIssues = inventory.issues ?? [];
  if (!workspaces.length) throw new Error("No verified Perfect Planner workspace is registered.");
  const requestedWorkspaceId = fixtureMode ? "smoke-fixture" : process.env.PERFECT_PLANNER_WORKSPACE_ID;
  const first = requestedWorkspaceId
    ? workspaces.find((workspace) => workspace.workspaceId === requestedWorkspaceId)
    : workspaces[0];
  if (!first) throw new Error(`Registered workspace ${requestedWorkspaceId} was not found.`);
  const mappedResult = await client.callTool({
    name: "planner_map_app",
    arguments: { workspace_id: first.workspaceId, max_depth: 3, max_nodes: 80 },
  });
  const mapped = requireStructured(mappedResult, "planner_map_app");
  const searchedResult = await client.callTool({
    name: "planner_search_app",
    arguments: { workspace_id: first.workspaceId, query: "PerfectPlannerShell", max_results: 10 },
  });
  const searched = requireStructured(searchedResult, "planner_search_app");
  const gitResult = await client.callTool({ name: "planner_git_inventory", arguments: {
    workspace_id: first.workspaceId, registry_revision: first.registryRevision, root_identity: first.rootIdentity,
  } });
  const gitInventory = requireStructured(gitResult, "planner_git_inventory");
  const briefResult = dataOnly ? null : await client.callTool({
    name: "planner_prepare_computer_use",
    arguments: {
      workspace_id: first.workspaceId,
      intent: "Open the visible Perfect Planner app and verify the current workspace without changing files.",
      target: "Perfect Planner desktop app",
    },
  });
  const brief = dataOnly ? null : requireStructured(briefResult, "planner_prepare_computer_use");
  if (fixtureMode && (registryIssues.length || workspaces.length !== 1 || mapped.census?.fileCount !== 2
    || searched.matchCount !== 1 || searched.matches?.[0]?.path !== "src/PerfectPlannerShell.jsx"
    || gitInventory.observation?.state !== "no-git-marker"
    || (!dataOnly && brief.computerUseAvailable !== false))) {
    throw new Error("Hermetic MCP smoke verification returned unexpected fixture results.");
  }
  process.stdout.write(`${JSON.stringify({
    mode: fixtureMode ? "fixture" : "live",
    scope: fixtureMode ? "Synthetic MCP transport smoke test; no live app, computer-use, CI, or deployment receipt." : "Registered local workspace MCP verification; computer-use briefing does not execute computer-use.",
    toolNames: tools.tools.map((tool) => tool.name),
    exercisedTools: ["planner_list_registered_apps", "planner_map_app", "planner_search_app", "planner_git_inventory", ...(!dataOnly ? ["planner_prepare_computer_use"] : [])],
    gitInventory: gitInventory.observation,
    registryRoot,
    workspaces,
    registryIssues,
    mapped: {
      workspaceId: mapped.workspace?.workspaceId,
      fileCount: mapped.census?.fileCount,
      directoryCount: mapped.structure?.directoryCount,
      digest: mapped.census?.digest,
      truncated: mapped.structure?.truncated,
    },
    searched: {
      query: searched.query,
      matchCount: searched.matchCount,
      capped: searched.capped,
      firstMatch: searched.matches?.[0] ?? null,
    },
    computerUseBrief: dataOnly ? { skipped: true, reason: "data-only-verification" } : {
      authority: brief.authority,
      computerUseAvailable: brief.computerUseAvailable,
      plannerBoundary: brief.plannerBoundary,
    },
  }, null, 2)}\n`);
} finally {
  try {
    await client?.close();
  } finally {
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  }
}
