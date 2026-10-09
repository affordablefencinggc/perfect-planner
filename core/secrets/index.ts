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

/**
 * Canary and sentinel strings that say they are not real ("must-not-leave",
 * "do-not-retain-payload", "fake-key", "example_token"): tests and receipts use
 * them to prove a secret was dropped.
 */
export const SENTINEL = /^(?:do[-_]?not|must[-_]?not|never|not[-_]a|fake|dummy|sample|example|placeholder|redacted)(?:[-_][a-z]+)+$/i;

/** A placeholder or a self-describing sentinel: never a credential. */
export function isStandIn(value: string): boolean {
  return isPlaceholder(value) || SENTINEL.test(value);
}

/**
 * A phrase of three or more lower-case words joined by "-", "_" or "."
 * ("auth.session.token"). Assigned to a name that is not itself a secret name
 * (TOKEN_KEY, a label field) it is a key name or label; assigned to PASSWORD,
 * API_KEY or the like, or on an env line, it is a passphrase and still counts.
 */
export const WORD_PHRASE = /^[a-z]+(?:[-_.][a-z]+){2,}$/;

// An env-style line: NAME=value with no spaces around "=", optionally exported.
const ENV_LINE = /^\s*(?:export\s+|set\s+|setx\s+)?[A-Za-z_][A-Za-z0-9_]*=/;

function phraseExempt(name: string | undefined, value: string, line: string): boolean {
  return WORD_PHRASE.test(value) && !(name !== undefined && isSecretName(name)) && !ENV_LINE.test(line);
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
  /** The secret's name, for rules that capture one (DB_PASSWORD in DB_PASSWORD="..."). */
  name?: string;
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
      if (isStandIn(value) || !/[A-Za-z]/.test(value)) continue;
      if (rule.nameGroup !== undefined && phraseExempt(m[rule.nameGroup], value, line)) continue;
      found.push({ rule: rule.id, description: rule.description, start: valueStart, end: valueStart + value.length, value, ...(rule.nameGroup !== undefined ? { name: m[rule.nameGroup]! } : {}) });
    }
  }
  return found;
}

// ---------- redaction and the diff check ----------
//
// detectSecrets (one line of a known file, used by Jev's diff check) and
// redactSecrets (any text) share every rule below. Redaction is broader in a
// few places only: every cookie value, and plain words on `name: value` lines.

export const REDACTED = "[redacted-secret]";

// A whole PEM block, BEGIN through END; with no END line, to the end of the text.
const PEM_BLOCK = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$(?![\s\S]))/g;

interface ValueRule {
  id: string;
  description: string;
  /** The secret value is group 1. */
  pattern: RegExp;
  /** Count a value that is just a word like "password" (otherwise read as documentation). */
  words?: boolean;
}

