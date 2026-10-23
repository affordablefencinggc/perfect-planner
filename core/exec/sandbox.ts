// Contain a test command: it may read the toolchain and its own worktree, write only its worktree and a
// private scratch folder, and reach no network. Leaf module (imports only ./executable). The command is
// wrapped, not replaced: the caller's own runner still scrubs the environment, enforces the timeout and
// keeps the output tail, so this is a second wall behind those. Linux only (bubblewrap); everywhere else
// the runner fails closed. See core/host/ISOLATION.md.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findExecutable, isWithin } from "./executable";

export interface SandboxPolicy {
  /** The only places the command may write: its worktree. A private scratch folder is added on its own. */
  writable: readonly string[];
  /** Visible read-only: the toolchain and the git folder. Nothing else outside the OS runtime exists. */
  readable: readonly string[];
}

export type SandboxKind = "bubblewrap" | "none";
export interface SandboxStatus {
  kind: SandboxKind;
  /** Plain words, set when kind is "none". */
  reason?: string;
}

/** Same shape as the gate's TestRunner (declared here so this module stays a leaf). */
export interface ContainedRunResult {
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
}
export type ContainedRunner<O> = (command: string, cwd: string, options: O) => Promise<ContainedRunResult>;

export const CONTAINED_HEADER = "[contained: bubblewrap, no network, writes only in the worktree]";
export const NOT_CONTAINED_HEADER = "[NOT contained]";

const SYSTEM_DIRS = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"];
const ETC_FILES = ["passwd", "group", "hosts", "nsswitch.conf", "ld.so.cache", "ld.so.conf", "ld.so.conf.d", "ssl", "ca-certificates", "localtime", "alternatives"];
/** Where the command gets private, throwaway writable space. */
function scratchFor(policy: SandboxPolicy): string {
  // A worktree under /tmp would sit inside a writable /tmp and so make its parent folders writable.
  return [...policy.readable, ...policy.writable].some((dir) => isWithin("/tmp", dir)) ? "/run/pp-scratch" : "/tmp";
}

let cached: Promise<SandboxStatus> | undefined;

/** Forget the cached answer (tests, and a Settings "check again"). */
export function resetSandboxStatus(): void {
  cached = undefined;
}

/** Whether this computer can contain a command, and if not, why in plain words. Cached; cheap to ask again. */
export function sandboxStatus(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<SandboxStatus> {
  if (platform === "win32") return Promise.resolve({ kind: "none", reason: "containing test commands is not available on Windows yet (it needs the AppContainer helper)" });
  if (platform !== "linux") return Promise.resolve({ kind: "none", reason: "containing test commands is only available on Linux and Windows" });
  cached ??= probe(env);
  return cached;
}

function probe(env: NodeJS.ProcessEnv): Promise<SandboxStatus> {
  const bwrap = bwrapPath(env);
  if (!bwrap) return Promise.resolve({ kind: "none", reason: "bubblewrap is not installed (install the bubblewrap package)" });
  return new Promise((resolve) => {
    let stderr = "";
    const child = spawn(bwrap, ["--unshare-all", "--die-with-parent", "--ro-bind", "/", "/", "true"], { stdio: ["ignore", "ignore", "pipe"], env: {} });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); resolve({ kind: "none", reason: `bubblewrap could not start: ${error.message}` }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ kind: "bubblewrap" });
      const why = /namespace|Operation not permitted|Permission denied|EPERM/i.test(stderr)
        ? "this computer does not allow unprivileged user namespaces (on Ubuntu 24.04 set kernel.apparmor_restrict_unprivileged_userns=0 or add a bubblewrap profile)"
        : `bubblewrap failed its self-check: ${stderr.trim().split("\n")[0] ?? `exit ${code}`}`;
      resolve({ kind: "none", reason: why });
    });
  });
}

function bwrapPath(env: NodeJS.ProcessEnv): string | null {
  return findExecutable("bwrap", env, os.tmpdir(), "linux");
}

function lstat(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch {
    return undefined;
  }
}

function real(p: string): string | undefined {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return undefined;
  }
}

/** POSIX single-quote a word for `sh -c`. */
export function shQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The bubblewrap arguments (after the program name) that run `command` under `policy`. Everything not
 * bound below does not exist inside, so there is nothing to deny: the main checkout's .env, the app's data
 * folder, other projects and ~/.ssh are simply absent.
 */
export function bwrapArgs(policy: SandboxPolicy, command: string, cwd: string): string[] {
  const scratch = scratchFor(policy);
  const args = ["--die-with-parent", "--new-session", "--unshare-all", "--cap-drop", "ALL", "--proc", "/proc", "--dev", "/dev", "--tmpfs", scratch];
  for (const dir of SYSTEM_DIRS) {
    const stat = lstat(dir);
    if (stat?.isSymbolicLink()) args.push("--symlink", fs.readlinkSync(dir), dir);
    else if (stat?.isDirectory()) args.push("--ro-bind", dir, dir);
  }
  for (const name of ETC_FILES) {
    const file = path.join("/etc", name);
    if (real(file)) args.push("--ro-bind", file, file);
  }
  for (const dir of policy.readable) if (real(dir)) args.push("--ro-bind", dir, dir);
  for (const dir of policy.writable) args.push("--bind", dir, dir);
  args.push("--remount-ro", "/");
  const env: Record<string, string> = { HOME: scratch, TMPDIR: scratch, TEMP: scratch, TMP: scratch, NPM_CONFIG_CACHE: `${scratch}/.npm`, SANDBOXED_BY: "bubblewrap" };
  for (const [key, value] of Object.entries(env)) args.push("--setenv", key, value);
  args.push("--chdir", cwd, "/bin/sh", "-c", command);
  return args;
}

