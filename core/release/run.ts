import { execFile } from "node:child_process";
import { findExecutable, gitExecutable, NO_CWD_SEARCH_ENV } from "../exec/index";
import type { CommandRunner } from "./types";

/**
 * A CommandRunner for a real repository. Programs are started by absolute
 * path from PATH, never from the repo folder or any `protect` root (the
 * project folder, the repo's top level, worktrees), compared as written and
 * as real paths so a linked PATH folder cannot reach them (core/exec). On
 * Windows a git.exe planted in a cloned repo would otherwise run first.
 * Children get NO_CWD_SEARCH_ENV so they cannot fall into the same trap.
 * Never uses a shell.
 */
export function createSafeRunner(options: { protect?: readonly string[] } = {}): CommandRunner {
  const protect = options.protect ?? [];
  return (command, args, runOptions = {}) => {
    const cwd = runOptions.cwd ?? process.cwd();
    let file: string;
    try {
      file = command === "git" ? gitExecutable(cwd, protect) : findExecutable(command, process.env, cwd, process.platform, protect) ?? "";
      if (!file) throw new Error(`${command} was not found on PATH`);
    } catch (error) {
      return Promise.resolve({ code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
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
