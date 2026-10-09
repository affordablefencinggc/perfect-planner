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

// standalone: also bundle the npm packages (and the extra entries), for the desktop app,
// which ships these files with its own Node runtime and no node_modules.
export async function buildCoreHost({ outDir = CORE_HOST_OUT, standalone = false, entries = {} } = {}) {
  await build({
    entryPoints: { index: path.join(projectRoot, "core/host/index.ts"), agent: path.join(projectRoot, "core/host/agentStdio.ts"), connect: path.join(projectRoot, "core/host/agentConnect.ts"), ...entries },
    outdir: outDir,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outExtension: { ".js": ".mjs" },
    ...(standalone
      // CommonJS packages inside an ESM bundle still call require() for Node built-ins.
      ? { banner: { js: 'import { createRequire as __ppCreateRequire } from "node:module"; const require = __ppCreateRequire(import.meta.url);' } }
      : { packages: "external" }),
    logLevel: "warning",
  });
  // The worktree manager copies its commit-time secret scan from ./hooks next to its own module.
  mkdirSync(path.join(outDir, "hooks"), { recursive: true });
  copyFileSync(path.join(projectRoot, "core/worktrees/hooks/secret-scan.mjs"), path.join(outDir, "hooks", "secret-scan.mjs"));
  // Shipping safety (core/release/protect.ts) installs its whole-branch pre-push scan from the same
  // place, with the modules it imports (a hook missing one refuses every push).
  for (const file of ["pre-push.mjs", "secrets-detector.mjs", "git-exec.mjs"]) {
    copyFileSync(path.join(projectRoot, "core/release/hooks", file), path.join(outDir, "hooks", file));
  }
  // connect.mjs installs this skill so a connected agent knows the loop rules.
  mkdirSync(path.join(outDir, "skill"), { recursive: true });
  copyFileSync(path.join(projectRoot, "core/mcp/skill/SKILL.md"), path.join(outDir, "skill", "SKILL.md"));
  return outDir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildCoreHost().then((out) => console.log(`[perfect-planner] Core host built in ${out}`), (error) => { console.error(error.message); process.exit(1); });
}
