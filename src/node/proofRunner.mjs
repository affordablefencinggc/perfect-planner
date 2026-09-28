import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { appendJournalEvent } from "./journalStore.mjs";
import { bindTaskAttemptToLedger } from "./taskOutcomeBinding.mjs";
import { parseTaskCheckResult } from "./taskOutcomeContract.mjs";
import {readProofArtifactDigest} from './proofArtifactRead.mjs';

const forbiddenShells = new Set(["cmd", "powershell", "pwsh", "bash", "sh", "zsh", "fish"]);
const destructiveGit = new Set(["add", "commit", "push", "reset", "clean", "checkout", "switch", "merge", "rebase", "cherry-pick", "revert", "tag", "branch", "worktree"]);
const packageManagers = new Set(["npm", "npx", "pnpm", "yarn", "bun"]);
const DEFAULT_STDOUT_BYTES = 1024 * 1024;
const DEFAULT_STDERR_BYTES = 1024 * 1024;
const DEFAULT_COMBINED_OUTPUT_BYTES = 2 * 1024 * 1024;
export const SAFE_PRODUCTION_PROOF_PROFILE = Object.freeze({ id: "bounded-production-v1", maxMemoryBytes: 512 * 1024 * 1024, maxCpuTimeMs: 120_000, maxProcesses: 16, shell: false, mechanisms: Object.freeze({ win32: ["job-object"], linux: ["cgroup-v2", "rlimit"], darwin: ["sandbox-exec", "rlimit"] }) });

function executableName(command) { return path.basename(command).toLowerCase().replace(/\.(exe|cmd|bat)$/i, ""); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function isWithin(root, candidate) { const relative = path.relative(root, candidate); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }

function validateCommand(command, args, policy) {
  if (!command || typeof command !== "string") throw new Error("Proof command must be one executable path or name.");
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Error("Proof command arguments must be a string array.");
  const name = executableName(command);
  if (forbiddenShells.has(name)) throw new Error(`Shell executable ${name} is forbidden; proof commands run without a shell.`);
  const allowed = new Set((policy.allowedExecutables ?? []).map(executableName));
  if (!allowed.has(name)) throw new Error(`Executable ${name} is not approved by this proof policy.`);
  if (name === "node" && args.some((arg) => ["-e", "--eval", "-p", "--print"].includes(arg))) throw new Error("Inline Node evaluation is forbidden; point to a reviewed script file.");
  if (name === "git" && destructiveGit.has(String(args[0] ?? "").toLowerCase())) throw new Error(`Destructive Git subcommand ${args[0]} is forbidden in proof mode.`);
  if (packageManagers.has(name) && policy.allowPackageScripts !== true) throw new Error(`${name} execution requires allowPackageScripts: true in the approved proof policy.`);
}

function safeEnvironment(extra = {}) {
  const base = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "COMSPEC", "HOME", "USERPROFILE"]) {
    if (process.env[key]) base[key] = process.env[key];
  }
  return { ...base, CI: "true", NO_COLOR: "1", ...extra };
}

function positiveByteLimit(value, fallback, name) {
  const limit = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error(`${name} must be a positive safe integer.`);
  return limit;
}

function outputLimits(policy) {
  return Object.freeze({
    stdoutBytes: positiveByteLimit(policy.maxStdoutBytes, DEFAULT_STDOUT_BYTES, "maxStdoutBytes"),
    stderrBytes: positiveByteLimit(policy.maxStderrBytes, DEFAULT_STDERR_BYTES, "maxStderrBytes"),
    combinedBytes: positiveByteLimit(policy.maxCombinedOutputBytes, DEFAULT_COMBINED_OUTPUT_BYTES, "maxCombinedOutputBytes"),
  });
}

