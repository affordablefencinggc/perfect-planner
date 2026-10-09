// One secret detector for the whole core: the release scanner (core/release)
// blocks pushes with SECRET_RULES and findSecrets, Jev's fixed
// diff check uses the same rules, and redactSecrets hides secrets in anything
// that leaves Perfect Planner (Jev requests) or that agents write (relay and
// tool text). Redaction is deliberately broader than detection: hiding a
// harmless word costs little, a leaked key costs a rotation.
//
// No dependencies, so any core module can import it.

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

function baseName(path: string): string {
  const p = path.replace(/\\/g, "/");
  return p.slice(p.lastIndexOf("/") + 1);
}

/** True for files where `NAME: value` / `NAME=value` lines are configuration. */
export function isConfigLikeFile(path: string): boolean {
  return CONFIG_NAME.test(baseName(path).toLowerCase());
}

/** First 4 characters, an ellipsis and the length: "ghp_…(40)". */
export function maskSecret(s: string): string {
  return `${s.slice(0, 4)}…(${s.length})`;
}

export interface SecretMatch {
  rule: string;
  description: string;
  /** Where the secret value sits in the line. */
  start: number;
  end: number;
  value: string;
}

/**
 * The SECRET_RULES findings on one line of a file, exactly as the release
 * scanner counts them: config-only rules apply to config-like files (or when
 * `everywhere` is set), named values must reach the name's minimum length,
 * and placeholders are skipped.
 */
export function findSecrets(file: string, line: string, options: { everywhere?: boolean } = {}): SecretMatch[] {
  const config = options.everywhere === true || isConfigLikeFile(file);
  const found: SecretMatch[] = [];
  const taken: Array<[number, number]> = [];
  for (const rule of SECRET_RULES) {
    if (rule.configOnly && !config) continue;
    for (const m of line.matchAll(rule.pattern)) {
      const start = m.index ?? 0;
      if (rule.valueGroup === undefined) {
        taken.push([start, start + m[0].length]);
        found.push({ rule: rule.id, description: rule.description, start, end: start + m[0].length, value: m[0] });
        continue;
      }
      const value = m[rule.valueGroup]!;
      const valueStart = start + m[0].lastIndexOf(value);
      if (taken.some(([a, b]) => valueStart >= a && valueStart < b)) continue;
      taken.push([valueStart, valueStart + value.length]);
      if (rule.nameGroup !== undefined && value.length < minValueLength(m[rule.nameGroup]!)) continue;
      if (isPlaceholder(value) || !/[A-Za-z]/.test(value)) continue;
      found.push({ rule: rule.id, description: rule.description, start: valueStart, end: valueStart + value.length, value });
    }
  }
  return found;
}

// ---------- redaction ----------

export const REDACTED = "[redacted-secret]";

// A whole PEM block, BEGIN through END; with no END line, to the end of the text.
const PEM_BLOCK = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$(?![\s\S]))/g;

