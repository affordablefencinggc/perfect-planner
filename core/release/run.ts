import { execFile } from "node:child_process";
import { findExecutable, gitExecutable, NO_CWD_SEARCH_ENV } from "../exec/index";
import { runGit } from "../worktrees/git";
import type { CommandRunner } from "./types";

/**
 * A CommandRunner for a real repository. Programs are started by absolute
 * path from PATH, never from the repo folder or any `protect` root (the
 * project folder, the repo's top level, worktrees), compared as written and
 * as real paths so a linked PATH folder cannot reach them (core/exec). On
 * Windows a git.exe planted in a cloned repo would otherwise run first.
 * Children get NO_CWD_SEARCH_ENV so they cannot fall into the same trap.
 * Never uses a shell.
 *
 * git goes through core/worktrees' runGit, so the repo's own hooks, fsmonitor,
 * external diff, textconv, filter programs and merge drivers never run as the
 * host. runGit finds git from the working folder alone; when the `protect`
 * roots would pick a different git (a PATH folder that reaches a protected
 * root from outside the working folder), the call is refused rather than run.
 */
export function createSafeRunner(options: { protect?: readonly string[] } = {}): CommandRunner {
  const protect = options.protect ?? [];
  return async (command, args, runOptions = {}) => {
    const cwd = runOptions.cwd ?? process.cwd();
    const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
    if (command === "git") {
      try {
        if (protect.length && gitExecutable(cwd, protect) !== gitExecutable(cwd)) {
          return { code: 127, stdout: "", stderr: "The git found on PATH from this folder is inside a protected project folder; it was not run" };
        }
        const result = await runGit(cwd, [...args]);
        return { code: result.code, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        return { code: 127, stdout: "", stderr: message(error) };
      }
    }
    let file: string;
    try {
      file = findExecutable(command, process.env, cwd, process.platform, protect) ?? "";
      if (!file) throw new Error(`${command} was not found on PATH`);
    } catch (error) {
      return { code: 127, stdout: "", stderr: message(error) };
    }
    return new Promise((resolveRun) => {
      execFile(file, [...args], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, windowsHide: true, env: { ...process.env, ...NO_CWD_SEARCH_ENV } }, (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
        resolveRun({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      });
    });
  };
}

/** createSafeRunner() with only the working folder protected. */
export const safeRunner: CommandRunner = createSafeRunner();
