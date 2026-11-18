// GitHub's answer about one commit, read honestly: the remote this repo pushes to, whether this
// computer has a usable GitHub sign-in, and what GitHub says about that commit's checks.
//
// Nothing here is a receipt. A configured remote is not a pushed commit; a signed-in CLI is not a
// token with access; a check that has not run is not green. GREEN requires GitHub to report at
// least one check, every one of them completed, and every conclusion passing. "neutral" and
// "skipped" are deliberately treated as non-blocking: a check that GitHub says did nothing must
// not block, and must not be counted as a pass of real work either. Anything else is red, pending
// or unknown, with a plain reason and the next action.
//
// A token is used for the request header only. It is never returned, logged, put in a URL or
// copied into a reason, and a token embedded in a remote URL is stripped before that URL is shown.
import { spawn, type ChildProcess } from "node:child_process";

/** How a command finished. A non-zero code is a normal answer, not an exception. */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Runs one program without a shell. Injected in tests so no real git, gh or GitHub is touched.
 * It rejects only when the program could not be started at all (for example, gh is not installed).
 */
export type Exec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

/** A check run, as GitHub names it and as this app reports it. */
export interface GitHubCheck {
  name: string;
  /** GitHub's raw status: queued, in_progress, completed, ... */
  status: string;
  /** GitHub's raw conclusion, or null while the check has not finished. */
  conclusion: string | null;
  url?: string;
}

/** What GitHub says about one commit. "not-configured" is added by githubStatus, never by fetchCheckRuns. */
export type GitHubCheckState = "green" | "red" | "pending" | "unknown";
export type GitHubState = GitHubCheckState | "not-configured";

export interface GitHubRemote {
  /** The origin URL as configured, with any userinfo (and so any embedded token) removed. */
  remote: string | null;
  owner: string | null;
  repo: string | null;
  /** Why no GitHub owner/repo could be read. Absent when they were. */
  reason?: string;
  /** A machine-readable cause for `reason`, so the caller can name the exact next action. */
  code?: "no-remote" | "not-github" | "git-failed";
}

export interface GitHubAuth {
  authenticated: boolean;
  method: "gh" | "token" | null;
  reason: string;
}

export interface CheckRunsResult {
  checks: GitHubCheck[];
  state: GitHubCheckState;
  reason: string;
  /** The HTTP status when GitHub answered with an error, for the next action. Never shown as the reason. */
  httpStatus?: number;
}

export interface GitHubStatusView {
  state: GitHubState;
  reason: string;
  remote: string | null;
  branch: string | null;
  sha: string | null;
  checks: GitHubCheck[];
  nextAction: string;
}

export interface GitHubStatusOptions {
  exec?: Exec;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Bounds the GitHub HTTP request only. */
  timeoutMs?: number;
}

export const DEFAULT_EXEC_TIMEOUT_MS = 10_000;
export const DEFAULT_FETCH_TIMEOUT_MS = 8_000;

// GitHub logins are letters, digits and hyphens; repository names may also hold dots and underscores.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
/** A full object id: GitHub is SHA-1 today, SHA-256 repositories are already possible. */
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const PASSING = new Set(["success", "neutral", "skipped"]);
const FAILING = new Set(["failure", "cancelled", "timed_out", "action_required", "stale", "startup_failure"]);

const defaultExec: Exec = (command, args, options = {}) =>
  new Promise<ExecResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: timedOut ? -1 : code ?? -1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** A folder on a network share is never read: asking git there talks to another machine with this user's credentials. */
function isNetworkPath(dir: string): boolean {
  return /^(?:\\\\|\/\/)/.test(dir);
}

/** The host a remote points at, for a plain reason that does not echo a path or credentials. */
function remoteHost(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const scp = /^(?:[^@/]+@)?([^:/]+):.+$/.exec(text);
  if (scp && !text.includes("://")) return scp[1] ?? null;
  try {
    return new URL(text).hostname || null;
  } catch {
    return null;
  }
}

/** Remove userinfo from a remote URL, so a token that was pasted into it is never shown. */
function sanitizeRemote(raw: string): string {
  return raw.trim().replace(/\/\/[^/@]*@/, "//");
}

/** owner/repo from a GitHub remote, or null for any other host or shape. */
function parseGitHubRemote(raw: string): { owner: string; repo: string } | null {
  const text = raw.trim();
  if (!text) return null;
  // scp-like: git@github.com:owner/repo.git
  const scp = /^(?:[A-Za-z0-9._-]+@)?github\.com:(.+)$/i.exec(text);
  if (scp) return splitRepositoryPath(scp[1] ?? "");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== "github.com") return null;
  if (!["https:", "ssh:", "git:"].includes(url.protocol)) return null;
  return splitRepositoryPath(url.pathname.replace(/^\/+/, ""));
}

