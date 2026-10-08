#!/usr/bin/env node
// `npm run --silent mcp`: start the read-only stdio MCP server, defaulting the registry
// to the desktop app's folder. stdout belongs to the MCP protocol; notes go to stderr.
import { defaultRegistryRoot, mcpServerPath } from "../mcp/agentSetupPaths.mjs";
import { pathToFileURL } from "node:url";

if (!process.env.PERFECT_PLANNER_REGISTRY_ROOT) {
  const root = defaultRegistryRoot();
  if (!root) { console.error("Set PERFECT_PLANNER_REGISTRY_ROOT to the Perfect Planner app registry folder."); process.exit(1); }
  process.env.PERFECT_PLANNER_REGISTRY_ROOT = root;
}
console.error(`Perfect Planner MCP reading registered apps from ${process.env.PERFECT_PLANNER_REGISTRY_ROOT}`);
await import(pathToFileURL(mcpServerPath()).href);
