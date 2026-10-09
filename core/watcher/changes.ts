import { git } from "../worktrees/git";
import { pathKey, toRepoPath } from "../worktrees/platform";

/** Planner bookkeeping lives here inside each worktree; it is never task work. */
export const IGNORED_PREFIX = ".perfect-planner/";

function keep(file: string): boolean {
  if (!file) return false;
  const key = pathKey(file);
  return key !== pathKey(".perfect-planner") && !key.startsWith(pathKey(IGNORED_PREFIX));
}

function zsplit(text: string): string[] {
  return text.split("\0").filter((part) => part.length > 0);
}

/** Paths changed by commits between `baseSha` and HEAD. Renames count as delete + add, so both names appear. */
export async function committedFiles(worktreePath: string, baseSha: string): Promise<string[]> {
  const out = await git(worktreePath, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", baseSha, "HEAD", "--"]);
  return zsplit(out);
}

/** Staged, unstaged and untracked paths. A staged rename reports both its new and old name. */
export async function uncommittedFiles(worktreePath: string): Promise<string[]> {
  const out = await git(worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]);
  const parts = zsplit(out);
  const files: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    const xy = entry.slice(0, 2);
    files.push(entry.slice(3));
    // In -z v1 output a rename or copy is "XY new\0old\0".
    if (/[RC]/.test(xy) && index + 1 < parts.length) {
      files.push(parts[index + 1]);
      index += 1;
    }
  }
  return files;
}

/** Sorted, de-duplicated, repo-relative forward-slash paths. Dedupe is by the OS path key. */
export function normalizeFileList(files: Iterable<string>): string[] {
  const byKey = new Map<string, string>();
  for (const raw of files) {
    const file = toRepoPath(raw);
    if (!keep(file)) continue;
    const key = pathKey(file);
    if (!byKey.has(key)) byKey.set(key, file);
  }
  return [...byKey.values()].sort(byCodePoint);
}

export function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Everything the task has touched: committed changes since `baseSha` plus
 * staged, unstaged and untracked files. Throws GitError if the folder is not
 * a work tree or `baseSha` is unknown.
 */
export async function changedFiles(worktreePath: string, baseSha: string): Promise<string[]> {
  const [committed, uncommitted] = await Promise.all([committedFiles(worktreePath, baseSha), uncommittedFiles(worktreePath)]);
  return normalizeFileList([...committed, ...uncommitted]);
}
