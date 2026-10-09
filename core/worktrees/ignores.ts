import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { git } from "./git";
import { lines, pathKey, toRepoPath } from "./platform";

/** Planner-private folder inside the user's repo: the ledger, worker tokens, task worktrees. Never committed. */
export const PRIVATE_DIR = ".perfect-planner";

/**
 * Patterns kept in the repo's .git/info/exclude (shared by every worktree), so `git add -A` never picks up
 * the ledger or a worker token. The tracked .gitignore is left alone.
 */
export const REQUIRED_IGNORES = [`/${PRIVATE_DIR}/`] as const;

/** Add any missing REQUIRED_IGNORES (plus `extra`) to the repo's info/exclude. Returns the patterns added. */
export async function ensureRequiredIgnores(cwd: string, extra: readonly string[] = []): Promise<string[]> {
  const exclude = path.join(path.resolve(cwd, await git(cwd, ["rev-parse", "--git-common-dir"])), "info", "exclude");
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  const present = new Set(current.split(/\r?\n/));
  const missing = [...REQUIRED_IGNORES, ...extra].filter((pattern, index, all) => !present.has(pattern) && all.indexOf(pattern) === index);
  if (!missing.length) return [];
  mkdirSync(path.dirname(exclude), { recursive: true });
  writeFileSync(exclude, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  return missing;
}

/** The repo-relative paths that sit in the planner-private folder (case-insensitively where the disk is). */
export function privatePaths(files: readonly string[]): string[] {
  const dir = pathKey(PRIVATE_DIR);
  return files.filter((file) => {
    const key = pathKey(toRepoPath(file));
    return key === dir || key.startsWith(`${dir}/`);
  });
}

/** Paths under the planner-private folder that are staged or tracked in cwd's index (and so in its next commit). */
export async function stagedPrivatePaths(cwd: string): Promise<string[]> {
  return privatePaths(lines(await git(cwd, ["-c", "core.quotePath=false", "ls-files", "--cached", "--", `:(icase)${PRIVATE_DIR}`])));
}
