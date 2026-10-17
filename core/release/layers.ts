import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PushProtectionResult } from "./pushProtection";
import { checkIgnoreList, scanText } from "./secrets";
import type { CommandRunner } from "./types";

// The four secret layers as one report (plan: "No scanner catches 100% alone,
// so the guarantee comes from layering"). Layers 1 and 2 are installed by
// core/worktrees (placeholder env files, commit-time scan); layer 3 is this
// module's pre-push scan plus the ignore list; layer 4 is GitHub's own push
// protection. This only reads facts the caller gathered and says plainly
// which layer is missing; it never claims a layer it could not check.

export interface PostureInput {
  /** Env files copied into worktrees, to confirm they only hold placeholders (layer 1). */
  worktreeEnvFiles?: { file: string; text: string }[];
  /** Whether each worktree has the commit-time scan as its hook (layer 2). Undefined: not checked. */
  commitScanInstalled?: boolean;
  /** Whether the pre-push scan is installed (layer 3). Undefined: not checked. */
  prePushInstalled?: boolean;
  /** The repo's .gitignore text (layer 3, enforced ignore list). */
  gitignoreText?: string;
  /** GitHub push protection (layer 4). */
  pushProtection?: PushProtectionResult;
}

export type LayerState = "on" | "off" | "unchecked";

export interface LayerReport {
  layer: 1 | 2 | 3 | 4;
  name: string;
  state: LayerState;
  summary: string;
}

export interface Posture {
  /** True only when every layer was checked and is on. */
  ok: boolean;
  layers: LayerReport[];
}

function flag(value: boolean | undefined, on: string, off: string): { state: LayerState; summary: string } {
  if (value === undefined) return { state: "unchecked", summary: "Not checked yet" };
  return value ? { state: "on", summary: on } : { state: "off", summary: off };
}

export function secretPosture(input: PostureInput): Posture {
  const layers: LayerReport[] = [];

  // Layer 1: agents never hold real secrets.
  if (!input.worktreeEnvFiles) {
    layers.push({ layer: 1, name: "Agents hold placeholders only", state: "unchecked", summary: "Not checked yet" });
  } else {
    const leaks = input.worktreeEnvFiles.flatMap((env) => scanText(env.file, env.text));
    layers.push({
      layer: 1,
      name: "Agents hold placeholders only",
      state: leaks.length === 0 ? "on" : "off",
      summary: leaks.length === 0
        ? `${input.worktreeEnvFiles.length} worktree env file${input.worktreeEnvFiles.length === 1 ? "" : "s"} hold placeholders only`
        : `Real-looking values in ${[...new Set(leaks.map((leak) => leak.file))].join(", ")}`,
    });
  }

  // Layer 2: scan on every commit.
  layers.push({ layer: 2, name: "Scan on every commit", ...flag(input.commitScanInstalled, "Commit-time scan installed in every worktree", "A worktree has no commit-time scan") });

  // Layer 3: whole-branch scan before push, plus the ignore list.
  const ignore = input.gitignoreText === undefined ? undefined : checkIgnoreList(input.gitignoreText);
  if (input.prePushInstalled === undefined && ignore === undefined) {
    layers.push({ layer: 3, name: "Whole-branch scan before push", state: "unchecked", summary: "Not checked yet" });
  } else {
    const problems: string[] = [];
    if (input.prePushInstalled === false) problems.push("pre-push scan not installed");
    if (input.prePushInstalled === undefined) problems.push("pre-push scan not checked");
    if (ignore && !ignore.ok) problems.push(`.gitignore misses ${ignore.missing.join(", ")}`);
    if (ignore === undefined) problems.push(".gitignore not checked");
    const off = (input.prePushInstalled === false) || (ignore !== undefined && !ignore.ok);
    layers.push({
      layer: 3,
      name: "Whole-branch scan before push",
      state: problems.length === 0 ? "on" : off ? "off" : "unchecked",
      summary: problems.length === 0 ? "Pre-push scan installed and env files and keys are ignored" : problems.join("; "),
    });
  }

  // Layer 4: GitHub push protection.
  const pp = input.pushProtection;
  layers.push({
    layer: 4,
    name: "GitHub push protection",
    state: !pp || pp.status === "unknown" ? "unchecked" : pp.status === "enabled" ? "on" : "off",
    summary: pp ? pp.detail : "Not checked yet",
  });

  return { ok: layers.every((layer) => layer.state === "on"), layers };
}

const SHIM_MARK = "# Perfect Planner: whole-branch secret scan before any push (layer 3).";

