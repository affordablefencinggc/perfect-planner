// The host never runs a git found in the user's repo: project open, worktree launch and merge all start
// git by absolute path with the current folder left out of the program search (core/exec).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendNumbered } from "../numbering/index";
import { asPersonRequest } from "./keys";
import { runCommand } from "./project";
import { hostCall, startTestHost } from "./testing";

const isWindows = process.platform === "win32";
const originalPath = process.env.PATH;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  process.env.PATH = originalPath;
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A program called git in the repo that leaves a marker if it ever runs. */
function plantGit(dir: string): string {
  const marker = path.join(dir, "..", `${path.basename(dir)}-planted-ran`);
  if (isWindows) {
    fs.writeFileSync(path.join(dir, "git.cmd"), `@echo off\r\necho planted> "${marker}"\r\n`);
    fs.copyFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "hostname.exe"), path.join(dir, "git.exe"));
  } else {
    fs.writeFileSync(path.join(dir, "git"), `#!/bin/sh\necho planted > "${marker}"\necho planted\n`);
    fs.chmodSync(path.join(dir, "git"), 0o755);
  }
  return marker;
}

describe("git the host starts", () => {
  it("is never a git planted in the user's repo, whatever PATH says", async () => {
    const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pp-git-path-")));
    cleanups.push(() => {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(`${repo}-planted-ran`, { force: true });
    });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "Owner");
    git(repo, "config", "user.email", "owner@example.invalid");
    git(repo, "config", "commit.gpgsign", "false");
    fs.writeFileSync(path.join(repo, "README.md"), "# App\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "Initial");
    const marker = plantGit(repo);
    process.env.PATH = [".", "", repo, originalPath].join(path.delimiter);

    expect((await runCommand("git", ["--version"], { cwd: repo })).stdout).toMatch(/^git version \d/);
    const ctx = await startTestHost({ projectRootOverride: repo });
    cleanups.push(() => ctx.stop());
    expect((await hostCall(ctx.base, "GET", "/status?project=app")).status).toBe(200);
    expect((await ctx.host.project("app").protection).prePush.state).toBe("installed");
    asPersonRequest(() => appendNumbered(ctx.host.project("app").ledger, { actor: { kind: "person", id: "owner" }, type: "task.created", summary: "Save notes", data: { title: "Save notes" } }));
    const dispatched = await hostCall(ctx.base, "POST", "/tasks/T-1/dispatch?project=app", {});
    expect(dispatched.status, JSON.stringify(dispatched.body)).toBe(200);
    expect(fs.existsSync(dispatched.body.result.worktree)).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  }, 60_000);
});
