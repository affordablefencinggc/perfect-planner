// Attack 8, second part: repo shapes oddrepos.test.ts does not reach. Each case is refused in plain words or goes all the
// way through, with nothing run that the repo names (marker files that must never appear).
//
//   - an LFS pointer file with no git-lfs on the machine, and an LFS filter set in the repo's config (works without
//     git-lfs installed, unlike the real-LFS case in oddrepos.test.ts)
//   - a submodule that was never initialised (a plain clone)
//   - 100,000 files, made in one go with `git fast-import` (10,000 on Windows, where writing the working copy is the slow part)
//   - a full disk when the merge starts (needs permission to mount a small RAM disk; Linux only)
//   - a protected main on GitHub: the app only merges on this computer and never pushes, so a remote that refuses every
//     push is never asked and never changes
//
// Symlink loops (inside the repo, in the worker's worktree and outward) are already attacked in oddrepos.test.ts.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addTask, buildCheckApprove, cleanTemp, dispatchAndApproveTest, git, makeRepo, startWindow, tempDir, type Window } from "./helpers";

afterAll(cleanTemp, 300_000);
const q = "?project=p";
const FEATURE = "export const notes = () => [];\n";
const POINTER = "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 8192\n";

async function open(repo: string): Promise<Window> {
  const data = tempDir();
  return startWindow({ data, project: repo, secrets: path.join(data, "secrets.json") });
}

async function wholeFlow(win: Window, repo: string, title = "Save notes"): Promise<{ merged: string; seconds: number }> {
  const task = await addTask(win, q, title);
  const w = await dispatchAndApproveTest(win, q, task);
  const started = Date.now();
  const head = await buildCheckApprove(win, q, w);
  const merged = await win.call("POST", `/tasks/${task}/merge${q}`, { commit: head });
  expect(merged.status, JSON.stringify(merged.body)).toBe(200);
  expect(git(repo, "show", "main:src/save.js")).toContain("save");
  expect(win.host.project("p").ledger.status.ok).toBe(true);
  return { merged: git(repo, "rev-parse", "main"), seconds: (Date.now() - started) / 1000 };
}

/** Files git tracks, counted without holding the whole list in one string (100,000 names overflow the helper's buffer). */
function trackedFiles(repo: string): number {
  return execFileSync("git", ["ls-files", "-z"], { cwd: repo, maxBuffer: 1 << 28 }).toString().split("\0").filter(Boolean).length;
}

function expectNothingLeftBehind(repo: string, win: Window) {
  const trees = path.join(repo, ".perfect-planner", "worktrees");
  expect(fs.existsSync(trees) ? fs.readdirSync(trees) : []).toEqual([]);
  expect(git(repo, "branch", "--list").split("\n").map((b) => b.trim().replace("* ", "")).filter((b) => b && b !== "main")).toEqual([]);
  expect(win.host.project("p").ledger.status.ok).toBe(true);
}

describe("attack 8b: LFS pointer files without git-lfs on the machine", () => {
  it("a committed pointer file with a .gitattributes line but no filter settings: the whole flow goes through and the pointer is carried as it is", async () => {
    const repo = makeRepo({ ".gitignore": ".perfect-planner/\n", ".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n", "logo.bin": POINTER, "src/features/notes/index.js": FEATURE });
    const win = await open(repo);
    try {
      const { merged } = await wholeFlow(win, repo);
      expect(git(repo, "show", `${merged}:logo.bin`)).toBe(POINTER.trimEnd());
    } finally {
      await win.stop();
    }
  }, 60_000);

  it("the same repo with the LFS filter set in its config is refused in plain words, the filter never runs, nothing is left behind", async () => {
    const marker = path.join(tempDir("pp-attack-marker-"), "lfs-filter-ran");
    const repo = makeRepo({ ".gitignore": ".perfect-planner/\n", ".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n", "logo.bin": POINTER, "src/features/notes/index.js": FEATURE });
    for (const kind of ["smudge", "clean", "process"]) git(repo, "config", `filter.lfs.${kind}`, `sh -c 'touch ${marker}; cat'`);
    git(repo, "config", "filter.lfs.required", "true");
    const win = await open(repo);
    try {
      const task = await addTask(win, q);
      const refused = await win.call("POST", `/tasks/${task}/dispatch${q}`, { model: "builder-model" });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("GIT_PROGRAM_REFUSED");
      expect(refused.body.message).toMatch(/filter\.lfs/);
      expect(fs.existsSync(marker), "the LFS filter ran").toBe(false);
      expectNothingLeftBehind(repo, win);
    } finally {
      await win.stop();
    }
  }, 60_000);
});

