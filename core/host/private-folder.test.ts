// The planner-private folder (.perfect-planner/: ledger, worker tokens, briefs, worktrees) must never be
// stageable in the user's repo, even before the gate runs: the host excludes it before the ledger opens.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendNumbered } from "../numbering/index";
import { asPersonRequest } from "./keys";
import { hostCall, startTestHost } from "./testing";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

function newRepo(): string {
  // No .gitignore: nothing but Perfect Planner keeps its folder out of commits.
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pp-private-")));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Owner");
  git(repo, "config", "user.email", "owner@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "README.md"), "# App\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "Initial");
  cleanups.push(() => fs.rmSync(repo, { recursive: true, force: true }));
  return repo;
}

const exclude = (repo: string) => fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8").split(/\r?\n/);
const stageable = (repo: string) => {
  git(repo, "add", "-A");
  return git(repo, "diff", "--cached", "--name-only").split("\n").filter(Boolean);
};

describe("the planner-private folder in the user's repo", () => {
  it("is excluded when the project opens, before the ledger or a token file exists", async () => {
    const repo = newRepo();
    const ctx = await startTestHost({ projectRootOverride: repo });
    cleanups.push(() => ctx.stop());
    expect(fs.existsSync(path.join(repo, ".perfect-planner"))).toBe(false);
    expect((await hostCall(ctx.base, "GET", "/status?project=app")).status).toBe(200);
    expect(exclude(repo)).toContain("/.perfect-planner/");
    expect(fs.existsSync(path.join(repo, ".perfect-planner", "ledger"))).toBe(true);

    // A dispatched worker's token file and brief sit in the folder; `git add -A` still stages nothing of it.
    asPersonRequest(() => appendNumbered(ctx.host.project("app").ledger, { actor: { kind: "person", id: "owner" }, type: "task.created", summary: "Save notes", data: { title: "Save notes" } }));
    const dispatched = await hostCall(ctx.base, "POST", "/tasks/T-1/dispatch?project=app", {});
    expect(dispatched.status, JSON.stringify(dispatched.body)).toBe(200);
    expect(fs.existsSync(dispatched.body.result.tokenFile)).toBe(true);
    expect(git(repo, "status", "--porcelain", "--untracked-files=all")).not.toMatch(/\.perfect-planner/);
    expect(stageable(repo)).toEqual([]);
  }, 60_000);

  it("is excluded in a repo the person points the project at", async () => {
    const home = newRepo();
    const other = newRepo();
    const ctx = await startTestHost({ projectRootOverride: home });
    cleanups.push(() => ctx.stop());
    const picked = await hostCall(ctx.base, "POST", "/tasks/repo?project=app", { root: other });
    expect(picked.status, JSON.stringify(picked.body)).toBe(200);
    expect(exclude(other)).toContain("/.perfect-planner/");
    fs.mkdirSync(path.join(other, ".perfect-planner", "tokens"), { recursive: true });
    fs.writeFileSync(path.join(other, ".perfect-planner", "tokens", "T-1.token"), "secret");
    expect(stageable(other)).toEqual([]);
  });

  it("excludes a ledger folder that sits below the top of a repo by its own path", async () => {
    const repo = newRepo();
    const sub = path.join(repo, "apps", "web");
    fs.mkdirSync(sub, { recursive: true });
    const ctx = await startTestHost({ projectRootOverride: sub });
    cleanups.push(() => ctx.stop());
    expect((await hostCall(ctx.base, "GET", "/status?project=app")).status).toBe(200);
    expect(exclude(repo)).toContain("/apps/web/.perfect-planner/");
    expect(stageable(repo)).toEqual([]);
  });
});
