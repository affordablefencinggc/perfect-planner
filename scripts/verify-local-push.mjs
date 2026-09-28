import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const limits = Object.freeze({ inputBytes: 64_000, inputMs: 10_000, gitMs: 10_000, outputBytes: 4_000_000, secretMs: 90_000, checkMs: 600_000 });
const approvedCommands = Object.freeze(["npm run build", "npm test", "npm run test:ui"]);
const approvalBytes = 64_000;
const failure = (reason) => { throw new Error(reason); };
const cleanEnvironment = () => {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" };
  if (process.platform === "win32") {
    env.SystemRoot = "C:\\Windows";
    env.windir = "C:\\Windows";
  }
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"]) delete env[key];
  return env;
};

export function runBoundedCommand(command, args, { root, input = "", timeoutMs, maxBytes = limits.outputBytes }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, env: cleanEnvironment(), shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    const stdoutHash = createHash("sha256"), stderrHash = createHash("sha256");
    let bytes = 0, reason = null, done = false;
    const chunks = [];
    let fallback;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer); clearTimeout(fallback);
      const stdoutDigest = stdoutHash.digest("hex"), stderrDigest = stderrHash.digest("hex");
      resolve({ code, reason, outputBytes: bytes, outputComplete: reason === null, outputHash: sha(JSON.stringify({ stdoutDigest, stderrDigest })), stdout: Buffer.concat(chunks).toString("utf8") });
    };
    const stop = (why) => {
      if (reason) return;
      reason = why;
      if (process.platform === "win32" && child.pid) {
        // Do not resolve this security boundary through PATH or attacker-controlled
        // SystemRoot. taskkill /T is the only generally available Windows tree kill.
        const taskkill = spawnSync("C:\\Windows\\System32\\taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore", timeout: 5_000 });
        if (taskkill.error || taskkill.status !== 0) {
          try { child.kill("SIGKILL"); } catch {}
        }
      } else if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
      fallback = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(null); }, 1_000);
    };
    const timer = setTimeout(() => stop("command-time-limit"), timeoutMs);
    const collect = (chunk, stdout) => {
      if (done || reason) return;
      bytes += chunk.length;
      if (bytes > maxBytes) { stop("command-output-limit"); return; }
      (stdout ? stdoutHash : stderrHash).update(chunk);
      if (stdout) chunks.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(chunk, true));
    child.stderr.on("data", (chunk) => collect(chunk, false));
    child.on("error", () => { reason = "command-unavailable"; finish(null); });
    child.on("close", finish);
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function hashFile(file) { return sha(await readFile(file)); }

export async function inspectLocalPushCommandContract(root = process.cwd()) {
  root = await realpath(root);
  const packagePath = path.join(root, "package.json");
  const packageInfo = await lstat(packagePath);
  if (!packageInfo.isFile() || packageInfo.isSymbolicLink()) failure("package-manifest-not-regular");
  const lockfiles = [];
  for (const name of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]) {
    const file = path.join(root, name);
    const info = await lstat(file).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink()) failure("dependency-lock-not-regular");
    lockfiles.push({ name, sha256: await hashFile(file) });
  }
  if (!lockfiles.length) failure("dependency-lock-required");
  const runnerSha256 = await hashFile(fileURLToPath(import.meta.url));
  const body = { schemaVersion: 1, kind: "perfect-planner-local-push-command-contract", repository: sha(root.toLowerCase()), packageJsonSha256: await hashFile(packagePath), lockfiles, runnerSha256, commands: [...approvedCommands] };
  return { ...body, contractDigest: sha(JSON.stringify(body)) };
}

async function requireCommandApproval(root, approvalPath) {
  if (!approvalPath || !path.isAbsolute(approvalPath)) failure("external-command-approval-required");
  const canonical = await realpath(approvalPath).catch(() => failure("external-command-approval-required"));
  const relative = path.relative(root, canonical);
  if (!relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) failure("command-approval-inside-project-refused");
  const info = await lstat(canonical);
  if (!info.isFile() || info.isSymbolicLink() || info.size > approvalBytes) failure("command-approval-not-regular-or-bounded");
  const handle = await open(canonical, "r");
  let raw;
  try {
    const before = await handle.stat();
    raw = await handle.readFile("utf8");
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) failure("command-approval-changed-during-read");
  } finally { await handle.close(); }
  let approval;
  try { approval = JSON.parse(raw); } catch { failure("command-approval-invalid"); }
  const keys = Object.keys(approval ?? {}).sort().join(",");
  if (keys !== "approvedAt,approvedBy,contractDigest,kind,schemaVersion" || approval.schemaVersion !== 1 || approval.kind !== "perfect-planner-local-push-command-approval" || typeof approval.approvedBy !== "string" || !approval.approvedBy.trim() || !Number.isFinite(Date.parse(approval.approvedAt)) || !/^[a-f0-9]{64}$/.test(approval.contractDigest)) failure("command-approval-invalid");
  const contract = await inspectLocalPushCommandContract(root);
  if (approval.contractDigest !== contract.contractDigest) failure("command-approval-drift");
  return { contractDigest: contract.contractDigest, approvedBy: approval.approvedBy, approvedAt: approval.approvedAt };
}

async function trustedNpmCli(input, root) {
  if (!input || !path.isAbsolute(input) || path.basename(input) !== "npm-cli.js") failure("npm-cli-unavailable-run-through-npm");
  const info = await lstat(input);
  if (!info.isFile() || info.isSymbolicLink()) failure("npm-cli-not-regular");
  const canonical = await realpath(input);
  const relative = path.relative(root, canonical);
  if (!relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) failure("npm-cli-inside-project-refused");
  const metadata = JSON.parse(await readFile(path.resolve(canonical, "../../package.json"), "utf8"));
  if (metadata.name !== "npm") failure("npm-cli-package-invalid");
  return canonical;
}

