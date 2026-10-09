import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gitExecutable, NO_CWD_SEARCH_ENV } from "../exec/index";
import { safeRunner } from "./run";

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
});
