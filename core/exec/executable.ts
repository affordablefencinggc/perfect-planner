import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

/**
 * Set on every child we start. On Windows it stops CreateProcess (and cmd.exe) from looking in the
 * current folder before PATH, so a program planted in the user's repo is never picked up by name.
 */
export const NO_CWD_SEARCH_ENV = { NoDefaultCurrentDirectoryInExePath: "1" } as const;

const isNetworkPath = (dir: string, platform: NodeJS.Platform) => platform === "win32" && /^[\\/]{2}/.test(dir);

/**
 * Absolute path of `name` from PATH, never from the current folder: relative and empty PATH entries,
 * network shares and any entry inside `cwd` are skipped. On Windows only `.exe` counts, since a
 * .cmd/.bat cannot be started without a shell. Returns null when nothing qualifies.
 */
export function findExecutable(name: string, env: NodeJS.ProcessEnv, cwd: string, platform: NodeJS.Platform = process.platform): string | null {
  const windows = platform === "win32";
  const pathValue = Object.entries(env).find(([key]) => (windows ? key.toUpperCase() === "PATH" : key === "PATH"))?.[1] ?? "";
  const here = path.resolve(cwd);
  const extensions = windows ? [".exe"] : [""];
  for (const entry of pathValue.split(windows ? ";" : ":")) {
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || !path.isAbsolute(dir) || isNetworkPath(dir, platform)) continue;
    if (isWithin(here, path.resolve(dir))) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, `${name}${extension}`);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (!windows) accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** True when `candidate` is `root` or inside it. */
export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export class ExecutableNotFoundError extends Error {}

let cached: { pathValue: string; file: string } | undefined;

/**
 * The absolute git to run, resolved once from PATH (again only if PATH changes) and never from the
 * repo: spawn("git") with cwd set to a cloned repo would run a git.exe planted in it on Windows.
 * Refuses a git that sits inside `cwd`. Use this for every git spawn, with NO_CWD_SEARCH_ENV in its env.
 */
export function gitExecutable(cwd: string = process.cwd()): string {
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  if (cached?.pathValue !== pathValue) {
    const file = findExecutable("git", process.env, cwd);
    if (!file) throw new ExecutableNotFoundError("git was not found on PATH (relative PATH entries and the repo folder are never searched). Install Git and restart Perfect Planner.");
    cached = { pathValue, file };
  }
  if (isWithin(path.resolve(cwd), cached.file)) {
    throw new ExecutableNotFoundError(`The git on PATH (${cached.file}) is inside ${cwd}, so it could be the repo's own; refusing to run it.`);
  }
  return cached.file;
}
