import { execFileSync, spawn } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitExecutable, NO_CWD_SEARCH_ENV } from "../exec/index";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout as bytes, for binary-exact reads such as git cat-file. */
  stdoutBytes: Buffer;
}

export interface GitOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
  /**
   * Hooks folder to use instead of none. Host git never runs the repo's own hooks (.git/hooks or a
   * core.hooksPath from repo config); pass the app's own hooks here when the host wants them.
   */
  hooksPath?: string;
}

/**
 * Settings from the user's own global and system git config that are copied into the app's private
 * global config, because nothing works without them: who commits, which folders git may open
 * (safe.directory) and line-ending handling. None of them names a program.
 */
const CARRIED_SETTINGS = ["user.name", "user.email", "safe.directory", "core.autocrlf", "core.eol", "core.longpaths", "core.symlinks"];

/**
 * The repo's own config and hooks are writable by any program on the PC, and git would run what they
 * name (hooks, fsmonitor, external diff, filters, merge drivers) as the host. Every host git call
 * therefore runs with these fixed on the command line, which outranks every config file.
 */
const fixedConfig = (hooksPath: string, attributesFile: string): string[] => [
  `core.hooksPath=${hooksPath}`,
  "core.fsmonitor=false",
  "core.untrackedCache=false",
  "diff.external=",
  `core.attributesFile=${attributesFile}`,
  "core.askPass=",
  "core.quotepath=off",
  "commit.gpgSign=false",
  "tag.gpgSign=false",
  "gc.auto=0",
  "maintenance.auto=false",
  // Settings that would change what a diff shows the person.
  "diff.relative=false",
  "diff.noprefix=false",
  "diff.mnemonicPrefix=false",
  `diff.orderFile=${attributesFile}`,
  "diff.ignoreSubmodules=none",
  "color.ui=false",
  // Signature checks run gpg.program (or gpg.ssh.program) from the repo config.
  "log.showSignature=false",
  "merge.verifySignatures=false",
  // The host never talks to a remote; ext:: and the other transports (ssh, a remote's uploadpack) run programs.
  "protocol.allow=never",
];

/** Commands whose output is a diff: never through an external diff program or a textconv filter. */
const DIFF_COMMANDS = new Set(["diff", "show", "log", "diff-tree", "diff-index", "diff-files"]);

/**
 * Commands that read or write the working tree, which is where filter programs and merge drivers run.
 * Before each, the repo config is checked and the command refused if it names one (see filterPrograms).
 */
const WORKTREE_COMMANDS = new Set(["merge", "worktree", "status", "diff", "add", "checkout", "switch", "reset", "stash", "commit", "read-tree", "checkout-index", "apply", "restore", "rm", "mv", "cherry-pick", "rebase", "revert", "am", "pull"]);

interface Hardening {
  hooksPath: string;
  attributesFile: string;
  globalConfig: string;
}

let hardening: Hardening | undefined;

/**
 * A hooks path that can never hold a hook, so nothing written by another program is ever run. On
 * POSIX that is /dev/null (a device, so /dev/null/pre-commit cannot exist). Not on Windows: there
 * Git looks /dev/null up as C:\dev\null, a folder any user may create, and NUL is relative to the repo
 * (<repo>\NUL\<hook>, makeable with \\?\ paths). It uses the git program's own path instead: while git.exe
 * is a file nothing can sit inside it, and whoever can replace git.exe needs no hook.
 */
export function hooklessPath(program: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? program : "/dev/null";
}

/** The app's empty attributes file and private global config, made once per process. */
function hardeningFiles(program: string): Hardening {
  if (hardening) return hardening;
  const root = mkdtempSync(path.join(os.tmpdir(), "pp-git-"));
  const hooksPath = hooklessPath(program);
  const attributesFile = path.join(root, "attributes");
  writeFileSync(attributesFile, "");
  const globalConfig = path.join(root, "gitconfig");
  writeFileSync(globalConfig, "");
  // Read the user's own settings (reading config runs nothing) and copy the needed ones over.
  for (const key of CARRIED_SETTINGS) {
    for (const scope of ["--system", "--global"]) {
      let values: string[] = [];
      try {
        const out = execFileSync(program, ["config", scope, "--get-all", key], { cwd: root, env: { ...process.env, ...NO_CWD_SEARCH_ENV }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 10_000 });
        values = out.split(/\r?\n/).filter(Boolean);
      } catch {
        // Not set in that scope.
      }
      for (const value of values) {
        execFileSync(program, ["config", "--file", globalConfig, "--add", key, value], { cwd: root, env: { ...process.env, ...NO_CWD_SEARCH_ENV }, stdio: "ignore", windowsHide: true, timeout: 10_000 });
      }
    }
  }
  chmodSync(attributesFile, 0o444);
  hardening = { hooksPath, attributesFile, globalConfig };
  return hardening;
}

