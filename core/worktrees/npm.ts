import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findExecutable, gitExecutable, isWithin, NO_CWD_SEARCH_ENV, registeredRoots, system32Tool } from "../exec/index";

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

/** Said when an install fails with scripts skipped, so the person knows the switch exists and that it is theirs. */
export const INSTALL_SCRIPTS_HINT = "Install scripts were skipped; only a person can allow them (allowInstallScripts).";

/** Said on every failed host install: npm ran without the user's own config, so a private registry login or proxy is missing. */
export const NPM_CONFIG_HINT =
  "Perfect Planner installs ignore your own npm settings (~/.npmrc and npm_config_* variables), including a private registry login and proxy. If this project needs them, a person can install its dependencies in the worktree themselves, or set the install option to their own installer.";

/**
 * Run npm (e.g. ["ci", ...]) through Node with no shell. Adds --ignore-scripts unless allowed. The
 * project's own .npmrc is agent-controlled, so every setting that names a program is fixed on the
 * command line (which outranks every config file): git is core/exec's, the script shell is the
 * system's. User and global config come from an empty file, and inherited npm_config_* variables are
 * dropped. Resolves to the exit code.
 */
export function runNpm(args: readonly string[], options: NpmRunOptions): Promise<{ code: number; output: string }> {
  const cli = npmCliPath(options.cwd, options.protect);
  const protect = options.protect ?? [];
  const configDir = mkdtempSync(path.join(os.tmpdir(), "pp-npmrc-"));
  // npm refuses one file as both user and global config.
  const userConfig = path.join(configDir, "user.npmrc");
  const globalConfig = path.join(configDir, "global.npmrc");
  writeFileSync(userConfig, "");
  writeFileSync(globalConfig, "");
  const shell = process.platform === "win32" ? system32Tool("cmd.exe") : "/bin/sh";
  let git: string;
  try {
    git = gitExecutable(options.cwd, protect);
  } catch (error) {
    rmSync(configDir, { recursive: true, force: true });
    return Promise.reject(error);
  }
  const fixed = [`--git=${git}`, `--script-shell=${shell}`, `--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`, "--node-options=", "--editor=", "--browser=false"];
  const finalArgs = [cli, ...args, ...fixed, ...(options.allowInstallScripts ? [] : ["--ignore-scripts"])];
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
  return new Promise<{ code: number; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, finalArgs, {
      cwd: options.cwd,
      env: { ...inherited, ...options.env, ...NO_CWD_SEARCH_ENV },
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
  }).finally(() => rmSync(configDir, { recursive: true, force: true }));
}
