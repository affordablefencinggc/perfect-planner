#!/usr/bin/env node
// Perfect Planner pre-push hook (layer 3): last local stop before secrets leave
// the machine. Standalone and dependency-free, so it cannot import TypeScript.
//
// The rules below MIRROR core/release/secrets.ts. secrets.test.ts runs
// `node pre-push.mjs --rules` and fails if they drift apart.
//
// Git feeds stdin lines: <local ref> <local sha> <remote ref> <remote sha>.
// Findings are printed masked to stderr; any finding exits 1.
// Testing modes: --scan-text <file> [allowlist.json]  (JSON findings), --rules,
// --placeholder, --check-name <path>, --check-config <path>.
//
// There is no inline "allow this line" marker. A reviewed exception is an exact
// fingerprint in .perfect-planner/secret-allowlist.json, read from the BASE
// commit (the remote's current tip, or the merge-base for a new branch) and never
// from the pushed commit, so a push cannot allowlist its own secret.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const ALLOWLIST_PATH = ".perfect-planner/secret-allowlist.json";

const RULES = [
  { id: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { id: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: "openai-key", pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}|\bsk-(?!ant-)[A-Za-z0-9]{32,}/g },
  { id: "slack-token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { id: "stripe-key", pattern: /\b[sr]k_live_[A-Za-z0-9]{16,}/g },
  { id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { id: "private-key", pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
  { id: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    id: "aws-secret-key",
    pattern: /\baws[_-]?secret[_-]?access[_-]?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/gi,
    valueGroup: 1,
  },
  {
    id: "generic-assignment",
    pattern: /\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|client[_-]?secret)[A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']([^"'\s]{8,})["']/gi,
    valueGroup: 2,
    nameGroup: 1,
  },
  {
    id: "generic-assignment-unquoted",
    pattern: /^\s*(?:-\s+)?(?:export\s+)?([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|client[_-]?secret)[A-Za-z0-9_.-]*)\s*[:=]\s*([^\s"'#;]{8,})\s*(?:[#;].*)?$/gi,
    valueGroup: 2,
    nameGroup: 1,
    configOnly: true,
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
const PLACEHOLDER = /^(?:placeholder|changeme|x{3,}|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|process\.env\.[\w.]+|your[_-][\w-]*|example|dummy|test|redacted|\*{3,}|none|null|undefined|todo)$|^(?:secret:\/\/|keychain:|keyring:|vault:|dpapi:|op:\/\/|credentials:)/i;
const CONFIG_NAME = /\.(?:ya?ml|ini|cfg|conf|properties|toml)$|^\.env(?:\..+)?$|^\.npmrc$|^dockerfile(?:\..+)?$|^docker-compose/;
const NPMRC_TOKEN = /_authToken\s*=\s*(\S+)/;

const mask = (s) => `${s.slice(0, 4)}…(${s.length})`;
const baseName = (p) => { const q = p.replace(/\\/g, "/"); return q.slice(q.lastIndexOf("/") + 1); };

const minLength = (name) => (/password|passwd|secret/i.test(name) ? 8 : 12);
const isConfigLike = (path) => CONFIG_NAME.test(baseName(path).toLowerCase());
const fingerprintOf = (file, rule, value) => `${file.replace(/\\/g, "/")}:${rule}:${createHash("sha256").update(value).digest("hex")}`;

function parseAllowlist(text) {
  const out = new Set();
  let doc;
  try { doc = JSON.parse(text); } catch { return out; }
  if (typeof doc !== "object" || doc === null || doc.version !== 1 || !Array.isArray(doc.allow)) return out;
  const ok = (v) => typeof v === "string" && v.trim().length > 0;
  for (const e of doc.allow) {
    if (typeof e === "object" && e !== null && ok(e.fingerprint) && ok(e.reason) && ok(e.approvedBy)) out.add(e.fingerprint);
  }
  return out;
}

function forbiddenRule(path) {
  if (path.replace(/\\/g, "/") === ALLOWLIST_PATH) return null;
  const name = baseName(path).toLowerCase();
  if (ENV_TEMPLATE.test(name)) return null;
  for (const r of FORBIDDEN) if (r.pattern.test(name)) return r.id;
  return null;
}

function scanText(file, text, allow) {
  const findings = [];
  const isNpmrc = baseName(file).toLowerCase() === ".npmrc";
  const config = isConfigLike(file);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const taken = [];
    const add = (rule, secret) => {
      const fingerprint = fingerprintOf(file, rule, secret);
      if (allow && allow.has(fingerprint)) return;
      findings.push({ file, line: i + 1, rule, preview: mask(secret), fingerprint });
    };
    for (const rule of RULES) {
      if (rule.configOnly && !config) continue;
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
        taken.push([valueStart, valueStart + value.length]);
        if (rule.nameGroup !== undefined && value.length < minLength(m[rule.nameGroup])) continue;
        if (PLACEHOLDER.test(value) || !/[A-Za-z]/.test(value)) continue;
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

// The commit the push is measured against: the remote tip, else the merge-base
// with origin/HEAD, else null (brand-new history: no trusted allowlist exists).
function baseForPush(localSha, remoteSha) {
  if (!ZERO.test(remoteSha)) return remoteSha;
  try { return git(["merge-base", localSha, "origin/HEAD"]).trim(); } catch { return null; }
}

function filesForPush(localSha, base) {
  if (base) return lines(git(["diff", "--name-only", "--diff-filter=ACMR", `${base}..${localSha}`]));
  return lines(git(["ls-tree", "-r", "--name-only", localSha]));
}

function allowlistAt(base) {
  if (!base) return new Set();
  try { return parseAllowlist(git(["show", `${base}:${ALLOWLIST_PATH}`])); } catch { return new Set(); }
}

function scanPush(localSha, remoteSha) {
  const base = baseForPush(localSha, remoteSha);
  const allow = allowlistAt(base);
  const findings = [];
  for (const path of filesForPush(localSha, base)) {
    const rule = forbiddenRule(path);
    if (rule) {
      const fingerprint = fingerprintOf(path, rule, path);
      if (!allow.has(fingerprint)) findings.push({ file: path, rule, preview: "(forbidden file)", fingerprint });
    }
    let content;
    try { content = git(["show", `${localSha}:${path}`]); } catch { continue; }
    if (content.includes("\0")) continue;
    findings.push(...scanText(path, content, allow));
  }
  return findings;
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--rules") {
    console.log(JSON.stringify(RULES.map((r) => ({
      id: r.id, source: r.pattern.source, flags: r.pattern.flags,
      valueGroup: r.valueGroup ?? null, nameGroup: r.nameGroup ?? null, configOnly: r.configOnly === true,
    }))));
    return 0;
  }
  if (args[0] === "--placeholder") {
    console.log(JSON.stringify({ source: PLACEHOLDER.source, flags: PLACEHOLDER.flags }));
    return 0;
  }
  if (args[0] === "--check-config") {
    console.log(JSON.stringify(isConfigLike(args[1] ?? "")));
    return 0;
  }
  if (args[0] === "--check-name") {
    console.log(JSON.stringify(forbiddenRule(args[1] ?? "")));
    return 0;
  }
  if (args[0] === "--scan-text") {
    const allow = args[2] ? parseAllowlist(readFileSync(args[2], "utf8")) : undefined;
    console.log(JSON.stringify(scanText(args[1], readFileSync(args[1], "utf8"), allow)));
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
  for (const f of findings) process.stderr.write(`  ${f.file}${f.line ? `:${f.line}` : ""}  ${f.rule}  ${f.preview}  ${f.fingerprint}\n`);
  process.stderr.write(`Remove them, or have a reviewer add the fingerprint to ${ALLOWLIST_PATH} on the remote base branch first.\n`);
  return 1;
}

process.exit(main());
