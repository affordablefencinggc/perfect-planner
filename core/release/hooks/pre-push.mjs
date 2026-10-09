#!/usr/bin/env node
// Perfect Planner pre-push hook (layer 3): last local stop before secrets leave
// the machine. No dependencies: it imports only secrets-detector.mjs beside it,
// the generated JS copy of core/secrets, so it detects exactly what the review
// gate and Jev's diff check detect. secrets.test.ts fails if that copy is stale
// or if this file's forbidden names and fingerprints drift from secrets.ts.
//
// Git feeds stdin lines: <local ref> <local sha> <remote ref> <remote sha>.
// Findings are printed masked to stderr; any finding exits 1.
// Testing modes: --scan-text <file> [allowlist.json]  (JSON findings), --rules,
// --placeholder, --check-name <path>, --check-config <path>.
//
// This hook is a local, best-effort layer. The binding check is the review
// gate's scanBranch with person-approved ledger fingerprints, plus GitHub push
// protection. There is no inline "allow this line" marker. A file entry in
// .perfect-planner/secret-allowlist.json is honoured here ONLY as it exists on
// the repository's default branch on the remote (origin/HEAD, else origin/main,
// else origin/master); never from the pushed ref, its remote tip or a merge-base
// of the pushed branch, so pushes to a feature branch cannot approve their own
// secret (an entry only reaches the default branch through review). With no
// resolvable default branch, no allowlist applies.

import { execFileSync } from "node:child_process";
import { scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
// Generated from core/secrets by build-detector.mjs: the same detector as the review gate and Jev.
import { PLACEHOLDER, SECRET_RULES, detectSecrets, isConfigLikeFile, maskSecret } from "./secrets-detector.mjs";

const ALLOWLIST_PATH = ".perfect-planner/secret-allowlist.json";

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
const PLANNER_STATE = /(^|\/)\.perfect-planner\//i;
const NPMRC_TOKEN = /_authToken\s*=\s*(\S+)/;

const baseName = (p) => { const q = p.replace(/\\/g, "/"); return q.slice(q.lastIndexOf("/") + 1); };

const fingerprintOf = (file, rule, value) => {
  const f = file.replace(/\\/g, "/");
  return `${f}:${rule}:${scryptSync(value, `perfect-planner:${f}:${rule}`, 32).toString("hex")}`;
};

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
  // Perfect Planner's own state (ledger, worker tokens, briefs, keys) never leaves the machine.
  if (PLANNER_STATE.test(path.replace(/\\/g, "/"))) return "planner-state";
  const name = baseName(path).toLowerCase();
  if (ENV_TEMPLATE.test(name)) return null;
  for (const r of FORBIDDEN) if (r.pattern.test(name)) return r.id;
  return null;
}

function scanText(file, text, allow) {
  const findings = [];
  const isNpmrc = baseName(file).toLowerCase() === ".npmrc";
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const add = (rule, secret) => {
      const fingerprint = fingerprintOf(file, rule, secret);
      if (allow && allow.has(fingerprint)) return;
      findings.push({ file, line: i + 1, rule, preview: maskSecret(secret), fingerprint });
    };
    // An .npmrc auth token is reported under its own rule; the detector skips that span.
    let npmStart;
    if (isNpmrc) {
      const m = NPMRC_TOKEN.exec(line);
      if (m && !PLACEHOLDER.test(m[1])) {
        npmStart = (m.index ?? 0) + m[0].length - m[1].length;
        add("npmrc-auth-token", m[1]);
      }
    }
    for (const span of detectSecrets(file, line)) {
      if (npmStart !== undefined && span.end > npmStart) continue;
      add(span.rule, line.slice(span.start, span.end));
    }
  }
  return findings;
}

const ZERO = /^0+$/;

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}
const lines = (s) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

// What the push is measured against: the remote tip, else the merge-base with
// the default branch, else null (brand-new history: scan everything).
function baseForPush(localSha, remoteSha, defaultRef) {
  if (!ZERO.test(remoteSha)) return remoteSha;
  if (!defaultRef) return null;
  try { return git(["merge-base", localSha, defaultRef]).trim(); } catch { return null; }
}

function filesForPush(localSha, base) {
  if (base) return lines(git(["diff", "--name-only", "--diff-filter=ACMR", `${base}..${localSha}`]));
  return lines(git(["ls-tree", "-r", "--name-only", localSha]));
}

// The remote's default branch as last fetched: origin/HEAD, else origin/main,
// else origin/master. Null when none resolves.
function defaultBranchRef() {
  const candidates = [];
  try {
    const head = git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).trim();
    if (head) candidates.push(head);
  } catch { /* origin/HEAD not set */ }
  candidates.push("refs/remotes/origin/main", "refs/remotes/origin/master");
  for (const ref of candidates) {
    try { git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]); return ref; } catch { /* try next */ }
  }
  return null;
}

function allowlistFromDefaultBranch(defaultRef) {
  if (!defaultRef) return new Set();
  try { return parseAllowlist(git(["show", `${defaultRef}:${ALLOWLIST_PATH}`])); } catch { return new Set(); }
}

function scanPush(localSha, remoteSha) {
  const defaultRef = defaultBranchRef();
  const base = baseForPush(localSha, remoteSha, defaultRef);
  const allow = allowlistFromDefaultBranch(defaultRef);
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
    console.log(JSON.stringify(SECRET_RULES.map((r) => ({
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
    console.log(JSON.stringify(isConfigLikeFile(args[1] ?? "")));
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
  process.stderr.write(`Remove them, or have a reviewer add the fingerprint to ${ALLOWLIST_PATH} on the remote default branch first.\n`);
  return 1;
}

process.exit(main());
