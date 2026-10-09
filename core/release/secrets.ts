// Secret scanning for "Shipping safely" (layers 1-3: staged/added text, ignore
// list, whole-branch scan before push). Plain Node, injected git runner.
//
// Rules here are mirrored in hooks/pre-push.mjs (which cannot import TS);
// secrets.test.ts fails if the two drift apart.
//
// A full secret is never printed, stored or thrown: every finding carries only
// maskSecret(match), e.g. "ghp_…(40)".

import { ALLOWLIST_PATH, fingerprintOf, parseAllowlist } from "./allowlist";
import type { ChangedFile, CommandRunner, SecretFinding } from "./types";

export { ALLOWLIST_PATH, fingerprintOf, parseAllowlist };

export interface SecretRule {
  id: string;
  description: string;
  pattern: RegExp;
  /** Capture group holding the secret value when the whole match is not it. */
  valueGroup?: number;
  /** Capture group holding the secret's NAME; its keywords set the minimum value length. */
  nameGroup?: number;
  /** Only applied to config-like files (see isConfigLikeFile). */
  configOnly?: boolean;
}

// There is deliberately no inline "allow this line" marker: a reviewed exception
// is an exact fingerprint in .perfect-planner/secret-allowlist.json (allowlist.ts).

export const SECRET_RULES: readonly SecretRule[] = [
  { id: "aws-access-key", description: "AWS access key id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "github-token", description: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { id: "anthropic-key", description: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: "openai-key", description: "OpenAI API key", pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}|\bsk-(?!ant-)[A-Za-z0-9]{32,}/g },
  { id: "slack-token", description: "Slack token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { id: "stripe-key", description: "Stripe live key", pattern: /\b[sr]k_live_[A-Za-z0-9]{16,}/g },
  { id: "google-api-key", description: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { id: "private-key", description: "Private key block", pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
  { id: "jwt", description: "JSON web token", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    id: "aws-secret-key",
    description: "AWS secret access key (quoted or not)",
    pattern: /\baws[_-]?secret[_-]?access[_-]?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/gi,
    valueGroup: 1,
  },
  {
    id: "generic-assignment",
    description: "Hard-coded secret assigned to a secret-looking name",
    pattern: /\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|client[_-]?secret)[A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']([^"'\s]{8,})["']/gi,
    valueGroup: 2,
    nameGroup: 1,
  },
  {
    id: "generic-assignment-unquoted",
    description: "Unquoted secret on a whole NAME: value / NAME=value line of a config file",
    pattern: /^\s*(?:-\s+)?(?:export\s+)?([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|client[_-]?secret)[A-Za-z0-9_.-]*)\s*[:=]\s*([^\s"'#;]{8,})\s*(?:[#;].*)?$/gi,
    valueGroup: 2,
    nameGroup: 1,
    configOnly: true,
  },
];

/**
 * A value is a placeholder only when the WHOLE value is one (or a secret-store
 * reference such as "secret://..." or "dpapi:v1:..."); containing the word
 * "test" or "example" somewhere is not enough.
 */
export const PLACEHOLDER = /^(?:placeholder|changeme|x{3,}|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|process\.env\.[\w.]+|your[_-][\w-]*|example|dummy|test|redacted|\*{3,}|none|null|undefined|todo)$|^(?:secret:\/\/|keychain:|keyring:|vault:|dpapi:|op:\/\/|credentials:)/i;

/** True for obvious stand-ins like "changeme", "<token>", "${TOKEN}". */
export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value);
}

/** Minimum value length for a secret name: password/secret 8, key/token 12. */
export function minValueLength(name: string): number {
  return /password|passwd|secret/i.test(name) ? 8 : 12;
}

const CONFIG_NAME = /\.(?:ya?ml|ini|cfg|conf|properties|toml)$|^\.env(?:\..+)?$|^\.npmrc$|^dockerfile(?:\..+)?$|^docker-compose/;

/** True for files where `NAME: value` / `NAME=value` lines are configuration. */
export function isConfigLikeFile(path: string): boolean {
  return CONFIG_NAME.test(baseName(path).toLowerCase());
}

/** First 4 characters, an ellipsis and the length: "ghp_…(40)". */
export function maskSecret(s: string): string {
  return `${s.slice(0, 4)}…(${s.length})`;
}

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

function baseName(path: string): string {
  const p = path.replace(/\\/g, "/");
  return p.slice(p.lastIndexOf("/") + 1);
}

/** Rule id when a file name must never be committed, else null. */
export function isForbiddenFile(path: string): string | null {
  if (path.replace(/\\/g, "/") === ALLOWLIST_PATH) return null;
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
  const config = isConfigLikeFile(file);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const taken: Array<[number, number]> = [];
    const add = (rule: string, secret: string) => {
      const fingerprint = fingerprintOf(file, rule, secret);
      if (allow?.has(fingerprint)) return;
      findings.push({ file, line: i + 1, rule, preview: maskSecret(secret), fingerprint });
    };
    for (const rule of SECRET_RULES) {
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
        if (rule.nameGroup !== undefined && value.length < minValueLength(m[rule.nameGroup])) continue;
        if (isPlaceholder(value) || !/[A-Za-z]/.test(value)) continue;
        add(rule.id, value);
      }
    }
    if (isNpmrc) {
      const m = NPMRC_TOKEN.exec(line);
      if (m && !isPlaceholder(m[1])) add("npmrc-auth-token", m[1]);
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