describe("attack 8b: a submodule that was never initialised (a plain clone)", () => {
  it("the folder is an empty directory in the worktree, the whole flow goes through and the submodule entry is kept", async () => {
    const lib = makeRepo({ "lib.js": "export const x = 1;\n" });
    const source = makeRepo({ ".gitignore": ".perfect-planner/\n", "src/features/notes/index.js": FEATURE });
    git(source, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "vendor/lib");
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "Vendor a library");
    const repo = path.join(tempDir("pp-attack-clone-"), "clone");
    git(source, "clone", "-q", source, repo);
    git(repo, "config", "user.name", "Owner");
    git(repo, "config", "user.email", "owner@example.invalid");
    git(repo, "config", "commit.gpgsign", "false");
    git(repo, "config", "core.autocrlf", "false");
    expect(fs.readdirSync(path.join(repo, "vendor", "lib"))).toEqual([]);
    const before = git(repo, "ls-tree", "main", "vendor/lib");
    const win = await open(repo);
    try {
      await wholeFlow(win, repo);
      expect(git(repo, "ls-tree", "main", "vendor/lib")).toBe(before);
    } finally {
      await win.stop();
    }
  }, 90_000);
});

describe("attack 8b: 100,000 files", () => {
  const WINDOWS = process.platform === "win32";
  const FOLDERS = WINDOWS ? 100 : 1000;
  const PER_FOLDER = 100;
  // Generous on purpose: slow runners must not flake. These limits only catch a hang or a quadratic walk.
  const LIMIT_MS = 240_000;
  let repo: string;
  let win: Window;
  beforeAll(async () => {
    repo = makeRepo({ ".gitignore": ".perfect-planner/\n", "README.md": "# Huge\n" });
    // One commit built by git fast-import: no per-file process, no per-file write until the final checkout.
    const parts: string[] = ["commit refs/heads/main\ncommitter Owner <owner@example.invalid> 1700000000 +0000\ndata 5\nHuge\nfrom refs/heads/main^0\n"];
    for (let d = 0; d < FOLDERS; d += 1) {
      for (let f = 0; f < PER_FOLDER; f += 1) {
        const body = `export const v${f} = ${d};\n`;
        parts.push(`M 100644 inline src/features/f${String(d).padStart(4, "0")}/c${f}.js\ndata ${Buffer.byteLength(body)}\n${body}\n`);
      }
    }
    execFileSync("git", ["fast-import", "--quiet"], { cwd: repo, input: parts.join(""), maxBuffer: 1 << 28, stdio: ["pipe", "pipe", "pipe"] });
    git(repo, "reset", "-q", "--hard", "main");
    expect(trackedFiles(repo)).toBe(FOLDERS * PER_FOLDER + 2);
    win = await open(repo);
  }, 300_000);
  afterAll(async () => win?.stop(), 300_000);

  it("every screen answers and the code scan finishes within the limit", async () => {
    for (const screen of ["/status", "/tasks", "/planning", "/mvp", "/summary", "/plan"]) {
      const started = Date.now();
      const res = await win.call("GET", `${screen}${q}`);
      expect(res.status, screen).toBe(200);
      expect(Date.now() - started, `${screen} took too long`).toBeLessThan(LIMIT_MS);
    }
    const started = Date.now();
    const staged = await win.call("POST", `/mvp/stage${q}`, { mode: "existing", goal: "Ship the notes app" });
    expect(staged.status, JSON.stringify(staged.body).slice(0, 300)).toBe(200);
    expect(Date.now() - started).toBeLessThan(LIMIT_MS);
  }, 300_000);

  it("the whole flow goes through, main is clean and the repository is sound", async () => {
    const { seconds } = await wholeFlow(win, repo);
    expect(seconds).toBeLessThan(LIMIT_MS / 1000);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(trackedFiles(repo)).toBe(FOLDERS * PER_FOLDER + 4);
  }, 480_000);
});

