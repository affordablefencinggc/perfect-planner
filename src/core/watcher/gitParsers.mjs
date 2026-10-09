// Pure parsers for the git output the watcher reads. No I/O, no shell.

const RECORD_SEPARATOR = "\x1e";
const FIELD_SEPARATOR = "\x1f";

// "Implements: P-2 §3.1 (T-14)" -> ["P-2 §3.1"]. Several refs may be separated
// by commas or semicolons. Only plan-qualified clause refs are returned; the
// trailing "(T-14)" task marker is ignored here.
const PLAN_CLAUSE_REF = /^(P-\d+)\s+(§\d+(?:\.\d+)*)/;

export function parseImplementsRefs(message) {
  if (typeof message !== "string" || message.length === 0) return [];
  const refs = [];
  for (const line of message.split(/\r?\n/)) {
    const match = /^\s*implements:\s*(.*)$/i.exec(line);
    if (!match) continue;
    for (const part of match[1].split(/[,;]/)) {
      const ref = PLAN_CLAUSE_REF.exec(part.trim());
      if (ref) {
        const value = `${ref[1]} ${ref[2]}`;
        if (!refs.includes(value)) refs.push(value);
      }
    }
  }
  return refs;
}

// Parses output of `git diff --name-only -z` (NUL separated, no quoting).
export function parseNulList(text) {
  if (typeof text !== "string") return [];
  return text.split("\0").filter((entry) => entry.length > 0);
}

// Parses `git status --porcelain=v1 -z`. Each entry is "XY PATH"; a rename or
// copy is followed by a second NUL field holding the original path, which is
// skipped because the new path is the one that changed.
export function parseStatusZ(text) {
  if (typeof text !== "string") return [];
  const fields = text.split("\0");
  const paths = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path) paths.push(path);
    if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") {
      index += 1;
    }
  }
  return paths;
}

// Parses `git worktree list --porcelain` into [{ path, branch }].
// `branch` is the short branch name, or null for detached/bare worktrees.
export function parseWorktreePorcelain(text) {
  if (typeof text !== "string") return [];
  const worktrees = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: null };
      worktrees.push(current);
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line.trim() === "") {
      current = null;
    }
  }
  return worktrees;
}

// Parses output of a log run with the format
//   %H%x1f%s%x1f%b%x1f%cI%x1e
// into [{ hash, subject, body, committedAt }], newest first (git order).
export function parseCommitLog(text) {
  if (typeof text !== "string") return [];
  const commits = [];
  for (const rawRecord of text.split(RECORD_SEPARATOR)) {
    const record = rawRecord.replace(/^\s+/, "");
    if (record.length === 0) continue;
    const fields = record.split(FIELD_SEPARATOR);
    if (fields.length < 4) continue;
    const hash = fields[0].trim();
    if (!/^[0-9a-f]{7,64}$/i.test(hash)) continue;
    commits.push({
      hash,
      subject: fields[1].trim(),
      body: fields.slice(2, -1).join(FIELD_SEPARATOR),
      committedAt: fields[fields.length - 1].trim(),
    });
  }
  return commits;
}
