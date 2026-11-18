import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Exec, ExecResult, GitHubStatusView } from "../../github/status";
import type { CoreProject } from "../project";
import { Router, type Handler } from "../router";
import { startTestHost } from "../testing";
import { githubStatusView, registerGitHubRoutes } from "./github";

// The route is read-only: it resolves the git folder the project chose, then asks core/github.
// These tests drive the real router and a real temporary git repository, and inject git/gh/fetch
// only where the answer would otherwise come from this computer or from GitHub itself.

const SHA = "0123456789abcdef0123456789abcdef01234567";
const TOKEN = "fake-route-token";
const REPO_URL = "https://github.com/acme/fence.git";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" },
  }).trim();

function answer(partial: Partial<ExecResult> = {}): ExecResult {
  return { code: 0, stdout: "", stderr: "", ...partial };
}

function fakeExec(answers: Record<string, ExecResult>): Exec & { calls: Array<{ command: string; args: string[]; cwd?: string }> } {
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const exec = (async (command: string, args: string[], options?: { cwd?: string }) => {
    calls.push({ command, args, ...(options?.cwd ? { cwd: options.cwd } : {}) });
    const found = answers[[command, ...args].join(" ")];
    if (!found) throw new Error(`${command} is not available`);
    return found;
  }) as Exec & { calls: typeof calls };
  exec.calls = calls;
  return exec;
}

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: { headers?: Record<string, string> } }> = [];
  const impl = (async (url: string, init: { headers?: Record<string, string> }) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function selectRepo(project: CoreProject, root: string): void {
  fs.mkdirSync(path.join(project.root, ".perfect-planner"), { recursive: true });
  fs.writeFileSync(path.join(project.root, ".perfect-planner", "repo.json"), JSON.stringify({ root }));
}

async function handlerFor(router: Router): Promise<Handler> {
  const matched = router.match("GET", "/github/status");
  if (!matched || matched === "method") throw new Error("GET /github/status is not registered");
  return matched.handler;
}

describe("GET /github/status", () => {
  let ctx: Awaited<ReturnType<typeof startTestHost>>;
  let repo: string;
  const made: string[] = [];

  beforeEach(async () => {
    ctx = await startTestHost({ watch: false });
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "pp-github-repo-"));
    made.push(repo);
    git(repo, "init", "-q");
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-q", "-m", "first");
  });

  afterEach(async () => {
    await ctx.stop();
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("registers one GET route", () => {
    const router = new Router();
    registerGitHubRoutes(router);
    expect(router.match("GET", "/github/status")).not.toBeNull();
    expect(router.match("GET", "/github/status/")).not.toBeNull();
    expect(router.match("POST", "/github/status")).toBe("method");
    expect(router.match("GET", "/github/elsewhere")).toBeNull();
  });

  it("answers the registered route with not-configured when the project has no git folder", async () => {
    const project = await ctx.host.openProject("gh-empty");
    const router = new Router();
    registerGitHubRoutes(router);
    const handler = await handlerFor(router);
    const view = (await handler({ path: "/github/status", params: {}, query: new URLSearchParams(), body: undefined, project, host: ctx.host })) as GitHubStatusView;
    expect(view).toMatchObject({ state: "not-configured", remote: null, branch: null, sha: null, checks: [] });
    expect(view.reason).toMatch(/git folder/i);
    expect(view.nextAction).toMatch(/Tasks/);
  });

  it("says not-configured when the chosen repository has no origin remote", async () => {
    const project = await ctx.host.openProject("gh-no-remote");
    selectRepo(project, repo);
    const view = await githubStatusView(project);
    expect(view.state).toBe("not-configured");
    expect(view.remote).toBeNull();
    expect(view.reason).toMatch(/no origin remote/i);
    expect(view.nextAction).toMatch(/git remote add origin/);
    expect(view.checks).toEqual([]);
  });

  it("reads the repository the project chose, not the ledger folder", async () => {
    const project = await ctx.host.openProject("gh-chosen");
    selectRepo(project, repo);
    const exec = fakeExec({
      "git remote get-url origin": answer({ stdout: `${REPO_URL}\n` }),
      "git rev-parse --abbrev-ref HEAD": answer({ stdout: "main\n" }),
      "git rev-parse HEAD": answer({ stdout: `${SHA}\n` }),
      "gh auth status": answer({ stdout: "github.com\n  ✓ Logged in to github.com account octocat\n" }),
      "gh auth token": answer({ stdout: `${TOKEN}\n` }),
    });
    const fetched = fakeFetch(200, { total_count: 1, check_runs: [{ name: "build", status: "completed", conclusion: "success" }] });
    const view = await githubStatusView(project, { exec, env: {}, fetchImpl: fetched.impl });
    expect(view).toMatchObject({ state: "green", remote: REPO_URL, branch: "main", sha: SHA });
    expect(view.checks).toEqual([{ name: "build", status: "completed", conclusion: "success" }]);
    // Every git question was asked of the chosen repository (the real path git reports), not of the ledger folder.
    const chosen = fs.realpathSync(repo);
    const gitCalls = exec.calls.filter((call) => call.command === "git");
    expect(gitCalls).toHaveLength(3);
    expect(gitCalls.every((call) => call.cwd === chosen)).toBe(true);
    expect(JSON.stringify(view)).not.toContain(TOKEN);
  });

  it("never reports green from a configured remote alone", async () => {
    const project = await ctx.host.openProject("gh-no-auth");
    selectRepo(project, repo);
    const exec = fakeExec({
      "git remote get-url origin": answer({ stdout: `${REPO_URL}\n` }),
      "gh auth status": answer({ code: 1, stderr: "You are not logged into any GitHub hosts. Run gh auth login to authenticate.\n" }),
    });
    const fetched = fakeFetch(200, { total_count: 0, check_runs: [] });
    const view = await githubStatusView(project, { exec, env: {}, fetchImpl: fetched.impl });
    expect(view.state).toBe("not-configured");
    expect(view.nextAction).toMatch(/gh auth login/);
    expect(fetched.calls).toHaveLength(0);
  });
});
