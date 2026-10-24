import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Actor } from "../ledger/index";
import { gitExecutable } from "../exec/index";
import { filterPrograms, git, GitHardeningError, GitProgramRefusedError, runGit } from "../worktrees/git";
import { WorktreeManager } from "../worktrees/manager";
import { commitAll, makeRepo, memoryLedger, writeFiles } from "../worktrees/testing";
import { pinTestFiles } from "./gate";
import { TestGate, sensitiveChanges, unalteredPins, verifyMergeCommit } from "./index";

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

describe("only an allow-list of git commands skips the filter check", () => {
  it("refuses hash-object, blame and cat-file --filters while a filter program is configured", async () => {
    const ctx = await approvedRepo();
    await git(ctx.root, ["config", "filter.evil.clean", plant(path.join(path.dirname(ctx.root), "filter.sh"), ctx.marker)]);
    writeFiles(ctx.gitDir, { "info/attributes": "* filter=evil\n" });
    for (const args of [["hash-object", "feature.txt"], ["blame", "feature.txt"], ["cat-file", "--filters", "HEAD:feature.txt"]]) {
      await expect(runGit(ctx.root, args)).rejects.toThrow(/a person must review/);
    }
    // Reading objects and refs stays possible.
    expect((await runGit(ctx.root, ["cat-file", "blob", "HEAD:feature.txt"])).stdout).toBe("disabled\n");
    expect((await runGit(ctx.root, ["rev-parse", "HEAD"])).code).toBe(0);
    expect(existsSync(ctx.marker)).toBe(false);
  }, SLOW);
});

describe("settings that only apply on some branches or folders (includeIf) are refused too", () => {
  /** A config file that names a filter program, pulled in by the project config only under `condition`. */
  function plantConditional(ctx: Awaited<ReturnType<typeof approvedRepo>>, condition: string, name: string) {
    const program = plant(path.join(path.dirname(ctx.root), `${name}.sh`), ctx.marker);
    const included = path.join(path.dirname(ctx.root), `${name}.gitconfig`).replace(/\\/g, "/");
    writeFileSync(included, `[filter "evil"]\n\tsmudge = ${program}\n\tclean = ${program}\n`);
    writeFiles(ctx.gitDir, { "info/attributes": "* filter=evil\n" });
    return { included, key: `includeIf.${condition}.path` };
  }

  it("refuses dispatch when the worker's branch (onbranch) or folder (gitdir) would turn on a filter", async () => {
    for (const condition of ["onbranch:pp/**", "gitdir:**/.perfect-planner/worktrees/**"]) {
      const ctx = await approvedRepo();
      const { included, key } = plantConditional(ctx, condition, "dispatch");
      await git(ctx.root, ["config", key, included]);
      await expect(ctx.manager.create({ taskId: "T-1", actor: OWNER })).rejects.toBeInstanceOf(GitProgramRefusedError);
      expect(existsSync(ctx.marker), `${condition} ran: ${existsSync(ctx.marker) ? readFileSync(ctx.marker, "utf8") : ""}`).toBe(false);
      expect((await runGit(ctx.root, ["worktree", "list", "--porcelain"])).stdout).not.toContain(".perfect-planner/worktrees");
    }
  }, SLOW * 2);

  it("refuses the merge when the candidate's folder (gitdir) would turn on a filter", async () => {
    const ctx = await approvedRepo();
    const info = await ctx.manager.create({ taskId: "T-1", actor: OWNER });
    writeFiles(info.path, { "feature.txt": "enabled\n" });
    const tip = await commitAll(info.path, "enable feature");
    expect((await ctx.gate.prove("T-1", info.path)).ok).toBe(true);
    expect(ctx.gate.approveDiff("T-1", OWNER, tip).ok).toBe(true);
    expect(ctx.gate.approveMerge("T-1", OWNER, tip).ok).toBe(true);
    const { included, key } = plantConditional(ctx, "gitdir:**/pp-gate-*/**", "merge");
    await git(ctx.root, ["config", key, included]);
    const merged = await ctx.gate.mergeAndVerify("T-1", { repoRoot: ctx.root, branch: info.branch, integrationBranch: "main", actor: OWNER });
    expect(merged).toMatchObject({ ok: false, reason: expect.stringContaining("filter.evil.smudge") });
    expect(existsSync(ctx.marker), existsSync(ctx.marker) ? readFileSync(ctx.marker, "utf8") : "").toBe(false);
    expect(await git(ctx.root, ["rev-parse", "main"])).not.toBe(tip);
  }, SLOW);

  it("finds a conditional include nested in an included file, whatever its condition", async () => {
    const ctx = await approvedRepo();
    const { included, key } = plantConditional(ctx, "onbranch:never-used/**", "nested");
    const outer = path.join(path.dirname(ctx.root), "outer.gitconfig").replace(/\\/g, "/");
    writeFileSync(outer, `[includeIf "${key.slice("includeIf.".length, -".path".length)}"]\n\tpath = ${included}\n`);
    await git(ctx.root, ["config", "include.path", outer]);
    expect(await filterPrograms(ctx.root)).toEqual(expect.arrayContaining(["filter.evil.smudge", "filter.evil.clean"]));
    await expect(runGit(ctx.root, ["checkout", "-q", "-b", "other"])).rejects.toBeInstanceOf(GitProgramRefusedError);
    expect(existsSync(ctx.marker)).toBe(false);
  });
});