async function runChild(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let settled = false;
    let stdoutObservedBytes = 0;
    let stderrObservedBytes = 0;
    let capturedBytes = 0;
    let outputOverflow = null;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs);
    const capture = (stream, destination, value) => {
      const chunk = Buffer.from(value);
      if (stream === "stdout") stdoutObservedBytes += chunk.length;
      else stderrObservedBytes += chunk.length;
      if (outputOverflow) return;
      const streamObserved = stream === "stdout" ? stdoutObservedBytes : stderrObservedBytes;
      const streamLimit = stream === "stdout" ? options.outputLimits.stdoutBytes : options.outputLimits.stderrBytes;
      const streamCapturedBefore = streamObserved - chunk.length;
      const streamRemaining = Math.max(0, streamLimit - streamCapturedBefore);
      const combinedRemaining = Math.max(0, options.outputLimits.combinedBytes - capturedBytes);
      const accepted = Math.min(chunk.length, streamRemaining, combinedRemaining);
      if (accepted > 0) { destination.push(chunk.subarray(0, accepted)); capturedBytes += accepted; }
      if (chunk.length > accepted) {
        const limit = streamRemaining <= combinedRemaining ? `${stream}Bytes` : "combinedBytes";
        outputOverflow = { stream, limit, observedBytes: streamObserved, capturedBytes, limits: options.outputLimits };
        child.kill();
      }
    };
    child.stdout.on("data", (chunk) => capture("stdout", stdout, chunk));
    child.stderr.on("data", (chunk) => capture("stderr", stderr, chunk));
    child.on("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.on("close", (exit, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exit, signal, timedOut, outputOverflow, output: { limits: options.outputLimits, stdoutObservedBytes, stderrObservedBytes, capturedBytes, truncated: Boolean(outputOverflow) }, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

function validateProductionIsolation(result, profile, limits) {
  const isolation = result?.isolation;
  const approvedMechanisms = profile.mechanisms[process.platform] ?? [];
  if (!isolation?.enforced || isolation.profileId !== profile.id || isolation.platform !== process.platform || isolation.shell !== false || !approvedMechanisms.includes(isolation.mechanism)) throw new Error(`Production proof isolation requires an enforced ${profile.id} adapter for ${process.platform}.`);
  for (const key of ["maxMemoryBytes", "maxCpuTimeMs", "maxProcesses"]) if (isolation.limits?.[key] !== profile[key]) throw new Error(`Production proof isolation did not enforce ${key}.`);
  if (typeof result.stdout !== "string" || typeof result.stderr !== "string" || typeof result.timedOut !== "boolean") throw new Error("Production proof isolation returned an invalid process result.");
  const stdoutBytes = Buffer.byteLength(result.stdout); const stderrBytes = Buffer.byteLength(result.stderr);
  if (stdoutBytes > limits.stdoutBytes || stderrBytes > limits.stderrBytes || stdoutBytes + stderrBytes > limits.combinedBytes) throw new Error("Production proof isolation returned output beyond the approved capture limits.");
  return Object.freeze({ ...isolation, limits: Object.freeze({ ...isolation.limits }) });
}

export async function runProof(options) {
  // Preserve the validated identity, destination and command across awaits.
  // Authority adapters remain trusted host capabilities, not wire data.
  options = { ...options,
    args: Array.isArray(options.args) ? [...options.args] : options.args,
    policy: options.policy ? { ...options.policy,
      allowedExecutables: Array.isArray(options.policy.allowedExecutables) ? [...options.policy.allowedExecutables] : options.policy.allowedExecutables,
      env: options.policy.env ? { ...options.policy.env } : undefined,
    } : undefined,
  };
  const taskFields = ['taskAttemptWire', 'taskLedgerWire', 'taskCheckId'];
  const hasTaskContext = taskFields.some(key => options[key] !== undefined);
  if (hasTaskContext && taskFields.some(key => typeof options[key] !== 'string')) throw new Error('TASK_OUTCOME_CONTEXT_INCOMPLETE');
  const taskContext = hasTaskContext
    ? bindTaskAttemptToLedger(options.taskAttemptWire, options.taskLedgerWire, options.taskCheckId)
    : null;
  if (taskContext && options.itemId !== taskContext.attempt.binding.taskId) throw new Error('TASK_OUTCOME_ITEM_MISMATCH');
  const policy = options.policy ?? {};
  const args = options.args ?? [];
  validateCommand(options.command, args, policy);
  const limits = outputLimits(policy);
  const allowedRoot = await realpath(path.resolve(options.allowedRoot));
  const cwd = await realpath(path.resolve(options.cwd));
  if (!isWithin(allowedRoot, cwd)) throw new Error("Proof cwd escapes the approved repository root.");
  const evidenceDirectory = path.resolve(options.evidenceDirectory);
  if (!isWithin(allowedRoot, evidenceDirectory)) throw new Error("Evidence directory escapes the approved repository root.");
  await mkdir(evidenceDirectory, { recursive: true });
  const startedAt = Date.now();
  const timeoutMs = Number(options.timeoutMs ?? 90_000); const environment = safeEnvironment(policy.env);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Proof timeout must be a positive safe integer.");
  const production = policy.executionProfile === "production-isolated";
  if (production && typeof options.isolationAdapter?.execute !== "function") throw new Error("Production proof requires an explicit OS isolation adapter.");
  // A durable intent precedes any child/adapter execution. An intent without a
  // terminal receipt is unresolved, never proof that work completed or stopped.
  const runId = randomUUID();
  const journalOptions = { actor: options.actor, session: options.session, timeoutMs: options.lockTimeoutMs ?? 5000 };
  await appendJournalEvent(options.journalPath, {
    action: "proof-admitted", payload: { runId, planId: String(options.planId), itemId: String(options.itemId), proven: false, taskContext },
  }, journalOptions);
  let failureStage = "execution";
  try {
  let result; let isolation;
  if (production) {
    if (typeof options.isolationAdapter?.execute !== "function") throw new Error("Production proof requires an explicit OS isolation adapter.");
    result = await options.isolationAdapter.execute({ command: options.command, args: [...args], cwd, env: environment, timeoutMs, outputLimits: limits, profile: SAFE_PRODUCTION_PROOF_PROFILE });
    failureStage = "isolation-validation";
    isolation = validateProductionIsolation(result, SAFE_PRODUCTION_PROOF_PROFILE, limits);
    result = { exit: result.exit, signal: result.signal ?? null, timedOut: result.timedOut, outputOverflow: result.outputOverflow ?? null, output: result.output ?? { limits, stdoutObservedBytes: Buffer.byteLength(result.stdout), stderrObservedBytes: Buffer.byteLength(result.stderr), capturedBytes: Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), truncated: false }, stdout: result.stdout, stderr: result.stderr };
  } else {
    result = await runChild(options.command, args, { cwd, env: environment, timeoutMs, outputLimits: limits });
    isolation = Object.freeze({ enforced: false, profileId: "local-bounded", platform: process.platform, shell: false, mechanism: null, limits: null });
  }
  const outputTruncated = Boolean(result.outputOverflow || result.output?.truncated);
  result.output = { ...result.output, truncated: outputTruncated };
  const durationMs = Date.now() - startedAt;
  failureStage = "artifact-persistence";
  const artifactName = `${String(options.planId).replace(/[^a-z0-9-]/gi, "-")}-${String(options.itemId).replace(/[^a-z0-9-]/gi, "-")}-${randomUUID().slice(0, 8)}.proof.json`;
  const artifactPath = path.join(evidenceDirectory, artifactName);
  const record = {
    schemaVersion: 1,
    runId,
    taskContext,
    planId: String(options.planId),
    itemId: String(options.itemId),
    command: { executable: options.command, args },
    cwd,
    startedAt: new Date(startedAt).toISOString(),
    durationMs,
    exit: result.exit,
    signal: result.signal,
    timedOut: result.timedOut,
    outputOverflow: result.outputOverflow,
    output: result.output,
    stdout: result.stdout,
    stderr: result.stderr,
    environment: { node: process.version, platform: process.platform, arch: process.arch }, isolation, productionReady: production,
  };
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  const artifactHash = sha256(bytes);
  // A terminal receipt must not outrun its evidence file. Keep a failed or
  // partial artifact for recovery; never overwrite it on a later attempt.
  // File sync alone does not establish parent-directory power-loss durability.
  const artifactHandle = await open(artifactPath, 'wx', 0o600);
  try { await artifactHandle.writeFile(bytes); await artifactHandle.sync(); }
  finally { await artifactHandle.close(); }
  const proven = result.exit === 0 && !result.timedOut && !outputTruncated;
  // A typed observation, not an authenticated task verdict. Neither the local
  // child path nor current adapter contract proves process-tree cleanup.
  const taskCheckResult = taskContext ? parseTaskCheckResult(JSON.stringify({
    schemaVersion: 1, kind: 'TASK_CHECK_RESULT',
    binding: taskContext.attempt.binding,
    attemptId: taskContext.attempt.attemptId, checkId: taskContext.checkId,
    producerId: taskContext.attempt.producerId, sessionId: taskContext.attempt.sessionId,
    exitCode: result.exit ?? null, timedOut: result.timedOut,
    outputTruncated,
    cleanup: 'unknown', artifactDigest: artifactHash,
  })) : null;
  failureStage = "terminal-receipt-persistence";
  const journalEntry = await appendJournalEvent(options.journalPath, {
    action: "prove",
    payload: { runId, taskContext, taskCheckResult, planId: record.planId, itemId: record.itemId, artifact: artifactName, sha256: artifactHash, exit: result.exit, timedOut: result.timedOut, outputOverflow: outputTruncated, outputLimit: result.outputOverflow?.limit ?? null, productionReady: record.productionReady, isolationProfile: isolation.profileId, proven },
  }, { actor: options.actor, session: options.session, timeoutMs: options.lockTimeoutMs ?? 5000 });
  return { proven, taskCheckResult, artifactName, artifactPath, sha256: artifactHash, journalEntry, ...record };
  } catch (error) {
    try {
      await appendJournalEvent(options.journalPath, { action: "proof-unresolved", payload: {
        runId, taskContext, planId: String(options.planId), itemId: String(options.itemId), proven: false,
        reason: "execution-or-persistence-error", cleanup: "unknown",
        failureStage, cause: "unknown", nextAction: "Inspect retained run evidence before retrying; process cleanup is unverified.",
      } }, journalOptions);
    } catch (persistenceError) {
      throw new AggregateError([error, persistenceError], "Proof failed and its terminal receipt could not be persisted; admitted run remains unresolved.");
    }
    throw error;
  }
}

export async function verifyProofArtifact(artifactPath, expectedHash) {
  return readProofArtifactDigest(artifactPath, expectedHash);
}
