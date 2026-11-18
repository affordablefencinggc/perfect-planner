import { describe, expect, it } from "vitest";
import { fetchCheckRuns, githubStatus, readGitHubAuth, readGitHubRemote, type Exec, type ExecResult } from "./status";

// GitHub status is read through three injected boundaries (git/gh through exec, GitHub through
// fetch), so these tests never start a process or touch the network. The rules under test are the
// ones a person relies on: no remote or no sign-in is "not-configured", green needs every check
// to pass, and a token is never part of any answer.

const SHA = "0123456789abcdef0123456789abcdef01234567";
const TOKEN = "ghs_must_not_leave_this_module_1234567890";
const REPO_URL = "https://github.com/acme/fence.git";

function answer(partial: Partial<ExecResult> = {}): ExecResult {
  return { code: 0, stdout: "", stderr: "", ...partial };
}

type ExecCall = { command: string; args: string[]; cwd?: string };

function fakeExec(answers: Record<string, ExecResult>): Exec & { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec = (async (command: string, args: string[], options?: { cwd?: string }) => {
    calls.push({ command, args, ...(options?.cwd ? { cwd: options.cwd } : {}) });
    const found = answers[[command, ...args].join(" ")];
    // A program that was not scripted is treated like a missing tool, never like a success.
    if (!found) throw new Error(`${command} is not available`);
    return found;
  }) as Exec & { calls: ExecCall[] };
  exec.calls = calls;
  return exec;
}

function gitAnswers(url: string | null): Record<string, ExecResult> {
  return {
    "git remote get-url origin": url ? answer({ stdout: `${url}\n` }) : answer({ code: 2, stderr: "error: No such remote 'origin'\n" }),
    "git rev-parse --abbrev-ref HEAD": answer({ stdout: "main\n" }),
    "git rev-parse HEAD": answer({ stdout: `${SHA}\n` }),
  };
}

function ghAnswers(token = TOKEN): Record<string, ExecResult> {
  return {
    "gh auth status": answer({ stdout: "github.com\n  ✓ Logged in to github.com account octocat\n" }),
    "gh auth token": answer({ stdout: `${token}\n` }),
  };
}

