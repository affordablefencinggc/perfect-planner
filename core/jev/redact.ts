// Secret patterns shared by the diff checks, everything sent to Jev, and the
// text agents write through the relay and tools. Redaction is deliberately
// eager: a false positive costs a word, a miss leaks a key.

export const REDACTED = "[redacted-secret]";

const SECRET_NAME = String.raw`[A-Za-z0-9_.-]*?(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|private[_-]?key|access[_-]?key|credentials?)[A-Za-z0-9_.-]*`;

export const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "private key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/ },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "OpenAI-style key", pattern: /\bsk-(?:live_|test_|proj-|ant-)?[A-Za-z0-9_-]{20,}/ },
  { name: "Stripe key", pattern: /\b[rs]k_(live|test)_[A-Za-z0-9]{16,}/ },
  { name: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  // apiKey = "...", "client_secret": "...", password: '...'
  { name: "assigned secret", pattern: /\b[A-Za-z0-9_]*?(api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["'](?!\[redacted)[^"'\s]{12,}["']/i },
  // DB_PASSWORD=..., export GITHUB_TOKEN=... (env files and shell lines)
  { name: "env secret", pattern: new RegExp(String.raw`(?:^|[\s+;])(?:export\s+)?[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*=(?!["'$[])[^\s"'&;]{6,}`) },
];

// A whole PEM block, BEGIN through END; with no END line, to the end of the text.
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----|$(?![\s\S]))/g;

// Replacing only the value keeps the name, so a reader still sees what was there.
const QUOTED_VALUE = new RegExp(String.raw`(\b${SECRET_NAME}["']?\s*[:=]\s*)(["'])(?!\[redacted)[^"'\s]{8,}\2`, "gi");
const BARE_VALUES = [
  new RegExp(String.raw`((?:^|[\s+;])(?:export\s+)?[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*=)(?!["'$[])[^\s"'&;]{6,}`, "g"),
  // Lower-case and query-string forms that the diff check leaves alone: token=..., api_key=...
  new RegExp(String.raw`(\b${SECRET_NAME}=)(?!["'$[])[^\s"'&;]{6,}`, "gi"),
];

export function redactSecrets(text: string): string {
  let out = text.replace(PEM_BLOCK, REDACTED);
  out = out.replace(QUOTED_VALUE, `$1$2${REDACTED}$2`);
  for (const pattern of BARE_VALUES) out = out.replace(pattern, `$1${REDACTED}`);
  for (const { pattern } of SECRET_PATTERNS) out = out.replace(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`), REDACTED);
  return out;
}

export function looksSecret(text: string): boolean {
  return redactSecrets(text) !== text;
}
