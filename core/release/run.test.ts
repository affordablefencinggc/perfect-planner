import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gitExecutable, NO_CWD_SEARCH_ENV } from "../exec/index";
import { Ledger, MemoryStore } from "../ledger/index";
import { installNumberingRules } from "../numbering/index";
import { installPrePushHook, prePushInstalled } from "./layers";
import { protectProject } from "./protect";
import { createSafeRunner, safeRunner } from "./run";
import { scanBranch } from "./secrets";

const env = { ...process.env, ...NO_CWD_SEARCH_ENV };

// A repo with a "git" planted in it, and that folder first on PATH: the trap a cloned repo can set.
function plantedRepo(): { root: string; marker: string; pathWithRepoFirst: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-planted-"));
  execFileSync(gitExecutable(root), ["init", "-q"], { cwd: root, env });
  const marker = path.join(root, "planted-ran");
  if (process.platform === "win32") {
    fs.copyFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "hostname.exe"), path.join(root, "git.exe"));
  } else {
    fs.writeFileSync(path.join(root, "git"), `#!/bin/sh\necho planted > "${marker}"\necho planted\n`);
    fs.chmodSync(path.join(root, "git"), 0o755);
  }
  return { root, marker, pathWithRepoFirst: `${root}${path.delimiter}.${path.delimiter}${process.env.PATH ?? ""}` };
}

