// Shared pieces for the attack suite (core/attack/*.test.ts): a host that can be stopped and started again
// over the same folders and keys (a restart), keys that survive a process dying (the OS key store does),
// real throwaway git repositories, and the driver that takes one task all the way to "ready to merge"
// the way a person and a worker do through the app. Test code only; nothing here ships.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { KeychainKeyProvider, type KeyState, type SecretStore } from "../ledger/index";
import { bridgeCall } from "../mcp/index";
import { CSRF_HEADER, createCoreHost, type CoreHost } from "../host/index";
import { HostKeys } from "../host/keys";

/** A key store in a file, so keys outlive the process that made them (like the OS key store does). */
export class FileSecrets implements SecretStore {
  readonly description = "attack-suite key file";
  constructor(private readonly file: string) {}
  state(): KeyState {
    return { available: true };
  }
  private read(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }
  get(account: string): string | undefined {
    return this.read()[account];
  }
  set(account: string, value: string): void {
    const next = { ...this.read(), [account]: value };
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next));
    fs.renameSync(tmp, this.file);
  }
  remove(account: string): void {
    const next = this.read();
    delete next[account];
    fs.writeFileSync(this.file, JSON.stringify(next));
  }
}

export const hostKeysOn = (secretsFile: string): HostKeys => new HostKeys(new KeychainKeyProvider(new FileSecrets(secretsFile)));

