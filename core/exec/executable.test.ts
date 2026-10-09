import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findExecutable, gitExecutable, isLocalWindowsPath, NO_CWD_SEARCH_ENV } from "./executable";

const isWindows = process.platform === "win32";
const cleanups: (() => void)[] = [];
const originalPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = originalPath;
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeRepo(): string {
  const root = tempDir("pp-exec-repo-");
  writeFileSync(path.join(root, "a.txt"), "a\n");
  execFileSync(gitExecutable(root), ["init", "-q"], { cwd: root, env: { ...process.env, ...NO_CWD_SEARCH_ENV } });
  return root;
}

const git = (cwd: string, args: string[]) =>
  execFileSync(gitExecutable(cwd), args, { cwd, encoding: "utf8", env: { ...process.env, ...NO_CWD_SEARCH_ENV }, windowsHide: true });

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
    const base = tempDir("pp-exe-");
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

  it("never runs a git planted in the repo, whatever PATH says", () => {
    const repo = makeRepo();
    plantGit(repo);
    for (const prefix of [".", "", repo]) {
      process.env.PATH = `${prefix}${path.delimiter}${originalPath}`;
      expect(git(repo, ["--version"])).toMatch(/^git version \d/);
      expect(gitExecutable(repo).startsWith(repo)).toBe(false);
    }
    expect(existsSync(path.join(repo, "planted-ran"))).toBe(false);
  });

  it("starts git with the current folder left out of Windows' program search", () => {
    const repo = makeRepo();
    const inherited = process.env.NoDefaultCurrentDirectoryInExePath;
    delete process.env.NoDefaultCurrentDirectoryInExePath;
    cleanups.push(() => {
      if (inherited !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = inherited;
    });
    expect(git(repo, ["-c", "alias.showenv=!env", "showenv"])).toContain("NoDefaultCurrentDirectoryInExePath=1");
  });
});

describe("isLocalWindowsPath", () => {
  it("accepts only local drive-letter paths and refuses UNC in every spelling", () => {
    for (const ok of ["C:\\Program Files\\Git\\cmd", "c:/tools/git", "D:\\"]) expect(isLocalWindowsPath(ok)).toBe(true);
    for (const bad of [
      "\\\\server\\share\\git",
      "//server/share/git",
      "\\/server\\share",
      "/\\server/share",
      "\\\\?\\UNC\\server\\share",
      "\\??\\UNC\\server\\share",
      "\\\\?\\C:\\tools",
      "\\\\.\\pipe\\x",
      "\\tools\\git",
      "C:tools",
      "tools\\git",
      "",
    ]) expect(isLocalWindowsPath(bad)).toBe(false);
  });
});
