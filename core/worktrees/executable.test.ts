import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findExecutable, gitExecutable } from "./executable";
import { git } from "./git";
import { realDir } from "./platform";
import { makeRepo } from "./testing";

const isWindows = process.platform === "win32";
const cleanups: (() => void)[] = [];
const originalPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = originalPath;
  while (cleanups.length) cleanups.pop()!();
});

/** A program called git that, if it ever runs, leaves a marker and does not answer like git. */
function plantGit(dir: string): string {
  if (isWindows) {
    const file = path.join(dir, "git.exe");
    copyFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "hostname.exe"), file);
    return file;
  }
  const file = path.join(dir, "git");
  writeFileSync(file, `#!/bin/sh\necho planted > "${path.join(dir, "planted-ran")}"\necho planted\n`);
  chmodSync(file, 0o755);
  return file;
}

describe("git resolver", () => {
  it("findExecutable skips empty, relative and in-repo PATH entries", () => {
    const base = realDir(mkdtempSync(path.join(os.tmpdir(), "pp-exe-")));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const repo = path.join(base, "repo");
    const tools = path.join(base, "tools");
    mkdirSync(path.join(repo, "bin"), { recursive: true });
    mkdirSync(tools);
    plantGit(repo);
    plantGit(path.join(repo, "bin"));
    const real = plantGit(tools);
    const env = { PATH: ["", ".", "bin", repo, path.join(repo, "bin"), tools].join(path.delimiter) };
    expect(findExecutable("git", env, repo)).toBe(real);
    expect(findExecutable("git", { PATH: [".", repo].join(path.delimiter) }, repo)).toBeNull();
  });

  it("never runs a git planted in the repo, whatever PATH says", async () => {
    const repo = await makeRepo({ "a.txt": "a\n" });
    cleanups.push(repo.cleanup);
    plantGit(repo.root);
    for (const prefix of [".", "", repo.root]) {
      process.env.PATH = `${prefix}${path.delimiter}${originalPath}`;
      expect(await git(repo.root, ["--version"])).toMatch(/^git version \d/);
      expect(gitExecutable(repo.root).startsWith(repo.root)).toBe(false);
    }
    expect(existsSync(path.join(repo.root, "planted-ran"))).toBe(false);
  });

  it("starts git with the current folder left out of Windows' program search", async () => {
    const repo = await makeRepo({ "a.txt": "a\n" });
    cleanups.push(repo.cleanup);
    const inherited = process.env.NoDefaultCurrentDirectoryInExePath;
    delete process.env.NoDefaultCurrentDirectoryInExePath;
    cleanups.push(() => {
      if (inherited !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = inherited;
    });
    expect(await git(repo.root, ["-c", "alias.showenv=!env", "showenv"])).toContain("NoDefaultCurrentDirectoryInExePath=1");
  });
});
