#!/usr/bin/env node
// Bundles the core host (core/host) and the agent's stdio MCP entry into plain
// Node ESM under dist/core-host, so the production server and connected agents
// run the TypeScript core without a TypeScript loader.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CORE_HOST_OUT = path.join(projectRoot, "dist", "core-host");

export async function buildCoreHost() {
  await build({
    entryPoints: { index: path.join(projectRoot, "core/host/index.ts"), agent: path.join(projectRoot, "core/host/agentStdio.ts"), connect: path.join(projectRoot, "core/host/agentConnect.ts") },
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
  // The hook imports files beside it, so every file in PRE_PUSH_HOOK_FILES is copied (a missing one makes
  // the built hook crash and refuse every push).
  for (const file of prePushHookFiles()) {
    copyFileSync(path.join(projectRoot, "core/release/hooks", file), path.join(CORE_HOST_OUT, "hooks", file));
  }
  // connect.mjs installs this skill so a connected agent knows the loop rules.
  mkdirSync(path.join(CORE_HOST_OUT, "skill"), { recursive: true });
  copyFileSync(path.join(projectRoot, "core/mcp/skill/SKILL.md"), path.join(CORE_HOST_OUT, "skill", "SKILL.md"));
  return CORE_HOST_OUT;
}

/** The pre-push hook's files, read from core/release/protect.ts so the list has one source. */
export function prePushHookFiles() {
  const source = readFileSync(path.join(projectRoot, "core/release/protect.ts"), "utf8");
  const match = /export const PRE_PUSH_HOOK_FILES[^=]*=\s*(\[[^\]]*\])/.exec(source);
  if (!match) throw new Error("core/release/protect.ts no longer exports PRE_PUSH_HOOK_FILES as a list; update scripts/build-core-host.mjs");
  const files = JSON.parse(match[1]);
  if (!Array.isArray(files) || !files.includes("pre-push.mjs") || files.some((f) => typeof f !== "string" || f.includes("/") || f.includes("\\"))) {
    throw new Error("PRE_PUSH_HOOK_FILES must list plain file names, including pre-push.mjs");
  }
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildCoreHost().then((out) => console.log(`[perfect-planner] Core host built in ${out}`), (error) => { console.error(error.message); process.exit(1); });
}