export async function verifyLocalPush({ root = process.cwd(), input, npmCliPath = process.env.npm_execpath, commandApprovalPath = process.env.PERFECT_PLANNER_PUSH_APPROVAL } = {}) {
  const receipt = { schemaVersion: 1, kind: "perfect-planner-local-push-proof", state: "blocked", head: null, refsDigest: null, checks: [], reason: null, secretsReturned: false, malwareVerdict: "not-assessed", productionVerdict: "not-assessed", limits,
    limitations: ["Local checks do not prove malware absence, remote CI success, merge, or production deployment.", "Clean-tree checks cover tracked and untracked files; ignored dependencies and build outputs are outside Git status.", "Checks attest the current checkout between commands; this is not an isolated or tamper-proof execution environment."] };
  try {
    root = await realpath(root);
    if (typeof input !== "string" || Buffer.byteLength(input) > limits.inputBytes) failure("push-input-invalid-or-exceeds-bound");
    receipt.refsDigest = sha(input);
    const git = (args) => {
      const result = spawnSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], { cwd: root, env: cleanEnvironment(), shell: false, windowsHide: true, encoding: "utf8", timeout: limits.gitMs, maxBuffer: limits.outputBytes });
      if (result.error || result.status !== 0) failure("git-read-failed-or-exceeded-bound");
      return result.stdout.trim();
    };
    if (path.relative(root, await realpath(git(["rev-parse", "--show-toplevel"]))) !== "") failure("run-from-repository-root");
    const head = git(["rev-parse", "--verify", "HEAD^{commit}"]);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) failure("head-invalid");
    receipt.head = head;
    const lines = input.trim().split(/\r?\n/).filter(Boolean);
    if (!lines.length) failure("push-refs-required");
    let proposed = 0;
    for (const line of lines) {
      const match = /^(\S+) ([a-f0-9]{40}|[a-f0-9]{64}) (\S+) ([a-f0-9]{40}|[a-f0-9]{64})$/.exec(line);
      if (!match) failure("invalid-push-refs");
      if (/^0+$/.test(match[2])) continue;
      const proposedCommit = git(["rev-parse", "--verify", match[2] + "^{commit}"]);
      if (proposedCommit !== head) failure("proposed-ref-does-not-resolve-to-head");
      proposed++;
    }
    const assertClean = () => {
      if (git(["rev-parse", "--verify", "HEAD^{commit}"]) !== head) failure("head-changed-during-proof");
      if (git(["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"])) failure("checkout-is-dirty");
    };
    assertClean();
    if (!proposed) { receipt.state = "not-applicable"; receipt.reason = "deletion-only-no-local-build-proof"; return receipt; }
    receipt.commandApproval = await requireCommandApproval(root, commandApprovalPath);
    const npmCli = await trustedNpmCli(npmCliPath, root);
    const checks = [
      { name: "outgoing-secrets", args: [path.join(scriptRoot, "verify-secrets.mjs"), "--push"], input, timeoutMs: limits.secretMs },
      { name: "build", args: [npmCli, "run", "build"], timeoutMs: limits.checkMs },
      { name: "tests", args: [npmCli, "test"], timeoutMs: limits.checkMs },
      { name: "ui-tests", args: [npmCli, "run", "test:ui"], timeoutMs: limits.checkMs },
    ];
    for (const check of checks) {
      assertClean();
      const result = await runBoundedCommand(process.execPath, check.args, { root, input: check.input, timeoutMs: check.timeoutMs });
      receipt.checks.push({ name: check.name, state: result.code === 0 && !result.reason ? "passed" : "blocked", exitCode: result.code, outputBytes: result.outputBytes, outputComplete: result.outputComplete, outputHash: result.outputHash, reason: result.reason });
      assertClean();
      if (result.reason || result.code !== 0) failure(result.reason ?? `${check.name}-failed`);
      if (check.name === "outgoing-secrets") {
        const scan = JSON.parse(result.stdout);
        if (scan.mode !== "push" || scan.state !== "passed" || scan.findingCount !== 0 || scan.coverageIssues?.length !== 0 || scan.secretsReturned !== false) failure("secret-scan-proof-invalid");
      }
    }
    assertClean();
    receipt.state = "passed";
  } catch (error) {
    receipt.reason = /^[a-z][a-z0-9-]+$/.test(error.message) ? error.message : "local-proof-unavailable";
  }
  return receipt;
}

async function readPushInput() {
  return new Promise((resolve, reject) => {
    const chunks = []; let bytes = 0;
    const timer = setTimeout(() => { process.stdin.destroy(); reject(new Error("push-input-time-limit")); }, limits.inputMs);
    process.stdin.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > limits.inputBytes) { clearTimeout(timer); process.stdin.destroy(); reject(new Error("push-input-limit")); }
      else chunks.push(chunk);
    });
    process.stdin.on("end", () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString("utf8")); });
    process.stdin.on("error", () => { clearTimeout(timer); reject(new Error("push-input-read-failed")); });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result;
  try { result = await verifyLocalPush({ input: await readPushInput() }); }
  catch (error) { result = { schemaVersion: 1, kind: "perfect-planner-local-push-proof", state: "blocked", reason: error.message, secretsReturned: false }; }
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exitCode = result.state === "passed" || result.state === "not-applicable" ? 0 : 1;
}
