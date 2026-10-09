#!/usr/bin/env node
// Bundles the core host (core/host) and the agent's stdio MCP entry into plain
// Node ESM under dist/core-host, so the production server and connected agents
// run the TypeScript core without a TypeScript loader.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CORE_HOST_OUT = path.join(projectRoot, "dist", "core-host");

export async function buildCoreHost() {
  await build({
    entryPoints: { index: path.join(projectRoot, "core/host/index.ts"), agent: path.join(projectRoot, "core/host/agentStdio.ts") },
    outdir: CORE_HOST_OUT,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outExtension: { ".js": ".mjs" },
    packages: "external",
    logLevel: "warning",
  });
  return CORE_HOST_OUT;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildCoreHost().then((out) => console.log(`[perfect-planner] Core host built in ${out}`), (error) => { console.error(error.message); process.exit(1); });
}