describe("include lines that are hard to read are refused, never skipped", () => {
  it("reads an include from a file with a non-ASCII name, and a path with a newline in it", async () => {
    const ctx = await approvedRepo();
    const program = plant(path.join(path.dirname(ctx.root), "odd.sh"), ctx.marker);
    const dir = path.dirname(ctx.root);
    const filter = `[filter "evil"]\n\tsmudge = ${program}\n`;
    // (A) The conditional include sits in outé.gitconfig, whose name git quotes in its output.
    writeFileSync(path.join(dir, "evil-a.gitconfig"), filter);
    writeFileSync(path.join(dir, "outé.gitconfig"), `[includeIf "onbranch:never/**"]\n\tpath = evil-a.gitconfig\n`);
    await git(ctx.root, ["config", "include.path", path.join(dir, "outé.gitconfig").replace(/\\/g, "/")]);
    expect(await filterPrograms(ctx.root)).toContain("filter.evil.smudge");
    await git(ctx.root, ["config", "--unset", "include.path"]);
    // (B) A path with a newline in it (not possible in a Windows file name).
    if (process.platform !== "win32") {
      const odd = path.join(dir, "evil\nb.gitconfig");
      writeFileSync(odd, filter);
      await git(ctx.root, ["config", "includeIf.onbranch:never/**.path", odd]);
      expect(await filterPrograms(ctx.root)).toContain("filter.evil.smudge");
    }
    expect(existsSync(ctx.marker)).toBe(false);
  });

  it("refuses %(prefix)/ and ~user/ include paths it can't place the way git would", async () => {
    for (const value of ["%(prefix)/etc/evil.gitconfig", "~someone/evil.gitconfig"]) {
      const ctx = await approvedRepo();
      await git(ctx.root, ["config", "includeIf.onbranch:never/**.path", value]);
      expect(await filterPrograms(ctx.root)).toEqual([expect.stringContaining(value)]);
      await expect(runGit(ctx.root, ["checkout", "-q", "-b", "other"])).rejects.toBeInstanceOf(GitProgramRefusedError);
    }
  });
});