const made: string[] = [];
export function tempDir(prefix = "pp-attack-"): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}
export function cleanTemp(): void {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

// The suite's own git calls ignore the machine's global and system git config (a global LFS filter, a signing key, a
// hooks path of the person running the tests), so every run starts from the same place. The app's git is separate.
// Git's own spelling of the null device, not Node's os.devNull: on Windows that is "\\\\.\\nul", which git refuses
// ("fatal: unable to access '\\\\.\\nul': Invalid argument", windows-latest run 39034322787), while git for Windows
// maps "/dev/null" to NUL itself.
const NULL_DEVICE = "/dev/null";
const GIT_IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid", GIT_CONFIG_GLOBAL: NULL_DEVICE, GIT_CONFIG_NOSYSTEM: "1" };

/** Plain git for test setup (the repo's own config applies; signing is switched off per repo). Hooks never run. */
export function git(cwd: string, ...args: string[]): string {
  // No hooks for the suite's own calls: a hook installed by a test repo (git lfs install) must only ever fire for the app's git.
  return gitWithHooks(cwd, "-c", `core.hooksPath=${NULL_DEVICE}`, ...args);
}

/** The same, but with the repo's hooks allowed: for setup that has to install them (git lfs install). */
export function gitWithHooks(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_IDENTITY }, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function write(dir: string, file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}

/** A real repo with one commit on main (or none, with commit: false). The folder is the project folder too. */
export function makeRepo(files: Record<string, string> = { "README.md": "# Notes app\n", ".gitignore": ".perfect-planner/\n" }, { commit = true }: { commit?: boolean } = {}): string {
  const repo = tempDir("pp-attack-repo-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "user.name", "Owner");
  git(repo, "config", "user.email", "owner@example.invalid");
  // Like the worktree tests: the app carries the machine's autocrlf into its own git, so on Windows the merge writes CRLF into
  // the main checkout while these helpers (which ignore system config) read it as a change. Pin it for the repo.
  git(repo, "config", "core.autocrlf", "false");
  for (const [name, text] of Object.entries(files)) write(repo, name, text);
  if (commit) {
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "Initial");
  }
  return repo;
}

export interface Window {
  host: CoreHost;
  base: string;
  origin: string;
  cookie: string;
  csrf: string;
  stop: () => Promise<void>;
  /** The person's own window: cookie, CSRF token and Origin. */
  person: () => Record<string, string>;
  call: (method: "GET" | "POST", route: string, body?: unknown) => Promise<{ status: number; body: { ok: boolean; result?: any; code?: string; message?: string } }>;
}

export interface StartOptions {
  /** App data folder (owner pins, witnesses). Kept across a restart. */
  data: string;
  /** The project folder; here also the git repo. */
  project: string;
  secrets: string;
  /** Listen on this port (a restart on the same address as before). Default: any free port. */
  port?: number;
}

/** Claims a launch secret the way the app window does and returns the person's window on that host. */
export async function connectWindow(base: string, launch: string): Promise<Pick<Window, "base" | "origin" | "cookie" | "csrf" | "person" | "call">> {
  const origin = base.replace(/\/api\/core$/, "");
  const claim = await fetch(`${base}/session/claim`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ launch }) });
  const cookie = (claim.headers.get("set-cookie") ?? "").split(";")[0]!;
  const csrf = ((await claim.json()) as { result: { csrf: string } }).result.csrf;
  const person = () => ({ cookie, [CSRF_HEADER]: csrf, origin });
  const call: Window["call"] = async (method, route, body) => {
    const send = async () => {
      const res = await fetch(`${base}${route}`, { method, headers: { ...person(), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, body: (await res.json()) as { ok: boolean; result?: any; code?: string; message?: string } };
    };
    const first = await send();
    // A new project waits for "Start a new history for this folder" before its first write; take it as the person would.
    if (first.body.code === "START_HISTORY") {
      const project = new URL(route, "http://local").searchParams.get("project");
      const started = await fetch(`${base}/owner/start${project ? `?project=${encodeURIComponent(project)}` : ""}`, { method: "POST", headers: { ...person(), "content-type": "application/json" }, body: "{}" });
      if (started.status !== 200) return first;
      return send();
    }
    return first;
  };
  return { base, origin, cookie, csrf, person, call };
}

/** Starts the core host in this process on a loopback port and opens the person's window on it. */
export async function startWindow(options: StartOptions): Promise<Window> {
  const host = createCoreHost({ root: options.data, projectRootOverride: options.project, bridge: true, keys: hostKeysOn(options.secrets) });
  const server = http.createServer((req, res) => host.middleware(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/core`;
  const window = await connectWindow(base, host.issueLaunch());
  return {
    ...window,
    host,
    stop: async () => {
      await host.close();
      // Drop the keep-alive sockets so a restart on the same address does not reuse a connection to the dead server.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    },
  };
}

export const TEST_FILE = "tests/save.check.mjs";
export const TEST_SOURCE = 'import { existsSync } from "node:fs";\nprocess.exit(existsSync("src/save.js") ? 0 : 1);\n';

export interface Dispatched {
  task: string;
  worktree: string;
  branch: string;
  bridgeUrl: string;
  tokenFile: string;
  token: string;
  agent: string;
  call: ReturnType<typeof bridgeCall>;
}

/** Drives a task as the app does: dispatch, the worker proposes a failing test, the person approves it. */
export async function dispatchAndApproveTest(win: Pick<Window, "call">, q: string, task = "T-1", test: { file: string; source: string; command: string } = { file: TEST_FILE, source: TEST_SOURCE, command: `node ${TEST_FILE}` }): Promise<Dispatched> {
  const dispatched = await win.call("POST", `/tasks/${task}/dispatch${q}`, { model: "builder-model" });
  if (dispatched.status !== 200) throw new Error(`dispatch ${task}: ${JSON.stringify(dispatched.body)}`);
  const d = dispatched.body.result as { worktree: string; branch: string; bridgeUrl: string; tokenFile: string };
  const token = fs.readFileSync(d.tokenFile, "utf8");
  const call = bridgeCall(d.bridgeUrl, token);
  const hello = (await call({ tool: "hello", args: { name: "Worker" } })) as { agent: string };
  write(d.worktree, test.file, test.source);
  git(d.worktree, "add", "-A");
  git(d.worktree, "commit", "-q", "-m", "Test first");
  await call({ tool: "propose_test", args: { task, command: test.command, files: [test.file] }, agent: hello.agent });
  const view = (await win.call("GET", `/tasks${q}`)).body.result as { tasks: { id: string; test: { entry: string } }[] };
  const entry = view.tasks.find((t) => t.id === task)!.test.entry;
  const approved = await win.call("POST", `/tasks/${task}/approve-test${q}`, { test: entry });
  if (approved.status !== 200 || !approved.body.result.failsFirst) throw new Error(`approve-test ${task}: ${JSON.stringify(approved.body)}`);
  return { task, worktree: d.worktree, branch: d.branch, bridgeUrl: d.bridgeUrl, tokenFile: d.tokenFile, token, agent: hello.agent, call };
}

/** The worker claims, builds the feature, commits and attaches proof; the person checks and approves the diff. Returns the approved commit. */
export async function buildCheckApprove(win: Pick<Window, "call">, q: string, w: Dispatched, extraFiles: Record<string, string> = {}): Promise<string> {
  await w.call({ tool: "claim_task", args: { task: w.task }, agent: w.agent });
  write(w.worktree, "src/save.js", "export const save = (note) => note;\n");
  for (const [name, text] of Object.entries(extraFiles)) write(w.worktree, name, text);
  git(w.worktree, "add", "-A");
  git(w.worktree, "commit", "-q", "-m", "Save notes");
  const head = git(w.worktree, "rev-parse", "HEAD");
  await w.call({ tool: "attach_proof", args: { task: w.task, kind: "commit", link: head }, agent: w.agent });
  const checked = await win.call("POST", `/tasks/${w.task}/check${q}`);
  if (checked.status !== 200 || !checked.body.result.passed) throw new Error(`check ${w.task}: ${JSON.stringify(checked.body)}`);
  // The worker's own test file counts as a sensitive change: the person confirms they read exactly those files.
  const diff = (await win.call("GET", `/tasks/${w.task}/diff${q}`)).body.result as { sensitive: string[] };
  const approved = await win.call("POST", `/tasks/${w.task}/approve-diff${q}`, { commit: head, confirmSensitive: diff.sensitive });
  if (approved.status !== 200) throw new Error(`approve-diff ${w.task}: ${JSON.stringify(approved.body)}`);
  return head;
}

/** Creates the person's own task T-n through the planning route (a person-signed task.created). */
export async function addTask(win: Pick<Window, "call">, q: string, title = "Save notes"): Promise<string> {
  const res = await win.call("POST", `/planning/tasks${q}`, { title });
  if (res.status !== 200) throw new Error(`add task: ${JSON.stringify(res.body)}`);
  return res.body.result.task as string;
}

/** Every file path under a folder (not following links), relative, for "nothing new appeared" checks. */
export function listTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      out.push(path.relative(dir, full));
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full);
    }
  };
  walk(dir);
  return out.sort();
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
