// File-scope claim patterns shared by the Ledger and collision checks.
//
// A claim is a project-relative path written with "/". It may use a small,
// safe glob subset:
//   *   any characters inside one folder or file name (never crosses "/")
//   ?   exactly one character inside one name
//   **  any number of folders (zero or more); must be a whole path part
// A claim also covers everything inside it, so "src/components" and
// "src/components/**" describe the same area.
//
// Overlap is conservative: two claims overlap when some concrete path could be
// matched by both. Comparison ignores letter case, matching the existing
// case-insensitive collision rules; callers keep the original text for display.

export const CLAIM_PATTERN_HELP = "Use project paths with / such as src/app.js, src/core/** or tests/core-*.test.mjs. * matches within one name, ** matches any folders, ? matches one character.";

const FORBIDDEN = /[\\:<>|\[\]{}\u0000-\u001f]/;

/** Returns null for an acceptable claim, otherwise a plain-language reason. */
export function claimPatternProblem(path) {
  if (typeof path !== "string" || !path) return "A file scope path is missing.";
  if (path.startsWith("/")) return "File scope paths must be relative to the project folder, not start with /.";
  if (FORBIDDEN.test(path)) return "File scope paths cannot contain backslashes, drive letters (:), < > |, or { } [ ] patterns.";
  const parts = path.split("/");
  if (parts.some((part) => !part)) return "File scope paths cannot have empty parts (// or a trailing /).";
  if (parts.some((part) => part === "." || part === "..")) return "File scope paths cannot use . or .. to step outside a folder.";
  if (parts.some((part) => part.includes("**") && part !== "**")) return "** must be a whole path part, like src/**/index.js.";
  return null;
}

export const isClaimPattern = (path) => /[*?]/.test(path);

const segmentsOf = (path) => {
  const parts = String(path).toLowerCase().split("/").filter(Boolean);
  // Every claim covers what is inside it.
  if (parts.at(-1) !== "**") parts.push("**");
  // Consecutive ** parts mean the same as one.
  return parts.filter((part, index) => !(part === "**" && parts[index - 1] === "**"));
};

/** True when some single name matches both name patterns (with * and ?). */
export function namePatternsOverlap(left, right) {
  const a = String(left).toLowerCase(), b = String(right).toLowerCase();
  const memo = new Map();
  const visit = (i, j) => {
    const key = i * (b.length + 1) + j;
    if (memo.has(key)) return memo.get(key);
    memo.set(key, false);
    let result;
    if (i === a.length && j === b.length) result = true;
    else if (a[i] === "*") result = visit(i + 1, j) || (j < b.length && visit(i, j + 1));
    else if (b[j] === "*") result = visit(i, j + 1) || (i < a.length && visit(i + 1, j));
    else if (i === a.length || j === b.length) result = false;
    else result = (a[i] === "?" || b[j] === "?" || a[i] === b[j]) && visit(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return visit(0, 0);
}

/**
 * True when some concrete project path is covered by both claims.
 * Inputs are claim paths already accepted by claimPatternProblem (or the
 * collision engine's normalized file surfaces).
 */
export function claimPatternsOverlap(left, right) {
  const a = segmentsOf(left), b = segmentsOf(right);
  const memo = new Map();
  const visit = (i, j) => {
    const key = i * (b.length + 1) + j;
    if (memo.has(key)) return memo.get(key);
    memo.set(key, false);
    let result;
    if (i === a.length && j === b.length) result = true;
    else if (a[i] === "**") result = visit(i + 1, j) || (j < b.length && visit(i, j + 1));
    else if (b[j] === "**") result = visit(i, j + 1) || (i < a.length && visit(i + 1, j));
    else if (i === a.length || j === b.length) result = false;
    else result = namePatternsOverlap(a[i], b[j]) && visit(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return visit(0, 0);
}
