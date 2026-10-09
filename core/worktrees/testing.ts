import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ledger, MemoryStore } from "../ledger/index";
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
  return { root, cleanup: () => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) };
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
