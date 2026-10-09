import { spawn, type ChildProcess } from "node:child_process";

export interface TestRunOptions {
  /** Kill the whole process tree after this long. Default 10 minutes. */
  timeoutMs?: number;
  /** Extra variables on top of the allow-listed environment (see TEST_ENV_ALLOW). */
  env?: Record<string, string>;
}

export interface TestRunResult {
  passed: boolean;
  /** Null when the process was killed or never started. */
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Last ~4 KB of combined stdout and stderr. */
  outputTail: string;
}

export type TestRunner = (command: string, cwd: string, options: TestRunOptions) => Promise<TestRunResult>;

export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
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

/** A run proves the test fails only if the test itself ran and reported failure. */
export function isConclusiveFailure(run: TestRunResult): boolean {
  if (run.passed || run.timedOut || run.exitCode === null) return false;
  // Shell "cannot execute" / "command not found" (POSIX) and "not recognized" (cmd.exe) mean the test never ran.
  // cmd.exe /d /s /c (how Node runs shell: true) exits 1, not 9009, for an unknown command, so read its message too.
  if (isWindows) return run.exitCode !== 9009 && !(run.exitCode === 1 && CMD_NOT_FOUND.test(run.outputTail));
  return run.exitCode !== 126 && run.exitCode !== 127;
}

/** cmd.exe's message when the command is not a program, a built-in or a batch file (English Windows). */
const CMD_NOT_FOUND = /is not recognized as an internal or external command,\s*operable program or batch file\.\s*$/;

/** Kill the child and everything it started. */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (isWindows) {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
    killer.on("error", () => child.kill());
    return;
  }
  try {
    // The child was spawned detached, so it leads its own process group.
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/**
 * Run a user-approved test command through the platform shell (sh on POSIX, cmd.exe on Windows).
 * Never throws: a command that cannot start is reported as a failure with the error as output.
 */
export function runTestCommand(command: string, cwd: string, options: TestRunOptions = {}): Promise<TestRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  const tail = new Tail();
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let child: ChildProcess;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolve({ passed: !timedOut && exitCode === 0, exitCode: timedOut ? null : exitCode, timedOut, durationMs: Date.now() - started, outputTail: tail.text() });
    };
    let grace: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      tail.push(Buffer.from(`\n[perfect-planner] test timed out after ${timeoutMs} ms; process tree killed\n`));
      killTree(child);
      // If something still holds the pipes open, stop waiting for them.
      grace = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null);
      }, 5000);
    }, timeoutMs);
    try {
      child = spawn(command, { cwd, env: scrubbedEnv(process.env, options.env), shell: true, windowsHide: true, detached: !isWindows, stdio: ["ignore", "pipe", "pipe"] });
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
