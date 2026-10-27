import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashEntry } from "../ledger/chain";
import type { LedgerEntry } from "../ledger/types";
import { git, runGit } from "../worktrees/git";

/**
 * A shared-work bundle: one file a person can send by any means. Layout: the magic line, 4 bytes
 * (big-endian) giving the header length, the JSON header, then a git bundle. The header names the
 * branches and the ledger entries that go with them and carries a sha256 of the git bundle, so any
 * change in transit is caught. Until teammates' keys are trusted (a later step) a bundle is only
 * checked for damage, never for who sent it, and says so ("signed": false).
 */
const MAGIC = "PPBUNDLE1\n";

export interface BundleManifest {
  format: 1;
  project: string;
  sender: string;
  createdAt: string;
  /** Branch name to the commit it points at. */
  branches: Record<string, string>;
  entries: LedgerEntry[];
  gitBundleSha256: string;
  signed: false;
}

export class BundleError extends Error {}

const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const SAFE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** Entries must link to each other and hash correctly; a slice may start anywhere. */
export function checkEntrySlice(entries: readonly LedgerEntry[]): string | null {
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (hashEntry(e) !== e.hash) return `${e.n} was changed after it was written`;
    if (i > 0 && e.prev !== entries[i - 1]!.hash) return `${e.n} does not follow ${entries[i - 1]!.n}`;
  }
  return null;
}

export interface ExportOptions {
  repoRoot: string;
  project: string;
  sender: string;
  branches: string[];
  entries: readonly LedgerEntry[];
  outFile: string;
  now?: () => Date;
}