describe("the app's own git settings cannot be used to run a program", () => {
  it("points hooks at a path that can never hold one, so a hook planted where the old empty folder was never runs", async () => {
    const ctx = await approvedRepo();
    // Through the hardened runner the hooks folder is /dev/null (git.exe's own path on Windows), not a temp folder.
    const hooks = await git(ctx.root, ["rev-parse", "--git-path", "hooks"]);
    expect(process.platform === "win32" ? path.resolve(hooks) : hooks).toBe(process.platform === "win32" ? path.resolve(gitExecutable(ctx.root)) : "/dev/null");
    // The old layout: an empty no-hooks folder beside the app's attributes file. Plant every hook there.
    const attributes = await git(ctx.root, ["config", "--get", "core.attributesFile"]);
    for (const hook of HOOKS) plant(path.join(path.dirname(attributes), "no-hooks", hook), ctx.marker);
    cleanups.push(() => rmSync(path.join(path.dirname(attributes), "no-hooks"), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
    const { merged } = await wholeLoop(ctx);
    expect(merged.ok).toBe(true);
    expect(existsSync(ctx.marker)).toBe(false);
  }, SLOW);

  it("refuses to run git once its empty attributes file is changed", async () => {
    const repo = await makeRepo({ "a.txt": "a\n" });
    cleanups.push(repo.cleanup);
    const attributes = await git(repo.root, ["config", "--get", "core.attributesFile"]);
    chmodSync(attributes, 0o644);
    writeFileSync(attributes, "* diff=planted\n");
    try {
      await expect(runGit(repo.root, ["rev-parse", "HEAD"])).rejects.toBeInstanceOf(GitHardeningError);
    } finally {
      writeFileSync(attributes, "");
      chmodSync(attributes, 0o444);
    }
    expect((await runGit(repo.root, ["rev-parse", "HEAD"])).code).toBe(0);
  });

  it("never reaches a remote: ext::, a local remote's uploadpack and ssh commands do not run", async () => {
    const ctx = await approvedRepo();
    const other = await makeRepo({ "b.txt": "b\n" });
    cleanups.push(other.cleanup);
    const program = plant(path.join(path.dirname(ctx.root), "remote-program"), ctx.marker);
    await git(ctx.root, ["config", "remote.ext.url", `ext::sh ${program} %S`]);
    await git(ctx.root, ["config", "remote.local.url", other.root.replace(/\\/g, "/")]);
    await git(ctx.root, ["config", "remote.local.uploadpack", program]);
    await git(ctx.root, ["config", "remote.ssh.url", "ssh://example.invalid/repo.git"]);
    await git(ctx.root, ["config", "core.sshCommand", program]);
    // A variable inherited from whoever started the app must not re-allow them either.
    process.env.GIT_ALLOW_PROTOCOL = "ext:file:ssh";
    try {
      for (const remote of ["ext", "local", "ssh"]) {
        expect((await runGit(ctx.root, ["fetch", remote], { timeoutMs: 10_000 })).code).not.toBe(0);
        expect((await runGit(ctx.root, ["ls-remote", remote], { timeoutMs: 10_000 })).code).not.toBe(0);
      }
    } finally {
      delete process.env.GIT_ALLOW_PROTOCOL;
    }
    expect(existsSync(ctx.marker)).toBe(false);
  }, SLOW);

  it("follows include.path in the project config to a planted filter or fsmonitor and still runs nothing", async () => {
    const ctx = await approvedRepo();
    const program = plant(path.join(path.dirname(ctx.root), "included-program"), ctx.marker);
    const included = path.join(path.dirname(ctx.root), "included.gitconfig");
    writeFileSync(included, `[core]\n\tfsmonitor = ${program}\n[log]\n\tshowSignature = true\n[gpg]\n\tprogram = ${program}\n`);
    await git(ctx.root, ["config", "include.path", included.replace(/\\/g, "/")]);
    const { merged } = await wholeLoop(ctx);
    expect(merged.ok).toBe(true);
    expect(existsSync(ctx.marker)).toBe(false);

    writeFileSync(included, `[filter "x"]\n\tclean = ${program}\n`);
    writeFileSync(path.join(ctx.root, ".gitattributes"), "* filter=x\n");
    await expect(runGit(ctx.root, ["status"])).rejects.toBeInstanceOf(GitProgramRefusedError);
    expect(existsSync(ctx.marker)).toBe(false);
  }, SLOW);
});

describe("the merge lands only the clean merge of the approved commit", () => {
  it("refuses when the candidate moved after the merge", async () => {
    const ctx = await approvedRepo();
    const info = await ctx.manager.create({ taskId: "T-1", actor: OWNER });
    writeFiles(info.path, { "feature.txt": "enabled\n" });
    const tip = await commitAll(info.path, "enable feature");
    expect((await ctx.gate.prove("T-1", info.path)).ok).toBe(true);
    expect(ctx.gate.approveDiff("T-1", OWNER, tip).ok).toBe(true);
    expect(ctx.gate.approveMerge("T-1", OWNER, tip).ok).toBe(true);
    const before = await git(ctx.root, ["rev-parse", "main"]);
    const prepare = async (candidate: string) => {
      writeFiles(candidate, { "unapproved.txt": "slipped in\n" });
      await git(candidate, ["add", "unapproved.txt"]);
      await git(candidate, ["commit", "-q", "--amend", "--no-edit"]);
    };
    const merged = await ctx.gate.mergeAndVerify("T-1", { repoRoot: ctx.root, branch: info.branch, integrationBranch: "main", actor: OWNER, prepare });
    expect(merged).toMatchObject({ ok: false, reason: expect.stringContaining("moved") });
    expect(await git(ctx.root, ["rev-parse", "main"])).toBe(before);
  }, SLOW);

  it("refuses a merge commit with the right parents but a different tree", async () => {
    const ctx = await approvedRepo();
    const base = await git(ctx.root, ["rev-parse", "main"]);
    await git(ctx.root, ["checkout", "-q", "-b", "work"]);
    writeFiles(ctx.root, { "feature.txt": "enabled\n" });
    const approved = await commitAll(ctx.root, "enable feature");
    writeFiles(ctx.root, { "unapproved.txt": "slipped in\n" });
    await git(ctx.root, ["add", "-A"]);
    const tree = await git(ctx.root, ["write-tree"]);
    const forged = await git(ctx.root, ["commit-tree", tree, "-p", base, "-p", approved, "-m", "merge"]);
    await git(ctx.root, ["reset", "-q", "--hard", forged]);
    expect(await verifyMergeCommit(ctx.root, forged, base, approved)).toMatch(/not the clean merge/);
    const clean = await git(ctx.root, ["commit-tree", `${approved}^{tree}`, "-p", base, "-p", approved, "-m", "merge"]);
    await git(ctx.root, ["reset", "-q", "--hard", clean]);
    expect(await verifyMergeCommit(ctx.root, clean, base, approved)).toBeNull();
  }, SLOW);
});

describe("sensitiveChanges for the diff the person approves", () => {
  it("flags dependency, git, CI and hook files from the changed paths alone", () => {
    expect(
      sensitiveChanges(["src/app.ts", "package.json", "pnpm-lock.yaml", ".npmrc", ".gitattributes", ".gitmodules", ".github/workflows/ci.yml", ".githooks/pre-commit", ".husky/pre-push", "vite.config.mjs", "README.md"]),
    ).toEqual(["package.json", "pnpm-lock.yaml", ".npmrc", ".gitattributes", ".gitmodules", ".github/workflows/ci.yml", ".githooks/pre-commit", ".husky/pre-push", "vite.config.mjs"]);
  });

  it("skips the flag only for the exact approved test file, and only while it is exactly what was approved", () => {
    const pinned = ["tests/save.check.mjs"];
    const changed = ["src/save.js", "tests/save.check.mjs", "tests/helper.mjs", "tests/other.check.mjs", "tests/save.check.mjs.bak", "tests/sub/save.check.mjs"];
    const support = new Set(["tests/save.check.mjs"]);
    // Not told the approved file is unchanged: nothing is exempt, as before.
    expect(sensitiveChanges(changed, pinned, support)).toContain("tests/save.check.mjs");
    // Told it is unchanged: that one path drops out; every other test-like file and renamed copy stays flagged.
    expect(sensitiveChanges(changed, pinned, support, new Set(pinned))).toEqual(["tests/helper.mjs", "tests/other.check.mjs", "tests/save.check.mjs.bak", "tests/sub/save.check.mjs"]);
    // The exemption needs the file to be pinned: an "unchanged" claim for any other path does nothing.
    expect(sensitiveChanges(["tests/helper.mjs"], pinned, support, new Set(["tests/helper.mjs"]))).toEqual(["tests/helper.mjs"]);
    // Real sensitive files are never exempted, even when pinned and unchanged.
    const hard = ["package.json", ".github/workflows/ci.yml", "vitest.config.mjs", "tests/setup.mjs"];
    expect(sensitiveChanges(hard, hard, new Set(hard), new Set(hard))).toEqual(hard);
  });

  it("unalteredPins lists only approved files whose committed content is still the approved content", async () => {
    const repo = await makeRepo({ "tests/a.check.mjs": "process.exit(0);\n", "tests/b.check.mjs": "process.exit(0);\n" });
    cleanups.push(repo.cleanup);
    const pins = pinTestFiles(repo.root, ["tests/a.check.mjs", "tests/b.check.mjs"]);
    writeFiles(repo.root, { "tests/b.check.mjs": "process.exit(0); // edited after approval\n", "tests/c.check.mjs": "process.exit(0);\n" });
    const tip = await commitAll(repo.root, "edit b, add c");
    expect([...(await unalteredPins(repo.root, tip, pins))]).toEqual(["tests/a.check.mjs"]);
  });
  it("shows no flag for the approved test plus product code, keeps flags for other tests and CI files, and flags an edited copy", async () => {
    const repo = await makeRepo({ "tests/a.check.mjs": "process.exit(0);\n", "src/app.js": "export const a = 1;\n" });
    cleanups.push(repo.cleanup);
    const pins = pinTestFiles(repo.root, ["tests/a.check.mjs"]);
    const flagged = async (tip: string, changed: string[]) => sensitiveChanges(changed, Object.keys(pins), new Set(Object.keys(pins)), await unalteredPins(repo.root, tip, pins));
    // (a) the approved test file plus product code only: nothing flagged.
    writeFiles(repo.root, { "src/app.js": "export const a = 2;\n" });
    const tipA = await commitAll(repo.root, "product code");
    expect(await flagged(tipA, ["src/app.js", "tests/a.check.mjs"])).toEqual([]);
    // (b) another test file, package.json or a CI workflow alongside it: still flagged.
    writeFiles(repo.root, { "tests/other.check.mjs": "process.exit(0);\n", "package.json": "{}\n", ".github/workflows/ci.yml": "on: push\n" });
    const tipB = await commitAll(repo.root, "other files");
    const all = ["src/app.js", "tests/a.check.mjs", "tests/other.check.mjs", "package.json", ".github/workflows/ci.yml"];
    expect(await flagged(tipB, all)).toEqual(["tests/other.check.mjs", "package.json", ".github/workflows/ci.yml"]);
    // (c) an edited copy of the approved test is flagged.
    writeFiles(repo.root, { "tests/a.check.mjs": "process.exit(0); // edited\n" });
    const tipC = await commitAll(repo.root, "edit approved test");
    expect(await flagged(tipC, ["src/app.js", "tests/a.check.mjs"])).toEqual(["tests/a.check.mjs"]);
  });
});
