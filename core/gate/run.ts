import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isLocalWindowsPath, isWithin, NO_CWD_SEARCH_ENV, system32Tool, systemRoot } from "../exec/index";

export interface TestRunOptions {
  /** Kill the whole process tree after this long. Default 10 minutes. */
  timeoutMs?: number;
  /** Extra variables on top of the allow-listed environment (see TEST_ENV_ALLOW). */
  env?: Record<string, string>;
  /**
   * Folders no program the test starts may come from, beyond `cwd`: the repo, its worktrees, the
   * candidate, the project folder. Their PATH entries are dropped and a command that starts a program
   * inside one is refused (see testEnv and resolveCommand).
   */
  protect?: readonly string[];
  /** After a timeout, wait at most this long for the tree to be killed before reporting. Default 15 s. */
  killWaitMs?: number;
  /** How the tree is killed after a timeout. Tests only; default killTree. */
  killTree?: (child: ChildProcess) => Promise<void>;
}

export interface TestRunResult {
  passed: boolean;
  /** Null when the process was killed, never started, or its program was not found. */
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Last ~4 KB of combined stdout and stderr. */
  outputTail: string;
}

export type TestRunner = (command: string, cwd: string, options: TestRunOptions) => Promise<TestRunResult>;

export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const KILL_WAIT_MS = 15_000;
const TAIL_BYTES = 4096;
const isWindows = process.platform === "win32";

/** Bounded buffer that keeps only the last TAIL_BYTES of everything written. */
class Tail {
  private chunks: Buffer[] = [];
  private size = 0;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size - (this.chunks[0]?.length ?? 0) >= TAIL_BYTES && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length;
    }
  }

  text(): string {
    const all = Buffer.concat(this.chunks);
    const start = Math.max(0, all.length - TAIL_BYTES);
    // Step forward past UTF-8 continuation bytes so we never print half a character.
    let from = start;
    while (from < all.length && from > 0 && (all[from]! & 0xc0) === 0x80) from += 1;
    return all.subarray(from).toString("utf8");
  }
}

/**
 * Variables a test command may see. Everything else (API keys, cloud credentials, tokens the
 * user's shell happens to hold) is dropped, so agent-written tests cannot read or leak them.
 */
export const TEST_ENV_ALLOW = [
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE",
  "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)",
  "USER", "USERNAME", "LOGNAME", "SHELL", "TERM", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "CI", "NPM_CONFIG_CACHE",
] as const;

/** Copy only allow-listed variables (matched case-insensitively, as Windows does), plus explicit extras. */
export function scrubbedEnv(source: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const allow = new Set<string>(TEST_ENV_ALLOW);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined && allow.has(key.toUpperCase())) env[key] = value;
  return { ...env, ...extra };
}

/**
 * Folder of the Node the app runs tests with: the desktop app's own (PP_NODE_BINARY, an absolute path
 * set by the app) or, failing that, the Node running this process.
 */
export function appNodeDir(nodeBinary = process.env.PP_NODE_BINARY, execPath = process.execPath): string {
  return path.dirname(nodeBinary && path.isAbsolute(nodeBinary) ? nodeBinary : execPath);
}

/** Every root as written and as a real path, for the inside-a-root checks. */
function rootSet(cwd: string, protect: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const root of [cwd, ...protect]) {
    if (!root) continue;
    roots.add(path.resolve(root));
    const real = realOrNull(root);
    if (real) roots.add(real);
  }
  return [...roots];
}

function realOrNull(p: string): string | null {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

/**
 * The test command's environment with a PATH it could not have been planted into. Same rules as the
 * agent connect line's childEnv: keep only folders that are absolute, local (a drive-letter path on
 * Windows), resolvable, and neither as written nor as a real path inside `cwd` or a protected root.
 * The app's Node folder goes first (when it passes the same check), so `node` is the app's own Node even
 * on a PC with no Node installed. NoDefaultCurrentDirectoryInExePath stops cmd.exe searching `cwd`.
 */
export function testEnv(
  env: NodeJS.ProcessEnv,
  options: { cwd: string; protect?: readonly string[]; platform?: NodeJS.Platform; nodeDir?: string },
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const windows = platform === "win32";
  const p = windows ? path.win32 : path.posix;
  const roots = rootSet(options.cwd, options.protect ?? []);
  const inside = (dir: string) => roots.some((root) => isWithin(root, dir));
  const usable = (dir: string) => {
    if (!dir || !p.isAbsolute(dir) || (windows && !isLocalWindowsPath(dir))) return false;
    const real = realOrNull(dir);
    return !!real && !(windows && !isLocalWindowsPath(real)) && !inside(path.resolve(dir)) && !inside(real);
  };
  const keys = Object.keys(env).filter((name) => (windows ? name.toUpperCase() === "PATH" : name === "PATH"));
  const value = keys.map((key) => env[key]).find((v) => typeof v === "string") ?? "";
  const kept: string[] = [];
  for (const entry of value.split(p.delimiter)) {
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    if (usable(dir) && !kept.includes(dir)) kept.push(dir);
  }
  const node = options.nodeDir ?? appNodeDir();
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of keys) delete out[key];
  out[windows ? "Path" : "PATH"] = [...(usable(node) ? [node] : []), ...kept.filter((dir) => dir !== node)].join(p.delimiter);
  return { ...out, ...NO_CWD_SEARCH_ENV };
}