describe("safeRunner and the pre-push hook never run a git planted in the repo", () => {
  it("safeRunner runs the real git, by absolute path", async () => {
    const { root, marker, pathWithRepoFirst } = plantedRepo();
    const saved = process.env.PATH;
    try {
      process.env.PATH = pathWithRepoFirst;
      const result = await safeRunner("git", ["rev-parse", "--git-path", "hooks"], { cwd: root });
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toMatch(/hooks$/);
      expect(result.stdout).not.toContain("planted");
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      process.env.PATH = saved;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("the pre-push hook scans with the real git too", () => {
    const { root, marker, pathWithRepoFirst } = plantedRepo();
    try {
      const git = (...args: string[]) => execFileSync(gitExecutable(os.tmpdir()), args, { cwd: root, env, encoding: "utf8" }).trim();
      fs.writeFileSync(path.join(root, "a.txt"), "hello\n");
      git("-c", "user.name=t", "-c", "user.email=t@example.com", "add", "a.txt");
      git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "one");
      const sha = git("rev-parse", "HEAD");
      const hook = fileURLToPath(new URL("./hooks/pre-push.mjs", import.meta.url));
      const result = spawnSync(process.execPath, [hook], {
        cwd: root,
        input: `refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`,
        encoding: "utf8",
        env: { ...process.env, PATH: pathWithRepoFirst },
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // A PATH folder outside the repo that links into it (symlink, or a junction on Windows).
  function linkedPath(target: string): { link: string; pathWithLinkFirst: string; cleanup: () => void } {
    const holder = fs.mkdtempSync(path.join(os.tmpdir(), "pp-link-"));
    const link = path.join(holder, "bin");
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    return { link, pathWithLinkFirst: `${link}${path.delimiter}${process.env.PATH ?? ""}`, cleanup: () => fs.rmSync(holder, { recursive: true, force: true }) };
  }

  it("safeRunner skips a PATH folder that reaches the repo through a link", async () => {
    const { root, marker } = plantedRepo();
    const { pathWithLinkFirst, cleanup } = linkedPath(root);
    const saved = process.env.PATH;
    try {
      process.env.PATH = pathWithLinkFirst;
      const result = await safeRunner("git", ["rev-parse", "--git-path", "hooks"], { cwd: root });
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain("planted");
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      process.env.PATH = saved;
      cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("createSafeRunner protects extra roots, so a planted git at the repo top is skipped from a subfolder", async () => {
    const { root, marker } = plantedRepo();
    const sub = path.join(root, "packages", "app");
    fs.mkdirSync(sub, { recursive: true });
    const { pathWithLinkFirst, cleanup } = linkedPath(root);
    const saved = process.env.PATH;
    try {
      process.env.PATH = pathWithLinkFirst;
      const result = await createSafeRunner({ protect: [root] })("git", ["rev-parse", "--show-toplevel"], { cwd: sub });
      // From the subfolder alone the planted git looks fine; the protect roots catch it, and the call is refused.
      expect(result.code).toBe(127);
      expect(result.stderr).toMatch(/protected project folder/);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      process.env.PATH = saved;
      cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("the pre-push hook skips a PATH folder that reaches the repo through a link", () => {
    const { root, marker } = plantedRepo();
    const { pathWithLinkFirst, cleanup } = linkedPath(root);
    try {
      const git = (...args: string[]) => execFileSync(gitExecutable(os.tmpdir()), args, { cwd: root, env, encoding: "utf8" }).trim();
      fs.writeFileSync(path.join(root, "a.txt"), "hello\n");
      git("-c", "user.name=t", "-c", "user.email=t@example.com", "add", "a.txt");
      git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "one");
      const sha = git("rev-parse", "HEAD");
      const hook = fileURLToPath(new URL("./hooks/pre-push.mjs", import.meta.url));
      const result = spawnSync(process.execPath, [hook], {
        cwd: root,
        input: `refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`,
        encoding: "utf8",
        env: { ...process.env, PATH: pathWithLinkFirst },
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// A repo whose own config and hooks name programs that write a marker file: the trap a cloned or
// agent-edited repo can set for whatever runs git in it as the host.
function trappedRepo(): { root: string; marker: string; first: string; second: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-trapped-"));
  const marker = path.join(root, "trap-ran").replace(/\\/g, "/");
  const git = (...args: string[]) => execFileSync(gitExecutable(os.tmpdir()), args, { cwd: root, env, encoding: "utf8" }).trim();
  git("init", "-q");
  const id = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
  fs.writeFileSync(path.join(root, "a.txt"), "one\n");
  git(...id, "add", "a.txt");
  git(...id, "commit", "-qm", "one");
  const first = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "a.txt"), "two\n");
  fs.writeFileSync(path.join(root, "b.txt"), "new\n");
  git(...id, "add", "a.txt", "b.txt");
  git(...id, "commit", "-qm", "two");
  const second = git("rev-parse", "HEAD");
  // Set the traps after committing, so making the fixture runs none of them.
  const trap = `echo ran >> '${marker}'`;
  const hooks = path.join(root, "trap-hooks");
  fs.mkdirSync(hooks);
  for (const name of ["pre-push", "post-checkout", "reference-transaction", "post-index-change"]) {
    fs.writeFileSync(path.join(hooks, name), `#!/bin/sh\n${trap}\n`);
    fs.chmodSync(path.join(hooks, name), 0o755);
  }
  for (const name of ["pre-push", "reference-transaction"]) {
    fs.writeFileSync(path.join(root, ".git", "hooks", name), `#!/bin/sh\n${trap}\n`);
    fs.chmodSync(path.join(root, ".git", "hooks", name), 0o755);
  }
  fs.writeFileSync(path.join(root, ".git", "info", "attributes"), "* diff=trap filter=trap\n");
  git("config", "core.fsmonitor", trap);
  git("config", "diff.external", trap);
  git("config", "diff.trap.textconv", `${trap}; cat`);
  git("config", "filter.trap.clean", `${trap}; cat`);
  git("config", "filter.trap.smudge", `${trap}; cat`);
  return { root, marker, first, second, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe("host git never runs the repo's own hooks or programs", () => {
  it("the trap is real: plain git runs it", () => {
    const { root, marker, first, second, cleanup } = trappedRepo();
    try {
      // `git show <commit>` is one of the calls safeRunner makes below: plain git runs the textconv.
      execFileSync(gitExecutable(os.tmpdir()), ["show", second], { cwd: root, env, encoding: "utf8" });
      expect(fs.existsSync(marker)).toBe(true);
      fs.rmSync(marker);
      execFileSync(gitExecutable(os.tmpdir()), ["diff", first, second], { cwd: root, env, encoding: "utf8" });
      expect(fs.existsSync(marker)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("safeRunner, scanBranch, installPrePushHook, prePushInstalled and protectProject run none of it", async () => {
    const { root, marker, first, second, cleanup } = trappedRepo();
    try {
      const scan = await scanBranch(safeRunner, { cwd: root, base: first, head: second });
      expect(scan).toMatchObject({ ok: true, filesScanned: 2 });
      const show = await safeRunner("git", ["show", second], { cwd: root });
      expect(show.code).toBe(0);
      expect(show.stdout).toContain("+two");
      // A working-tree command is refused outright while the repo names a filter program.
      const status = await safeRunner("git", ["status"], { cwd: root });
      expect(status.code).not.toBe(0);
      expect(status.stderr).toMatch(/will not run it/);
      // Its hooks folder is the repo's own (.git/hooks here; the trap hooks are not named in config).
      const installed = await installPrePushHook(safeRunner, { cwd: root, hookScript: "/opt/pp/pre-push.mjs" });
      expect(installed.installed).toBe(false);
      expect(fs.realpathSync(installed.path)).toBe(fs.realpathSync(path.join(root, ".git", "hooks", "pre-push")));
      expect(await prePushInstalled(safeRunner, { cwd: root })).toBe(false);
      const ledger = Ledger.openSync(new MemoryStore());
      installNumberingRules(ledger);
      const report = await protectProject(ledger, { cwd: root, protect: [root] });
      expect(report.prePush.state).toBe("foreign-hook");
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("installPrePushHook follows the repo's core.hooksPath although host git fixes its own", async () => {
    const { root, marker, cleanup } = trappedRepo();
    try {
      execFileSync(gitExecutable(os.tmpdir()), ["config", "core.hooksPath", "own-hooks"], { cwd: root, env });
      const installed = await installPrePushHook(safeRunner, { cwd: root, hookScript: "/opt/pp/pre-push.mjs" });
      expect(installed).toMatchObject({ installed: true });
      expect(fs.realpathSync(installed.path)).toBe(fs.realpathSync(path.join(root, "own-hooks", "pre-push")));
      expect(await prePushInstalled(safeRunner, { cwd: root })).toBe(true);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("the pre-push hook runs none of it either", () => {
    const { root, marker, first, second, cleanup } = trappedRepo();
    try {
      const hook = fileURLToPath(new URL("./hooks/pre-push.mjs", import.meta.url));
      for (const remote of [first, "0".repeat(40)]) {
        const result = spawnSync(process.execPath, [hook], { cwd: root, input: `refs/heads/main ${second} refs/heads/main ${remote}\n`, encoding: "utf8", env: process.env });
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
      }
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      cleanup();
    }
  });
});