/** Formats beyond SECRET_RULES; both redaction and the diff check use them. */
const VALUE_RULES: readonly ValueRule[] = [
  { id: "auth-header", description: "Authorization header", pattern: /\b(?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:bearer|basic|token|digest)\s+([A-Za-z0-9._~+/=-]{4,})/gi },
  { id: "bearer-token", description: "Bearer token", pattern: /\bbearer\s+([A-Za-z0-9._~+/-]{12,}=*)/gi },
  { id: "connection-string", description: "password in a connection string", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/"'`]*:([^\s@/"'`]+)@/gi },
  { id: "mysql-password", description: "mysql -p password", pattern: /\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\n]*?\s-p([^\s-][^\s]*)/gi },
  { id: "password-flag", description: "password on a command line", pattern: /--(?:password|passwd|pass|token|secret|api-key|apikey|auth-token)(?:=|\s+)([^\s"'`-][^\s"'`]*)/gi },
  // curl -u user:<password> or --user user:<password> ("pass" counts: a real password can be a word)
  { id: "curl-user", description: "password in curl -u", pattern: /\bcurl\b[^\n]*?\s(?:-u|--user)(?:\s+|=)["']?[^\s:"'$]+:([^\s"'$][^\s"']*)/gi, words: true },
  { id: "npm-token", description: "npm token", pattern: /\b(npm_[A-Za-z0-9]{36})\b/g },
  { id: "stripe-test-key", description: "Stripe test key", pattern: /\b([rs]k_test_[A-Za-z0-9]{16,})/g },
];

// NAME = value, NAME: value, "NAME": "value", with or without quotes and spaces.
// "scheme://" is not an assignment, so a URL's query string still gets checked.
const ASSIGNMENT = /([A-Za-z_][A-Za-z0-9_.-]*)["']?[ \t]*[:=][ \t]*(?!\/\/)(?:"([^"\n]+)"|'([^'\n]+)'|([^\s"'`#;,&)]+))/g;

const SECRET_WORDS = new Set(["password", "passwd", "pass", "pwd", "passphrase", "pgpass", "pgpassword", "secret", "token", "apikey", "auth"]);
const KEY_PAIRS = new Set(["api", "private", "access", "secret", "signing", "encryption", "master", "session", "client"]);

function nameWords(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[_.-]+/).filter(Boolean);
}

/** True for names that hold secrets: DB_PASSWORD, apiKey, client_secret, PGPASS, AUTH. */
export function isSecretName(name: string): boolean {
  // The secret word must end the name: GITHUB_TOKEN and apiKey hold secrets,
  // TOKEN_URL, tokenType, passwordLabel and AUTH-FOLDER do not.
  const words = nameWords(name);
  const last = words[words.length - 1];
  if (last === undefined) return false;
  // A lone upper-case "PASS" is usually a result ("PASS: 18/18"); a lower-case
  // "pass:" key, DB_PASS and userPass are secrets. Whole words only, so
  // passthrough and bypass never match.
  if (last === "pass") return words.length > 1 || name === "pass";
  if (SECRET_WORDS.has(last)) return true;
  return last === "key" && words.length > 1 && KEY_PAIRS.has(words[words.length - 2]!);
}

// SHOUTY_ENV_NAMES ending in _KEY (STRIPE_KEY=...) are keys when assigned a bare
// value; a quoted one is usually a storage key name ("auth.session.token").
const ENV_KEY_NAME = /^[A-Z0-9_]+_KEY$/;

// A value that starts like code: an expression, a template, a reference to the environment.
const CODE_START = /^(?:[-+!~(\[{`/<>=?:&|*@\\]|\$\{|\$[A-Za-z_(]|%[A-Za-z_]|process\.env|os\.environ|import\.meta)/;
const CODE_CHARS = /=>|[[\](){}<>]/;
// Words that follow "token:" as a type or a keyword, not a value.
const CODE_WORDS = new Set(["string", "number", "boolean", "bigint", "symbol", "object", "unknown", "any", "void", "never", "null", "undefined", "true", "false", "none", "nil", "await", "new", "this", "self", "typeof", "function", "async", "return", "const", "let", "var", "str", "int", "bytes", "buffer", "uint8array", "readonly", "optional"]);
const IDENTIFIER_CHAIN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
// A whole line that is one `name: value` pair, as in YAML.
const YAML_LINE = /^\s*(?:-\s+)?["']?[A-Za-z_][\w.-]*["']?\s*:\s*[^\s,;{}()]+\s*(?:#.*)?$/;

type Mode = "redact" | "detect";

function isLiteralSecret(name: string, value: string, quoted: boolean, context: { mode: Mode; envLine: boolean; configFile: boolean; yamlLine: boolean }): boolean {
  if (value.length < 3 || value.includes(REDACTED) || isStandIn(value) || !/[A-Za-z0-9]/.test(value)) return false;
  // In source code the diff check keeps the release scanner's minimum lengths, so
  // test strings ("forged") pass; configuration lines and redaction take any length.
  if (context.mode === "detect" && !context.envLine && !context.configFile && value.length < minValueLength(name)) return false;
  if (quoted) {
    // Prose ("Secret check") is not a credential; neither is a value that only names a field ("Password").
    if (/\s/.test(value) || SECRET_WORDS.has(value.toLowerCase())) return false;
    return true;
  }
  if (CODE_START.test(value) || CODE_CHARS.test(value) || CODE_WORDS.has(value.toLowerCase())) return false;
  if (!IDENTIFIER_CHAIN.test(value)) return true;
  // A bare identifier: code (token = value, token: string, a.b.c) unless the
  // line is plainly configuration (DB_PASSWORD=<word>, or password: <word> in YAML).
  // On NAME=value lines a dotted value is a literal (API_KEY=blue.whale.sings.loud), not member access.
  if (context.envLine) return true;
  // In config files and on lone `name: value` lines, a dotted value is a literal too (passphrase: a.b.c).
  if (context.configFile || context.yamlLine) return true;
  // Redaction also hides identifiers with digits ("hunter2"); plain words stay
  // unless the line is a lone `name: value` (YAML in a log or a paste).
  if (context.mode !== "redact" || value.includes(".") || /^[_$]/.test(value) || /[a-z][A-Z]/.test(value) || SECRET_WORDS.has(value.toLowerCase())) return false;
  return /\d/.test(value) || context.yamlLine;
}

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / s.length) * Math.log2(n / s.length);
  return bits;
}

// Content digests and embedded files, never credentials: Subresource Integrity
// values ("integrity": "sha512-<base64>", as in package-lock.json) and data: URIs
// (base64 images in generated evidence). Long runs inside them are skipped; any
// other rule still applies to the rest of the line.
const BENIGN_BLOBS = [/\bsha(?:256|384|512)-[A-Za-z0-9+/]{40,}={0,2}/g, /\bdata:[\w.+-]+\/[\w.+-]+(?:;[\w.+-]+=[\w.+-]+)*;base64,[A-Za-z0-9+/]+={0,2}/g];

function benignRanges(line: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const pattern of BENIGN_BLOBS) for (const m of line.matchAll(pattern)) ranges.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  return ranges;
}

// Long mixed-case-and-digit runs with high entropy: generated tokens nobody named.
const LONG_RUN = /[A-Za-z0-9+_-]{32,}={0,2}/g;
// A label glued to a hash ("SHA256468ca0...", "Overlay442fde...") is a digest, not a credential.
const LABELLED_HEX = /^[A-Za-z]{0,16}(?:[0-9a-f]{32,}|[0-9A-F]{32,})$/;
function looksGenerated(run: string): boolean {
  if (LABELLED_HEX.test(run.replace(/=+$/, ""))) return false;
  return /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run) && entropy(run) >= 4;
}

// Cookie and Set-Cookie headers: <name>=<value> pairs, minus attributes like Path
const COOKIE_HEADER = /\b(?:set-)?cookie\s*:\s*([^\n]+)/gi;
const SESSION_COOKIE = /sess|sid|token|auth|jwt|login|remember/i;
const COOKIE_ATTRIBUTES = new Set(["path", "domain", "expires", "max-age", "samesite", "secure", "httponly", "priority", "partitioned"]);

export interface SecretSpan {
  rule: string;
  description: string;
  start: number;
  end: number;
}

function scanLine(line: string, mode: Mode, file: string): SecretSpan[] {
  const spans: SecretSpan[] = [];
  const add = (rule: string, description: string, start: number, end: number) => {
    if (end > start && !spans.some((s) => start < s.end && end > s.start)) spans.push({ rule, description, start, end });
  };
  // YAML, ini and .env files count every line as configuration; elsewhere only NAME=value lines do.
  const configFile = isConfigLikeFile(file);
  const context = { mode, envLine: false, configFile, yamlLine: YAML_LINE.test(line) };

  for (const f of findSecrets(file, line, { everywhere: mode === "redact" })) {
    // The scanner's generic rule matches any name containing a secret word; here the word must end the name.
    if (f.name !== undefined && !isSecretName(f.name)) continue;
    add(f.rule, f.description, f.start, f.end);
  }
  for (const rule of VALUE_RULES) {
    for (const m of line.matchAll(rule.pattern)) {
      const value = m[1];
      if (!value || isStandIn(value) || CODE_START.test(value) || value.includes(REDACTED) || !/[A-Za-z0-9]/.test(value) || (!rule.words && SECRET_WORDS.has(value.toLowerCase()))) continue;
      const start = (m.index ?? 0) + m[0].lastIndexOf(value);
      add(rule.id, rule.description, start, start + value.length);
    }
  }
  for (const m of line.matchAll(ASSIGNMENT)) {
    const [, name, dq, sq, bare] = m;
    const value = dq ?? sq ?? bare ?? "";
    const secretName = isSecretName(name!) || (bare !== undefined && ENV_KEY_NAME.test(name!));
    // Env-style only when this assignment itself opens the line as NAME=value (a minified "a=b,secret:c" is code).
    const envLine = ENV_LINE.test(line.slice(m.index ?? 0)) && /^\s*(?:(?:export|set|setx)\s+)?$/.test(line.slice(0, m.index ?? 0));
    if (!secretName || !isLiteralSecret(name!, value, bare === undefined, { ...context, envLine })) continue;
    const start = (m.index ?? 0) + m[0].lastIndexOf(value);
    add("secret-assignment", `value assigned to ${name}`, start, start + value.length);
  }
  // Redaction hides every cookie value; the diff check flags session-like ones (URL-encoded or not).
  for (const m of line.matchAll(COOKIE_HEADER)) {
    const base = (m.index ?? 0) + m[0].length - m[1]!.length;
    for (const pair of m[1]!.matchAll(/([^=;\s]+)=([^;\s]+)/g)) {
      const [, cookie, value] = pair;
      if (COOKIE_ATTRIBUTES.has(cookie!.toLowerCase())) continue;
      if (mode === "detect" && !(SESSION_COOKIE.test(cookie!) && value!.length >= 8 && !isStandIn(value!) && !CODE_START.test(value!))) continue;
      const start = base + (pair.index ?? 0) + pair[0].length - value!.length;
      add("cookie", "cookie value", start, start + value!.length);
    }
  }
  {
    const benign = benignRanges(line);
    for (const m of line.matchAll(LONG_RUN)) {
      const at = m.index ?? 0;
      if (benign.some(([a, b]) => at >= a && at < b)) continue;
      if (looksGenerated(m[0])) add("high-entropy", "generated token", m.index ?? 0, (m.index ?? 0) + m[0].length);
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * Secrets on one line of a file, for Jev's diff check: the release scanner's
 * rules plus every format redaction knows, without flagging ordinary code.
 */
export function detectSecrets(file: string, line: string): SecretSpan[] {
  if (/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/.test(line)) return [{ rule: "private-key", description: "Private key block", start: 0, end: line.length }];
  return scanLine(line, "detect", file);
}

/** Hides every secret Perfect Planner can recognise; the names stay so a reader still sees what was there. */
export function redactSecrets(text: string): string {
  return text
    .replace(PEM_BLOCK, REDACTED)
    .split("\n")
    .map((line) => {
      let out = line;
      for (const span of scanLine(line, "redact", "").reverse()) out = `${out.slice(0, span.start)}${REDACTED}${out.slice(span.end)}`;
      return out;
    })
    .join("\n");
}

/** True when redactSecrets would hide something in the text. */
export function looksSecret(text: string): boolean {
  return redactSecrets(text) !== text;
}

/** What redactSecrets would hide on one line, and why. */
export function redactionSpans(line: string): SecretSpan[] {
  return scanLine(line, "redact", "");
}