function splitRepositoryPath(path: string): { owner: string; repo: string } | null {
  const parts = path.replace(/\/+$/, "").split("/");
  if (parts.length !== 2) return null;
  const owner = parts[0] ?? "";
  const repo = (parts[1] ?? "").replace(/\.git$/i, "");
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === ".." || repo.includes("..")) return null;
  return { owner, repo };
}

/**
 * The GitHub remote of the repository at `cwd`, read from `git remote get-url origin`.
 * Never throws: a missing git, a missing remote and a non-GitHub remote are all plain reasons.
 */
export async function readGitHubRemote({ cwd, exec = defaultExec }: { cwd: string; exec?: Exec }): Promise<GitHubRemote> {
  const none = (reason: string, code: GitHubRemote["code"]): GitHubRemote => ({ remote: null, owner: null, repo: null, reason, code });
  if (isNetworkPath(cwd)) return none("This project's git folder is on a network share, which Perfect Planner does not read.", "git-failed");
  let result: ExecResult;
  try {
    result = await exec("git", ["remote", "get-url", "origin"], { cwd });
  } catch {
    return none("Git could not be run to read this repository's origin remote.", "git-failed");
  }
  if (result.code !== 0) {
    const text = `${result.stderr}${result.stdout}`;
    if (/no such remote/i.test(text)) return none("This repository has no origin remote, so there is no GitHub repository to check.", "no-remote");
    if (/not a git repository/i.test(text)) return none("This folder is not a git repository, so there is no GitHub remote to read.", "git-failed");
    return none("Git could not read this repository's origin remote.", "git-failed");
  }
  const raw = firstLine(result.stdout);
  if (!raw) return none("The origin remote has no address.", "no-remote");
  const parsed = parseGitHubRemote(raw);
  const remote = sanitizeRemote(raw);
  if (!parsed) {
    const host = remoteHost(raw);
    return { remote, owner: null, repo: null, code: "not-github", reason: host ? `The origin remote points to ${host}, not github.com.` : "The origin remote is not a GitHub address." };
  }
  return { remote, owner: parsed.owner, repo: parsed.repo };
}

