import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Actor } from "../ledger/index";
import { git, runGit } from "../worktrees/git";
import { WorktreeManager } from "../worktrees/manager";
import { commitAll, makeRepo, memoryLedger, writeFiles } from "../worktrees/testing";
import { TestGate, sensitiveChanges } from "./index";

// A program on the PC writes hooks or git settings into the project's own .git between approval and
// merge. The app's git must never run them, and the diff the person sees must be the real one.

const OWNER: Actor = { kind: "person", id: "owner" };
const WORKER: Actor = { kind: "agent", id: "worker-1", model: "test-model" };
const SLOW = 90_000;
const CHECK = `import { readFileSync } from "node:fs";\nprocess.exit(readFileSync("feature.txt", "utf8").includes("enabled") ? 0 : 1);\n`;

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const HOOKS = ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "pre-merge-commit", "post-merge", "post-checkout", "reference-transaction", "post-rewrite", "pre-auto-gc", "post-index-change"];

/** An attacker script that appends to the marker whenever anything runs it (sh, as git runs it on every OS). */
function plant(file: string, marker: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\necho "ran $0" >> "${marker.replace(/\\/g, "/")}"\ncat\n`);
  chmodSync(file, 0o755);
  return file.replace(/\\/g, "/");
}

async function approvedRepo() {
  const repo = await makeRepo({ "check.mjs": CHECK, "feature.txt": "disabled\n" });
  cleanups.push(repo.cleanup);
  const root = repo.root;
  const marker = path.join(path.dirname(root), "attacker-ran");
  const ledger = await memoryLedger();
  const gate = new TestGate({ ledger, timeoutMs: 30_000 });
  expect(gate.define("T-1", "node check.mjs", WORKER).ok).toBe(true);
  expect(gate.approve("T-1", OWNER, { cwd: root }).ok).toBe(true);
  expect((await gate.confirmFailsFirst("T-1", root)).ok).toBe(true);
  const manager = new WorktreeManager({ repoRoot: root, ledger, install: false, ports: [43400, 43499] });
  const gitDir = path.join(root, ".git");
  return { root, marker, ledger, gate, manager, gitDir };
}

/** Dispatch, the worker's commit, check, the diff the person reviews, both approvals, and the merge. */
async function wholeLoop(ctx: Awaited<ReturnType<typeof approvedRepo>>) {
  const info = await ctx.manager.create({ taskId: "T-1", actor: OWNER });
  writeFiles(info.path, { "feature.txt": "enabled\n" });
  const tip = await commitAll(info.path, "enable feature");
  expect((await ctx.gate.prove("T-1", info.path)).ok).toBe(true);
  const base = await git(ctx.root, ["merge-base", "main", tip]);
  const shown = await git(ctx.root, ["diff", base, tip]);
  expect(ctx.gate.approveDiff("T-1", OWNER, tip).ok).toBe(true);
  expect(ctx.gate.approveMerge("T-1", OWNER, tip).ok).toBe(true);
  const merged = await ctx.gate.mergeAndVerify("T-1", { repoRoot: ctx.root, branch: info.branch, integrationBranch: "main", actor: OWNER });
  return { info, tip, shown, merged };
}

const REAL_DIFF = /^diff --git a\/feature\.txt b\/feature\.txt\n[\s\S]*^-disabled\n\+enabled$/m;

describe("the app's git ignores hooks and settings planted in the project", () => {
  it("never runs .git/hooks during dispatch, check, diff, approval or merge", async () => {
    const ctx = await approvedRepo();
    for (const hook of HOOKS) plant(path.join(ctx.gitDir, "hooks", hook), ctx.marker);
    const { merged } = await wholeLoop(ctx);
    expect(merged.ok).toBe(true);
    expect(existsSync(ctx.marker)).toBe(false);
  }, SLOW);

  it("never runs hooks from a core.hooksPath the project config points elsewhere", async () => {
    const ctx = await approvedRepo();
    const evil = path.join(path.dirname(ctx.root), "evil-hooks");
    for (const hook of HOOKS) plant(path.join(evil, hook), ctx.marker);
    await git(ctx.root, ["config", "core.hooksPath", evil.replace(/\\/g, "/")]);
    const { merged } = await wholeLoop(ctx);
    expect(merged.ok).toBe(true);
    expect(existsSync(ctx.marker)).toBe(false);
  }, SLOW);

  it("never runs a core.fsmonitor program", async () => {
    const ctx = await approvedRepo();
    await git(ctx.root, ["config", "core.fsmonitor", plant(path.join(path.dirname(ctx.root), "fsmonitor.sh"), ctx.marker)]);
    const { merged } = await wholeLoop(ctx);
    expect(merged.ok).toBe(true);
    expect(existsSync(ctx.marker)).toBe(false);
  }, SLOW);

  it("shows the real diff: no external diff, diff driver, textconv or display setting can change it", async () => {
    const ctx = await approvedRepo();
    const script = plant(path.join(path.dirname(ctx.root), "fake-diff.sh"), ctx.marker);
    for (const [key, value] of [["diff.external", script], ["diff.evil.command", script], ["diff.evil.textconv", script], ["diff.relative", "true"], ["diff.noprefix", "true"], ["color.ui", "always"]]) {
      await git(ctx.root, ["config", key!, value!]);
    }
    writeFiles(ctx.gitDir, { "info/attributes": "* diff=evil\n" });
    const { shown, merged } = await wholeLoop(ctx);
    expect(shown).toMatch(REAL_DIFF);
    expect(shown).not.toContain("\u001b[");
    expect(merged.ok).toBe(true);
    expect(existsSync(ctx.marker)).toBe(false);
  }, SLOW);

  it("refuses, without running it, a filter program or merge driver in the project config", async () => {
    for (const [key, attribute] of [["filter.evil.smudge", "filter=evil"], ["filter.evil.clean", "filter=evil"], ["filter.evil.process", "filter=evil"], ["merge.evil.driver", "merge=evil"]] as const) {
      const ctx = await approvedRepo();
      // Work is dispatched and checked before the attacker acts.
      const info = await ctx.manager.create({ taskId: "T-1", actor: OWNER });
      writeFiles(info.path, { "feature.txt": "enabled\n" });
      const tip = await commitAll(info.path, "enable feature");
      expect((await ctx.gate.prove("T-1", info.path)).ok).toBe(true);
      expect(ctx.gate.approveDiff("T-1", OWNER, tip).ok).toBe(true);
      expect(ctx.gate.approveMerge("T-1", OWNER, tip).ok).toBe(true);

      await git(ctx.root, ["config", key, plant(path.join(path.dirname(ctx.root), "filter.sh"), ctx.marker)]);
      writeFiles(ctx.gitDir, { "info/attributes": `* ${attribute}\n` });
      const refusal = expect.stringContaining(key);
      expect(await ctx.gate.prove("T-1", info.path)).toMatchObject({ ok: false, reason: refusal });
      expect(await ctx.gate.mergeAndVerify("T-1", { repoRoot: ctx.root, branch: info.branch, integrationBranch: "main", actor: OWNER })).toMatchObject({ ok: false, reason: refusal });
      await expect(ctx.manager.create({ taskId: "T-2", actor: OWNER })).rejects.toThrow(/a person must review/);
      expect((await runGit(ctx.root, ["rev-parse", "main"])).stdout.trim()).not.toBe(tip);
      expect(existsSync(ctx.marker), `${key} ran: ${existsSync(ctx.marker) ? readFileSync(ctx.marker, "utf8") : ""}`).toBe(false);
    }
  }, SLOW * 2);
});

describe("sensitiveChanges for the diff the person approves", () => {
  it("flags dependency, git, CI and hook files from the changed paths alone", () => {
    expect(
      sensitiveChanges(["src/app.ts", "package.json", "pnpm-lock.yaml", ".npmrc", ".gitattributes", ".gitmodules", ".github/workflows/ci.yml", ".githooks/pre-commit", ".husky/pre-push", "vite.config.mjs", "README.md"]),
    ).toEqual(["package.json", "pnpm-lock.yaml", ".npmrc", ".gitattributes", ".gitmodules", ".github/workflows/ci.yml", ".githooks/pre-commit", ".husky/pre-push", "vite.config.mjs"]);
  });
});