/** The folders a worktree's `.git` file points into (its own entry and the shared git folder), read-only. */
export function gitDirsFor(cwd: string): string[] {
  const dirs: string[] = [];
  try {
    const dotGit = path.join(cwd, ".git");
    if (fs.statSync(dotGit).isFile()) {
      const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
      const own = match && real(path.resolve(cwd, match[1]!.trim()));
      if (own) {
        dirs.push(own);
        let common = own;
        try {
          common = real(path.resolve(own, fs.readFileSync(path.join(own, "commondir"), "utf8").trim())) ?? own;
        } catch {
          // no commondir: the entry is the whole git folder
        }
        if (common !== own) dirs.push(common);
      }
    } else {
      const own = real(dotGit);
      if (own) dirs.push(own);
    }
  } catch {
    // not a git folder: nothing to bind
  }
  return dirs;
}

/**
 * PATH folders (and the prefix above a `bin` folder, where npm and node_modules sit) a command may read,
 * minus anything inside or around a protected root, the home folder or the filesystem root.
 */
export function toolchainDirs(env: NodeJS.ProcessEnv, options: { cwd: string; protect?: readonly string[]; nodeDir?: string; home?: string }): string[] {
  const hidden = [options.cwd, ...(options.protect ?? [])].flatMap((root) => [path.resolve(root), real(root)].filter((r): r is string => !!r));
  const home = options.home ?? env.HOME;
  const clash = (dir: string) => hidden.some((root) => isWithin(root, dir) || isWithin(dir, root));
  const system = (dir: string) => SYSTEM_DIRS.some((s) => isWithin(s, dir));
  const out: string[] = [];
  const add = (dir: string | undefined) => {
    const resolved = dir && path.isAbsolute(dir) ? real(dir) : undefined;
    if (!resolved || resolved === "/" || system(resolved) || out.includes(resolved) || clash(resolved)) return;
    // Never a folder that holds the home folder (that would show ~/.ssh).
    if (home && isWithin(resolved, home)) return;
    out.push(resolved);
  };
  const entries = [...(options.nodeDir ? [options.nodeDir] : []), ...(env.PATH ?? "").split(path.delimiter)];
  for (const entry of entries) {
    add(entry);
    if (path.basename(entry) === "bin") add(path.dirname(entry));
  }
  return out;
}

export interface ContainedRunnerOptions<O extends { env?: Record<string, string>; protect?: readonly string[] }> {
  /** The runner that does the work (timeout, scrubbed env, tail). Gets the wrapped command. */
  base: ContainedRunner<O>;
  /** Folder of the Node the app runs tests with. */
  nodeDir?: string;
  /** A reason to refuse the command before it starts (a planted program, shell syntax we cannot judge). */
  precheck?: (command: string, cwd: string, options: O) => string | undefined;
  /** Tests only: where bubblewrap is (default: looked up on PATH). */
  bwrap?: string;
  /** Tests only. */
  status?: () => Promise<SandboxStatus>;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/**
 * Runner that contains each command. Fails closed: when the sandbox cannot start, nothing runs and the
 * result is `exitCode: null` (a run that proves nothing), never an uncontained run.
 */
export function containedRunner<O extends { env?: Record<string, string>; protect?: readonly string[] }>(options: ContainedRunnerOptions<O>): ContainedRunner<O> {
  const env = options.env ?? process.env;
  const notRun = (cwd: string, text: string): ContainedRunResult => ({ passed: false, exitCode: null, timedOut: false, durationMs: 0, outputTail: `${NOT_CONTAINED_HEADER}\n[perfect-planner] ${text}\n` });
  return async (command, cwd, runOptions) => {
    const status = await (options.status ?? (() => sandboxStatus(options.platform, env)))();
    if (status.kind !== "bubblewrap") return notRun(cwd, `Not run: this computer cannot contain test commands (${status.reason ?? "no sandbox"}). Turn off Contain test commands to run uncontained.`);
    const bwrap = options.bwrap ?? bwrapPath(env);
    if (!bwrap) return notRun(cwd, "Not run: this computer cannot contain test commands (bubblewrap is not installed).");
    const refusal = options.precheck?.(command, cwd, runOptions);
    if (refusal) return { passed: false, exitCode: null, timedOut: false, durationMs: 0, outputTail: `${CONTAINED_HEADER}\n[perfect-planner] ${refusal}\n` };
    const worktree = real(cwd) ?? path.resolve(cwd);
    const policy: SandboxPolicy = {
      writable: [worktree],
      readable: [...gitDirsFor(cwd), ...toolchainDirs(env, { cwd, ...(runOptions.protect ? { protect: runOptions.protect } : {}), ...(options.nodeDir ? { nodeDir: options.nodeDir } : {}) })],
    };
    const wrapped = [bwrap, ...bwrapArgs(policy, command, worktree)].map(shQuote).join(" ");
    const result = await options.base(wrapped, cwd, runOptions);
    // bubblewrap's own failure is not a test failure: a broken sandbox must not look like "the test fails first".
    const broken = result.exitCode === 1 && /^bwrap: /m.test(result.outputTail);
    return { ...result, ...(broken ? { passed: false, exitCode: null } : {}), outputTail: `${CONTAINED_HEADER}\n${result.outputTail}` };
  };
}
