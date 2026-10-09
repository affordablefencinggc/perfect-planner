#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import * as z from "zod/v4";
import {preparePlannerDraft} from './plannerDraftBridge.mjs';

import {
  buildComputerUseBrief,
  inspectRegisteredWorkspaceInventory,
  inspectRegisteredGitWorkspace,
  inspectRegisteredMergeRecovery,
  mapRegisteredWorkspace,
  resolveRelayWriteConfig,
  searchRegisteredWorkspace,
} from "./perfectPlannerMcpCore.mjs";
import { registerRelayTools } from "./perfectPlannerRelayTools.mjs";

const registryRoot = process.env.PERFECT_PLANNER_REGISTRY_ROOT;
const recoveryCatalogRoot = process.env.PERFECT_PLANNER_RECOVERY_CATALOG_ROOT;
if (!registryRoot) throw new Error("PERFECT_PLANNER_REGISTRY_ROOT is required.");
const writeConfig = resolveRelayWriteConfig(process.env, process.argv.slice(2));

const instructions = [
  "Perfect Planner is the grounded context and evidence boundary for user-registered local apps.",
  "Only inspect workspaces returned by planner_list_registered_apps; never substitute an unregistered path.",
  "Prefer these read-only MCP tools and direct app APIs. Never launch computer use as a fallback when a tool fails.",
  "planner_prepare_computer_use only prepares context; it neither controls the computer nor grants permission. Do not call it when the user has disabled computer use.",
  writeConfig.write
    ? "Relay write tools are enabled: call hello first and pass its token to every relay tool. A worker token covers only the task it claimed; the main-chat token covers the relay. Relay tools only append to the Perfect Planner ledger; they cannot approve plans, merge, mark tasks done, mutate files, or grant operating-system authority."
    : "This server is read-only: it cannot approve plans, resolve collisions, mutate files, or grant operating-system authority.",
].join(" ");

const server = new McpServer({ name: "perfect-planner", version: "0.1.0" }, { instructions });
const readOnly = { title: "Perfect Planner", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const response = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value });

server.registerTool('planner_prepare_task_draft', {
  title:'Prepare tasks for Planner review',
  description:'Validate a LOCAL_DRAFT task proposal for a registered app and return importable draftJson. Does NOT update the live ledger. Obtain the exact binding from a draft exported by the target Planner project; never invent its census digest. Save the returned JSON and have the user review/import it through Ledger. No approval or execution authority.',
  inputSchema:{workspace_id:z.string(),ledger:z.object({}).passthrough()},
  annotations:{...readOnly,title:'Prepare unapproved task proposal'},
},async({workspace_id,ledger})=>response(await preparePlannerDraft(registryRoot,workspace_id,ledger)));

server.registerTool("planner_list_registered_apps", {
  title: "List registered apps",
  description: "List the local app folders explicitly registered read-only in Perfect Planner.",
  inputSchema: {},
  annotations: readOnly,
}, async () => response(await inspectRegisteredWorkspaceInventory(registryRoot)));

server.registerTool("planner_map_app", {
  title: "Map a registered app",
  description: "Build a bounded file census, top-down folder tree, and evidence-labelled architecture discovery map for one registered app.",
  inputSchema: {
    workspace_id: z.string().describe("Workspace id returned by planner_list_registered_apps"),
    max_depth: z.number().int().min(1).max(12).default(5),
    max_nodes: z.number().int().min(10).max(2000).default(400),
  },
  annotations: readOnly,
}, async ({ workspace_id, max_depth, max_nodes }) => response(await mapRegisteredWorkspace(registryRoot, workspace_id, { maxDepth: max_depth, maxNodes: max_nodes })));

server.registerTool("planner_search_app", {
  title: "Search a registered app",
  description: "Instant literal text search across bounded readable files in a registered app. Returns file, line, and short matching previews.",
  inputSchema: {
    workspace_id: z.string().describe("Workspace id returned by planner_list_registered_apps"),
    query: z.string().min(2).max(200),
    case_sensitive: z.boolean().default(false),
    max_results: z.number().int().min(1).max(200).default(50),
  },
  annotations: readOnly,
}, async ({ workspace_id, query, case_sensitive, max_results }) => response(await searchRegisteredWorkspace(registryRoot, workspace_id, query, { caseSensitive: case_sensitive, maxResults: max_results })));