/** A small RAM disk, or null where this computer will not let the test mount one. */
function mountSmallDisk(): { dir: string; unmount: () => void } | null {
  if (process.platform !== "linux") return null;
  const dir = tempDir("pp-attack-ramdisk-");
  const run = (args: string[]) => {
    try {
      execFileSync(process.getuid?.() === 0 ? args[0]! : "sudo", process.getuid?.() === 0 ? args.slice(1) : ["-n", ...args], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  if (!run(["mount", "-t", "tmpfs", "-o", "size=1m", "tmpfs", dir])) return null;
  return { dir, unmount: () => void run(["umount", dir]) };
}

describe("attack 8b: the disk is full when the merge starts", () => {
  const disk = mountSmallDisk();
  // Without the right to mount a RAM disk (a normal CI runner without sudo) the case cannot be simulated cheaply, so it says so by name.
  it.skipIf(!disk)("the merge is refused or fails in plain words, main is untouched, nothing is half-made, and the same merge goes through once space is back", async () => {
    const repo = makeRepo({ ".gitignore": ".perfect-planner/\n", "README.md": "# Full\n", "src/features/notes/index.js": FEATURE });
    const win = await open(repo);
    const oldTmp = process.env.TMPDIR;
    try {
      const task = await addTask(win, q);
      const w = await dispatchAndApproveTest(win, q, task);
      const head = await buildCheckApprove(win, q, w);
      const mainBefore = git(repo, "rev-parse", "main");
      // The merge candidate is made in the temp folder; the RAM disk is that folder and it has no room left.
      process.env.TMPDIR = disk!.dir;
      const filler = path.join(disk!.dir, "filler");
      const fd = fs.openSync(filler, "w");
      try {
        const chunk = Buffer.alloc(64 * 1024, 1);
        for (;;) fs.writeSync(fd, chunk);
      } catch {
        // ENOSPC: the disk is now full.
      } finally {
        fs.closeSync(fd);
      }
      const merged = await win.call("POST", `/tasks/${task}/merge${q}`, { commit: head });
      expect(merged.status, JSON.stringify(merged.body)).toBeGreaterThanOrEqual(400);
      expect(merged.status, "the host crashed instead of answering").toBeLessThan(600);
      expect(typeof merged.body.message === "string" && merged.body.message.length > 0, "no plain reason").toBe(true);
      expect(git(repo, "rev-parse", "main")).toBe(mainBefore);
      expect(git(repo, "status", "--porcelain")).toBe("");
      expect(win.host.project("p").ledger.status.ok).toBe(true);
      // Space comes back; nothing needs repairing by hand.
      fs.rmSync(filler);
      const again = await win.call("POST", `/tasks/${task}/merge${q}`, { commit: head });
      expect(again.status, JSON.stringify(again.body)).toBe(200);
    } finally {
      if (oldTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = oldTmp;
      await win.stop();
      disk!.unmount();
    }
  }, 90_000);
  if (!disk) it("(not run here) needs permission to mount a RAM disk: Linux as root or with sudo", () => {
    expect(os.platform()).toBeDefined();
  });
});

describe("attack 8b: protected main on GitHub", () => {
  it("the merge happens on this computer only: a remote that refuses every push is never pushed to and does not change", async () => {
    const marker = path.join(tempDir("pp-attack-marker-"), "remote-hook-ran");
    const remote = tempDir("pp-attack-remote-");
    git(remote, "init", "-q", "--bare", "-b", "main");
    const hook = path.join(remote, "hooks", "pre-receive");
    fs.writeFileSync(hook, `#!/bin/sh\ntouch "${marker.replace(/\\/g, "/")}"\necho "GH006: Protected branch update failed for refs/heads/main." >&2\nexit 1\n`, { mode: 0o755 });
    const repo = makeRepo({ ".gitignore": ".perfect-planner/\n", "src/features/notes/index.js": FEATURE });
    git(repo, "remote", "add", "origin", remote);
    const win = await open(repo);
    try {
      const { merged } = await wholeFlow(win, repo);
      expect(merged).toBe(git(repo, "rev-parse", "main"));
      expect(fs.existsSync(marker), "something pushed to the protected remote").toBe(false);
      expect(execFileSync("git", ["for-each-ref"], { cwd: remote }).toString().trim(), "the remote changed").toBe("");
    } finally {
      await win.stop();
    }
  }, 60_000);
});
