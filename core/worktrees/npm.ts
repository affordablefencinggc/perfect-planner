import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { findExecutable, isWithin, NO_CWD_SEARCH_ENV, registeredRoots } from "../exec/index";

export class NpmNotFoundError extends Error {}

const real = (file: string): string | undefined => {
  try {
    return realpathSync.native(file);
  } catch {
    return undefined;
  }
};

/**
 * npm's own entry script, found without a shell and never inside `protect` (the project folder, the
 * repo top level, worktrees the host made; never derived by walking up from cwd). Looks beside the
 * Node that runs Perfect Planner first (Windows and Unix layouts), then follows an npm on PATH found
 * by core/exec. It is then run as `node npm-cli.js`, so neither cmd.exe nor `#!/usr/bin/env node`
 * gets to search PATH or the current folder.
 */
export function npmCliPath(cwd: string, protect: readonly string[] = [], env: NodeJS.ProcessEnv = process.env): string {
  const roots = [cwd, ...protect, ...registeredRoots()].flatMap((root) => [path.resolve(root), real(root)]).filter((root): root is string => !!root);
  const safe = (file: string | undefined): string | undefined => {
    const resolved = file ? real(file) : undefined;
    if (!file || !resolved || path.basename(resolved) !== "npm-cli.js") return undefined;
    return roots.some((root) => isWithin(root, file) || isWithin(root, resolved)) ? undefined : resolved;
  };
  const nodeDir = path.dirname(process.execPath);
  const beside = [path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"), path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")];
  for (const candidate of beside) {
    const found = existsSync(candidate) ? safe(candidate) : undefined;
    if (found) return found;
  }
  if (process.platform !== "win32") {
    const onPath = findExecutable("npm", env, cwd, process.platform, protect);
    const found = safe(onPath ?? undefined);
    if (found) return found;
  } else {
    const node = findExecutable("node", env, cwd, process.platform, protect);
    const found = node ? safe(path.join(path.dirname(node), "node_modules", "npm", "bin", "npm-cli.js")) : undefined;
    if (found) return found;
  }
  throw new NpmNotFoundError("npm was not found next to Node or on PATH outside this project, so dependencies were not installed.");
}

export interface NpmRunOptions {
  cwd: string;
  /** Roots no program may come from; see npmCliPath. */
  protect?: readonly string[];
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Run packages' install scripts. Off unless a person enabled them: a dependency's postinstall is arbitrary code. */
  allowInstallScripts?: boolean;
}

/** Run npm (e.g. ["ci", ...]) through Node with no shell. Adds --ignore-scripts unless allowed. Resolves to the exit code. */
export function runNpm(args: readonly string[], options: NpmRunOptions): Promise<{ code: number; output: string }> {
  const cli = npmCliPath(options.cwd, options.protect);
  const finalArgs = [cli, ...args, ...(options.allowInstallScripts ? [] : ["--ignore-scripts"])];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, finalArgs, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, ...NO_CWD_SEARCH_ENV },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const keep = (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      while (size > 64 * 1024 && chunks.length > 1) size -= chunks.shift()!.length;
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 10 * 60_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output: Buffer.concat(chunks).toString("utf8") });
    });
  });
}