server.registerTool("planner_git_inventory", {
  title: "Inspect local branches and working copies",
  description: "Read local Git branch/worktree metadata for an exactly registered app. No source execution, edits, fetch, push, cleanup, CI or production verification. Stale identity, changing inventory and hard limits are refused.",
  inputSchema: {
    workspace_id: z.string(),
    registry_revision: z.number().int().min(1),
    root_identity: z.string().regex(/^[a-f0-9]{64}$/),
  },
  annotations: readOnly,
}, async ({ workspace_id, registry_revision, root_identity }) => response(await inspectRegisteredGitWorkspace(registryRoot, workspace_id,
  { registryRevision: registry_revision, rootIdentity: root_identity }, { gitExecutable: process.env.PERFECT_PLANNER_GIT_EXECUTABLE })));

server.registerTool("planner_inspect_recovery", {
  title: "Inspect retained work",
  description: "Read registered recovery-store metadata. Start with null catalog_head, store_id and cursor, then use returned opaque store IDs and catalog head. Unknown coverage is not an empty queue. No adoption, cleanup, merge, CI or promotion authority.",
  inputSchema: z.strictObject({
    workspace_id: z.string().min(1).max(160),
    registry_revision: z.number().int().min(1),
    root_identity: z.string().regex(/^[a-f0-9]{64}$/),
    catalog_head: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    store_id: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    cursor: z.strictObject({ listingDigest: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().min(0) }).nullable(),
  }),
  annotations: readOnly,
}, async ({ workspace_id, registry_revision, root_identity, catalog_head, store_id, cursor }, extra) => {
  if (!recoveryCatalogRoot) return { isError: true, ...response({ code: "MCP_RECOVERY_NOT_CONFIGURED", message: "Recovery inspection is not configured by this host. No recovery actions were taken." }) };
  try {
    return response(await inspectRegisteredMergeRecovery(registryRoot, recoveryCatalogRoot, workspace_id,
      { registryRevision: registry_revision, rootIdentity: root_identity, catalogHead: catalog_head, storeId: store_id, cursor }, { signal: extra.signal }));
  } catch {
    // Never forward filesystem/parser errors across the protocol boundary.
    return { isError: true, ...response({ code: "MCP_RECOVERY_UNAVAILABLE", message: "Recovery inspection could not be verified. No recovery actions were taken." }) };
  }
});

server.registerTool("planner_prepare_computer_use", {
  title: "Prepare grounded computer use",
  description: "Create a registered-workspace brief before the separately installed Codex computer-use tool operates a visible app or browser.",
  inputSchema: {
    workspace_id: z.string().describe("Workspace id returned by planner_list_registered_apps"),
    intent: z.string().min(3).max(500).describe("The exact visible UI outcome requested by the user"),
    target: z.string().max(160).default("Perfect Planner desktop app"),
  },
  annotations: readOnly,
}, async ({ workspace_id, intent, target }) => response(await buildComputerUseBrief(registryRoot, workspace_id, { intent, target })));

if (writeConfig.write) {
  // The ledger is opened lazily on the first relay call so listing tools never takes the single-writer lock.
  let relayPromise = null;
  let openedLedger = null;
  const getRelay = () => (relayPromise ??= (async () => {
    const [{ openLedger }, { createRelay, createFileSessionStore }] = await Promise.all([
      import("../src/core/ledger/index.mjs"),
      import("../src/core/relay/index.mjs"),
    ]);
    openedLedger = await openLedger(writeConfig.ledgerRoot, {});
    // Only sha256 hashes of session tokens are stored, next to the ledger, so agents can resume after a restart.
    const sessionStore = createFileSessionStore(path.join(writeConfig.ledgerRoot, ".perfect-planner", "relay", "sessions.json"));
    return createRelay({ ledger: openedLedger, sessionStore, mainAgent: process.env.PP_MAIN_AGENT?.trim() || null });
  })().catch((error) => { relayPromise = null; throw error; }));
  registerRelayTools(server, getRelay, z);
  const closeLedger = () => { try { openedLedger?.close(); } catch { /* best effort on exit */ } };
  process.once("exit", closeLedger);
  process.stdin.once("end", closeLedger);
}

await server.connect(new StdioServerTransport());
console.error("Perfect Planner MCP ready on stdio");
