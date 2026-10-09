// Deterministic diff pre-checks that run before Jev spends any budget.
// A finding here is an automatic reject: files outside the task scope,
// deleted or weakened tests, and added secrets. Nothing in this module calls
// a model, touches the network, or echoes a matched secret.

// Mirrors the rule set in scripts/verify-secrets.mjs (that file is a CLI
// script with top-level effects, so it cannot be imported). Keep in sync.
export const SECRET_RULES = Object.freeze([
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9_]{30,255}|github_pat_[A-Za-z0-9_]{40,255})\b/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["slack-token", /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/],
  ["openai-key", /\bsk-(?:proj-|svcacct-|ant-)?[A-Za-z0-9_-]{20,255}\b/],
  ["generic-assignment", /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password)["']?\s*[:=]\s*["'][^"'\r\n]{12,}["']/i],
  ["environment-secret", /^\s*(?:export\s+)?[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*[A-Za-z0-9_./+~-]{16,}/],
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/],
]);

const ASSERTION = /\bassert(?:\.[A-Za-z]+)?\s*\(|\bexpect\s*\(|\.should\b|\bt\.(?:is|deepEqual|true|false|throws|equal|ok)\s*\(|\bself\.assert[A-Za-z]*\s*\(|^\s*assert\s|\bassert_(?:eq|ne)?!\s*\(|\bassert!\s*\(/;
const SKIP = /\b(?:it|test|describe|suite)\.(?:skip|todo|only)\s*\(|\bx(?:it|describe|test)\s*\(|\{\s*skip\s*:\s*true|\bt\.skip\s*\(|@pytest\.mark\.skip|@unittest\.skip|#\[ignore\]|\bt\.Skip\(/;

export function normalizePath(file) {
  return String(file ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
}

export function isTestPath(file) {
  const p = normalizePath(file);
  return /(^|\/)(tests?|tests-ui|__tests__|spec|specs)\//.test(p)
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p)
    || /(^|\/)test_[^/]+\.py$/.test(p) || /_test\.(py|go|rs)$/.test(p);
}

function unquote(raw) {
  let p = raw.trim();
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1).replace(/\\(["\\])/g, "$1").replace(/\\t/g, "\t");
  return p;
}

function stripPrefix(p) {
  if (p === "/dev/null") return null;
  return normalizePath(p.replace(/^[ab]\//, ""));
}

/** Parses a unified (git) diff into files, hunks and numbered lines. */
export function parseUnifiedDiff(diff) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;
  const startFile = () => {
    file = { oldPath: null, newPath: null, status: "modified", binary: false, hunks: [] };
    files.push(file);
    hunk = null;
  };
  for (const line of String(diff ?? "").split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      startFile();
      const m = /^diff --git ("?a\/.+?"?) ("?b\/.+"?)$/.exec(line);
      if (m) { file.oldPath = stripPrefix(unquote(m[1])); file.newPath = stripPrefix(unquote(m[2])); }
      continue;
    }
    if (line.startsWith("--- ") && (!hunk || hunk.done)) {
      if (!file || file.hunks.length) startFile();
      file.oldPath = stripPrefix(unquote(line.slice(4).split("\t")[0]));
      if (file.oldPath === null) file.status = "added";
      continue;
    }
    if (line.startsWith("+++ ") && file && (!hunk || hunk.done)) {
      file.newPath = stripPrefix(unquote(line.slice(4).split("\t")[0]));
      if (file.newPath === null) file.status = "deleted";
      continue;
    }
    if (!file) continue;
    if (line.startsWith("new file mode")) { file.status = "added"; continue; }
    if (line.startsWith("deleted file mode")) { file.status = "deleted"; continue; }
    if (line.startsWith("rename from ")) { file.status = "renamed"; file.oldPath = normalizePath(unquote(line.slice(12))); continue; }
    if (line.startsWith("rename to ")) { file.status = "renamed"; file.newPath = normalizePath(unquote(line.slice(10))); continue; }
    if (line.startsWith("Binary files ")) { file.binary = true; continue; }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) {
      hunk = { lines: [], oldLeft: h[2] === undefined ? 1 : Number(h[2]), newLeft: h[4] === undefined ? 1 : Number(h[4]), done: false };
      hunk.done = hunk.oldLeft === 0 && hunk.newLeft === 0;
      file.hunks.push(hunk);
      oldLine = Number(h[1]);
      newLine = Number(h[3]);
      continue;
    }
    if (!hunk || hunk.done) continue;
    if (line.startsWith("+")) { hunk.lines.push({ kind: "+", text: line.slice(1), newLine: newLine++ }); hunk.newLeft--; }
    else if (line.startsWith("-")) { hunk.lines.push({ kind: "-", text: line.slice(1), oldLine: oldLine++ }); hunk.oldLeft--; }
    else if (line.startsWith(" ") || line === "") { hunk.lines.push({ kind: " ", text: line.slice(1) }); oldLine++; newLine++; hunk.oldLeft--; hunk.newLeft--; }
    if (hunk.oldLeft <= 0 && hunk.newLeft <= 0) hunk.done = true;
  }
  for (const f of files) {
    if (f.status === "added") f.oldPath = null;
    if (f.status === "deleted") f.newPath = null;
    f.path = f.newPath ?? f.oldPath;
  }
  return files.filter((f) => f.path);
}

/** True when `file` is inside the task scope. Entries are exact paths, folder prefixes ending in "/", or prefixes ending in "/**". */
export function inScope(file, scope) {
  const p = normalizePath(file);
  return scope.some((raw) => {
    const s = normalizePath(raw);
    if (s.endsWith("/**")) return p.startsWith(s.slice(0, -2));
    if (s.endsWith("/")) return p.startsWith(s);
    return p === s;
  });
}

const norm = (text) => text.trim().replace(/\s+/g, " ");

/**
 * Runs every deterministic check. Returns { ok, notes } where each note is
 * { file, line, rule, note }. Notes never contain secret material.
 */
export function precheckDiff({ diff, files: scope }) {
  const notes = [];
  const parsed = parseUnifiedDiff(diff);
  if (!Array.isArray(scope) || scope.length === 0) {
    notes.push({ file: null, line: null, rule: "scope-missing", note: "No task file scope was supplied, so the diff cannot be shown to stay inside the task." });
  }
  if (String(diff ?? "").trim() && parsed.length === 0) {
    notes.push({ file: null, line: null, rule: "diff-unparsed", note: "The diff could not be parsed as a unified diff." });
  }
  for (const f of parsed) {
    const touched = [f.oldPath, f.newPath].filter(Boolean);
    if (Array.isArray(scope) && scope.length) {
      for (const p of new Set(touched)) {
        if (!inScope(p, scope)) notes.push({ file: p, line: null, rule: "out-of-scope", note: `Changes ${p}, which is outside the task's files.` });
      }
    }
    if (f.status === "deleted" && isTestPath(f.oldPath)) {
      notes.push({ file: f.oldPath, line: null, rule: "test-deleted", note: `Deletes test file ${f.oldPath}.` });
    }
    if (f.status === "renamed" && isTestPath(f.oldPath) && !isTestPath(f.newPath)) {
      notes.push({ file: f.oldPath, line: null, rule: "test-deleted", note: `Moves test file ${f.oldPath} out of the test suite (${f.newPath}).` });
    }
    const added = f.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "+"));
    const removed = f.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "-"));
    if (isTestPath(f.oldPath ?? f.newPath) && f.status !== "deleted") {
      const addedSet = new Map();
      for (const l of added) addedSet.set(norm(l.text), (addedSet.get(norm(l.text)) ?? 0) + 1);
      for (const l of removed) {
        if (!ASSERTION.test(l.text)) continue;
        const key = norm(l.text);
        if (addedSet.get(key)) { addedSet.set(key, addedSet.get(key) - 1); continue; }
        notes.push({ file: f.oldPath ?? f.newPath, line: l.oldLine, rule: "assertion-removed", note: `Removes or changes an assertion in ${f.oldPath ?? f.newPath} (old line ${l.oldLine}).` });
      }
      for (const l of added) {
        if (SKIP.test(l.text)) notes.push({ file: f.path, line: l.newLine, rule: "test-skipped", note: `Skips or isolates tests in ${f.path} (line ${l.newLine}).` });
      }
    }
    for (const l of added) {
      for (const [rule, pattern] of SECRET_RULES) {
        if (pattern.test(l.text)) {
          notes.push({ file: f.path, line: l.newLine, rule: "secret-added", note: `Adds what looks like a secret (${rule}) in ${f.path} at line ${l.newLine}; value withheld.` });
          break;
        }
      }
    }
  }
  return { ok: notes.length === 0, notes, files: parsed.map((f) => ({ path: f.path, status: f.status })) };
}