/** Formats the scanner leaves to review but redaction always hides; the value is group 1. */
const REDACT_VALUES: readonly RegExp[] = [
  // Authorization: Bearer x / Basic x, and a bare "Bearer x" in logs
  /\b(?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:bearer|basic|token|digest)\s+([A-Za-z0-9._~+/=-]{4,})/gi,
  /\bbearer\s+([A-Za-z0-9._~+/-]{12,}=*)/gi,
  // scheme://user:password@host
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:([^\s@/]+)@/gi,
  // mysql -uroot -pSECRET (the password is glued to -p)
  /\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\n]*?\s-p([^\s-][^\s]*)/gi,
  // --password=x / --password x
  /--(?:password|passwd|pass|token|secret|api-key|apikey|auth-token)(?:=|\s+)([^\s"'-][^\s"']*)/gi,
  // npm automation tokens
  /\b(npm_[A-Za-z0-9]{36})\b/g,
];

// NAME = value, NAME: value, "NAME": "value", with or without quotes and spaces.
// "scheme://" is not an assignment, so a URL's query string still gets checked.
const ASSIGNMENT = /([A-Za-z_][A-Za-z0-9_.-]*)["']?[ \t]*[:=][ \t]*(?!\/\/)(?:"([^"\n]+)"|'([^'\n]+)'|([^\s"'#;,&)]+))/g;

const SECRET_WORDS = new Set(["password", "passwd", "pass", "pwd", "passphrase", "pgpass", "pgpassword", "secret", "token", "apikey", "auth"]);
const KEY_PAIRS = new Set(["api", "private", "access", "secret", "signing", "encryption", "master", "session", "client"]);

function nameWords(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[_.-]+/).filter(Boolean);
}

/** True for names that hold secrets: DB_PASSWORD, apiKey, client_secret, PGPASS, AUTH. */
export function isSecretName(name: string): boolean {
  // The secret word must end the name: GITHUB_TOKEN and apiKey hold secrets,
  // TOKEN_URL, tokenRef and AUTH-FOLDER do not.
  const words = nameWords(name);
  const last = words[words.length - 1];
  if (last === undefined) return false;
  if (SECRET_WORDS.has(last)) return true;
  return last === "key" && words.length > 1 && KEY_PAIRS.has(words[words.length - 2]!);
}

// SHOUTY_ENV_NAMES ending in _KEY (STRIPE_KEY=...) are keys when assigned a bare
// value; a quoted one is usually a storage key name ("app.last-name").
const ENV_KEY_NAME = /^[A-Z0-9_]+_KEY$/;

// A bare value that is code, not a literal: an expression, a call, a member
// access, a type, an identifier, or a reference to the environment.
const CODE_START = /^(?:[-+!~(\[{`/<>=?:&|*@]|\$\{|\$[A-Za-z_]|%[A-Za-z_]|process\.env|os\.environ)/;
const IDENTIFIER_CHAIN = /^[A-Za-z_$][A-Za-z_$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(.*)?$|^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\(.*)?$|^[A-Za-z_$][\w$]*\(/;

function isLiteralSecret(value: string, quoted: boolean): boolean {
  if (value.length < 3 || value.includes(REDACTED) || isPlaceholder(value)) return false;
  // Quoted prose ("Secret check") or a URL-ish word list is not a credential.
  if (quoted) return !/\s/.test(value);
  return !CODE_START.test(value) && !IDENTIFIER_CHAIN.test(value) && !/=>|[[\](){}<>]/.test(value);
}

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / s.length) * Math.log2(n / s.length);
  return bits;
}

// Long mixed-case-and-digit runs with high entropy: generated tokens nobody named.
const LONG_RUN = /[A-Za-z0-9+_-]{32,}={0,2}/g;
function looksGenerated(run: string): boolean {
  return /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run) && entropy(run) >= 4;
}

function replaceGroup(text: string, pattern: RegExp, keep: (value: string) => boolean = () => false): string {
  return text.replace(pattern, (...args: unknown[]) => {
    const match = args[0] as string;
    const value = args[1] as string | undefined;
    if (!value || value.includes(REDACTED) || keep(value)) return match;
    const at = match.lastIndexOf(value);
    return `${match.slice(0, at)}${REDACTED}${match.slice(at + value.length)}`;
  });
}

/** Hides every secret Perfect Planner can recognise; the names stay so a reader still sees what was there. */
export function redactSecrets(text: string): string {
  let out = text.replace(PEM_BLOCK, REDACTED);
  for (const pattern of REDACT_VALUES) out = replaceGroup(out, pattern);
  out = out
    .split("\n")
    .map((line) => {
      // Config-only rules stay with the scanner; ASSIGNMENT below covers those lines with a code check.
      const found = findSecrets("", line).filter((f) => !line.slice(f.start, f.end).includes(REDACTED));
      let next = line;
      for (const f of found.sort((a, b) => b.start - a.start)) next = `${next.slice(0, f.start)}${REDACTED}${next.slice(f.end)}`;
      return next;
    })
    .join("\n");
  out = out.replace(ASSIGNMENT, (match: string, name: string, dq?: string, sq?: string, bare?: string) => {
    const value = dq ?? sq ?? bare ?? "";
    const secretName = isSecretName(name) || (bare !== undefined && ENV_KEY_NAME.test(name));
    if (!secretName || !isLiteralSecret(value, bare === undefined)) return match;
    const at = match.lastIndexOf(value);
    return `${match.slice(0, at)}${REDACTED}${match.slice(at + value.length)}`;
  });
  return out.replace(LONG_RUN, (run) => (looksGenerated(run) ? REDACTED : run));
}

/** True when redactSecrets would hide something in the text. */
export function looksSecret(text: string): boolean {
  return redactSecrets(text) !== text;
}
