#!/usr/bin/env node
// Runs a release gate chain and records each gate's real exit status, bound to the exact workspace
// revision, in .cache/release-evidence.json. The release build reads that evidence (see
// generate-truth-report.mjs) so the completion report can only reach GO when every required gate
// passed on the same revision in this run. A human approval for that revision is a separate input.
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RELEASE_APPROVAL_KIND, RELEASE_EVIDENCE_KIND, RELEASE_PROFILES, computeWorkspaceRevision, releaseRecordDigest } from "../src/node/ciDerivation.mjs";

export const RELEASE_EVIDENCE_FILE = path.join(".cache", "release-evidence.json");
export const RELEASE_APPROVAL_FILE = path.join(".cache", "release-approval.json");
// Verification that does not depend on dist runs first, so the build can bind its truth to it; the
// dist-dependent gates follow and the chain stops at the first failure.
export const RELEASE_CHAINS = Object.freeze({
  web: Object.freeze([...RELEASE_PROFILES.web, "build", "verify:performance", "verify:readiness"]),
  release: Object.freeze([...RELEASE_PROFILES.release, "build", "verify:performance", "tauri:build -- --no-bundle", "verify:readiness"]),
});

const sealed = (record) => ({ ...record, digest: releaseRecordDigest(record) });
async function writeAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, file);
}
const sameRevision = (left, right) => left?.head === right?.head && left?.treeDigest === right?.treeDigest;

const realOrNull = (file) => { try { return realpathSync.native(file); } catch { return null; } };
const inside = (root, file) => { const relative = path.relative(root, file); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); };
// npm's own entry script, run as `node npm-cli.js`, so neither a shell nor cmd.exe's current-folder
// search ever resolves "npm" (a planted npm.cmd in the repository would otherwise run). Prefers the
// npm that launched this script, then the npm installed beside this Node; never one inside the repo.
export function npmCliPath(root, env = process.env) {
  const roots = [path.resolve(root), realOrNull(root)].filter(Boolean);
  const nodeDir = path.dirname(process.execPath);
  for (const candidate of [env.npm_execpath, path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"), path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")]) {
    const resolved = candidate && existsSync(candidate) ? realOrNull(candidate) : null;
    if (resolved && path.basename(resolved) === "npm-cli.js" && !roots.some((dir) => inside(dir, path.resolve(candidate)) || inside(dir, resolved))) return resolved;
  }
  throw new Error("npm's entry script was not found beside Node or from the npm that started this run; release gates did not run.");
}
// Gate scripts themselves run under npm's script shell; on Windows this stops cmd.exe searching the
// repository folder first when one of them names a bare program.
const NO_CWD_SEARCH_ENV = "NoDefaultCurrentDirectoryInExePath";
export function runGateStep(root, step) {
  const cli = npmCliPath(root);
  return spawnSync(process.execPath, [cli, "run", ...step.split(" ")], { cwd: root, stdio: "inherit", shell: false, windowsHide: true, env: { ...process.env, [NO_CWD_SEARCH_ENV]: "1" } }).status ?? 1;
}

export async function runReleaseGates(root, profile, options = {}) {
  const chain = RELEASE_CHAINS[profile];
  if (!chain) throw new Error(`Unknown release profile: ${profile}.`);
  const revision = computeWorkspaceRevision(root);
  if (!revision) throw new Error("Release gates require a readable Git workspace revision.");
  const evidencePath = path.join(root, RELEASE_EVIDENCE_FILE);
  const evidence = { schemaVersion: 1, kind: RELEASE_EVIDENCE_KIND, runId: randomUUID(), profile, revision: { head: revision.head, treeDigest: revision.treeDigest }, startedAt: new Date().toISOString(), completedAt: null, steps: [] };
  await writeAtomic(evidencePath, sealed(evidence));
  const runStep = options.runStep ?? ((step) => runGateStep(root, step));
  let failed = null;
  for (const step of chain) {
    const started = Date.now();
    process.stdout.write(`\n[release:${profile}] ${step}\n`);
    let exitCode = runStep(step);
    const after = computeWorkspaceRevision(root);
    // A gate that passed against a workspace that changed underneath it proves nothing about either revision.
    if (exitCode === 0 && !sameRevision(after, revision)) exitCode = 90;
    evidence.steps.push({ name: step.split(" ")[0], command: `npm run ${step}`, exitCode, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, ...(exitCode === 90 ? { reason: "workspace revision changed during the gate" } : {}) });
    await writeAtomic(evidencePath, sealed(evidence));
    if (exitCode !== 0) { failed = step; break; }
  }
  evidence.completedAt = new Date().toISOString();
  evidence.state = failed ? "failed" : "passed";
  await writeAtomic(evidencePath, sealed(evidence));
  return { state: evidence.state, failed, evidencePath, revision: evidence.revision };
}

// Records a human release approval for the exact current revision. It refuses non-interactive input
// so an unattended process cannot mint its own approval.
export async function approveRelease(root, approvedBy, options = {}) {
  const input = options.input ?? process.stdin; const output = options.output ?? process.stdout;
  if (!input.isTTY && options.allowNonInteractive !== true) throw new Error("Release approval must be given by a person in an interactive terminal.");
  if (!String(approvedBy ?? "").trim()) throw new Error("Release approval requires --by <name>.");
  const revision = computeWorkspaceRevision(root);
  if (!revision) throw new Error("Release approval requires a readable Git workspace revision.");
  const code = revision.treeDigest.slice(0, 8);
  const prompt = createInterface({ input, output });
  try {
    const answer = options.answer ?? await prompt.question(`Approve release of ${revision.head.slice(0, 12)} (workspace ${code}) as ${approvedBy}? Type ${code} to confirm: `);
    if (String(answer).trim() !== code) throw new Error("Release approval was not confirmed.");
  } finally { prompt.close(); }
  const approval = sealed({ schemaVersion: 1, kind: RELEASE_APPROVAL_KIND, approvedBy: String(approvedBy).trim(), approvedAt: new Date().toISOString(), revision: { head: revision.head, treeDigest: revision.treeDigest } });
  await writeAtomic(path.join(root, RELEASE_APPROVAL_FILE), approval);
  return approval;
}

export async function readReleaseRecord(file, maxBytes = 256 * 1024) {
  try { const bytes = await readFile(file); return bytes.length <= maxBytes ? JSON.parse(bytes.toString("utf8")) : null; } catch { return null; }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const value = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  if (args.includes("--approve")) {
    const approval = await approveRelease(root, value("--by"));
    process.stdout.write(`Release approval recorded for ${approval.revision.head} by ${approval.approvedBy}.\n`);
  } else {
    const result = await runReleaseGates(root, value("--profile") ?? "web");
    process.stdout.write(`\n[release] ${result.state}${result.failed ? ` at ${result.failed}` : ""}; evidence: ${result.evidencePath}\n`);
    process.exitCode = result.state === "passed" ? 0 : 1;
  }
}