/** A run proves the test fails only if the test itself ran and reported failure. */
export function isConclusiveFailure(run: TestRunResult): boolean {
  if (run.passed || run.timedOut || run.exitCode === null) return false;
  // npm that could not find the project's package.json or the named script never ran a test (exit 254 or 1), so the
  // worker could "make it pass" later by adding an empty script (F4 of the soak trial).
  if (/npm (?:error|ERR!) (?:code ENOENT|Missing script|Could not read package\.json)|Could not read package\.json|Missing script: /i.test(run.outputTail)) return false;
  // Shell "cannot execute" / "command not found" (POSIX) and "not recognized" (cmd.exe) mean the test never ran.
  // cmd.exe under `cmd /d /s /c` can report exit 1 for a missing command, so the message is checked too.
  if (isWindows) return run.exitCode !== 9009 && !/is not recognized as an internal or external command/i.test(run.outputTail);
  return run.exitCode !== 126 && run.exitCode !== 127;
}

const SHELL_BUILTINS = new Set(isWindows
  ? ["assoc", "break", "call", "cd", "chdir", "cls", "color", "copy", "date", "del", "dir", "echo", "endlocal", "erase", "exit", "for", "ftype", "goto", "if", "md", "mkdir", "mklink", "move", "path", "popd", "prompt", "pushd", "rd", "rem", "ren", "rename", "rmdir", "set", "setlocal", "shift", "start", "time", "title", "type", "ver", "verify", "vol"]
  : [".", ":", "[", "alias", "cd", "command", "eval", "exec", "exit", "export", "false", "set", "source", "test", "true", "type", "ulimit", "umask", "unset"]);

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export type ResolvedCommand =
  /** A shell builtin: nothing is started by name. */
  | { kind: "builtin" }
  | { kind: "found"; file: string }
  | { kind: "missing"; program: string }
  /** The program would be started from inside cwd or a protected root (as written or through a link). */
  | { kind: "inside"; program: string; file: string }
  /** Shell syntax (a variable, a glob, ~, a subshell) hides which program starts. */
  | { kind: "unclear"; program: string };

/** Commands that start the program named after them; their next word is what runs. */
const PREFIXES = new Set(isWindows ? [] : ["exec", "command", "nohup", "env", "time"]);

/**
 * The program a test command starts, looked up the way the shell will in the environment the test gets
 * (PATH, and PATHEXT on Windows; never the current folder once testEnv set NoDefaultCurrentDirectoryInExePath).
 * Leading NAME=value assignments are skipped. A path is resolved against `cwd`. The first match counts,
 * since that is what the shell runs, and its real path is checked against `cwd` and `protect`.
 */
