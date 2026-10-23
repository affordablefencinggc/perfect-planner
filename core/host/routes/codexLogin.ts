// "Log in to Codex" from the Connect area: runs `codex login` (ChatGPT sign-in in the browser) so no
// terminal is needed. Codex keeps the login in its own files; this app never reads, returns or stores
// any token or key. The browser address Codex prints is the only thing passed on, and only when it is
// a sign-in page on OpenAI's own hosts, so the person can open it by hand if no browser opened.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NO_CWD_SEARCH_ENV } from "../../exec/index";
import { agentLaunch } from "../agentConnect";
import { childEnv } from "../protectedRoots";
import { HttpError, type Router } from "../router";
import { projectRoots } from "./agents";

export type CodexLoginState = "idle" | "waiting" | "done" | "failed";

interface Run {
  state: CodexLoginState;
  url?: string;
  message?: string;
  child?: ChildProcess;
}

const LOGIN_MS = 5 * 60_000;
const STATUS_MS = 10_000;
const OPENAI_URL = /https:\/\/(?:auth\.openai\.com|chatgpt\.com|auth0\.openai\.com)\/[^\s"'<>]+/;
const runs = new Map<string, Run>();

function launchFor(args: string[], roots: string[]) {
  // A folder of its own, so no PATH folder (home's .local/bin) counts as inside the working folder.
  const cwd = path.join(os.tmpdir(), "pp-codex-login");
  fs.mkdirSync(cwd, { recursive: true });
  const env = { ...childEnv(process.env, { cwd, protect: roots }), ...NO_CWD_SEARCH_ENV };
  const launch = agentLaunch("codex", args, process.env, cwd, roots);
  return launch ? { launch, cwd, env } : null;
}

/** What `codex login status` says, reduced to a yes/no and the sign-in kind. Never the raw text. */
export function codexStatus(roots: string[]): Promise<{ installed: boolean; loggedIn: boolean; method?: "chatgpt" | "api-key" }> {
  const made = launchFor(["login", "status"], roots);
  if (!made) return Promise.resolve({ installed: false, loggedIn: false });
  return new Promise((resolve) => {
    execFile(made.launch.command, made.launch.args, { cwd: made.cwd, env: made.env, windowsHide: true, timeout: STATUS_MS, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
      if (error) return resolve({ installed: true, loggedIn: false });
      resolve({ installed: true, loggedIn: true, method: /api key/i.test(`${stdout}${stderr}`) ? "api-key" : "chatgpt" });
    });
  });
}

export function registerCodexLoginRoutes(router: Router): void {
  const view = async (key: string, roots: string[]) => {
    const run = runs.get(key) ?? { state: "idle" as const };
    const status = await codexStatus(roots);
    return {
      ...status,
      state: run.state === "waiting" ? "waiting" : status.loggedIn ? "done" : run.state === "done" ? "idle" : run.state,
      ...(run.state === "waiting" && run.url ? { url: run.url } : {}),
      ...(run.message ? { message: run.message } : {}),
    };
  };

  router.get("/agents/codex-login", async ({ project }) => view(project.key, projectRoots(project)));

  router.post("/agents/codex-login", async ({ project }) => {
    const key = project.key;
    const roots = projectRoots(project);
    const current = runs.get(key);
    if (current?.state === "waiting") return view(key, roots);
    const made = launchFor(["login"], roots);
    if (!made) throw new HttpError(404, "CODEX_MISSING", "Codex CLI is not installed on this computer. Install it first (npm install -g @openai/codex), then try again.");
    const run: Run = { state: "waiting" };
    runs.set(key, run);
    const child = spawn(made.launch.command, made.launch.args, { cwd: made.cwd, env: made.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    run.child = child;
    const timer = setTimeout(() => child.kill("SIGKILL"), LOGIN_MS);
    let seen = "";
    const take = (chunk: Buffer) => {
      seen = (seen + chunk.toString("utf8")).slice(-4000);
      const url = OPENAI_URL.exec(seen)?.[0];
      if (url && !run.url) run.url = url;
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", () => {
      clearTimeout(timer);
      Object.assign(run, { state: "failed", message: "Codex could not be started." });
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      delete run.child;
      delete run.url;
      if (code === 0 && (await codexStatus(roots)).loggedIn) Object.assign(run, { state: "done", message: "Signed in to Codex." });
      else Object.assign(run, { state: "failed", message: "Sign-in did not finish. Nothing was changed; try the button again." });
    });
    return view(key, roots);
  });
}