type FetchCall = { url: string; init: { headers?: Record<string, string>; redirect?: string; signal?: AbortSignal } };

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: FetchCall[] = [];
  const impl = (async (url: string, init: FetchCall["init"]) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function check(name: string, status: string, conclusion: string | null, extra: Record<string, unknown> = {}) {
  return { name, status, conclusion, ...extra };
}

describe("readGitHubRemote", () => {
  it("parses HTTPS and SSH GitHub remotes", async () => {
    const https = await readGitHubRemote({
      cwd: "/repo",
      exec: fakeExec({ "git remote get-url origin": answer({ stdout: "https://github.com/acme/fence.git\n" }) }),
    });
    expect(https).toEqual({ remote: REPO_URL, owner: "acme", repo: "fence" });

    const ssh = await readGitHubRemote({
      cwd: "/repo",
      exec: fakeExec({ "git remote get-url origin": answer({ stdout: "git@github.com:acme/fence.git\n" }) }),
    });
    expect(ssh).toEqual({ remote: "git@github.com:acme/fence.git", owner: "acme", repo: "fence" });
  });

  it("accepts the same remotes without .git and with a trailing slash", async () => {
    const https = await readGitHubRemote({
      cwd: "/repo",
      exec: fakeExec({ "git remote get-url origin": answer({ stdout: "https://github.com/acme/fence/\n" }) }),
    });
    expect(https).toMatchObject({ owner: "acme", repo: "fence" });

    const sshUrl = await readGitHubRemote({
      cwd: "/repo",
      exec: fakeExec({ "git remote get-url origin": answer({ stdout: "ssh://git@github.com/acme/fence.git\n" }) }),
    });
    expect(sshUrl).toMatchObject({ owner: "acme", repo: "fence" });
  });

  it("never shows a token that was pasted into the remote URL", async () => {
    const found = await readGitHubRemote({
      cwd: "/repo",
      exec: fakeExec({ "git remote get-url origin": answer({ stdout: "https://x-access-token:ghp_verysecretvalue@github.com/acme/fence.git\n" }) }),
    });
    expect(found).toMatchObject({ owner: "acme", repo: "fence" });
    expect(found.remote).toBe(REPO_URL);
    expect(JSON.stringify(found)).not.toContain("ghp_verysecretvalue");
  });

  it("says plainly when there is no origin remote", async () => {
    const found = await readGitHubRemote({ cwd: "/repo", exec: fakeExec(gitAnswers(null)) });
    expect(found).toMatchObject({ remote: null, owner: null, repo: null, code: "no-remote" });
    expect(found.reason).toMatch(/no origin remote/i);
  });

  it("names a remote that is not GitHub without echoing its path", async () => {
    const found = await readGitHubRemote({
      cwd: "/repo",
      exec: fakeExec({ "git remote get-url origin": answer({ stdout: "https://gitlab.com/acme/fence.git\n" }) }),
    });
    expect(found).toMatchObject({ owner: null, repo: null, code: "not-github" });
    expect(found.reason).toMatch(/gitlab\.com, not github\.com/);
  });
});

describe("readGitHubAuth", () => {
  it("uses the GitHub CLI when gh auth status exits 0", async () => {
    const auth = await readGitHubAuth({ exec: fakeExec(ghAnswers()), env: {} });
    expect(auth).toMatchObject({ authenticated: true, method: "gh" });
  });

  it("falls back to GITHUB_TOKEN or GH_TOKEN without returning the value", async () => {
    const noGh = fakeExec({ "gh auth status": answer({ code: 1, stderr: "You are not logged into any GitHub hosts.\n" }) });
    const githubToken = await readGitHubAuth({ exec: noGh, env: { GITHUB_TOKEN: TOKEN } });
    expect(githubToken).toMatchObject({ authenticated: true, method: "token" });
    expect(JSON.stringify(githubToken)).not.toContain(TOKEN);

    const ghToken = await readGitHubAuth({ exec: noGh, env: { GH_TOKEN: TOKEN } });
    expect(ghToken).toMatchObject({ authenticated: true, method: "token" });
    expect(JSON.stringify(ghToken)).not.toContain(TOKEN);
  });

  it("is not authenticated when gh is missing and no token is set", async () => {
    const auth = await readGitHubAuth({ exec: fakeExec({}), env: {} });
    expect(auth).toMatchObject({ authenticated: false, method: null });
    expect(auth.reason).toMatch(/not installed|could not be run/i);
  });

  it("treats an empty token as no token", async () => {
    const auth = await readGitHubAuth({
      exec: fakeExec({ "gh auth status": answer({ code: 1, stderr: "You are not logged into any GitHub hosts.\n" }) }),
      env: { GITHUB_TOKEN: "   " },
    });
    expect(auth).toMatchObject({ authenticated: false, method: null });
  });
});

describe("fetchCheckRuns", () => {
  const run = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    const fetched = fakeFetch(status, body, headers);
    return { fetched, result: fetchCheckRuns({ owner: "acme", repo: "fence", sha: SHA, token: TOKEN, fetchImpl: fetched.impl }) };
  };

  it("is green only when every check passed", async () => {
    const { fetched, result } = await run(200, {
      total_count: 2,
      check_runs: [check("build", "completed", "success"), check("test", "completed", "success")],
    });
    const view = await result;
    expect(view.state).toBe("green");
    expect(view.checks).toHaveLength(2);
    expect(fetched.calls[0]!.url).toBe(`https://api.github.com/repos/acme/fence/commits/${SHA}/check-runs?filter=latest&per_page=100`);
    expect(fetched.calls[0]!.init.headers).toMatchObject({
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(fetched.calls[0]!.init.redirect).toBe("error");
  });

  it("treats neutral and skipped as non-blocking, never as green on their own", async () => {
    const { result } = await run(200, {
      total_count: 2,
      check_runs: [check("docs", "completed", "neutral"), check("windows", "completed", "skipped")],
    });
    expect((await result).state).toBe("green");
  });

  it("is red when any check failed", async () => {
    const { result } = await run(200, {
      total_count: 3,
      check_runs: [check("build", "completed", "success"), check("test", "completed", "failure"), check("lint", "completed", "success")],
    });
    const view = await result;
    expect(view.state).toBe("red");
    expect(view.reason).toMatch(/1 check failed/);
    expect(view.reason).toMatch(/test/);
  });

  it("is red on cancelled, timed out and action-required checks too", async () => {
    for (const conclusion of ["cancelled", "timed_out", "action_required", "stale", "startup_failure"]) {
      const { result } = await run(200, { total_count: 1, check_runs: [check("build", "completed", conclusion)] });
      expect((await result).state, conclusion).toBe("red");
    }
  });

  it("is pending while a check is in progress or queued", async () => {
    const running = await run(200, {
      total_count: 2,
      check_runs: [check("build", "completed", "success"), check("test", "in_progress", null)],
    });
    expect((await running.result).state).toBe("pending");

    const queued = await run(200, { total_count: 1, check_runs: [check("test", "queued", null)] });
    expect((await queued.result).state).toBe("pending");
  });

  it("is unknown when GitHub reports no checks", async () => {
    const { result } = await run(200, { total_count: 0, check_runs: [] });
    const view = await result;
    expect(view.state).toBe("unknown");
    expect(view.reason).toMatch(/no check runs/i);
  });

  it("is unknown when a check result cannot be read, rather than calling it green", async () => {
    const { result } = await run(200, { total_count: 1, check_runs: [check("build", "completed", null)] });
    const view = await result;
    expect(view.state).toBe("unknown");
    expect(view.reason).toMatch(/does not understand/i);
  });

  it("refuses an incomplete page instead of calling the commit green", async () => {
    const { result } = await run(200, { total_count: 150, check_runs: [check("build", "completed", "success")] });
    const view = await result;
    expect(view.state).toBe("unknown");
    expect(view.reason).toMatch(/incomplete/i);
  });

  it("gives plain reasons for 401, 403, 404 and 429", async () => {
    const unauthorised = await (await run(401, { message: "Bad credentials" })).result;
    expect(unauthorised.state).toBe("unknown");
    expect(unauthorised.httpStatus).toBe(401);
    expect(unauthorised.reason).toMatch(/401/);

    const forbidden = await (await run(403, { message: "Forbidden" }, { "x-ratelimit-remaining": "0" })).result;
    expect(forbidden.state).toBe("unknown");
    expect(forbidden.reason).toMatch(/rate limit/i);

    const missing = await (await run(404, { message: "Not Found" })).result;
    expect(missing.state).toBe("unknown");
    expect(missing.reason).toMatch(/404/);

    const limited = await (await run(429, { message: "Too Many Requests" })).result;
    expect(limited.state).toBe("unknown");
    expect(limited.httpStatus).toBe(429);
    expect(limited.reason).toMatch(/429/);
  });

  it("does not call GitHub for a commit id that is not a full SHA", async () => {
    const fetched = fakeFetch(200, { total_count: 0, check_runs: [] });
    const view = await fetchCheckRuns({ owner: "acme", repo: "fence", sha: "abc123", token: TOKEN, fetchImpl: fetched.impl });
    expect(view.state).toBe("unknown");
    expect(fetched.calls).toHaveLength(0);
  });

  it("never returns the token in its answer", async () => {
    const { result } = await run(200, { total_count: 1, check_runs: [check("build", "completed", "success")] });
    expect(JSON.stringify(await result)).not.toContain(TOKEN);
  });
});

describe("githubStatus", () => {
  const answers = (url: string | null = REPO_URL, token = TOKEN) => ({ ...gitAnswers(url), ...ghAnswers(token) });

  it("is not-configured, with the exact next action, when the repository has no GitHub remote", async () => {
    const exec = fakeExec(gitAnswers(null));
    const fetched = fakeFetch(200, { total_count: 0, check_runs: [] });
    const view = await githubStatus("/repo", { exec, env: {}, fetchImpl: fetched.impl });
    expect(view.state).toBe("not-configured");
    expect(view.remote).toBeNull();
    expect(view.checks).toEqual([]);
    expect(view.nextAction).toMatch(/git remote add origin/);
    // Nothing was asked of GitHub or of the sign-in.
    expect(exec.calls.some((call) => call.command === "gh")).toBe(false);
    expect(fetched.calls).toHaveLength(0);
  });

  it("is not-configured when no GitHub sign-in is available", async () => {
    const exec = fakeExec({
      ...gitAnswers(REPO_URL),
      "gh auth status": answer({ code: 1, stderr: "You are not logged into any GitHub hosts. Run gh auth login to authenticate.\n" }),
    });
    const fetched = fakeFetch(200, { total_count: 0, check_runs: [] });
    const view = await githubStatus("/repo", { exec, env: {}, fetchImpl: fetched.impl });
    expect(view.state).toBe("not-configured");
    expect(view.reason).toMatch(/not signed in/i);
    expect(view.nextAction).toMatch(/gh auth login/);
    expect(fetched.calls).toHaveLength(0);
  });

  it("reports green from the checks on the current commit, and never returns the token", async () => {
    const exec = fakeExec(answers());
    const fetched = fakeFetch(200, {
      total_count: 1,
      check_runs: [check("build", "completed", "success", { html_url: "https://github.com/acme/fence/runs/1" })],
    });
    const view = await githubStatus("/repo", { exec, env: {}, fetchImpl: fetched.impl });
    expect(view).toMatchObject({ state: "green", remote: REPO_URL, branch: "main", sha: SHA });
    expect(view.checks[0]).toMatchObject({ name: "build", status: "completed", conclusion: "success", url: "https://github.com/acme/fence/runs/1" });
    expect(view.nextAction).toMatch(/every check on this commit passed/i);
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    // The git reads were asked of the same folder, and the token came from gh, not from the answer.
    expect(exec.calls.filter((call) => call.command === "git").every((call) => call.cwd === "/repo")).toBe(true);
  });

  it("uses GITHUB_TOKEN when the CLI is not signed in", async () => {
    const exec = fakeExec({
      ...gitAnswers(REPO_URL),
      "gh auth status": answer({ code: 1, stderr: "You are not logged into any GitHub hosts.\n" }),
    });
    const fetched = fakeFetch(200, { total_count: 1, check_runs: [check("build", "completed", "success")] });
    const view = await githubStatus("/repo", { exec, env: { GITHUB_TOKEN: TOKEN }, fetchImpl: fetched.impl });
    expect(view.state).toBe("green");
    expect(fetched.calls[0]!.init.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(view)).not.toContain(TOKEN);
  });

  it("turns a rejected sign-in into unknown with a sign-in action, never red or green", async () => {
    const exec = fakeExec(answers());
    const fetched = fakeFetch(401, { message: "Bad credentials" });
    const view = await githubStatus("/repo", { exec, env: {}, fetchImpl: fetched.impl });
    expect(view.state).toBe("unknown");
    expect(view.reason).toMatch(/401/);
    expect(view.nextAction).toMatch(/gh auth login/);
  });

  it("turns rate limiting into unknown with a wait action", async () => {
    const exec = fakeExec(answers());
    const fetched = fakeFetch(429, { message: "Too Many Requests" });
    const view = await githubStatus("/repo", { exec, env: {}, fetchImpl: fetched.impl });
    expect(view.state).toBe("unknown");
    expect(view.reason).toMatch(/429/);
    expect(view.nextAction).toMatch(/wait a minute/i);
  });

  it("stops waiting when GitHub does not answer", async () => {
    const exec = fakeExec(answers());
    const impl = ((_url: string, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const view = await githubStatus("/repo", { exec, env: {}, fetchImpl: impl, timeoutMs: 20 });
    expect(view.state).toBe("unknown");
    expect(view.reason).toMatch(/did not answer/i);
  });

  it("says a repository has no commit to check yet", async () => {
    const exec = fakeExec({
      ...answers(),
      "git rev-parse HEAD": answer({ code: 128, stderr: "fatal: ambiguous argument 'HEAD'\n" }),
    });
    const fetched = fakeFetch(200, { total_count: 0, check_runs: [] });
    const view = await githubStatus("/repo", { exec, env: {}, fetchImpl: fetched.impl });
    expect(view.state).toBe("unknown");
    expect(view.reason).toMatch(/no commit/i);
    expect(fetched.calls).toHaveLength(0);
  });

  it("says git could not be read rather than claiming there is no commit", async () => {
    const exec = fakeExec({
      "git remote get-url origin": answer({ stdout: `${REPO_URL}\n` }),
      ...ghAnswers(),
    });
    const fetched = fakeFetch(200, { total_count: 0, check_runs: [] });
    const view = await githubStatus("/repo", { exec, env: {}, fetchImpl: fetched.impl });
    expect(view.state).toBe("unknown");
    expect(view.reason).toMatch(/git could not be read/i);
    expect(view.nextAction).toMatch(/check that git opens/i);
    expect(fetched.calls).toHaveLength(0);
  });

  it("refuses a network share before running git there", async () => {
    const exec = fakeExec({});
    const view = await githubStatus("\\\\server\\share\\repo", { exec, env: {} });
    expect(view.state).toBe("not-configured");
    expect(view.reason).toMatch(/network share/i);
    expect(exec.calls).toHaveLength(0);
  });
});
