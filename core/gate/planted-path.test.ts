import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Actor } from "../ledger/index";
import { WorktreeManager } from "../worktrees/manager";
import { makeRepo, memoryLedger } from "../worktrees/testing";
import { isConclusiveFailure, resolveCommand, runTestCommand, TestGate, testEnv } from "./index";

// A worker plants a `node` (or `npm`) in the project and reaches it through a PATH folder that links
// into the repo. The test command must still run the real program, or the gate's evidence is forged.

const isWindows = process.platform === "win32";
const OWNER: Actor = { kind: "person", id: "owner" };
const WORKER: Actor = { kind: "agent", id: "worker-1", model: "test-model" };
const FAILING = `process.exit(1);\n`;

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return dir;
}

/** A program called `name` that leaves a marker and reports success without running anything. */
function plant(dir: string, name: string, marker: string): void {
  mkdirSync(dir, { recursive: true });
  if (isWindows) {
    writeFileSync(path.join(dir, `${name}.cmd`), `@echo planted %0>>"${marker}"\r\n@exit /b 0\r\n`);
    return;
  }
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\necho "planted $0" >> "${marker}"\nexit 0\n`);
  chmodSync(file, 0o755);
}

/** A folder outside the repo that leads into `target` (a junction on Windows), as a PATH entry would. */
function linkTo(target: string): string {
  const link = path.join(scratch("pp-path-link-"), "bin");
  symlinkSync(target, link, isWindows ? "junction" : "dir");
  return link;
}

/** Put `dir` first on this process's PATH (the runner reads process.env) until the test ends. */
function prependPath(dir: string): void {
  const before = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${before ?? ""}`;
  cleanups.push(() => {
    process.env.PATH = before;
  });
}

async function plantedRepo() {
  const repo = await makeRepo({
    "tests/s.check.mjs": FAILING,
    "package.json": JSON.stringify({ name: "planted", private: true, scripts: { test: "node tests/s.check.mjs" } }),
  });
  cleanups.push(repo.cleanup);
  const marker = path.join(scratch("pp-marker-"), "planted-ran");
  const tools = path.join(repo.root, ".tools");
  plant(tools, "node", marker);
  plant(tools, "npm", marker);
  return { root: repo.root, marker, tools };
}

describe("a node or npm planted in the project and reached through a linked PATH folder", () => {
  for (const command of ["node tests/s.check.mjs", "npm test"]) {
    it(`never runs for "${command}", so the real failing test is reported`, async () => {
      const { root, marker, tools } = await plantedRepo();
      prependPath(linkTo(tools));
      const run = await runTestCommand(command, root, { timeoutMs: 60_000 });
      expect(existsSync(marker)).toBe(false);
      expect(run.passed).toBe(false);
      expect(isConclusiveFailure(run)).toBe(true);
    }, 90_000);
  }

  it("is also skipped when the link leads into another checkout of the repo (the gate protects every worktree)", async () => {
    const { root, marker, tools } = await plantedRepo();
    const ledger = await memoryLedger();
    const gate = new TestGate({ ledger, timeoutMs: 60_000 });
    expect(gate.define("T-1", "node tests/s.check.mjs", WORKER).ok).toBe(true);
    expect(gate.approve("T-1", OWNER, { cwd: root }).ok).toBe(true);
    const manager = new WorktreeManager({ repoRoot: root, ledger, install: false, ports: [43500, 43599] });
    prependPath(linkTo(tools));
    // Planted in the main checkout, run in the worker's worktree.
    expect((await gate.confirmFailsFirst("T-1", root)).ok).toBe(true);
    const info = await manager.create({ taskId: "T-1", actor: OWNER });
    const proved = await gate.prove("T-1", info.path);
    expect(proved.ok).toBe(false);
    expect(existsSync(marker)).toBe(false);
  }, 90_000);

  it("refuses a command whose first word is a program inside the project, as written or through a link", async () => {
    const { root, marker, tools } = await plantedRepo();
    const link = linkTo(tools);
    for (const command of [`.tools${path.sep}node tests/s.check.mjs`, `"${path.join(link, "node")}" tests/s.check.mjs`, `X=1 .tools${path.sep}npm test`]) {
      const run = await runTestCommand(command, root, { timeoutMs: 60_000 });
      expect(run).toMatchObject({ passed: false, exitCode: null });
      expect(run.outputTail).toContain("refused");
      expect(isConclusiveFailure(run)).toBe(false);
    }
    expect(existsSync(marker)).toBe(false);
    expect(resolveCommand("$TOOL tests/s.check.mjs", root, process.env).kind).toBe("unclear");
  });
});

describe("testEnv", () => {
  it("keeps only PATH folders outside the project, and puts the app's Node first", async () => {
    const { root, tools } = await plantedRepo();
    const outside = scratch("pp-outside-bin-");
    const link = linkTo(tools);
    const nodeDir = path.dirname(process.execPath);
    const env = testEnv({ PATH: [".", "", "relative/bin", tools, link, root, outside, nodeDir].join(path.delimiter) }, { cwd: root, nodeDir });
    const value = env[isWindows ? "Path" : "PATH"]!.split(path.delimiter);
    expect(value).toEqual([nodeDir, outside]);
    expect(env.NoDefaultCurrentDirectoryInExePath).toBe("1");
  });

  it("finds the app's own Node when the PC has no Node on PATH", async () => {
    const dir = scratch("pp-no-node-");
    const empty = scratch("pp-empty-bin-");
    const before = process.env.PATH;
    process.env.PATH = empty;
    try {
      const run = await runTestCommand(`node -e "process.exit(0)"`, dir, { timeoutMs: 60_000 });
      expect(run.passed).toBe(true);
    } finally {
      process.env.PATH = before;
    }
  });
});
