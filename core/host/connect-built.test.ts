// The BUILT connect.mjs (one esbuild bundle, like dist/core-host/connect.mjs), run the way a person runs
// the connect line: nothing bundled into it may start a program on load, and neither connect.mjs nor the
// Claude Code it starts may ever run a git or claude planted in the repo, even through a PATH link.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const windows = process.platform === "win32";
const sep = path.delimiter;
const made: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-connect-built-"));
  made.push(dir);
  return dir;
};
const link = (target: string, at: string) => fs.symlinkSync(target, at, windows ? "junction" : "dir");

let connect = "";
beforeAll(async () => {
  const out = path.join(temp(), "core-host");
  await build({ entryPoints: { connect: path.resolve("core/host/agentConnect.ts") }, outdir: out, bundle: true, platform: "node", format: "esm", target: "node20", outExtension: { ".js": ".mjs" }, packages: "external", logLevel: "error" });
  fs.mkdirSync(path.join(out, "skill"));
  fs.copyFileSync(path.resolve("core/mcp/skill/SKILL.md"), path.join(out, "skill", "SKILL.md"));
  connect = path.join(out, "connect.mjs");
}, 60_000);
afterAll(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("built connect.mjs", () => {
  it("runs from outside any repo and from repo/src without running a planted git or claude", () => {
    const outside = temp();
    const project = temp();
    const repo = temp();
    fs.mkdirSync(path.join(repo, "src"));
    fs.mkdirSync(path.join(repo, "tools"));
    const tokenFile = path.join(project, ".perfect-planner", "tokens", "connect-C-1.token");
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, "");
    fs.writeFileSync(tokenFile.replace(/\.token$/, ".roots.json"), JSON.stringify({ roots: [project, repo] }));
    // Planted in the repo and reached through a PATH folder outside it that links in.
    const marker = path.join(outside, "planted-ran");
    if (!windows) {
      for (const name of ["git", "claude", "node"]) fs.writeFileSync(path.join(repo, "tools", name), `#!/bin/sh\necho "${name} $*" >> '${marker}'\n`, { mode: 0o755 });
    } else {
      fs.writeFileSync(path.join(repo, "tools", "claude.cmd"), "@echo off\r\n");
    }
    link(path.join(repo, "tools"), path.join(outside, "to-repo"));
    // The real Claude Code (npm layout); like Claude, it looks git up on its PATH.
    const report = path.join(outside, "claude-ran");
    const cli = path.join(outside, "safe", "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(
      cli,
      `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
require("node:child_process").spawnSync("git", ["--version"]);
appendFileSync(${JSON.stringify(report)}, JSON.stringify({ args: process.argv.slice(2), path: process.env.PATH ?? process.env.Path }) + "\\n");
`,
      { mode: 0o755 },
    );
    if (windows) fs.writeFileSync(path.join(outside, "safe", "claude.cmd"), "@echo off\r\n");
    else fs.symlinkSync(cli, path.join(outside, "safe", "claude"));
    const PATH = [path.join(outside, "to-repo"), path.join(outside, "safe"), process.env.PATH ?? process.env.Path ?? ""].join(sep);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: temp(), USERPROFILE: temp() };
    for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
    env[windows ? "Path" : "PATH"] = PATH;

    // A plain folder that is no repo, and a subfolder of the repo.
    for (const cwd of [temp(), path.join(repo, "src")]) {
      fs.rmSync(report, { force: true });
      const run = spawnSync(process.execPath, [connect, "http://127.0.0.1:5555", tokenFile], { cwd, env, encoding: "utf8" });
      expect(run.status, `${cwd}\n${run.stdout}\n${run.stderr}`).toBe(0);
      expect(fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "").toBe("");
      const calls = fs.readFileSync(report, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; path: string });
      expect(calls.at(-1)!.args.join(" ")).toContain("mcp add perfect-planner-core -s local");
      // Claude's PATH holds nothing that resolves into the repo.
      const realRepo = fs.realpathSync.native(repo);
      for (const call of calls) {
        for (const dir of call.path.split(sep).filter(Boolean)) {
          let real = dir;
          try {
            real = fs.realpathSync.native(dir);
          } catch {
            // missing folders cannot hold a program
          }
          expect(path.relative(realRepo, real).startsWith(".."), dir).toBe(true);
        }
      }
    }
  });
});