export async function exportBundle(opts: ExportOptions): Promise<BundleManifest> {
  if (!SAFE_NAME.test(opts.sender)) throw new BundleError("The sender name may only use letters, numbers, dots, dashes and underscores.");
  if (opts.branches.length === 0) throw new BundleError("Pick at least one branch to send.");
  const problem = checkEntrySlice(opts.entries);
  if (problem) throw new BundleError(`The ledger entries are not sound: ${problem}.`);
  const branches: Record<string, string> = {};
  for (const name of opts.branches) {
    const tip = await runGit(opts.repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}^{commit}`]);
    if (tip.code !== 0) throw new BundleError(`Branch ${name} was not found.`);
    branches[name] = tip.stdout.trim();
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), "pp-bundle-"));
  try {
    const gitFile = path.join(dir, "work.bundle");
    await git(opts.repoRoot, ["bundle", "create", gitFile, ...opts.branches.map((b) => `refs/heads/${b}`)]);
    const gitBytes = readFileSync(gitFile);
    const manifest: BundleManifest = {
      format: 1,
      project: opts.project,
      sender: opts.sender,
      createdAt: (opts.now ?? (() => new Date()))().toISOString(),
      branches,
      entries: [...opts.entries],
      gitBundleSha256: sha(gitBytes),
      signed: false,
    };
    const header = Buffer.from(JSON.stringify(manifest), "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(header.length);
    writeFileSync(opts.outFile, Buffer.concat([Buffer.from(MAGIC, "utf8"), len, header, gitBytes]));
    return manifest;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Reads and checks a bundle file without touching any repo. */
export function readBundle(file: string): { manifest: BundleManifest; gitBytes: Buffer } {
  const raw = readFileSync(file);
  const magic = Buffer.from(MAGIC, "utf8");
  if (raw.length < magic.length + 4 || !raw.subarray(0, magic.length).equals(magic)) throw new BundleError("This is not a Perfect Planner bundle.");
  const len = raw.readUInt32BE(magic.length);
  const start = magic.length + 4;
  if (len > 64 * 1024 * 1024 || start + len > raw.length) throw new BundleError("This bundle is cut short or damaged.");
  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(raw.subarray(start, start + len).toString("utf8")) as BundleManifest;
  } catch {
    throw new BundleError("This bundle's header cannot be read.");
  }
  if (manifest.format !== 1 || !SAFE_NAME.test(String(manifest.sender)) || typeof manifest.branches !== "object" || !Array.isArray(manifest.entries)) {
    throw new BundleError("This bundle's header is not valid.");
  }
  const gitBytes = raw.subarray(start + len);
  if (sha(gitBytes) !== manifest.gitBundleSha256) throw new BundleError("The work in this bundle was changed or damaged after it was made.");
  const problem = checkEntrySlice(manifest.entries);
  if (problem) throw new BundleError(`The ledger entries in this bundle are not sound: ${problem}.`);
  return { manifest, gitBytes };
}

export interface ImportResult {
  sender: string;
  /** Where each received branch now lives; your own branches are never touched. */
  refs: Record<string, string>;
  entries: number;
  signed: false;
}

/** Holds a bundle's branches under refs/pp-inbox/<sender>/<branch>. Nothing in your own branches changes. */
export async function importBundle(repoRoot: string, file: string): Promise<ImportResult> {
  const { manifest, gitBytes } = readBundle(file);
  const dir = mkdtempSync(path.join(os.tmpdir(), "pp-import-"));
  try {
    const gitFile = path.join(dir, "work.bundle");
    writeFileSync(gitFile, gitBytes);
    const verify = await runGit(repoRoot, ["bundle", "verify", gitFile]);
    if (verify.code !== 0) throw new BundleError(`Git does not accept the work in this bundle (${verify.stderr.trim().split(/\r?\n/)[0] ?? "unknown"}). Your copy may be missing earlier work it builds on.`);
    const unpack = await runGit(repoRoot, ["bundle", "unbundle", gitFile]);
    if (unpack.code !== 0) throw new BundleError(`Git could not unpack this bundle (${unpack.stderr.trim().split(/\r?\n/)[0] ?? "unknown"}).`);
    const refs: Record<string, string> = {};
    for (const [name, tip] of Object.entries(manifest.branches)) {
      if (!SAFE_NAME.test(name.replace(/\//g, "-")) || name.includes("..")) throw new BundleError(`The branch name "${name}" is not allowed.`);
      const dest = `refs/pp-inbox/${manifest.sender}/${name}`;
      if (!/^[0-9a-f]{40,64}$/.test(tip)) throw new BundleError(`The commit for branch ${name} is not valid.`);
      // The objects were unpacked above; only now does a ref point at them, and only if they really are there.
      if ((await runGit(repoRoot, ["cat-file", "-e", `${tip}^{commit}`])).code !== 0) throw new BundleError(`Branch ${name} arrived without its work.`);
      await git(repoRoot, ["update-ref", dest, tip]);
      refs[name] = dest;
    }
    return { sender: manifest.sender, refs, entries: manifest.entries.length, signed: false };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export type MergeCheck =
  | { clean: true; alreadyIn: boolean }
  | { clean: false; conflicts: string[] };

/** Works out the merge in git's object store only: no file, index or branch changes. */
export async function checkMerge(repoRoot: string, baseRef: string, incomingRef: string): Promise<MergeCheck> {
  const base = await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
  const inc = await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${incomingRef}^{commit}`]);
  if (base.code !== 0 || inc.code !== 0) throw new BundleError("One of the two branches could not be found.");
  if ((await runGit(repoRoot, ["merge-base", "--is-ancestor", inc.stdout.trim(), base.stdout.trim()])).code === 0) return { clean: true, alreadyIn: true };
  const r = await runGit(repoRoot, ["merge-tree", "--write-tree", "--no-messages", "--name-only", base.stdout.trim(), inc.stdout.trim()]);
  if (r.code === 0) return { clean: true, alreadyIn: false };
  if (r.code === 1) {
    const [, ...rest] = r.stdout.split(/\r?\n/);
    return { clean: false, conflicts: [...new Set(rest.map((l) => l.trim()).filter(Boolean))] };
  }
  throw new BundleError("Git could not work out the merge. It needs Git 2.38 or later.");
}