export class GitHardeningError extends Error {}

/** The attributes file (also the diff order file) must still be an empty file; git is not run otherwise. */
function checkHardening(files: Hardening): void {
  let size = -1;
  try {
    const stat = lstatSync(files.attributesFile);
    if (stat.isFile()) size = stat.size;
  } catch {
    // missing
  }
  if (size !== 0) {
    throw new GitHardeningError(`Perfect Planner's empty git attributes file (${files.attributesFile}) was changed, so git could be told to run a program. Git was not run. Restart Perfect Planner; it makes a fresh one.`);
  }
}

const baseEnv = (globalConfig: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...NO_CWD_SEARCH_ENV,
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
    LC_ALL: "C",
    // The user's global and system config are replaced by the app's own copy of a few safe settings.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_PROTOCOL_FROM_USER: "0",
  };
  // A hook or parent git process can export these; they would silently point us at another repo,
  // inject config, or name programs for git to run.
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS|SYSTEM)$/.test(key)) delete env[key];
  }
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_EXEC_PATH", "GIT_EXTERNAL_DIFF", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_TEMPLATE_DIR", "GIT_ALLOW_PROTOCOL", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_OBJECT_DIRECTORY"]) delete env[key];
  return env;
};

/** The git command in args (the first argument that is not a global option). */
function subcommand(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "-c" || arg === "-C") index += 1;
    else if (!arg.startsWith("-")) return arg;
  }
  return undefined;
}

export class GitProgramRefusedError extends Error {}

/**
 * Filter programs (filter.<name>.clean/smudge/process) and merge drivers (merge.<name>.driver) named in
 * the repo's config, read with the same hardened settings as every host git call. Reading config runs
 * nothing. Git would run these as the host on checkout, status, diff, add and merge.
 */
export async function filterPrograms(cwd: string): Promise<string[]> {
  const result = await spawnGit(cwd, ["config", "--includes", "--get-regexp", "^(filter\\..+\\.(clean|smudge|process)|merge\\..+\\.driver)$"], {});
  return result.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.split(" ")[0]!);
}

/**
 * Run git without a shell, by its absolute path from PATH (never a git in the repo), with the repo's
 * own hooks and every config setting that runs a program or changes what is shown switched off (see
 * fixedConfig and baseEnv). Diffs never use an external diff or textconv. A command that touches the
 * working tree is refused (GitProgramRefusedError) when the repo config names a filter program or
 * merge driver. Use this for every host git call. Never throws for a non-zero exit; see `git()`.
 */
export async function runGit(cwd: string, args: string[], options: GitOptions = {}): Promise<GitResult> {
  const command = subcommand(args);
  // Removing or listing worktrees runs no filter; adding one checks files out.
  const checksOut = command === "worktree" ? args[args.indexOf(command) + 1] === "add" : !!command && WORKTREE_COMMANDS.has(command);
  if (checksOut) {
    const programs = await filterPrograms(cwd);
    if (programs.length) {
      throw new GitProgramRefusedError(
        `This repo's git settings run a program (${programs.join(", ")}) when files are checked out, compared or merged. Perfect Planner will not run it; a person must review and remove it (git config --unset) before continuing.`,
      );
    }
  }
  return spawnGit(cwd, args, options);
}

function spawnGit(cwd: string, args: string[], options: GitOptions): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    let program: string;
    let files: Hardening;
    try {
      program = gitExecutable(cwd);
      files = hardeningFiles(program);
      checkHardening(files);
    } catch (error) {
      reject(error);
      return;
    }
    const command = subcommand(args);
    let finalArgs = args;
    if (command && DIFF_COMMANDS.has(command)) {
      const at = args.indexOf(command);
      finalArgs = [...args.slice(0, at + 1), "--no-ext-diff", "--no-textconv", ...args.slice(at + 1)];
    }
    const fixed = fixedConfig(options.hooksPath ?? files.hooksPath, files.attributesFile).flatMap((setting) => ["-c", setting]);
    const child = spawn(program, ["--no-pager", ...fixed, ...finalArgs], { cwd, env: { ...baseEnv(files.globalConfig), ...options.env, ...NO_CWD_SEARCH_ENV }, windowsHide: true, shell: false });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 60_000);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const bytes = Buffer.concat(out);
      resolve({ code: code ?? -1, stdout: bytes.toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), stdoutBytes: bytes });
    });
  });
}

export class GitError extends Error {
  constructor(readonly args: string[], readonly result: GitResult) {
    super(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

/** Run git and return trimmed stdout, throwing GitError on a non-zero exit. */
export async function git(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
  const result = await runGit(cwd, args, options);
  if (result.code !== 0) throw new GitError(args, result);
  return result.stdout.replace(/\r?\n$/, "");
}
