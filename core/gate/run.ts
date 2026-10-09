import { spawn, type ChildProcess } from "node:child_process";

export interface TestRunOptions {
  /** Kill the whole process tree after this long. Default 10 minutes. */
  timeoutMs?: number;
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

function testEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Inherited from a hook or parent git, these would point git inside the test at another repo.
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[key];
  return env;
}

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
      child = spawn(command, { cwd, env: testEnv(), shell: true, windowsHide: true, detached: !isWindows, stdio: ["ignore", "pipe", "pipe"] });
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