export function resolveCommand(command: string, cwd: string, env: NodeJS.ProcessEnv, protect: readonly string[] = []): ResolvedCommand {
  let rest = command;
  let program: string | undefined;
  for (;;) {
    const match = /^\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|<>()]+))/.exec(rest);
    if (!match) return { kind: "unclear", program: rest.trim() };
    program = match[1] ?? match[2] ?? match[3]!;
    rest = rest.slice(match[0].length);
    // POSIX `NAME=value cmd` and `exec cmd`: the program is a later word.
    if (!isWindows && match[3] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(program)) continue;
    if (PREFIXES.has(program)) {
      if (/^\s+-/.test(rest)) return { kind: "unclear", program };
      continue;
    }
    break;
  }
  if (/[=$%`*?{}~!^\[\]]/.test(program)) return { kind: "unclear", program };
  if (SHELL_BUILTINS.has(program.toLowerCase())) return { kind: "builtin" };
  const roots = rootSet(cwd, protect);
  const inside = (file: string) => {
    const real = realOrNull(file) ?? path.resolve(file);
    return roots.some((root) => isWithin(root, path.resolve(file)) || isWithin(root, real)) || (isWindows && !isLocalWindowsPath(real));
  };
  const lookup = (name: string) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1] ?? "";
  const extensions = isWindows ? ["", ...(lookup("PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  const first = (base: string) => {
    for (const ext of extensions) for (const file of [base + ext, base + ext.toLowerCase()]) if (isFile(file)) return file;
    return undefined;
  };
  const check = (file: string): ResolvedCommand => (inside(file) ? { kind: "inside", program, file } : { kind: "found", file });
  if (/[\\/]/.test(program)) {
    const file = first(path.resolve(cwd, program));
    return file ? check(file) : { kind: "missing", program };
  }
  // Without NoDefaultCurrentDirectoryInExePath cmd.exe looks in the current folder before PATH.
  const searchCwd = isWindows && !lookup("NODEFAULTCURRENTDIRECTORYINEXEPATH");
  const dirs = [...(searchCwd ? [cwd] : []), ...lookup("PATH").split(path.delimiter).filter(Boolean)];
  for (const dir of dirs) {
    const file = first(path.join(dir, program));
    if (file) return check(file);
  }
  return { kind: "missing", program };
}

/**
 * Whether the program a command starts with exists (see resolveCommand). Shell syntax we can't judge
 * counts as found, so this only ever rules out commands that plainly can't start.
 */
export function commandExists(command: string, cwd: string, env: NodeJS.ProcessEnv): boolean {
  return resolveCommand(command, cwd, env).kind !== "missing";
}

/**
 * Windows: end the whole tree with the system's own taskkill, found through the shared SystemRoot rule (a SystemRoot
 * that is not a local drive-letter path is ignored). taskkill gets SystemRoot in its own environment, because it
 * does not start without it, and any exit other than "done" or "already gone" (128) falls back to killing the child
 * itself. Exported for tests, which pass a stand-in spawn.
 */
export function killWindowsTree(child: ChildProcess, spawnImpl: typeof spawn = spawn, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (kill: boolean) => {
      if (settled) return;
      settled = true;
      if (kill) child.kill();
      resolve();
    };
    try {
      const killer = spawnImpl(system32Tool("taskkill.exe", env), ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore", env: { ...env, SystemRoot: systemRoot(env) } });
      killer.on("error", () => done(true));
      killer.on("exit", (code) => done(code !== 0 && code !== 128));
    } catch {
      done(true);
    }
  });
}

/**
 * Kill the child and everything it started. Resolves once the kill has been carried out (on Windows,
 * when taskkill exits), so a caller can wait before removing the folder the tree was running in.
 */
export function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return Promise.resolve();
  if (isWindows) return killWindowsTree(child);
  try {
    // The child was spawned detached, so it leads its own process group.
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  return Promise.resolve();
}

/**
 * Run a user-approved test command through the platform shell (sh on POSIX, cmd.exe on Windows).
 * Never throws: a command that cannot start is reported as a failure with the error as output.
 */
export function runTestCommand(command: string, cwd: string, options: TestRunOptions = {}): Promise<TestRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const killWaitMs = options.killWaitMs ?? KILL_WAIT_MS;
  const started = Date.now();
  const tail = new Tail();
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let child: ChildProcess;
    let killing: Promise<boolean> | undefined;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      const report = () => resolve({ passed: !timedOut && exitCode === 0, exitCode: timedOut ? null : exitCode, timedOut, durationMs: Date.now() - started, outputTail: tail.text() });
      // After a timeout, report only once the tree is gone (or the kill stops answering), so the
      // caller can remove its folder.
      if (!killing) return report();
      void killing.then((killed) => {
        if (!killed) tail.push(Buffer.from(`[perfect-planner] the process tree may still be running: killing it did not finish within ${killWaitMs} ms\n`));
        report();
      });
    };
    let grace: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      tail.push(Buffer.from(`\n[perfect-planner] test timed out after ${timeoutMs} ms; process tree killed\n`));
      let deadline: NodeJS.Timeout | undefined;
      killing = Promise.race([
        (options.killTree ?? killTree)(child).then(() => true, () => false),
        new Promise<boolean>((done) => {
          deadline = setTimeout(() => done(false), killWaitMs);
        }),
      ]).finally(() => clearTimeout(deadline));
      // If something still holds the pipes open, stop waiting for them.
      grace = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null);
      }, 5000);
    }, timeoutMs);
    const protect = options.protect ?? [];
    const env = testEnv(scrubbedEnv(process.env, options.env), { cwd, protect });
    const resolved = resolveCommand(command, cwd, env, protect);
    const refusal =
      resolved.kind === "missing" ? `command not found: ${resolved.program}`
      : resolved.kind === "inside" ? `refused: ${resolved.program} is ${resolved.file}, inside the project or one of its worktrees, so it could be a planted copy that reports a pass without running the test. Start the test with an installed program (node, npm, npx, python), then a script path.`
      : resolved.kind === "unclear" ? `refused: Perfect Planner can't tell which program "${resolved.program}" starts. Start the test with a plain program name or path.`
      : undefined;
    if (refusal) {
      tail.push(Buffer.from(`[perfect-planner] ${refusal}\n`));
      finish(null);
      return;
    }
    try {
      child = spawn(command, { cwd, env, shell: true, windowsHide: true, detached: !isWindows, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      tail.push(Buffer.from(String(error)));
      finish(null);
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => tail.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => tail.push(chunk));
    child.on("error", (error) => {
      tail.push(Buffer.from(`\n${error.message}\n`));
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}
