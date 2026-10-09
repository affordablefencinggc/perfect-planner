import { spawn } from "node:child_process";
import { gitExecutable, NO_CWD_SEARCH_ENV } from "./executable";

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
}

const baseEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...NO_CWD_SEARCH_ENV, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_EDITOR: "true", LC_ALL: "C" };
  // A hook or parent git process can export these; they would silently point us at another repo.
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[key];
  return env;
};

/**
 * Run git without a shell, by its absolute path from PATH (never a git in the repo). Never throws for
 * a non-zero exit; see `git()` for that.
 */
export function runGit(cwd: string, args: string[], options: GitOptions = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    let program: string;
    try {
      program = gitExecutable(cwd);
    } catch (error) {
      reject(error);
      return;
    }
    const child = spawn(program, ["-c", "core.quotepath=off", ...args], { cwd, env: { ...baseEnv(), ...options.env, ...NO_CWD_SEARCH_ENV }, windowsHide: true, shell: false });
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
