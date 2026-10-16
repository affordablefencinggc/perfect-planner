// GENERATED from core/secrets/index.ts by core/release/hooks/build-detector.mjs. Do not edit.
export const SECRET_RULES = [
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
export const PLACEHOLDER = /^(?:placeholder|changeme|x{3,}|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|process\.env\.[\w.]+|your[_-][\w-]*|example|dummy|test|redacted|\*{3,}|none|null|undefined|todo)$|^(?:secret:\/\/|keychain:|keyring:|vault:|dpapi:|op:\/\/|credentials:)/i;
export function isPlaceholder(value) {
    return PLACEHOLDER.test(value);
}
export const SENTINEL = /^(?:do[-_]?not|must[-_]?not|never|not[-_]a|fake|dummy|sample|example|placeholder|redacted)(?:[-_][a-z]+)+$/i;
export function isStandIn(value) {
    return isPlaceholder(value) || SENTINEL.test(value);
}
export const WORD_PHRASE = /^[a-z]+(?:[-_.][a-z]+){2,}$/;
const ENV_LINE = /^\s*(?:export\s+|set\s+|setx\s+)?[A-Za-z_][A-Za-z0-9_]*=/;
function phraseExempt(name, value, line) {
    return WORD_PHRASE.test(value) && !(name !== undefined && isSecretName(name)) && !ENV_LINE.test(line);
}
export function minValueLength(name) {
    return /password|passwd|secret/i.test(name) ? 8 : 12;
}
const CONFIG_NAME = /\.(?:ya?ml|ini|cfg|conf|properties|toml)$|^\.env(?:\..+)?$|^\.npmrc$|^dockerfile(?:\..+)?$|^docker-compose/;
function baseName(path) {
    const p = path.replace(/\\/g, "/");
    return p.slice(p.lastIndexOf("/") + 1);
}
export function isConfigLikeFile(path) {
    return CONFIG_NAME.test(baseName(path).toLowerCase());
}
export function maskSecret(s) {
    return `${s.slice(0, 4)}…(${s.length})`;
}
export function findSecrets(file, line, options = {}) {
    const config = options.everywhere === true || isConfigLikeFile(file);
    const found = [];
    const taken = [];
    for (const rule of SECRET_RULES) {
        if (rule.configOnly && !config)
            continue;
        for (const m of line.matchAll(rule.pattern)) {
            const start = m.index ?? 0;
            if (rule.valueGroup === undefined) {
                taken.push([start, start + m[0].length]);
                found.push({ rule: rule.id, description: rule.description, start, end: start + m[0].length, value: m[0] });
                continue;
            }
            const value = m[rule.valueGroup];
            const valueStart = start + m[0].lastIndexOf(value);
            if (taken.some(([a, b]) => valueStart >= a && valueStart < b))
                continue;
            taken.push([valueStart, valueStart + value.length]);
            if (rule.nameGroup !== undefined && value.length < minValueLength(m[rule.nameGroup]))
                continue;
            if (isStandIn(value) || !/[A-Za-z]/.test(value))
                continue;
            if (rule.nameGroup !== undefined && phraseExempt(m[rule.nameGroup], value, line))
                continue;
            found.push({ rule: rule.id, description: rule.description, start: valueStart, end: valueStart + value.length, value, ...(rule.nameGroup !== undefined ? { name: m[rule.nameGroup] } : {}) });
        }
    }
    return found;
}
export const REDACTED = "[redacted-secret]";
const PEM_BLOCK = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$(?![\s\S]))/g;
const VALUE_RULES = [
    { id: "auth-header", description: "Authorization header", pattern: /\b(?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:bearer|basic|token|digest)\s+([A-Za-z0-9._~+/=-]{4,})/gi },
    { id: "bearer-token", description: "Bearer token", pattern: /\bbearer\s+([A-Za-z0-9._~+/-]{12,}=*)/gi },
    { id: "connection-string", description: "password in a connection string", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/"'`]*:([^\s@/"'`]+)@/gi },
    { id: "mysql-password", description: "mysql -p password", pattern: /\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\n]*?\s-p([^\s-][^\s]*)/gi },
    { id: "password-flag", description: "password on a command line", pattern: /--(?:password|passwd|pass|token|secret|api-key|apikey|auth-token)(?:=|\s+)([^\s"'`-][^\s"'`]*)/gi },
    { id: "curl-user", description: "password in curl -u", pattern: /\bcurl\b[^\n]*?\s(?:-u|--user)(?:\s+|=)["']?[^\s:"'$]+:([^\s"'$][^\s"']*)/gi, words: true },
    { id: "npm-token", description: "npm token", pattern: /\b(npm_[A-Za-z0-9]{36})\b/g },
    { id: "stripe-test-key", description: "Stripe test key", pattern: /\b([rs]k_test_[A-Za-z0-9]{16,})/g },
];
const ASSIGNMENT = /([A-Za-z_][A-Za-z0-9_.-]*)["']?[ \t]*[:=][ \t]*(?!\/\/)(?:"([^"\n]+)"|'([^'\n]+)'|([^\s"'`#;,&)]+))/g;
const SECRET_WORDS = new Set(["password", "passwd", "pass", "pwd", "passphrase", "pgpass", "pgpassword", "secret", "token", "apikey", "auth"]);
const KEY_PAIRS = new Set(["api", "private", "access", "secret", "signing", "encryption", "master", "session", "client"]);
function nameWords(name) {
    return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[_.-]+/).filter(Boolean);
}
export function isSecretName(name) {
    const words = nameWords(name);
    const last = words[words.length - 1];
    if (last === undefined)
        return false;
    if (last === "pass")
        return words.length > 1 || name === "pass";
    if (SECRET_WORDS.has(last))
        return true;
    return last === "key" && words.length > 1 && KEY_PAIRS.has(words[words.length - 2]);
}
const ENV_KEY_NAME = /^[A-Z0-9_]+_KEY$/;
const CODE_START = /^(?:[-+!~(\[{`/<>=?:&|*@\\]|\$\{|\$[A-Za-z_(]|%[A-Za-z_]|process\.env|os\.environ|import\.meta)/;
const CODE_CHARS = /=>|[[\](){}<>]/;
const CODE_WORDS = new Set(["string", "number", "boolean", "bigint", "symbol", "object", "unknown", "any", "void", "never", "null", "undefined", "true", "false", "none", "nil", "await", "new", "this", "self", "typeof", "function", "async", "return", "const", "let", "var", "str", "int", "bytes", "buffer", "uint8array", "readonly", "optional"]);
const IDENTIFIER_CHAIN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const YAML_LINE = /^\s*(?:-\s+)?["']?[A-Za-z_][\w.-]*["']?\s*:\s*[^\s,;{}()]+\s*(?:#.*)?$/;
function isLiteralSecret(name, value, quoted, context) {
    if (value.length < 3 || value.includes(REDACTED) || isStandIn(value) || !/[A-Za-z0-9]/.test(value))
        return false;
    if (context.mode === "detect" && !context.envLine && !context.configFile && value.length < minValueLength(name))
        return false;
    if (quoted) {
        if (/\s/.test(value) || SECRET_WORDS.has(value.toLowerCase()))
            return false;
        return true;
    }
    if (CODE_START.test(value) || CODE_CHARS.test(value) || CODE_WORDS.has(value.toLowerCase()))
        return false;
    if (!IDENTIFIER_CHAIN.test(value))
        return true;
    if (context.envLine)
        return true;
    if (context.configFile || context.yamlLine)
        return true;
    if (context.mode !== "redact" || value.includes(".") || /^[_$]/.test(value) || /[a-z][A-Z]/.test(value) || SECRET_WORDS.has(value.toLowerCase()))
        return false;
    return /\d/.test(value) || context.yamlLine;
}
function entropy(s) {
    const counts = new Map();
    for (const c of s)
        counts.set(c, (counts.get(c) ?? 0) + 1);
    let bits = 0;
    for (const n of counts.values())
        bits -= (n / s.length) * Math.log2(n / s.length);
    return bits;
}
const BENIGN_BLOBS = [/\bsha(?:256|384|512)-[A-Za-z0-9+/]{40,}={0,2}/g, /\bdata:[\w.+-]+\/[\w.+-]+(?:;[\w.+-]+=[\w.+-]+)*;base64,[A-Za-z0-9+/]+={0,2}/g];
function benignRanges(line) {
    const ranges = [];
    for (const pattern of BENIGN_BLOBS)
        for (const m of line.matchAll(pattern))
            ranges.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    return ranges;
}
const LONG_RUN = /[A-Za-z0-9+_-]{32,}={0,2}/g;
const LABELLED_HEX = /^[A-Za-z]{0,16}(?:[0-9a-f]{32,}|[0-9A-F]{32,})$/;
function looksGenerated(run) {
    if (LABELLED_HEX.test(run.replace(/=+$/, "")))
        return false;
    return /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run) && entropy(run) >= 4;
}
const COOKIE_HEADER = /\b(?:set-)?cookie\s*:\s*([^\n]+)/gi;
const SESSION_COOKIE = /sess|sid|token|auth|jwt|login|remember/i;
const COOKIE_ATTRIBUTES = new Set(["path", "domain", "expires", "max-age", "samesite", "secure", "httponly", "priority", "partitioned"]);
function scanLine(line, mode, file) {
    const spans = [];
    const add = (rule, description, start, end) => {
        if (end > start && !spans.some((s) => start < s.end && end > s.start))
            spans.push({ rule, description, start, end });
    };
    const configFile = isConfigLikeFile(file);
    const context = { mode, envLine: false, configFile, yamlLine: YAML_LINE.test(line) };
    for (const f of findSecrets(file, line, { everywhere: mode === "redact" })) {
        if (f.name !== undefined && !isSecretName(f.name))
            continue;
        add(f.rule, f.description, f.start, f.end);
    }
    for (const rule of VALUE_RULES) {
        for (const m of line.matchAll(rule.pattern)) {
            const value = m[1];
            if (!value || isStandIn(value) || CODE_START.test(value) || value.includes(REDACTED) || !/[A-Za-z0-9]/.test(value) || (!rule.words && SECRET_WORDS.has(value.toLowerCase())))
                continue;
            const start = (m.index ?? 0) + m[0].lastIndexOf(value);
            add(rule.id, rule.description, start, start + value.length);
        }
    }
    for (const m of line.matchAll(ASSIGNMENT)) {
        const [, name, dq, sq, bare] = m;
        const value = dq ?? sq ?? bare ?? "";
        const secretName = isSecretName(name) || (bare !== undefined && ENV_KEY_NAME.test(name));
        const envLine = ENV_LINE.test(line.slice(m.index ?? 0)) && /^\s*(?:(?:export|set|setx)\s+)?$/.test(line.slice(0, m.index ?? 0));
        if (!secretName || !isLiteralSecret(name, value, bare === undefined, { ...context, envLine }))
            continue;
        const start = (m.index ?? 0) + m[0].lastIndexOf(value);
        add("secret-assignment", `value assigned to ${name}`, start, start + value.length);
    }
    for (const m of line.matchAll(COOKIE_HEADER)) {
        const base = (m.index ?? 0) + m[0].length - m[1].length;
        for (const pair of m[1].matchAll(/([^=;\s]+)=([^;\s]+)/g)) {
            const [, cookie, value] = pair;
            if (COOKIE_ATTRIBUTES.has(cookie.toLowerCase()))
                continue;
            if (mode === "detect" && !(SESSION_COOKIE.test(cookie) && value.length >= 8 && !isStandIn(value) && !CODE_START.test(value)))
                continue;
            const start = base + (pair.index ?? 0) + pair[0].length - value.length;
            add("cookie", "cookie value", start, start + value.length);
        }
    }
    {
        const benign = benignRanges(line);
        for (const m of line.matchAll(LONG_RUN)) {
            const at = m.index ?? 0;
            if (benign.some(([a, b]) => at >= a && at < b))
                continue;
            if (looksGenerated(m[0]))
                add("high-entropy", "generated token", m.index ?? 0, (m.index ?? 0) + m[0].length);
        }
    }
    return spans.sort((a, b) => a.start - b.start);
}
export function detectSecrets(file, line) {
    if (/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/.test(line))
        return [{ rule: "private-key", description: "Private key block", start: 0, end: line.length }];
    return scanLine(line, "detect", file);
}
export function redactSecrets(text) {
    return text
        .replace(PEM_BLOCK, REDACTED)
        .split("\n")
        .map((line) => {
        let out = line;
        for (const span of scanLine(line, "redact", "").reverse())
            out = `${out.slice(0, span.start)}${REDACTED}${out.slice(span.end)}`;
        return out;
    })
        .join("\n");
}
export function looksSecret(text) {
    return redactSecrets(text) !== text;
}
export function redactionSpans(line) {
    return scanLine(line, "redact", "");
}
