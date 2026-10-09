#!/usr/bin/env node
// Builds secrets-detector.mjs, the plain-JS copy of core/secrets that the
// pre-push hook imports (git runs the hook with node, which cannot load
// TypeScript). Run `node core/release/hooks/build-detector.mjs` after changing
// core/secrets; `--check` exits 1 when the copy is stale, and secrets.test.ts
// runs that check, so the hook and the review gate cannot drift apart.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const source = new URL("../../secrets/index.ts", import.meta.url);
const target = new URL("./secrets-detector.mjs", import.meta.url);

const HEADER = "// GENERATED from core/secrets/index.ts by core/release/hooks/build-detector.mjs. Do not edit.\n";

export function buildDetector() {
  const { outputText } = ts.transpileModule(readFileSync(source, "utf8").replace(/\r\n/g, "\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: false, newLine: ts.NewLineKind.LineFeed },
  });
  return HEADER + outputText;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fresh = buildDetector();
  if (process.argv.includes("--check")) {
    let current = "";
    try { current = readFileSync(target, "utf8").replace(/\r\n/g, "\n"); } catch { /* missing counts as stale */ }
    if (current !== fresh) {
      process.stderr.write("core/release/hooks/secrets-detector.mjs is stale: run node core/release/hooks/build-detector.mjs\n");
      process.exit(1);
    }
  } else {
    writeFileSync(target, fresh);
  }
}
