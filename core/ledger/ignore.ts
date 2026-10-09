import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gitExecutable, NO_CWD_SEARCH_ENV } from "../exec";

/**
 * Keeps the planner's private folder out of the user's commits: adds it to
 * the repo's .git/info/exclude (shared by every worktree; the tracked
 * .gitignore is left alone). Writes the same line as core/worktrees'
 * ensureRequiredIgnores ("/.perfect-planner/" at the repo root), so either
 * may run first without a duplicate. Does nothing outside a git repo or
 * when git is not on PATH. Returns the line added, if any.
 */
export function excludePrivateFolder(projectRoot: string): string | undefined {
  let prefix: string;
  let common: string;
  try {
    // git reports where the project sits in the repo, so no path comparison (8.3 names, drive
    // letter case, symlinks) is needed. The git is resolved from PATH, never from the repo.
    const out = execFileSync(gitExecutable(projectRoot), ["rev-parse", "--show-prefix", "--git-common-dir"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: { ...process.env, ...NO_CWD_SEARCH_ENV },
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      timeout: 10_000,
    }).split(/\r?\n/);
    prefix = out[0].replace(/\/+$/, "");
    common = path.resolve(projectRoot, out[1]);
  } catch {
    return undefined;
  }
  const line = `/${prefix ? `${prefix}/` : ""}.perfect-planner/`;
  const exclude = path.join(common, "info", "exclude");
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
  if (current.split(/\r?\n/).includes(line)) return undefined;
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.writeFileSync(exclude, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`);
  return line;
}
