import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  // Found by the #13 thread on macOS: a PATH folder that reaches the repo through a link (there,
  // every temp folder, since /var is /private/var) was not recognised as inside the repo.
  it("skips a PATH folder that reaches the repo through a symlink or junction", () => {
    const base = tempDir("pp-exe-link-");
    const repo = path.join(base, "repo");
    const tools = path.join(base, "tools");
    mkdirSync(path.join(repo, "bin"), { recursive: true });
    mkdirSync(tools);
    plantGit(path.join(repo, "bin"));
    const real = plantGit(tools);
    const viaLink = path.join(base, "looks-outside");
    symlinkSync(path.join(repo, "bin"), viaLink, isWindows ? "junction" : "dir");
    expect(findExecutable("git", { PATH: [viaLink, tools].join(path.delimiter) }, repo)).toBe(real);
    // The repo itself reached through a link, as cwd, is recognised too.
    const repoLink = path.join(base, "repo-link");
    symlinkSync(repo, repoLink, isWindows ? "junction" : "dir");
    expect(findExecutable("git", { PATH: [path.join(repo, "bin"), tools].join(path.delimiter) }, repoLink)).toBe(real);
  });

  it("skips a program on PATH that is a link to one inside the repo", (context) => {
    const base = tempDir("pp-exe-filelink-");
    const repo = path.join(base, "repo");
    const tools = path.join(base, "tools");
    const later = path.join(base, "later");
    mkdirSync(repo);
    mkdirSync(tools);
    mkdirSync(later);
    const planted = plantGit(repo);
    const real = plantGit(later);
    try {
      symlinkSync(planted, path.join(tools, path.basename(planted)), "file");
    } catch (error) {
      // File symlinks need Developer Mode or admin rights on Windows.
      if ((error as NodeJS.ErrnoException).code === "EPERM") return context.skip();
      throw error;
    }
    expect(findExecutable("git", { PATH: [tools, later].join(path.delimiter) }, repo)).toBe(real);
  });

  it("treats a PATH folder that does not exist as unusable", () => {
    const base = tempDir("pp-exe-missing-");
    const tools = path.join(base, "tools");
    mkdirSync(tools);
    const real = plantGit(tools);
    expect(findExecutable("git", { PATH: [path.join(base, "gone"), tools].join(path.delimiter) }, tempDir("pp-exe-cwd-"))).toBe(real);
  });

  it("never runs a planted git reached through a linked PATH entry", () => {
    const repo = makeRepo();
    mkdirSync(path.join(repo, "bin"));
    plantGit(path.join(repo, "bin"));
    const outside = tempDir("pp-exe-outside-");
    const viaLink = path.join(outside, "bin-link");
    symlinkSync(path.join(repo, "bin"), viaLink, isWindows ? "junction" : "dir");
    process.env.PATH = `${viaLink}${path.delimiter}${originalPath}`;
    expect(git(repo, ["--version"])).toMatch(/^git version \d/);
    expect(realpathSync.native(gitExecutable(repo)).startsWith(repo)).toBe(false);
    expect(existsSync(path.join(repo, "bin", "planted-ran"))).toBe(false);
  });

  // Review of 4c317f7: the project can be a subfolder of the repo (core/ledger/ignore.ts runs git
  // there), so a PATH entry at the repo root, such as an activated .venv/bin, was still searched.
  it("skips PATH entries inside the roots the host protects, with a subfolder cwd", () => {
    const repo = makeRepo();
    const project = path.join(repo, "apps", "web");
    mkdirSync(project, { recursive: true });
    mkdirSync(path.join(repo, ".venv", "bin"), { recursive: true });
    plantGit(path.join(repo, ".venv", "bin"));
    const tools = tempDir("pp-exe-tools-");
    const real = plantGit(tools);
    const env = { PATH: [path.join(repo, ".venv", "bin"), tools].join(path.delimiter) };
    // cwd alone does not cover the repo root; that is what `protect` is for.
    expect(findExecutable("git", env, project)).not.toBe(real);
    expect(findExecutable("git", env, project, process.platform, [repo])).toBe(real);
  });

  it("gitExecutable looks again when its cached git is inside a protected root", () => {
    const repo = makeRepo();
    const project = path.join(repo, "apps", "web");
    mkdirSync(project, { recursive: true });
    plantGit(repo);
    process.env.PATH = `${repo}${path.delimiter}${originalPath}`;
    // A first call without the root caches the repo's git, which is never run here.
    expect(gitExecutable(project).startsWith(repo)).toBe(true);
    const safe = gitExecutable(project, [repo]);
    expect(realpathSync.native(safe).startsWith(repo)).toBe(false);
    expect(execFileSync(safe, ["--version"], { cwd: project, encoding: "utf8", env: { ...process.env, ...NO_CWD_SEARCH_ENV } })).toMatch(/^git version \d/);
    expect(existsSync(path.join(repo, "planted-ran"))).toBe(false);
  });
});

describe("network shares on Windows (injected real paths)", () => {
  // Windows rules run on every OS here: the real paths below stand in for links (junctions,
  // symlinks, subst drives) whose targets are network shares.
  const links: Record<string, string> = {
    "C:\\tools": "\\\\server\\share\\tools",
    "C:\\dev": "C:\\dev",
    "C:\\dev\\git.exe": "\\??\\UNC\\server\\share\\git.exe",
    "C:\\safe": "C:\\safe",
    "C:\\safe\\git.exe": "C:\\safe\\git.exe",
    "C:\\tools\\git.exe": "\\\\server\\share\\tools\\git.exe",
    "C:\\repo": "C:\\repo",
    // The folder check stands alone: this folder is a share even though its file reads as local.
    "C:\\mix": "\\\\server\\share\\mix",
    "C:\\mix\\git.exe": "C:\\mix\\git.exe",
  };
  const io = {
    realpath: (file: string) => {
      const real = links[file];
      if (real === undefined) throw Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
      return real;
    },
    isProgram: (file: string) => file.toLowerCase().endsWith("git.exe") && file in links,
  };
  const find = (pathValue: string) => findExecutable("git", { Path: pathValue }, "C:\\repo", "win32", [], io);

  it("skips a local PATH folder whose real path is a share", () => {
    expect(find("C:\\tools;C:\\safe")).toBe("C:\\safe\\git.exe");
    expect(find("C:\\mix")).toBeNull();
  });

  it("skips a local git whose real path is a share in the \\??\\UNC spelling", () => {
    expect(find("C:\\dev;C:\\safe")).toBe("C:\\safe\\git.exe");
    expect(find("C:\\dev")).toBeNull();
  });

  it("still finds a local git when nothing points at a share", () => {
    expect(find("C:\\safe")).toBe("C:\\safe\\git.exe");
  });

  it("accepts only drive-letter paths", () => {
    expect(isLocalWindowsPath("C:\\Program Files\\Git\\cmd\\git.exe")).toBe(true);
    expect(isLocalWindowsPath("d:/tools/git.exe")).toBe(true);
    for (const share of ["\\\\server\\share\\git.exe", "//server/share/git.exe", "\\\\?\\UNC\\server\\share\\git.exe", "\\??\\UNC\\server\\share\\git.exe", "\\\\.\\C:\\git.exe", "C:git.exe", "\\git.exe"]) {
      expect(isLocalWindowsPath(share), share).toBe(false);
    }
  });
});
