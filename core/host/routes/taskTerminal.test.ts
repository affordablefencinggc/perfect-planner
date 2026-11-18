// POST /tasks/:id/terminal against the real host: the task's own worktree, the board's own paths,
// the runner's allowlist, and no ledger write. The route is registered here directly because this
// module owns its route file; registerRoutes in routes/index.ts is owned elsewhere.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendNumbered } from "../../numbering/index";
import { asPersonRequest } from "../keys";
import { hostCall, startTestHost } from "../testing";
import { confineWorktree, registerTaskTerminalRoutes } from "./taskTerminal";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" },
  }).trim();
const write = (dir: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};

let repo: string;
let ctx: Awaited<ReturnType<typeof startTestHost>>;
const q = "?project=terminal";
const post = (route: string, body: unknown = {}) => hostCall(ctx.base, "POST", route + q, body);
const project = () => ctx.host.project("terminal");

async function view(): Promise<{ repos: Array<{ name: string; ok: boolean; worktreeInspection?: string }>; tasks: Array<{ id: string; label: string; worktree?: { path: string } | null }> }> {
  const result = await hostCall(ctx.base, "GET", `/tasks${q}`);
  expect(result.status).toBe(200);
  return result.body.result;
}

/** The board reads Git folders without blocking the first answer; wait for its first real inspection. */
async function waitForInspection(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await view()).repos[0]?.worktreeInspection === "ready") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the board never finished inspecting the repository");
}

beforeEach(async () => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pp-task-terminal-")));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "user.name", "Owner");
  git(repo, "config", "user.email", "owner@example.invalid");
  write(repo, "README.md", "# Notes app\n");
  write(repo, ".gitignore", ".perfect-planner/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "Initial");
  ctx = await startTestHost({ projectRootOverride: repo, watch: false });
  registerTaskTerminalRoutes(ctx.host.router);
  asPersonRequest(() => appendNumbered(project().ledger, {
    actor: { kind: "person", id: "owner" },
    type: "task.created",
    summary: "Save notes",
    data: { title: "Save notes" },
  }));
});

afterEach(async () => {
  await ctx.stop();
  fs.rmSync(repo, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
});

describe("task terminal route", () => {
  it("refuses a task with no worktree, in plain words, without running anything", async () => {
    await waitForInspection();
    const result = await post("/tasks/T-1/terminal", { command: "git status" });
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("NO_WORKTREE");
    expect(result.body.message).toMatch(/no worktree/i);
    expect(result.body.message).toMatch(/start a worker/i);
  });

  it("runs git status in the task's own worktree and writes no ledger entry", async () => {
    const dispatched = await post("/tasks/T-1/dispatch", {});
    expect(dispatched.status).toBe(200);
    const worktree = dispatched.body.result.worktree as string;
    expect(fs.existsSync(worktree)).toBe(true);
    const before = project().entries().length;

    const result = await post("/tasks/T-1/terminal", { command: "git status" });
    expect(result.status).toBe(200);
    expect(result.body.result.task).toBe("T-1");
    expect(result.body.result.exitCode).toBe(0);
    expect(result.body.result.cwd).toBe(fs.realpathSync.native(worktree));
    expect(result.body.result.stdout).toMatch(/On branch pp\//);
    expect(result.body.result.transcriptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.body.result.truncated).toBe(false);
    expect(result.body.result.timedOut).toBe(false);
    // The transcript hash is the audit handle; the signed ledger is untouched.
    expect(project().entries().length).toBe(before);
  });

  it("refuses deleting, pushing, resetting and shell syntax before anything starts", async () => {
    const dispatched = await post("/tasks/T-1/dispatch", {});
    expect(dispatched.status).toBe(200);
    const worktree = dispatched.body.result.worktree as string;

    const push = await post("/tasks/T-1/terminal", { command: "git push" });
    expect(push.status).toBe(400);
    expect(push.body.code).toBe("NOT_ALLOWED");
    expect(push.body.message).toMatch(/changes the repository/);

    const reset = await post("/tasks/T-1/terminal", { command: "git reset --hard" });
    expect(reset.status).toBe(400);
    expect(reset.body.code).toBe("NOT_ALLOWED");

    const remove = await post("/tasks/T-1/terminal", { command: "rm -rf ." });
    expect(remove.status).toBe(400);
    expect(remove.body.code).toBe("NOT_ALLOWED");
    expect(remove.body.message).toMatch(/deletes files/);

    const shell = await post("/tasks/T-1/terminal", { command: "git status; rm -rf ." });
    expect(shell.status).toBe(400);
    expect(shell.body.code).toBe("SHELL_METACHARACTER");

    expect(fs.existsSync(path.join(worktree, "README.md"))).toBe(true);
  });

  it("refuses an empty command and a command that is not text", async () => {
    const empty = await post("/tasks/T-1/terminal", { command: "   " });
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe("INVALID");
    const missing = await post("/tasks/T-1/terminal", {});
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("INVALID");
  });
});

describe("worktree confinement", () => {
  it("accepts a folder inside the repository and refuses a sibling, a missing folder or a link out", () => {
    const inside = path.join(repo, ".perfect-planner", "worktrees", "T-1");
    expect(confineWorktree(repo, inside)).toMatchObject({ ok: false });
    fs.mkdirSync(inside, { recursive: true });
    expect(confineWorktree(repo, inside)).toMatchObject({ ok: true, path: fs.realpathSync.native(inside) });
    expect(confineWorktree(repo, path.join(repo, "..", "sibling"))).toMatchObject({ ok: false });

    const outside = fs.mkdtempSync(path.join(repo, "..", "pp-terminal-outside-"));
    try {
      expect(confineWorktree(repo, outside)).toMatchObject({ ok: false });
      const link = path.join(repo, "link-out");
      fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
      expect(confineWorktree(repo, link)).toMatchObject({ ok: false });
      fs.rmSync(link, { force: true });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});
