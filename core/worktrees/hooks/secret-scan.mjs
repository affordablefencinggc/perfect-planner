// Commit-time secret scan for task worktrees. Standalone on purpose: Perfect Planner
// copies this file into the managed repo's git dir, so it may import nothing but Node.
// Patterns mirror scripts/verify-secrets.mjs.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const SECRET_PATTERNS = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9_]{30,255}|github_pat_[A-Za-z0-9_]{40,255})\b/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["slack-token", /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/],
  ["openai-key", /\bsk-(?:proj-|svcacct-|ant-)?[A-Za-z0-9_-]{20,255}\b/],
  ["generic-assignment", /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password)["']?\s*[:=]\s*["'][^"'\r\n]{12,}["']/i],
  ["environment-secret", /^\s*(?:export\s+)?[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*[A-Za-z0-9_./+~-]{16,}/],
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/],
];

/** Scan a unified diff (-U0) and return findings for added lines only. Never returns the secret itself. */
export function scanDiff(diff) {
  const findings = [];
  let file = null;
  let line = 0;
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith("+++ ")) { file = raw.slice(4).replace(/^b\//, ""); continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (raw.startsWith("+") && file) {
      const text = raw.slice(1);
      for (const [rule, pattern] of SECRET_PATTERNS) if (pattern.test(text)) findings.push({ file, line, rule });
      line += 1;
    }
  }
  return findings;
}

function main() {
  const result = spawnSync("git", ["-c", "core.quotepath=off", "diff", "--cached", "--no-color", "--no-ext-diff", "-U0", "--diff-filter=ACMR"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (result.status !== 0) {
    process.stderr.write(`Perfect Planner secret scan could not read the staged changes: ${result.stderr || result.error}\n`);
    process.exit(1);
  }
  const findings = scanDiff(result.stdout);
  if (!findings.length) return;
  process.stderr.write("Perfect Planner blocked this commit: it looks like it contains a secret.\n");
  for (const finding of findings) process.stderr.write(`  ${finding.file}:${finding.line} (${finding.rule})\n`);
  process.stderr.write("Remove the value, keep it in the system key store, and commit again.\n");
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
