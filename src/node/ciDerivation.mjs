import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const WORKFLOW_EXTENSIONS = new Set([".yml", ".yaml"]);
const SAFE_COMMANDS = new Set(["node", "npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd"]);
const SHELL_SYNTAX = /(?:&&|\|\||[|><`;]|\$\(|\r|\n)/;
const REF_PATTERN = /^(?!-)(?!.*\.\.)(?!.*@\{)[A-Za-z0-9._/-]+$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/i;
const requestHash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// A release run records every gate it executes against one exact workspace revision. Only that
// recorded, digest-consistent, revision-bound evidence can turn Tier 3 green; flags never can.
export const RELEASE_EVIDENCE_KIND = "perfect-planner-release-evidence";
export const RELEASE_APPROVAL_KIND = "perfect-planner-release-approval";
// Gates that must have passed (in this run, on this revision) before the release build may claim GO.
export const RELEASE_PROFILES = Object.freeze({
  web: Object.freeze(["verify:secrets", "test", "test:ui", "test:sites"]),
  release: Object.freeze(["verify:secrets", "test", "test:ui", "verify:mcp", "test:sites", "test:native"]),
});
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
export const releaseRecordDigest = (record) => { const { digest, ...payload } = record ?? {}; return createHash("sha256").update(canonical(payload)).digest("hex"); };
const sameRevision = (left, right) => Boolean(left && right && SHA_PATTERN.test(String(left.head ?? "")) && /^[a-f0-9]{64}$/.test(String(left.treeDigest ?? "")) && left.head === right.head && left.treeDigest === right.treeDigest);

// Exact workspace identity: HEAD plus a digest of every tracked change and every untracked, non-ignored file.
export function computeWorkspaceRevision(root, options = {}) {
  const run = (args, maxBuffer = 64_000_000) => { const result = spawnSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], { cwd: root, shell: false, windowsHide: true, timeout: options.timeoutMs ?? 30_000, maxBuffer }); if (result.error || result.status !== 0) throw new Error("git-read-failed"); return result.stdout; };
  try {
    const head = run(["rev-parse", "--verify", "HEAD^{commit}"]).toString("utf8").trim();
    const digest = createHash("sha256").update(`head:${head}\n`).update(run(["diff", "HEAD", "--binary", "--no-ext-diff", "--no-color"]));
    const untracked = run(["ls-files", "--others", "--exclude-standard", "-z"]).toString("utf8").split("\0").filter(Boolean).sort();
    if (untracked.length > 20_000) throw new Error("untracked-limit");
    for (const file of untracked) { const blob = run(["hash-object", "--no-filters", "--", file]).toString("utf8").trim(); digest.update(`untracked:${file}:${blob}\n`); }
    return { head, treeDigest: digest.digest("hex"), untrackedCount: untracked.length };
  } catch { return null; }
}

export function assessReleaseEvidence(evidence, { revision, requiredSteps } = {}) {
  const reasons = [];
  const required = [...(requiredSteps ?? RELEASE_PROFILES[evidence?.profile] ?? [])];
  if (!evidence || evidence.schemaVersion !== 1 || evidence.kind !== RELEASE_EVIDENCE_KIND || !Array.isArray(evidence.steps) || !(evidence.profile in RELEASE_PROFILES)) return { valid: false, failed: false, profile: null, passed: [], missing: required, reasons: ["release evidence is absent or malformed"] };
  if (evidence.digest !== releaseRecordDigest(evidence)) reasons.push("release evidence digest does not match its content");
  if (!sameRevision(evidence.revision, revision)) reasons.push("release evidence was recorded for a different workspace revision");
  if (!required.length || RELEASE_PROFILES[evidence.profile].some((step) => !required.includes(step))) reasons.push("release evidence profile does not cover the required gates");
  const steps = evidence.steps.filter((step) => step && typeof step.name === "string" && Number.isSafeInteger(step.exitCode));
  const failedSteps = steps.filter((step) => step.exitCode !== 0).map((step) => step.name);
  const passed = required.filter((name) => steps.some((step) => step.name === name && step.exitCode === 0));
  const missing = required.filter((name) => !passed.includes(name));
  if (failedSteps.length) reasons.push(`release gate(s) failed: ${failedSteps.join(", ")}`);
  if (missing.length) reasons.push(`release gate(s) not recorded as passed: ${missing.join(", ")}`);
  return { valid: reasons.length === 0, failed: failedSteps.length > 0 && sameRevision(evidence.revision, revision), profile: evidence.profile, runId: evidence.runId ?? null, passed, missing, reasons };
}

export function assessReleaseApproval(approval, { revision } = {}) {
  if (!approval || approval.schemaVersion !== 1 || approval.kind !== RELEASE_APPROVAL_KIND || !String(approval.approvedBy ?? "").trim() || !Number.isFinite(Date.parse(approval.approvedAt))) return { valid: false, reason: "human release approval is absent or malformed" };
  if (approval.digest !== releaseRecordDigest(approval)) return { valid: false, reason: "human release approval digest does not match its content" };
  if (!sameRevision(approval.revision, revision)) return { valid: false, reason: "human release approval names a different workspace revision" };
  return { valid: true, approvedBy: String(approval.approvedBy), approvedAt: approval.approvedAt };
}

export function assessCiTier3(localMergedState, remoteCiStatus, release = null) {
  // Matching input commits alone do not identify the tested tree, so caller-supplied green flags
  // never promote. Green requires release evidence recorded by the gate runner for the exact
  // workspace revision (HEAD + full working-tree digest) with every required gate passing.
  if (localMergedState?.state === "red" || remoteCiStatus?.state === "red") return { exactMergedTruth: false, ciTier3: "red" };
  if (!release) return { exactMergedTruth: false, ciTier3: "grey" };
  const assessed = assessReleaseEvidence(release.evidence, release);
  return assessed.valid ? { exactMergedTruth: true, ciTier3: "green" } : { exactMergedTruth: false, ciTier3: assessed.failed ? "red" : "grey" };
}

function indentation(line) { return line.match(/^\s*/)[0].replace(/\t/g, "  ").length; }
function scalar(value = "") { return value.trim().replace(/^['"]|['"]$/g, ""); }
function tokenize(command) {
  const tokens = [];
  let current = "";
  let quote = null;
  for (const character of command.trim()) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
    } else if (character === "'" || character === '"') quote = character;
    else if (/\s/.test(character)) { if (current) { tokens.push(current); current = ""; } }
    else current += character;
  }
  if (quote) throw new Error("unterminated quote");
  if (current) tokens.push(current);
  return tokens;
}

function parseWorkflow(text, relativePath) {
  const lines = text.split(/\r?\n/);
  const workflow = { path: relativePath, name: path.basename(relativePath), pullRequest: false, jobs: [], warnings: [] };
  let jobsIndent = null;
  let triggersIndent = null;
  let currentJob = null;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const clean = raw.replace(/\s+#.*$/, "");
    const trimmed = clean.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const level = indentation(clean);
    const triggerRoot = trimmed.match(/^(?:on|['"]on['"]):\s*(.*)$/);
    if (level === 0 && triggerRoot) {
      triggersIndent = triggerRoot[1] ? null : level;
      if (/(?:^|[\[,\s])pull_request(?:[\],\s]|$)/.test(triggerRoot[1])) workflow.pullRequest = true;
    } else if (triggersIndent !== null && level > triggersIndent && /^pull_request:\s*/.test(trimmed)) workflow.pullRequest = true;
    if (triggersIndent !== null && level <= triggersIndent && !triggerRoot) triggersIndent = null;
    if (jobsIndent === null && /^jobs:\s*$/.test(trimmed)) { jobsIndent = level; continue; }
    if (jobsIndent === null || level <= jobsIndent) continue;
    const jobMatch = clean.match(/^(\s*)([A-Za-z0-9_-]+):\s*$/);
    if (jobMatch && level === jobsIndent + 2) {
      currentJob = { id: jobMatch[2], name: jobMatch[2], continueOnError: false, condition: null, commands: [], uses: [], unsupported: [] };
      workflow.jobs.push(currentJob);
      continue;
    }
    if (!currentJob) continue;
    const property = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (property && level === jobsIndent + 4) {
      if (property[1] === "name") currentJob.name = scalar(property[2]);
      if (property[1] === "continue-on-error") currentJob.continueOnError = scalar(property[2]) === "true";
      if (property[1] === "if") currentJob.condition = scalar(property[2]);
    }
    const run = trimmed.match(/^-\s+run:\s*(.*)$/) ?? trimmed.match(/^run:\s*(.*)$/);
    if (run) {
      const command = scalar(run[1]);
      if (!command || command === "|" || command === ">") currentJob.unsupported.push(`multiline run at line ${index + 1}`);
      else if (SHELL_SYNTAX.test(command)) currentJob.unsupported.push(`shell composition at line ${index + 1}`);
      else {
        try {
          const [executable, ...args] = tokenize(command);
          const basename = path.basename(executable ?? "").toLowerCase();
          if (!SAFE_COMMANDS.has(basename)) currentJob.unsupported.push(`unapproved executable ${executable || "empty"} at line ${index + 1}`);
          else currentJob.commands.push({ executable, args, sourceLine: index + 1 });
        } catch (error) { currentJob.unsupported.push(`${error.message} at line ${index + 1}`); }
      }
    }
    const uses = trimmed.match(/^-\s+uses:\s*(.*)$/) ?? trimmed.match(/^uses:\s*(.*)$/);
    if (uses) currentJob.uses.push(scalar(uses[1]));
  }
  if (!workflow.jobs.length) workflow.warnings.push("no jobs parsed");
  return workflow;
}

export async function deriveCiPlan(repositoryRoot, options = {}) {
  const root = await realpath(repositoryRoot);
  const workflowDirectory = path.join(root, ".github", "workflows");
  const maxFiles = Number(options.maxFiles ?? 32);
  const maxBytes = Number(options.maxBytes ?? 512 * 1024);
  let names;
  try { names = (await readdir(workflowDirectory)).sort(); }
  catch (error) {
    if (error.code === "ENOENT") return { schemaVersion: 1, state: "grey", reason: "no workflow directory", workflows: [], gates: [] };
    throw error;
  }
  if (names.length > maxFiles) throw new Error(`Workflow census refused: ${names.length} files exceeds limit ${maxFiles}.`);
  const workflows = [];
  for (const name of names) {
    if (!WORKFLOW_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
    const workflowPath = path.join(workflowDirectory, name);
    const stats = await lstat(workflowPath);
    if (stats.isSymbolicLink()) throw new Error(`Workflow census refused symbolic link: ${name}`);
    if (!stats.isFile()) continue;
    if (stats.size > maxBytes) throw new Error(`Workflow census refused oversized file: ${name}`);
    workflows.push(parseWorkflow(await readFile(workflowPath, "utf8"), path.posix.join(".github", "workflows", name)));
  }
  const pullRequestWorkflows = workflows.filter((workflow) => workflow.pullRequest);
  const gates = pullRequestWorkflows.flatMap((workflow) => workflow.jobs
    .filter((job) => !job.continueOnError)
    .map((job) => ({ workflow: workflow.path, job: job.id, name: job.name, condition: job.condition, commands: job.commands, uses: job.uses, supported: job.commands.length > 0 && job.unsupported.length === 0, warnings: job.unsupported })));
  if (!pullRequestWorkflows.length) return { schemaVersion: 1, state: "grey", reason: "no pull_request workflow", workflows, gates: [] };
  if (!gates.length) return { schemaVersion: 1, state: "grey", reason: "no blocking jobs derivable", workflows, gates: [] };
  if (gates.some((gate) => !gate.supported)) return { schemaVersion: 1, state: "grey", reason: "one or more blocking jobs cannot be reproduced without shell semantics", workflows, gates };
  return { schemaVersion: 1, state: "derived", reason: "local candidates derived; required-status and merged-state execution remain unverified", workflows, gates };
}

export async function fetchRemoteCiStatus(request, boundary = {}) {
  const provider = (boundary.providers ?? []).find((item) => item.id === request?.providerId);
  if (!provider) throw new Error("Remote CI request names an unapproved provider.");
  const origin = new URL(provider.origin);
  if (origin.protocol !== "https:" || origin.origin !== provider.origin || origin.username || origin.password) throw new Error("Remote CI provider requires one exact credential-free HTTPS origin.");
  const statusUrl = new URL(provider.statusPath ?? "/ci/status", origin);
  if (statusUrl.origin !== origin.origin) throw new Error("Remote CI status path cannot leave the approved provider origin.");
  for (const [name, value] of [["targetRef", request?.targetRef], ["sourceRef", request?.sourceRef]]) if (!REF_PATTERN.test(String(value ?? ""))) throw new Error(`Remote CI ${name} is not a safe exact ref.`);
  for (const [name, value] of [["targetSha", request?.targetSha], ["sourceSha", request?.sourceSha]]) if (!SHA_PATTERN.test(String(value ?? ""))) throw new Error(`Remote CI ${name} requires an exact 40-character commit SHA.`);
  const checkNames = request?.checkNames ?? [];
  if (!checkNames.length || new Set(checkNames).size !== checkNames.length || checkNames.some((name) => !/^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,127}$/.test(name))) throw new Error("Remote CI requires unique bounded check identities.");
  if (!String(request?.credentialHandle ?? "").startsWith("secret://")) throw new Error("Remote CI credentials require an opaque secret handle.");
  if (typeof boundary.resolveCredential !== "function" || typeof boundary.fetchImpl !== "function") throw new Error("Remote CI requires injected credential and transport boundaries.");
  const body = { schemaVersion: 1, providerId: provider.id, repository: String(request.repository ?? ""), targetRef: request.targetRef, sourceRef: request.sourceRef, targetSha: request.targetSha.toLowerCase(), sourceSha: request.sourceSha.toLowerCase(), checkNames };
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(body.repository)) throw new Error("Remote CI requires an exact bounded repository identity.");
  const credential = await boundary.resolveCredential({ handle: request.credentialHandle, providerId: provider.id, origin: provider.origin });
  if (!String(credential ?? "")) throw new Error("Remote CI credential resolution failed.");
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), Number(boundary.timeoutMs ?? 5000));
  let response;
  try { response = await boundary.fetchImpl(statusUrl.href, { method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization: `Bearer ${credential}` }, body: JSON.stringify(body), signal: controller.signal }); }
  finally { clearTimeout(timeout); }
  if (!response?.ok) throw new Error(`Remote CI provider returned HTTP ${response?.status ?? "unknown"}.`);
  if (response.url && response.url !== statusUrl.href) throw new Error("Remote CI transport left the exact approved status URL.");
  const maxResponseBytes = Number(boundary.maxResponseBytes ?? 256_000);
  const declaredBytes = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxResponseBytes) throw new Error("Remote CI response exceeds its byte limit.");
  const text = await response.text(); if (Buffer.byteLength(text) > maxResponseBytes) throw new Error("Remote CI response exceeds its byte limit.");
  const value = JSON.parse(text);
  for (const key of ["providerId", "repository", "targetRef", "sourceRef", "targetSha", "sourceSha"]) if (value?.[key] !== body[key]) throw new Error(`Remote CI response identity mismatch: ${key}.`);
  if (!Array.isArray(value.checks) || value.checks.length !== checkNames.length || new Set(value.checks.map((item) => item.name)).size !== checkNames.length) throw new Error("Remote CI response check identities are incomplete or duplicated.");
  const byName = new Map(value.checks.map((item) => [item.name, item]));
  for (const name of checkNames) { const check = byName.get(name); if (!check || !["success", "failure", "pending"].includes(check.state)) throw new Error(`Remote CI response is missing a valid exact check: ${name}.`); }
  const checks = checkNames.map((name) => ({ name, state: byName.get(name).state, url: byName.get(name).url ?? null }));
  const state = checks.some((item) => item.state === "failure") ? "red" : checks.every((item) => item.state === "success") ? "green" : "grey";
  return { schemaVersion: 1, state, providerId: provider.id, repository: body.repository, targetRef: body.targetRef, sourceRef: body.sourceRef, targetSha: body.targetSha, sourceSha: body.sourceSha, checks, requestHash: requestHash(body), credential: "REDACTED" };
}