/** A path for sh: forward slashes, single-quoted so nothing in it ($, backticks) is expanded. */
const shQuote = (value: string) => `'${value.replace(/\\/g, "/").replace(/'/g, `'\\''`)}'`;

/**
 * A git hook shim that runs the pre-push scan. Git runs hooks through sh on
 * every platform (Git for Windows ships one), so the same text works on
 * Windows, macOS and Linux. Node is named by absolute path, never a bare
 * `node` that sh would look up on PATH (a PATH folder inside or linked into
 * the repo could hold a planted one): the desktop app's own Node
 * (PP_NODE_BINARY) when set, so a person without Node can still push, else
 * the Node the host runs on. Both paths are single-quoted.
 */
export function prePushShim(hookScriptPath: string, env: NodeJS.ProcessEnv = process.env, execPath: string = process.execPath): string {
  const node = env.PP_NODE_BINARY || execPath;
  return `#!/bin/sh\n${SHIM_MARK}\nexec ${shQuote(node)} ${shQuote(hookScriptPath)} "$@"\n`;
}

/** The value of core.hooksPath in one config file (a path, ~ expanded), or undefined. */
async function hooksPathIn(run: CommandRunner, cwd: string, where: string[]): Promise<string | undefined> {
  const result = await run("git", ["config", ...where, "--includes", "--type=path", "--get", "core.hooksPath"], { cwd });
  const value = result.code === 0 ? result.stdout.trim() : "";
  return value || undefined;
}

/**
 * The folder git will run this repo's hooks from. Read from the config files
 * themselves, in git's order (worktree, repo, global, system), not from
 * `rev-parse --git-path hooks`: the host runs git with core.hooksPath fixed to
 * an empty folder on the command line (core/worktrees runGit), so that would
 * name the app's folder, not the repo's. A relative core.hooksPath is relative
 * to the worktree top, as when git runs a hook; none means <common git dir>/hooks.
 */
async function hooksDir(run: CommandRunner, cwd: string): Promise<string> {
  const dirs = await run("git", ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], { cwd });
  const [gitDir, commonDir] = dirs.code === 0 ? dirs.stdout.split(/\r?\n/).map((line) => line.trim()) : [];
  if (!gitDir || !commonDir) throw new Error(`Not a git repository: ${dirs.stderr.trim()}`);
  const top = await run("git", ["rev-parse", "--show-toplevel"], { cwd });
  const base = top.code === 0 && top.stdout.trim() ? top.stdout.trim() : gitDir;
  const globals = process.env.GIT_CONFIG_GLOBAL
    ? [process.env.GIT_CONFIG_GLOBAL]
    : [join(homedir(), ".gitconfig"), join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "git", "config")];
  const sources: string[][] = [["--worktree"], ["--local"], ...globals.filter((file) => existsSync(file)).map((file) => ["--file", file])];
  if (!process.env.GIT_CONFIG_NOSYSTEM) sources.push(process.env.GIT_CONFIG_SYSTEM ? ["--file", process.env.GIT_CONFIG_SYSTEM] : ["--system"]);
  for (const where of sources) {
    const value = await hooksPathIn(run, cwd, where);
    if (value) return resolve(base, value);
  }
  return join(commonDir, "hooks");
}

/** Whether the pre-push scan is installed as this repository's pre-push hook (layer 3). */
export async function prePushInstalled(run: CommandRunner, options: { cwd: string }): Promise<boolean> {
  const file = join(await hooksDir(run, options.cwd), "pre-push");
  return existsSync(file) && readFileSync(file, "utf8").includes(SHIM_MARK);
}

/**
 * Installs the pre-push scan as the repository's pre-push hook. Never
 * overwrites a hook that is not ours: it reports it instead, so the person
 * can chain the two.
 */
export async function installPrePushHook(
  run: CommandRunner,
  options: { cwd: string; hookScript: string },
): Promise<{ installed: boolean; path: string; reason?: string; updated?: boolean }> {
  const dir = await hooksDir(run, options.cwd);
  const file = join(dir, "pre-push");
  if (existsSync(file) && !readFileSync(file, "utf8").includes(SHIM_MARK)) {
    return { installed: false, path: file, reason: "This repository already has its own pre-push hook; add the Perfect Planner scan to it by hand" };
  }
  // Ours is rewritten whenever its text changed (a new Node path after an app update, a moved
  // hook script), so pushes never fail closed on a stale path; protectProject runs this on open.
  const shim = prePushShim(options.hookScript);
  const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  if (current !== shim) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, shim, { mode: 0o755 });
  }
  chmodSync(file, 0o755);
  return { installed: true, path: file, ...(current !== undefined && current !== shim ? { updated: true } : {}) };
}

/** Removes the pre-push scan, but only when the hook is ours; someone else's hook is left alone. */
export async function removePrePushHook(run: CommandRunner, options: { cwd: string }): Promise<{ removed: boolean; path: string }> {
  const file = join(await hooksDir(run, options.cwd), "pre-push");
  if (!existsSync(file) || !readFileSync(file, "utf8").includes(SHIM_MARK)) return { removed: false, path: file };
  rmSync(file);
  return { removed: true, path: file };
}
