// Secret scanning for "Shipping safely" (layers 1-3: staged/added text, ignore
// list, whole-branch scan before push). Plain Node, injected git runner.
//
// Detection is core/secrets detectSecrets, the same check Jev runs on a diff.
// hooks/pre-push.mjs imports a generated JS copy of it (git runs hooks with
// node, which cannot load TS); secrets.test.ts fails if the copy is stale.
//
// A full secret is never printed, stored or thrown: every finding carries only
// maskSecret(match), e.g. "ghp_…(40)".

import { ALLOWLIST_PATH, fingerprintOf, parseAllowlist } from "./allowlist";
import { PLACEHOLDER, SECRET_RULES, detectSecrets, isConfigLikeFile, isPlaceholder, maskSecret, minValueLength } from "../secrets/index";
import type { ChangedFile, CommandRunner, SecretFinding } from "./types";

export { ALLOWLIST_PATH, fingerprintOf, parseAllowlist };

// The detection rules themselves live in core/secrets, shared with Jev's diff
// check, so a diff Jev passes is one the push check passes too.
export type { SecretRule } from "../secrets/index";
export { PLACEHOLDER, SECRET_RULES, isConfigLikeFile, isPlaceholder, maskSecret, minValueLength };

interface ForbiddenRule {
  id: string;
  /** Tested against the lower-cased file name (no directory). */
  pattern: RegExp;
}

export const FORBIDDEN_FILES: readonly ForbiddenRule[] = [
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

function baseName(path: string): string {
  const p = path.replace(/\\/g, "/");
  return p.slice(p.lastIndexOf("/") + 1);
}

/** Rule id when a file name must never be committed, else null. */
export function isForbiddenFile(path: string): string | null {
  if (path.replace(/\\/g, "/") === ALLOWLIST_PATH) return null;
  // Perfect Planner's own state (ledger, worker tokens, briefs, keys) never leaves the machine.
  if (PLANNER_STATE.test(path.replace(/\\/g, "/"))) return "planner-state";
  const name = baseName(path).toLowerCase();
  if (ENV_TEMPLATE.test(name)) return null;
  for (const r of FORBIDDEN_FILES) if (r.pattern.test(name)) return r.id;
  return null;
}

const NPMRC_TOKEN = /_authToken\s*=\s*(\S+)/;

/** Scans text line by line; line numbers are 1-based. Findings in `allow` (by fingerprint) are skipped. */
export function scanText(file: string, text: string, allow?: ReadonlySet<string>): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const isNpmrc = baseName(file).toLowerCase() === ".npmrc";
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const add = (rule: string, secret: string) => {
      const fingerprint = fingerprintOf(file, rule, secret);
      if (allow?.has(fingerprint)) return;
      findings.push({ file, line: i + 1, rule, preview: maskSecret(secret), fingerprint });
    };
    // The same detector as Jev's diff check (core/secrets detectSecrets).
    // An .npmrc auth token is reported under its own rule; the detector skips that span.
    let npmStart: number | undefined;
    if (isNpmrc) {
      const m = NPMRC_TOKEN.exec(line);
      if (m && !isPlaceholder(m[1])) {
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

function forbiddenFinding(path: string, rule: string, allow?: ReadonlySet<string>): SecretFinding[] {
  const fingerprint = fingerprintOf(path, rule, path);
  return allow?.has(fingerprint) ? [] : [{ file: path, rule, preview: "(forbidden file)", fingerprint }];
}

/** Forbidden names for non-deleted files plus a scan of each file's added text. */
export function scanChange(files: ChangedFile[], allow?: ReadonlySet<string>): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const f of files) {
    if (f.deleted) continue;
    const rule = isForbiddenFile(f.path);
    if (rule) findings.push(...forbiddenFinding(f.path, rule, allow));
    if (f.binary || !f.addedText) continue;
    findings.push(...scanText(f.path, f.addedText, allow));
  }
  return findings;
}

export const REQUIRED_IGNORES: readonly string[] = [
  ".env",
  ".env.*",
  "!.env.example",
  "*.pem",
  "*.key",
  "id_rsa*",
  ".perfect-planner/secrets/",
  ".perfect-planner/tokens/",
];

const IGNORE_HEADER = "# Perfect Planner: never commit secrets";

export function checkIgnoreList(gitignoreText: string): { ok: boolean; missing: string[] } {
  const have = new Set(gitignoreText.split(/\r?\n/).map((l) => l.trim()));
  const missing = REQUIRED_IGNORES.filter((r) => !have.has(r));
  return { ok: missing.length === 0, missing };
}

/** Appends only the missing lines; idempotent; keeps the file's line endings. */
export function withRequiredIgnores(gitignoreText: string): string {
  const { missing } = checkIgnoreList(gitignoreText);
  if (missing.length === 0) return gitignoreText;
  const eol = gitignoreText.includes("\r\n") ? "\r\n" : "\n";
  let out = gitignoreText;
  if (out.length > 0 && !out.endsWith("\n")) out += eol;
  if (out.length > 0) out += eol;
  const header = gitignoreText.includes(IGNORE_HEADER) ? [] : [IGNORE_HEADER];
  return out + [...header, ...missing].join(eol) + eol;
}

export interface BranchScanResult {
  ok: boolean;
  findings: SecretFinding[];
  filesScanned: number;
}

/**
 * Layer 3: scan the full content of every file the branch adds or changes.
 * `approved` is the set of fingerprints a person approved in the signed ledger
 * (approvedFingerprints(ledger.entries())). No allowlist file is read from any
 * branch: a file a push adds approves nothing, so two pushes cannot approve
 * their own secret.
 */
export async function scanBranch(
  run: CommandRunner,
  opts: { cwd: string; base: string; head?: string; approved?: ReadonlySet<string> },
): Promise<BranchScanResult> {
  const head = opts.head ?? "HEAD";
  const list = await run("git", ["diff", "--name-only", "--diff-filter=ACMR", `${opts.base}...${head}`], { cwd: opts.cwd });
  if (list.code !== 0) {
    throw new Error(`git diff failed (exit ${list.code}): ${list.stderr.trim().split(/\r?\n/)[0] ?? ""}`);
  }
  const paths = list.stdout.split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
  const findings: SecretFinding[] = [];
  for (const path of paths) {
    const rule = isForbiddenFile(path);
    if (rule) findings.push(...forbiddenFinding(path, rule, opts.approved));
    const shown = await run("git", ["show", `${head}:${path}`], { cwd: opts.cwd });
    if (shown.code !== 0) {
      throw new Error(`git show failed for ${path} (exit ${shown.code}): ${shown.stderr.trim().split(/\r?\n/)[0] ?? ""}`);
    }
    if (shown.stdout.includes("\0")) continue;
    findings.push(...scanText(path, shown.stdout, opts.approved));
  }
  return { ok: findings.length === 0, findings, filesScanned: paths.length };
}
