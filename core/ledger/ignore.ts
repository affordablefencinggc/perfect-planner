import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Keeps the planner's private folder out of the user's commits: adds it to
 * the repo's .git/info/exclude (shared by every worktree; the tracked
 * .gitignore is left alone). Writes the same line as core/worktrees'
 * ensureRequiredIgnores ("/.perfect-planner/" at the repo root), so either
 * may run first without a duplicate. Does nothing outside a git repo or
 * when git is not installed. Returns the line added, if any.
 */
export function excludePrivateFolder(projectRoot: string): string | undefined {
  let top: string;
  let common: string;
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel", "--git-common-dir"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      timeout: 10_000,
    })
      .trim()
      .split(/\r?\n/);
    top = out[0];
    common = path.resolve(projectRoot, out[1]);
  } catch {
    return undefined;
  }
  const relative = path.relative(fs.realpathSync(top), fs.realpathSync(projectRoot)).split(path.sep).join("/");
  if (relative.startsWith("..")) return undefined;
  const line = `/${relative ? `${relative}/` : ""}.perfect-planner/`;
  const exclude = path.join(common, "info", "exclude");
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
  if (current.split(/\r?\n/).includes(line)) return undefined;
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.writeFileSync(exclude, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`);
  return line;
}