/** The token this app's environment offers, if any. The value is used, never returned in a reason. */
function envToken(env: NodeJS.ProcessEnv): string | null {
  for (const name of ["GITHUB_TOKEN", "GH_TOKEN"] as const) {
    const value = env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Whether this computer has a GitHub sign-in: `gh auth status` (exit 0) first, then GITHUB_TOKEN or
 * GH_TOKEN in the app's environment. The token is never part of the answer.
 */
export async function readGitHubAuth({ exec = defaultExec, env = process.env }: { exec?: Exec; env?: NodeJS.ProcessEnv } = {}): Promise<GitHubAuth> {
  let gh: ExecResult | null = null;
  try {
    gh = await exec("gh", ["auth", "status"], { env });
  } catch {
    gh = null; // gh is not installed, or could not be started: its message can name a path, so it is not repeated.
  }
  if (gh && gh.code === 0) return { authenticated: true, method: "gh", reason: "The GitHub CLI (gh) is signed in on this computer." };
  if (envToken(env)) return { authenticated: true, method: "token", reason: "A GitHub token is set for this app in its environment (the value is never shown)." };
  if (!gh) return { authenticated: false, method: null, reason: "The GitHub CLI (gh) is not installed or could not be run, and no GitHub token is set." };
  const text = `${gh.stdout}${gh.stderr}`;
  if (/not logged (?:in|into)|no oauth token/i.test(text)) return { authenticated: false, method: null, reason: "The GitHub CLI (gh) is installed but not signed in." };
  return { authenticated: false, method: null, reason: "The GitHub CLI (gh) did not confirm a sign-in, and no GitHub token is set." };
}

/** The token behind a gh sign-in. It is only ever handed to the request header. */
async function ghToken(exec: Exec, env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const result = await exec("gh", ["auth", "token"], { env });
    const token = result.code === 0 ? firstLine(result.stdout) : "";
    return token || null;
  } catch {
    return null;
  }
}

function unknown(reason: string, httpStatus?: number): CheckRunsResult {
  return { checks: [], state: "unknown", reason, ...(httpStatus === undefined ? {} : { httpStatus }) };
}

type CheckCategory = "passed" | "failed" | "pending" | "unrecognised";

function categoryOf(check: GitHubCheck): CheckCategory {
  if (check.conclusion !== null) {
    if (PASSING.has(check.conclusion)) return check.status === "completed" ? "passed" : "pending";
    if (FAILING.has(check.conclusion)) return "failed";
    return "unrecognised";
  }
  // A completed run with no conclusion is not a pass this app can read.
  return check.status === "completed" ? "unrecognised" : "pending";
}

/**
 * GitHub's check runs for one exact commit: GET /repos/{owner}/{repo}/commits/{sha}/check-runs.
 * Bounded by a timeout. Green only when every reported check completed as success (neutral and
 * skipped count as non-blocking, as documented above); red on any failure; pending while any check
 * is still queued or running; unknown when GitHub reported nothing this app can read.
 */
export async function fetchCheckRuns({
  owner,
  repo,
  sha,
  token,
  fetchImpl,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
}: {
  owner: string;
  repo: string;
  sha: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<CheckRunsResult> {
  const cleanOwner = owner.trim();
  const cleanRepo = repo.trim();
  const cleanSha = sha.trim();
  if (!OWNER.test(cleanOwner) || !REPO.test(cleanRepo) || cleanRepo === "." || cleanRepo === ".." || cleanRepo.includes("..")) {
    return unknown("The GitHub repository is not a valid owner/repo name, so its checks were not read.");
  }
  if (!SHA.test(cleanSha)) return unknown("The commit to check is not a full 40- or 64-character id, so its checks were not read.");
  const credential = token.trim();
  if (!credential) return unknown("No GitHub token is available to read this commit's checks.");

  const url = `https://api.github.com/repos/${encodeURIComponent(cleanOwner)}/${encodeURIComponent(cleanRepo)}/commits/${encodeURIComponent(cleanSha)}/check-runs?filter=latest&per_page=100`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  let response: Response;
  try {
    response = await (fetchImpl ?? fetch)(url, {
      method: "GET",
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${credential}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "perfect-planner",
      },
      signal: controller.signal,
    });
  } catch {
    return unknown(controller.signal.aborted ? "GitHub did not answer before the time limit." : "GitHub could not be reached from this computer.");
  } finally {
    clearTimeout(timer);
  }

  if (response.status !== 200) {
    const status = response.status;
    if (status === 401) return unknown("GitHub rejected the sign-in (401 Unauthorized). The token may be expired, or it may not have access to this repository.", 401);
    if (status === 403) {
      const remaining = response.headers?.get?.("x-ratelimit-remaining") ?? null;
      return unknown(
        remaining === "0"
          ? "GitHub's rate limit for this sign-in is used up (403)."
          : "GitHub refused the request (403): the sign-in may not have access to this repository, or its rate limit is reached.",
        403,
      );
    }
    if (status === 404) return unknown("GitHub could not find this repository or commit (404). The remote may be wrong, or the commit may not be pushed yet.", 404);
    if (status === 429) return unknown("GitHub is rate-limiting requests from this computer (429).", 429);
    return unknown(`GitHub answered with HTTP ${status}, so the checks were not read.`, status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return unknown("GitHub's answer could not be read as JSON.");
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const rawRuns = record.check_runs;
  if (!Array.isArray(rawRuns)) return unknown("GitHub's answer did not include check runs.");

  const checks: GitHubCheck[] = rawRuns.map((raw) => {
    const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 200) : "Unnamed check";
    const status = typeof item.status === "string" && item.status ? item.status : "unknown";
    const conclusion = typeof item.conclusion === "string" && item.conclusion ? item.conclusion : null;
    const html = typeof item.html_url === "string" ? item.html_url : typeof item.details_url === "string" ? item.details_url : "";
    // Only an https link is ever handed on: a check URL is displayed, and nothing else is allowed there.
    const url = /^https:\/\//i.test(html) ? html : undefined;
    return { name, status, conclusion, ...(url ? { url } : {}) };
  });

  if (!checks.length) return unknown(`GitHub has no check runs for ${cleanSha.slice(0, 7)} yet.`);
  const total = typeof record.total_count === "number" && Number.isFinite(record.total_count) ? record.total_count : checks.length;

  const failing = checks.filter((check) => categoryOf(check) === "failed");
  if (failing.length) {
    const names = failing.slice(0, 3).map((check) => check.name).join(", ");
    const more = failing.length > 3 ? ` and ${failing.length - 3} more` : "";
    return { checks, state: "red", reason: `${plural(failing.length, "check")} failed on ${cleanSha.slice(0, 7)}: ${names}${more}.` };
  }
  const unrecognised = checks.find((check) => categoryOf(check) === "unrecognised");
  if (unrecognised) {
    return {
      checks,
      state: "unknown",
      reason: `GitHub reported a check result this app does not understand (${unrecognised.name}: ${unrecognised.conclusion ?? unrecognised.status}).`,
    };
  }
  // Reading only one page of a longer list could call a commit green while a check was never seen.
  if (total > checks.length) {
    return { checks, state: "unknown", reason: `GitHub reported ${total} checks but only ${checks.length} were read, so the result is incomplete.` };
  }
  const pending = checks.filter((check) => categoryOf(check) === "pending").length;
  if (pending) {
    return { checks, state: "pending", reason: `Checks are still running on ${cleanSha.slice(0, 7)} (${pending} of ${checks.length} not finished).` };
  }
  const short = cleanSha.slice(0, 7);
  return {
    checks,
    state: "green",
    reason: checks.length === 1 ? `The check on ${short} passed.` : `All ${checks.length} checks passed on ${short}.`,
  };
}

function nextActionFor(result: CheckRunsResult): string {
  if (result.state === "green") return "Nothing to do: every check on this commit passed.";
  if (result.state === "red") return "Open the failing check, fix it, push the fix, then reload.";
  if (result.state === "pending") return "Wait for the checks to finish, then reload.";
  switch (result.httpStatus) {
    case 401:
      return "Sign in again with `gh auth login` (or replace GITHUB_TOKEN), then reload.";
    case 403:
      return "Check that the sign-in can read this repository and that its rate limit is not used up, then reload.";
    case 404:
      return "Push this commit to GitHub (`git push`), then reload.";
    case 429:
      return "Wait a minute for GitHub's rate limit to reset, then reload.";
    default:
      return "Push this commit if it is not on GitHub yet, or wait for a workflow to report a check, then reload.";
  }
}

/**
 * The GitHub status of the repository at `projectRoot`: remote, branch, commit, checks, a plain
 * reason and the next action. No remote, no usable sign-in or an unreadable remote is
 * "not-configured" — never green. Everything here is read-only; nothing is written and no token
 * leaves this module.
 */
export async function githubStatus(projectRoot: string, options: GitHubStatusOptions = {}): Promise<GitHubStatusView> {
  const exec = options.exec ?? defaultExec;
  const env = options.env ?? process.env;
  const notConfigured = (reason: string, nextAction: string, remote: string | null = null): GitHubStatusView => ({
    state: "not-configured",
    reason,
    remote,
    branch: null,
    sha: null,
    checks: [],
    nextAction,
  });

  if (isNetworkPath(projectRoot)) {
    return notConfigured("This project's git folder is on a network share, which Perfect Planner does not read.", "Move the repository to a local disk, then reload.");
  }

  const remote = await readGitHubRemote({ cwd: projectRoot, exec });
  if (!remote.remote || !remote.owner || !remote.repo) {
    const action = remote.code === "no-remote"
      ? "Add a GitHub remote in this folder (`git remote add origin https://github.com/OWNER/REPO.git`), then reload."
      : remote.code === "not-github"
        ? "Point origin at the GitHub repository (`git remote set-url origin https://github.com/OWNER/REPO.git`), then reload."
        : "Check that git opens in this folder and that origin is set, then reload.";
    return notConfigured(remote.reason ?? "This repository has no GitHub remote.", action, remote.remote);
  }

  const auth = await readGitHubAuth({ exec, env });
  if (!auth.authenticated) {
    return notConfigured(auth.reason, "Sign in on this computer with `gh auth login` (or set GITHUB_TOKEN for this app), then reload.");
  }

  let branch: string | null = null;
  let sha: string | null = null;
  let gitRead = true;
  try {
    const [branchResult, shaResult] = await Promise.all([
      exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: projectRoot }),
      exec("git", ["rev-parse", "HEAD"], { cwd: projectRoot }),
    ]);
    const name = branchResult.code === 0 ? firstLine(branchResult.stdout) : "";
    branch = name && name !== "HEAD" ? name : null;
    const commit = shaResult.code === 0 ? firstLine(shaResult.stdout) : "";
    if (SHA.test(commit)) sha = commit.toLowerCase();
  } catch {
    gitRead = false;
  }
  if (!sha) {
    return {
      state: "unknown",
      reason: gitRead
        ? "This repository has no commit that GitHub could be asked about yet."
        : "Git could not be read in this folder, so there is no commit to check.",
      remote: remote.remote,
      branch,
      sha: null,
      checks: [],
      nextAction: gitRead ? "Make the first commit in this repository, then reload." : "Check that git opens in this folder, then reload.",
    };
  }

  const token = (auth.method === "gh" ? await ghToken(exec, env) : null) ?? envToken(env);
  if (!token) {
    return {
      state: "not-configured",
      reason: "The GitHub CLI is signed in, but it did not give this app a token to read checks.",
      remote: remote.remote,
      branch,
      sha,
      checks: [],
      nextAction: "Run `gh auth token` in a terminal; if it prints nothing, sign in again with `gh auth login`, then reload.",
    };
  }

  const result = await fetchCheckRuns({
    owner: remote.owner,
    repo: remote.repo,
    sha,
    token,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return {
    state: result.state,
    reason: result.reason,
    remote: remote.remote,
    branch,
    sha,
    checks: result.checks,
    nextAction: nextActionFor(result),
  };
}
