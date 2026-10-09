import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Set on every child we start. On Windows it stops CreateProcess (and cmd.exe) from looking in the
 * current folder before PATH, so a program planted in the user's repo is never picked up by name.
 */
export const NO_CWD_SEARCH_ENV = { NoDefaultCurrentDirectoryInExePath: "1" } as const;

const isNetworkPath = (dir: string, platform: NodeJS.Platform) => platform === "win32" && /^[\\/]{2}/.test(dir);

/**
 * Absolute path of `name` from PATH, never from the current folder: relative and empty PATH
 * entries, network shares, entries whose folder cannot be resolved, and any entry inside `cwd` are
 * skipped. Paths are compared as written and as real paths, so a PATH entry or a program that
 * reaches `cwd` through a symlink or junction (on macOS every temp folder does: /var is
 * /private/var) is still recognised. On Windows only `.exe` counts, since a .cmd/.bat cannot be
 * started without a shell. `protect` adds roots the host registered itself (the project folder,
 * the repo's top level, worktrees it made), so a PATH entry at the repo root is skipped when cwd is
 * a subfolder. Returns null when nothing qualifies.
 */
export function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  protect: readonly string[] = [],
): string | null {
  const windows = platform === "win32";
  const pathValue = Object.entries(env).find(([key]) => (windows ? key.toUpperCase() === "PATH" : key === "PATH"))?.[1] ?? "";
  const roots = protectedRoots(cwd, protect);
  const extensions = windows ? [".exe"] : [""];
  for (const entry of pathValue.split(windows ? ";" : ":")) {
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || !path.isAbsolute(dir) || isNetworkPath(dir, platform)) continue;
    const realDir = realPath(dir);
    // A folder that cannot be resolved is not usable, never assumed safe.
    if (!realDir || isNetworkPath(realDir, platform) || insideAny(roots, path.resolve(dir), realDir)) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, `${name}${extension}`);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (!windows) accessSync(candidate, constants.X_OK);
        const realFile = realPath(candidate);
        if (!realFile || insideAny(roots, realFile)) continue;
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** Real path, or undefined when it cannot be resolved (missing, no access). */
function realPath(p: string): string | undefined {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
}

/**
 * The folders no program may be started from: `cwd`, plus any `protect` roots the host registered
 * itself (the project folder, the repo's top level, worktrees it made), each as written and as a
 * real path. Never derived by walking up from cwd: a home-folder dotfiles repo would then block ~/bin.
 */
function protectedRoots(cwd: string, protect: readonly string[] = []): string[] {
  const roots = new Set<string>();
  for (const root of [cwd, ...protect]) {
    if (typeof root !== "string" || root === "") continue;
    const here = path.resolve(root);
    roots.add(here);
    const real = realPath(here);
    if (real) roots.add(real);
  }
  return [...roots];
}

function insideAny(roots: readonly string[], ...candidates: string[]): boolean {
  return roots.some((root) => candidates.some((candidate) => isWithin(root, candidate)));
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
 * Refuses a git that sits inside `cwd` or a `protect` root (see findExecutable), as written or through
 * a link. Use this for every git spawn, with NO_CWD_SEARCH_ENV in its env.
 */
export function gitExecutable(cwd: string = process.cwd(), protect: readonly string[] = []): string {
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  if (cached?.pathValue !== pathValue) {
    const file = findExecutable("git", process.env, cwd);
    if (!file) throw new ExecutableNotFoundError("git was not found on PATH (relative PATH entries and the repo folder are never searched). Install Git and restart Perfect Planner.");
    cached = { pathValue, file };
  }
  const roots = protectedRoots(cwd, protect);
  if (insideAny(roots, path.resolve(cached.file), realPath(cached.file) ?? path.resolve(cached.file))) {
    // The cached git sits inside a root protected for this call: look again with those roots.
    const other = findExecutable("git", process.env, cwd, process.platform, protect);
    if (other) return other;
    throw new ExecutableNotFoundError(`The only git on PATH (${cached.file}) is inside ${[cwd, ...protect].join(" or ")}, so it could be the repo's own; refusing to run it.`);
  }
  return cached.file;
}
