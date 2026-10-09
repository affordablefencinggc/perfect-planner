#!/usr/bin/env node
// Minimal staged-file secret scan, copied into a task worktree's private hooks
// directory when the project has no scripts/verify-secrets.mjs of its own.
// It prints only file, line and rule for each finding, never the matched text,
// and exits 1 on any finding or read failure so the commit is blocked.
// It reads whatever index git hands the hook in GIT_INDEX_FILE, so it also
// covers `git commit -a` and partial commits, which use a temporary index.
//
// `--index-is-normal` instead exits 0 when GIT_INDEX_FILE is unset or names the
// checkout's own index, and 1 otherwise. The hook uses it to decide whether a
// project scanner that only accepts the normal index can run as well.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";

export const SECRET_PATTERNS = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9_]{30,255}|github_pat_[A-Za-z0-9_]{40,255})\b/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["slack-token", /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/g],
  ["openai-key", /\bsk-(?:proj-|svcacct-|ant-)?[A-Za-z0-9_-]{20,255}\b/g],
  ["generic-assignment", /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password)["']?\s*[:=]\s*["'][^"'\r\n]{12,}["']/gi],
  ["environment-secret", /(?:^|\n)\s*(?:export\s+)?[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*(?!PLACEHOLDER_)[A-Za-z0-9_./+~-]{16,}/g],
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/g],
];

export function scanText(file, text) {
  const findings = [];
  for (const [rule, pattern] of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const start = match.index + (match[0].length - match[0].replace(/^\s+/, "").length);
      findings.push({ path: file, line: text.slice(0, start).split("\n").length, rule });
    }
  }
  return findings;
}

function git(args, maxBuffer = 16_000_000, env = process.env) {
  const result = spawnSync("git", args, { encoding: "buffer", windowsHide: true, maxBuffer, shell: false, env });
  if (result.error || result.status !== 0) throw new Error("git-read-failed");
  return result.stdout;
}

function main() {
  const findings = [];
  const names = git(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"]).toString("utf8").split("\0").filter(Boolean);
  for (const name of names) {
    const blob = git(["show", ":" + name]);
    if (blob.includes(0)) continue; // binary
    findings.push(...scanText(name, blob.toString("utf8")));
  }
  if (findings.length) {
    process.stderr.write("Perfect Planner: commit blocked, possible secret(s) staged:\n");
    for (const f of findings) process.stderr.write(`  ${f.path}:${f.line} (${f.rule})\n`);
    process.exitCode = 1;
  }
}

function sameFile(a, b) {
  const real = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
  const ra = real(a);
  const rb = real(b);
  return process.platform === "win32" || process.platform === "darwin" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

export function indexIsNormal(env = process.env, cwd = process.cwd()) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "GIT_INDEX_FILE");
  if (key === undefined) return true;
  if (!env[key]) return false;
  // --git-path honours GIT_INDEX_FILE, so ask without it for the checkout's own index.
  const plain = { ...env };
  delete plain[key];
  const normal = git(["rev-parse", "--git-path", "index"], 1_000_000, plain).toString("utf8").trim();
  return sameFile(path.resolve(cwd, env[key]), path.resolve(cwd, normal));
}

const invokedDirectly = process.argv[1] && /bundledSecretScan\.mjs$|pp-secret-scan\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  if (process.argv.includes("--index-is-normal")) {
    let normal = false;
    try { normal = indexIsNormal(); } catch { normal = false; }
    process.exitCode = normal ? 0 : 1;
  } else try { main(); } catch (error) {
    process.stderr.write("Perfect Planner: secret scan could not read staged files (" + error.message + "); commit blocked.\n");
    process.exitCode = 1;
  }
}
