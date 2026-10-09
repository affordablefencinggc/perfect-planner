#!/usr/bin/env node
// Perfect Planner pre-push hook (layer 3): last local stop before secrets leave
// the machine. Standalone and dependency-free, so it cannot import TypeScript.
//
// The rules below MIRROR core/release/secrets.ts. secrets.test.ts runs
// `node pre-push.mjs --rules` and fails if they drift apart.
//
// Git feeds stdin lines: <local ref> <local sha> <remote ref> <remote sha>.
// Findings are printed masked to stderr; any finding exits 1.
// Testing modes: --scan-text <file>  (JSON findings), --rules, --check-name <path>.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ALLOW_MARKER = "pp-allow-secret";

const RULES = [
  { id: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { id: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: "openai-key", pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}|\bsk-(?!ant-)[A-Za-z0-9]{32,}/g },
  { id: "slack-token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { id: "stripe-key", pattern: /\b[sr]k_live_[A-Za-z0-9]{16,}/g },
  { id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { id: "private-key", pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
  { id: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    id: "generic-assignment",
    pattern: /\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|client[_-]?secret)[A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']([^"'\s]{12,})["']/gi,
    valueGroup: 2,
  },
];

const FORBIDDEN = [
  { id: "env-file", pattern: /^\.env(?:\..+)?$/ },
  { id: "pem-file", pattern: /\.pem$/ },
  { id: "key-file", pattern: /\.key$/ },
  { id: "pkcs12-file", pattern: /\.(?:p12|pfx)$/ },
  { id: "ssh-private-key", pattern: /^id_(?:rsa|ed25519|ecdsa)$/ },
  { id: "keystore-file", pattern: /\.keystore$/ },
  { id: "credentials-file", pattern: /^credentials\.json$/ },
  { id: "service-account-file", pattern: /^service-account.*\.json$/ },
];
const ENV_TEMPLATE = /^\.env\.(?:example|sample|template)$/;
const PLACEHOLDER = /placeholder|changeme|x{3,}|^<.*>$|\$\{|process\.env|^your[_-]|example|dummy|test|^(?:secret|keychain|keyring|vault|dpapi|op|credential)s?:/i;
// The last alternative: references to a secret store ("secret://...", "dpapi:v1:..."), not secrets.
const NPMRC_TOKEN = /_authToken\s*=\s*(\S+)/;

const mask = (s) => `${s.slice(0, 4)}…(${s.length})`;
const baseName = (p) => { const q = p.replace(/\\/g, "/"); return q.slice(q.lastIndexOf("/") + 1); };

function forbiddenRule(path) {
  const name = baseName(path).toLowerCase();
  if (ENV_TEMPLATE.test(name)) return null;
  for (const r of FORBIDDEN) if (r.pattern.test(name)) return r.id;
  return null;
}

function scanText(file, text) {
  const findings = [];
  const isNpmrc = baseName(file).toLowerCase() === ".npmrc";
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(ALLOW_MARKER)) continue;
    const taken = [];
    const add = (rule, secret) => findings.push({ file, line: i + 1, rule, preview: mask(secret) });
    for (const rule of RULES) {
      for (const m of line.matchAll(rule.pattern)) {
        const start = m.index ?? 0;
        if (rule.valueGroup === undefined) {
          taken.push([start, start + m[0].length]);
          add(rule.id, m[0]);
          continue;
        }
        const value = m[rule.valueGroup];
        const valueStart = start + m[0].lastIndexOf(value);
        if (taken.some(([a, b]) => valueStart >= a && valueStart < b)) continue;
        if (PLACEHOLDER.test(value) || !/[A-Za-z]/.test(value) || !/\d/.test(value)) continue;
        add(rule.id, value);
      }
    }
    if (isNpmrc) {
      const m = NPMRC_TOKEN.exec(line);
      if (m && !PLACEHOLDER.test(m[1])) add("npmrc-auth-token", m[1]);
    }
  }
  return findings;
}

const ZERO = /^0+$/;

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}
const lines = (s) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

function filesForPush(localSha, remoteSha) {
  if (!ZERO.test(remoteSha)) return lines(git(["diff", "--name-only", "--diff-filter=ACMR", `${remoteSha}..${localSha}`]));
  try {
    const base = git(["merge-base", localSha, "origin/HEAD"]).trim();
    return lines(git(["diff", "--name-only", "--diff-filter=ACMR", `${base}..${localSha}`]));
  } catch {
    return lines(git(["ls-tree", "-r", "--name-only", localSha]));
  }
}

function scanPush(localSha, remoteSha) {
  const findings = [];
  for (const path of filesForPush(localSha, remoteSha)) {
    const rule = forbiddenRule(path);
    if (rule) findings.push({ file: path, rule, preview: "(forbidden file)" });
    let content;
    try { content = git(["show", `${localSha}:${path}`]); } catch { continue; }
    if (content.includes("\0")) continue;
    findings.push(...scanText(path, content));
  }
  return findings;
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--rules") {
    console.log(JSON.stringify(RULES.map((r) => ({ id: r.id, source: r.pattern.source, flags: r.pattern.flags }))));
    return 0;
  }
  if (args[0] === "--check-name") {
    console.log(JSON.stringify(forbiddenRule(args[1] ?? "")));
    return 0;
  }
  if (args[0] === "--scan-text") {
    console.log(JSON.stringify(scanText(args[1], readFileSync(args[1], "utf8"))));
    return 0;
  }
  const input = readFileSync(0, "utf8");
  const findings = [];
  for (const row of lines(input)) {
    const [, localSha, , remoteSha] = row.split(/\s+/);
    if (!localSha || ZERO.test(localSha)) continue; // deleting a ref
    try {
      findings.push(...scanPush(localSha, remoteSha ?? "0"));
    } catch (err) {
      process.stderr.write(`pre-push: could not scan ${localSha.slice(0, 8)}: ${err instanceof Error ? err.message.split("\n")[0] : "error"}\n`);
      return 1;
    }
  }
  if (findings.length === 0) return 0;
  process.stderr.write("Push blocked: possible secrets found (values masked).\n");
  for (const f of findings) process.stderr.write(`  ${f.file}${f.line ? `:${f.line}` : ""}  ${f.rule}  ${f.preview}\n`);
  process.stderr.write(`Remove them, or add "${ALLOW_MARKER}" on a line you have reviewed.\n`);
  return 1;
}

process.exit(main());
