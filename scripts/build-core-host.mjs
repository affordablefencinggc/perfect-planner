#!/usr/bin/env node
// Bundles the core host (core/host) and the agent's stdio MCP entry into plain
// Node ESM under dist/core-host, so the production server and connected agents
// run the TypeScript core without a TypeScript loader.
import { copyFileSync, mkdirSync } from "node:fs";
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
  // The worktree manager copies its commit-time secret scan from ./hooks next to its own module.
  mkdirSync(path.join(CORE_HOST_OUT, "hooks"), { recursive: true });
  copyFileSync(path.join(projectRoot, "core/worktrees/hooks/secret-scan.mjs"), path.join(CORE_HOST_OUT, "hooks", "secret-scan.mjs"));
  // Shipping safety (core/release/protect.ts) installs its whole-branch pre-push scan from the same place.
  copyFileSync(path.join(projectRoot, "core/release/hooks/pre-push.mjs"), path.join(CORE_HOST_OUT, "hooks", "pre-push.mjs"));
  return CORE_HOST_OUT;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildCoreHost().then((out) => console.log(`[perfect-planner] Core host built in ${out}`), (error) => { console.error(error.message); process.exit(1); });
}
