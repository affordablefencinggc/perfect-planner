// The folders no agent CLI (or anything it starts) may run a program from, and the environment that
// keeps it that way. Side-effect free and free of the host routes, so connect.mjs bundles only this:
// connect.mjs runs in its own process, where the host's registered roots (core/exec protectRoots) are
// not known, so it reads the ones the host wrote beside the token file. Shared by every agent the
// connect line starts (Claude Code, Gemini, Codex).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isLocalWindowsPath, isWithin, registeredRoots } from "../exec/index";

const REPO_FILE = "repo.json";

/**
 * The repo folder the person picked for a project (kept in its .perfect-planner/), read without running
 * anything, so the host can protect it before its first git run. Never a whole drive or the home folder.
 */
export function chosenRepoRoot(projectRoot: string, platform: NodeJS.Platform = process.platform): string | undefined {
  try {
    const root = (JSON.parse(fs.readFileSync(path.join(projectRoot, ".perfect-planner", REPO_FILE), "utf8")) as { root?: unknown }).root;
    // On Windows only a drive-letter path is local: a network path in a hand-edited file is never looked at, since
    // looking at \\host\share makes Windows talk to that machine.
    if (typeof root === "string" && platform === "win32" && !isLocalWindowsPath(root)) return undefined;
    return typeof root === "string" && path.isAbsolute(root) && !repoRefusal(root) ? root : undefined;
  } catch {
    return undefined;
  }
}

/** Folders that are never a project to hand to workers: a whole drive or the home folder itself. */
export function repoRefusal(top: string, home = os.homedir()): string | null {
  // Same test as isHomeOrDrive (project.ts), with the home folder passable for tests.
  const dir = realOr(top);
  if (same(path.dirname(dir), dir)) return `${dir} is a whole drive. Choose your project's own git folder.`;
  if (same(dir, realOr(home))) return `${dir} is your home folder. Choose your project's own git folder.`;
  return null;
}

/** The roots file the host writes beside a token file (see writeTokenFile in routes/agents.ts). */
export function rootsFileFor(tokenFile: string): string {
  return tokenFile.replace(/\.token$/, ".roots.json");
}

/**
 * The folders no agent CLI may be started from, beyond the current folder: the project folder that owns
 * the token file (<project>/.perfect-planner/tokens/x.token), the repo the person picked for it, and the
 * folders the host recorded beside the token (x.roots.json: the repo git found, the worktree folders).
 * Never found by walking up to .git.
 */
export function protectFor(tokenFile: string | null): string[] {
  if (!tokenFile) return [];
  const project = path.dirname(path.dirname(path.dirname(tokenFile)));
  const repo = chosenRepoRoot(project);
  let recorded: unknown[] = [];
  try {
    const roots = (JSON.parse(fs.readFileSync(rootsFileFor(tokenFile), "utf8")) as { roots?: unknown }).roots;
    if (Array.isArray(roots)) recorded = roots;
  } catch {
    // an older app wrote no roots file
  }
  const roots = [project, ...(repo ? [repo] : []), ...recorded].filter((root): root is string => typeof root === "string" && path.isAbsolute(root));
  // A whole drive or the home folder is never a protected root: it would hide ~/.local/bin/claude.
  return [...new Set(roots)].filter((root) => !repoRefusal(root));
}

/**
 * The environment for an agent CLI. Its PATH keeps only folders it could not have been planted into:
 * absolute, local (a drive-letter path on Windows), resolvable, and neither as written nor as a real path
 * inside the current folder, a protected root, or a root this process registered. So the agent's own
 * lookups (git, node, rg) never find a program planted in the project, the repo or a worktree, even
 * through a link. This Node's folder goes first, so a wrapper script that calls `node` gets this Node.
 */
export function childEnv(
  env: NodeJS.ProcessEnv,
  options: { cwd: string; protect: readonly string[]; platform?: NodeJS.Platform; execPath?: string },
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const windows = platform === "win32";
  const p = windows ? path.win32 : path.posix;
  const roots = new Set<string>();
  for (const root of [options.cwd, ...options.protect, ...registeredRoots()]) {
    if (!root) continue;
    roots.add(path.resolve(root));
    roots.add(realOr(root));
  }
  const inside = (dir: string) => [...roots].some((root) => isWithin(root, dir));
  const keys = Object.keys(env).filter((name) => (windows ? name.toUpperCase() === "PATH" : name === "PATH"));
  const value = keys.map((key) => env[key]).find((v) => typeof v === "string") ?? "";
  const kept: string[] = [];
  for (const entry of value.split(p.delimiter)) {
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || !p.isAbsolute(dir) || (windows && !isLocalWindowsPath(dir))) continue;
    const real = realOrNull(dir);
    if (!real || (windows && !isLocalWindowsPath(real)) || inside(path.resolve(dir)) || inside(real)) continue;
    if (!kept.includes(dir)) kept.push(dir);
  }
  const node = p.dirname(options.execPath ?? process.execPath);
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of keys) delete out[key];
  out[windows ? "Path" : "PATH"] = [node, ...kept.filter((dir) => dir !== node)].join(p.delimiter);
  return out;
}

function same(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

function realOr(p: string): string {
  return realOrNull(p) ?? path.resolve(p);
}
