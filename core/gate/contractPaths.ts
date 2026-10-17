// Path rules for task contracts: pure, no git, no files. A contract names the
// files a task may change as repo-relative paths or globs; this module says
// which paths a pattern covers and which paths are never allowed by accident
// (dependency files, the planner's own folder, odd spellings).
//
// Pattern language (the same as the collision engine's file claims, so the
// patterns a contract lists can be handed to the worktree manager as claims):
//   *   any characters inside one folder or file name (never crosses "/")
//   ?   exactly one character inside one name
//   **  any number of folders (zero or more); must be a whole path part
// A pattern also covers everything inside it: "src/components" and
// "src/components/**" are the same area. Matching here is CASE SENSITIVE, so a
// file spelled in another case is outside the list (fail closed). Every
// "never allowed" test below is case INSENSITIVE, because a disk that ignores
// case would treat the two spellings as one file.

/** The planner's own folder holds the ledger, the contracts' signatures and worker tokens. */
export const CONTRACT_PRIVATE_DIR = ".perfect-planner";

/** Forward slashes, no leading "./", no doubled or trailing slash. */
export function normalizePattern(raw: string): string {
  return raw.trim().replaceAll("\\", "/").replace(/^(\.\/)+/, "").replace(/\/{2,}/g, "/").replace(/\/$/, "");
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const FORBIDDEN = /[\\:<>|[\]{}"]/;

/** Segments that are never a real name. Windows ignores a trailing dot or space, so those are aliases. */
function aliasedSegment(part: string): boolean {
  return /[. ]$/.test(part);
}

/**
 * Why a contract may not list this pattern, or null when it can. Stricter than the collision engine's
 * claimPatternProblem (it also refuses Windows aliases and the folders the planner and git own).
 */
export function patternProblem(raw: string): string | null {
  if (typeof raw !== "string" || !raw.trim()) return "A file path is missing.";
  const pattern = normalizePattern(raw);
  if (!pattern) return "A file path is missing.";
  if (pattern.length > 300) return "A file path is longer than 300 characters.";
  if (CONTROL.test(pattern)) return "A file path cannot contain control characters.";
  if (pattern.startsWith("/")) return "File paths must be relative to the project folder, not start with /.";
  if (FORBIDDEN.test(pattern)) return 'File paths cannot contain backslashes, drive letters (:), < > | " or { } [ ] patterns.';
  const parts = pattern.split("/");
  if (parts.some((part) => !part)) return "File paths cannot have empty parts (// or a trailing /).";
  if (parts.some((part) => part === "." || part === "..")) return "File paths cannot use . or .. to step outside a folder.";
  if (parts.some((part) => part.includes("**") && part !== "**")) return "** must be a whole path part, like src/**/index.js.";
  if (parts.some(aliasedSegment)) return "File paths cannot end a name with a dot or a space.";
  if (isProtectedPath(pattern)) return `${CONTRACT_PRIVATE_DIR} and .git belong to Perfect Planner and git; a task can never be allowed to change them.`;
  return null;
}

/** Does one name match a name pattern with * and ?. Case sensitive. */
function nameMatches(pattern: string, name: string): boolean {
  // Iterative glob with backtracking on the last *.
  let p = 0;
  let n = 0;
  let star = -1;
  let mark = 0;
  while (n < name.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === name[n])) {
      p += 1;
      n += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p;
      mark = n;
      p += 1;
    } else if (star >= 0) {
      p = star + 1;
      mark += 1;
      n = mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}

function covers(pattern: string[], file: string[], fold: boolean): boolean {
  const memo = new Map<number, boolean>();
  const visit = (i: number, j: number): boolean => {
    const key = i * (file.length + 1) + j;
    const known = memo.get(key);
    if (known !== undefined) return known;
    memo.set(key, false);
    let result: boolean;
    if (i === pattern.length) result = true; // a pattern covers everything inside it
    else if (pattern[i] === "**") result = visit(i + 1, j) || (j < file.length && visit(i, j + 1));
    else if (j === file.length) result = false;
    else result = (fold ? nameMatches(pattern[i]!.toLowerCase(), file[j]!.toLowerCase()) : nameMatches(pattern[i]!, file[j]!)) && visit(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return visit(0, 0);
}

/** True when `pattern` (a path or glob) covers the concrete repo path `file`. Case sensitive. */
export function pathCovered(pattern: string, file: string): boolean {
  return covers(normalizePattern(pattern).split("/"), normalizePattern(file).split("/"), false);
}

/** Same, ignoring letter case: used where a match means REFUSE (other tasks' claims, protected files). */
export function pathCoveredFolded(pattern: string, file: string): boolean {
  return covers(normalizePattern(pattern).split("/"), normalizePattern(file).split("/"), true);
}

/** Does a pattern contain a wildcard. */
export function isWildcard(pattern: string): boolean {
  return /[*?]/.test(pattern);
}

/** The planner's own folder, or anything inside any `.git` folder. Case insensitive. */
export function isProtectedPath(file: string): boolean {
  const parts = normalizePattern(file).toLowerCase().split("/");
  return parts[0] === CONTRACT_PRIVATE_DIR || parts.includes(".git");
}

const DEPENDENCY_NAMES = new Set(
  [
    // npm, yarn, pnpm, bun, deno
    "package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", ".yarnrc", ".yarnrc.yml", "pnpm-lock.yaml", "pnpm-workspace.yaml",
    ".pnpmfile.cjs", ".npmrc", "bun.lock", "bun.lockb", "deno.json", "deno.jsonc", "deno.lock",
    // Rust, Go
    "cargo.toml", "cargo.lock", "go.mod", "go.sum", "go.work", "go.work.sum",
    // Python
    "pipfile", "pipfile.lock", "pyproject.toml", "poetry.lock", "setup.py", "setup.cfg", "uv.lock",
    // Ruby, PHP, Dart, Swift, Elixir, JVM, .NET
    "gemfile", "gemfile.lock", "composer.json", "composer.lock", "pubspec.yaml", "pubspec.lock", "package.swift", "package.resolved",
    "podfile", "podfile.lock", "mix.exs", "mix.lock", "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts",
    "packages.config", "nuget.config", "directory.packages.props",
    // A submodule is a dependency too.
    ".gitmodules",
  ].map((name) => name.toLowerCase()),
);

/**
 * A file that adds or changes what the project depends on: manifests, lockfiles, package-manager settings
 * and submodules, in any folder. Case insensitive.
 */
export function isDependencyPath(file: string): boolean {
  const base = normalizePattern(file).toLowerCase().split("/").pop() ?? "";
  return DEPENDENCY_NAMES.has(base) || /^(requirements|constraints)[\w.-]*\.txt$/.test(base) || /\.(cs|fs|vb)proj$/.test(base);
}

/** A file that looks like a test: in a tests folder, or named *.test.* / *.spec.* / test_*.py / *_test.go. */
export function isTestLike(file: string): boolean {
  const path = normalizePattern(file);
  const base = path.split("/").pop() ?? "";
  return /(^|\/)(tests?|__tests__|specs?|e2e)\//i.test(path) || /\.(test|spec)\.[a-z0-9]+$/i.test(base) || /^test_.+\.py$/i.test(base) || /_test\.(go|py|rb|rs)$/i.test(base);
}

/** Why a changed path from git looks wrong (a spelling Windows or a shell could read as something else), or null. */
export function oddPathProblem(file: string): string | null {
  if (!file || CONTROL.test(file)) return "an empty name or one with control characters";
  if (file.includes("\\")) return "a backslash in its name";
  if (file.includes(":")) return "a colon in its name (Windows reads that as a data stream or a drive)";
  const parts = file.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return "an empty, . or .. part";
  if (parts.some(aliasedSegment)) return "a name that ends in a dot or a space (Windows reads it as another name)";
  return null;
}

/** Where a symlink points, resolved against the folder it sits in: a repo-relative path, or why that is not possible. */
export function resolveLinkTarget(linkPath: string, target: string): { path: string } | { problem: string } {
  const raw = target.replaceAll("\\", "/");
  if (!raw.trim()) return { problem: "points nowhere" };
  if (CONTROL.test(raw)) return { problem: "has control characters in its target" };
  if (raw.startsWith("/") || /^[a-z]:/i.test(raw)) return { problem: `points at ${target}, outside the project` };
  const stack = normalizePattern(linkPath).split("/").slice(0, -1);
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!stack.length) return { problem: `points at ${target}, outside the project` };
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.length ? { path: stack.join("/") } : { problem: `points at ${target}, the whole project folder` };
}
