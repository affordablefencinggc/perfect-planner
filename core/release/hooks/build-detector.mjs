#!/usr/bin/env node
// Builds the plain-JS copies the pre-push hook imports (git runs the hook with
// node, which cannot load TypeScript):
//   secrets-detector.mjs  from core/secrets/index.ts  (the shared secret detector)
//   git-exec.mjs          from core/exec/executable.ts (git by absolute path, never from the repo)
// Run `node core/release/hooks/build-detector.mjs` after changing either source;
// `--check` exits 1 when a copy is stale, and secrets.test.ts runs that check,
// so the hook cannot drift from the review gate.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const COPIES = [
  { source: "../../secrets/index.ts", target: "./secrets-detector.mjs", from: "core/secrets/index.ts" },
  { source: "../../exec/executable.ts", target: "./git-exec.mjs", from: "core/exec/executable.ts" },
];

export function buildCopy({ source, from }) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(source, import.meta.url), "utf8").replace(/\r\n/g, "\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: true, newLine: ts.NewLineKind.LineFeed },
  });
  return `// GENERATED from ${from} by core/release/hooks/build-detector.mjs. Do not edit.\n${outputText}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  for (const copy of COPIES) {
    const target = new URL(copy.target, import.meta.url);
    const fresh = buildCopy(copy);
    if (!check) { writeFileSync(target, fresh); continue; }
    let current = "";
    try { current = readFileSync(target, "utf8").replace(/\r\n/g, "\n"); } catch { /* missing counts as stale */ }
    if (current !== fresh) {
      process.stderr.write(`core/release/hooks/${copy.target.slice(2)} is stale: run node core/release/hooks/build-detector.mjs\n`);
      process.exitCode = 1;
    }
  }
}
