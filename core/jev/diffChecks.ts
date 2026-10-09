// The fixed, deterministic half of the diff review (spec §6.3). Perfect
// Planner checks these itself before Jev is asked anything, so a change that
// leaves the task's files, weakens a test or adds a secret is rejected with
// line notes even when Jev is unavailable.

export interface DiffLine {
  line: number;
  text: string;
}

export interface DiffFile {
  path: string;
  /** The path before the change, for renames and deletions. */
  oldPath: string;
  deleted: boolean;
  added: DiffLine[];
  removed: DiffLine[];
}

export interface LineNote {
  file: string;
  line?: number;
  note: string;
  rule: "scope" | "tests" | "secret";
}

function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, "");
}

/** Parse a unified git diff into files with their added and removed lines. */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith("diff --git ")) {
      const m = raw.match(/^diff --git (\S+) (\S+)$/);
      current = { path: stripPrefix(m?.[2] ?? ""), oldPath: stripPrefix(m?.[1] ?? ""), deleted: false, added: [], removed: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("deleted file mode")) current.deleted = true;
    else if (raw.startsWith("--- ")) {
      const p = raw.slice(4).trim();
      if (p !== "/dev/null") current.oldPath = stripPrefix(p);
    } else if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      if (p !== "/dev/null") current.path = stripPrefix(p);
    } else if (raw.startsWith("@@")) {
      const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldLine = Number(m?.[1] ?? 0);
      newLine = Number(m?.[2] ?? 0);
    } else if (raw.startsWith("+")) {
      current.added.push({ line: newLine++, text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      current.removed.push({ line: oldLine++, text: raw.slice(1) });
    } else if (raw.startsWith(" ")) {
      oldLine++;
      newLine++;
    }
  }
  return files;
}

/** A path is in scope when it equals an allowed path or sits under an allowed folder ("src/invoice/"). */
export function inScope(path: string, allowed: readonly string[]): boolean {
  const p = path.replace(/\\/g, "/");
  return allowed.some((a) => {
    const rule = a.replace(/\\/g, "/");
    if (rule.endsWith("/**")) return p.startsWith(rule.slice(0, -2));
    if (rule.endsWith("/")) return p.startsWith(rule);
    return p === rule;
  });
}

const TEST_FILE = /(^|\/)(tests?|__tests__|tests-ui|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const ASSERTION = /\b(expect|assert)\s*[.(]|\b(it|test|describe)\s*\(/;
const SKIPPED = /\b(it|test|describe)\s*\.\s*(skip|only|todo)\s*\(|\bx(it|describe)\s*\(/;

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path.replace(/\\/g, "/"));
}

export const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "OpenAI-style key", pattern: /\bsk-(?:live_|test_|proj-|ant-)?[A-Za-z0-9_-]{20,}/ },
  { name: "Stripe key", pattern: /\b[rs]k_(live|test)_[A-Za-z0-9]{16,}/ },
  { name: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "assigned secret", pattern: /\b(api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*["'][^"'\s]{12,}["']/i },
];

export function checkDiff(files: readonly DiffFile[], allowed: readonly string[]): LineNote[] {
  const notes: LineNote[] = [];
  for (const file of files) {
    if (allowed.length && !inScope(file.path, allowed) && !(file.deleted && inScope(file.oldPath, allowed))) {
      notes.push({ file: file.path, rule: "scope", note: "This file is outside the task's files." });
    }
    if (isTestFile(file.oldPath) || isTestFile(file.path)) {
      if (file.deleted) notes.push({ file: file.oldPath, rule: "tests", note: "A test file is deleted." });
      const removedAssertions = file.removed.filter((l) => ASSERTION.test(l.text)).length;
      const addedAssertions = file.added.filter((l) => ASSERTION.test(l.text)).length;
      if (!file.deleted && removedAssertions > addedAssertions) {
        const first = file.removed.find((l) => ASSERTION.test(l.text))!;
        notes.push({ file: file.path, line: first.line, rule: "tests", note: `${removedAssertions - addedAssertions} test assertion(s) removed.` });
      }
      for (const l of file.added) if (SKIPPED.test(l.text)) notes.push({ file: file.path, line: l.line, rule: "tests", note: "A test is skipped or focused (.skip, .only, .todo)." });
    }
    for (const l of file.added) {
      const hit = SECRET_PATTERNS.find((s) => s.pattern.test(l.text));
      if (hit) notes.push({ file: file.path, line: l.line, rule: "secret", note: `Looks like a ${hit.name} was added.` });
    }
  }
  return notes;
}
