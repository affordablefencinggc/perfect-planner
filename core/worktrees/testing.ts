import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ledger, MemoryStore } from "../ledger/index";
import { gitExecutable } from "../exec/index";
import { git } from "./git";
import { realDir } from "./platform";

/** A throwaway repo with one commit on main. Real path (no 8.3 names, no /var symlink). */
export async function makeRepo(files: Record<string, string> = { "README.md": "hello\n" }): Promise<{ root: string; cleanup: () => void }> {
  const parent = realDir(mkdtempSync(path.join(os.tmpdir(), "pp-core-")));
  const root = path.join(parent, "repo");
  mkdirSync(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.invalid"]);
  await git(root, ["config", "user.name", "Core Test"]);
  await git(root, ["config", "core.autocrlf", "false"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  writeFiles(root, files);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "initial"]);
  return { root, cleanup: () => removeTempDir(parent) };
}

/**
 * Remove a test's temp folder. On Windows a git process, the indexer or antivirus can hold a
 * handle for a few seconds after a test ends (EPERM/EBUSY); retry for longer, and if the folder
 * is still locked, leave it in the temp dir with a warning rather than fail the test that used it.
 */
export function removeTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (!["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"].includes(code)) throw error;
    console.warn(`could not remove ${dir} (${code}); leaving it in the temp folder`);
  }
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(root, ...name.split("/"));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
}

export async function commitAll(cwd: string, message: string): Promise<string> {
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

/** A real, empty in-memory ledger. */
export function memoryLedger(): Promise<Ledger> {
  return Ledger.open(new MemoryStore());
}

/** Plain git as a worker would run it: the repo's own config and hooks apply (the app's runGit ignores them). */
export function workerGit(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(gitExecutable(cwd), args, { cwd, encoding: "utf8", windowsHide: true });
  return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
