// Bounded, shell-free test-command runner.
// - keeps only the LAST `maxTailBytes` of combined stdout+stderr (default 64 KiB)
//   while hashing the full stream (sha256), so a noisy test never grows memory;
// - on timeout kills the whole process tree: Windows `taskkill /T /F /PID`,
//   POSIX SIGKILL to the child's own process group (spawned detached);
// - never runs through a shell (see command.mjs for resolution rules).
// src/node/guardedGitRunner.mjs#runBoundedProcess was considered: it keeps the
// FIRST bytes and kills the process on output overflow, caps timeouts at 120s,
// and compiles a PowerShell job-object helper per run, which does not fit a
// test runner that must keep the tail and let long suites finish.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { resolveCommand } from "./command.mjs";

export const DEFAULT_TAIL_BYTES = 64 * 1024;
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|AUTH)/i;

/** Copy of env without secret-looking variables; test code is agent-written and never receives keys. */
export function scrubEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => typeof value === "string" && !SECRET_ENV.test(key)));
}

function taskkillPath(env) {
  const root = Object.entries(env).find(([key]) => key.toUpperCase() === "SYSTEMROOT")?.[1] || process.env.SystemRoot || "C:\\Windows";
  return path.join(root, "System32", "taskkill.exe");
}

/** Kill a process and all its descendants. Resolves when the kill attempt has settled. */
export function killProcessTree(pid, { platform = process.platform, env = process.env } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(false);
  if (platform === "win32") {
    return new Promise((resolve) => {
      let killer;
      try { killer = spawn(taskkillPath(env), ["/T", "/F", "/PID", String(pid)], { windowsHide: true, stdio: "ignore", shell: false }); }
      catch { try { process.kill(pid, "SIGKILL"); } catch {} resolve(false); return; }
      killer.once("error", () => { try { process.kill(pid, "SIGKILL"); } catch {} resolve(false); });
      killer.once("close", (code) => resolve(code === 0));
    });
  }
  try { process.kill(-pid, "SIGKILL"); return Promise.resolve(true); }
  catch (error) {
    if (error.code === "ESRCH") return Promise.resolve(false);
    try { process.kill(pid, "SIGKILL"); } catch {}
    return Promise.resolve(false);
  }
}

class TailBuffer {
  constructor(limit) { this.limit = limit; this.chunks = []; this.size = 0; this.total = 0; this.hash = createHash("sha256"); }
  push(chunk) {
    this.hash.update(chunk); this.total += chunk.length;
    this.chunks.push(chunk); this.size += chunk.length;
    while (this.chunks.length > 1 && this.size - this.chunks[0].length >= this.limit) this.size -= this.chunks.shift().length;
  }
  result() {
    const all = Buffer.concat(this.chunks);
    const tail = all.length > this.limit ? all.subarray(all.length - this.limit) : all;
    return { outputTail: tail.toString("utf8"), outputBytes: this.total, outputSha256: this.hash.digest("hex"), truncated: this.total > tail.length };
  }
}

/**
 * Run argv in cwd. Resolves (never rejects for process failures) with
 * { exitCode, signal, timedOut, durationMs, outputTail, outputBytes, outputSha256, truncated, error, cleanupComplete, resolved }.
 */
export function runTestCommand(argv, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, maxTailBytes = DEFAULT_TAIL_BYTES, env, platform = process.platform, now = () => Date.now() } = {}) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return Promise.reject(Object.assign(new Error("cwd must be an absolute path"), { code: "TEST_CWD_INVALID" }));
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) return Promise.reject(Object.assign(new Error("timeoutMs out of range"), { code: "TEST_TIMEOUT_INVALID" }));
  if (!Number.isInteger(maxTailBytes) || maxTailBytes < 1) return Promise.reject(Object.assign(new Error("maxTailBytes out of range"), { code: "TEST_OUTPUT_LIMIT_INVALID" }));
  const childEnv = env ?? scrubEnvironment(process.env);
  const started = now();
  let plan;
  try { plan = resolveCommand(argv, { cwd, env: childEnv, platform }); }
  catch (error) {
    return Promise.resolve({ exitCode: null, signal: null, timedOut: false, durationMs: 0, outputTail: "", outputBytes: 0, outputSha256: createHash("sha256").digest("hex"), truncated: false, error: error.code || "TEST_COMMAND_INVALID", errorMessage: error.message, cleanupComplete: true, resolved: null });
  }
  return new Promise((resolve) => {
    const tail = new TailBuffer(maxTailBytes);
    let child, timedOut = false, settled = false, spawnError = null, timer, grace;
    const finish = (exitCode, signal, cleanupComplete = true) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(grace);
      resolve({ exitCode: timedOut || spawnError ? null : exitCode, signal: signal ?? null, timedOut, durationMs: Math.max(0, now() - started), ...tail.result(), error: spawnError, cleanupComplete, resolved: { file: plan.file, args: plan.args, via: plan.via } });
    };
    try {
      child = spawn(plan.file, plan.args, { cwd, env: childEnv, shell: false, windowsHide: true, windowsVerbatimArguments: plan.windowsVerbatimArguments, detached: platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) { spawnError = error.code || "TEST_SPAWN_FAILED"; finish(null, null); return; }
    child.stdout.on("data", (chunk) => tail.push(chunk));
    child.stderr.on("data", (chunk) => tail.push(chunk));
    const forceClose = (cleanupComplete) => { child.stdout.destroy(); child.stderr.destroy(); finish(child.exitCode, child.signalCode, cleanupComplete); };
    timer = setTimeout(async () => {
      timedOut = true;
      await killProcessTree(child.pid, { platform, env: childEnv });
      // If pipes are still held open after the tree kill, stop waiting.
      grace = setTimeout(() => forceClose(false), 3_000);
    }, timeoutMs);
    child.once("error", (error) => { spawnError = error.code || "TEST_SPAWN_FAILED"; if (!child.pid) finish(null, null); });
    child.once("exit", () => {
      // POSIX: reap stragglers left in the group (background servers etc.).
      if (platform !== "win32") killProcessTree(child.pid, { platform });
      // Windows: a detached grandchild can keep the pipes open; do not hang on it.
      else if (!timedOut) grace = setTimeout(() => forceClose(false), 2_000);
    });
    child.once("close", (code, signal) => finish(code, signal));
  });
}
