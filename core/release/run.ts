import { execFile } from "node:child_process";
import { findExecutable, gitExecutable, NO_CWD_SEARCH_ENV } from "../exec/index";
import type { CommandRunner } from "./types";

/**
 * The CommandRunner to use in a real repository. Programs are started by
 * absolute path from PATH, never from the repo folder (on Windows a git.exe
 * planted in a cloned repo would otherwise run first), with NO_CWD_SEARCH_ENV
 * so their own children cannot fall into the same trap. Never uses a shell.
 */
export const safeRunner: CommandRunner = (command, args, options = {}) => {
  const cwd = options.cwd ?? process.cwd();
  let file: string;
  try {
    file = command === "git" ? gitExecutable(cwd) : findExecutable(command, process.env, cwd) ?? "";
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
