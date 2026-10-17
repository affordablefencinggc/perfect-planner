// Looking after task folders: what registry, git and disk each say, and what is safe to clean up.
// Everything here only reads. The manager does the (few) writes, one at a time, and never deletes a branch
// except a fully merged one when its own folder is removed.
import { lstat, opendir } from "node:fs/promises";
import path from "node:path";
import { runGit } from "./git";
import { lines, samePath } from "./platform";

/** How one registered task folder stands against git and the disk. */
export type FolderState =
  /** Registry, git and disk agree. */
  | "ok"
  /** The folder was deleted outside the app; its branch is still there, so it can be recreated from it. */
  | "missing"
  /** The folder and the branch are both gone: only a stale record is left. */
  | "gone"
  /** The folder is there but git does not track it as a worktree (or the record points outside our folder). Never touched. */
  | "unlinked";

export interface FolderStatus {
  taskId: string;
  branch: string;
  path: string;
  state: FolderState;
  /** One plain sentence for the person. */
  note: string;
}

export interface UntrackedFolder {
  name: string;
  path: string;
  branch?: string;
}

export interface Reconciled {
  folders: FolderStatus[];
  /** pp worktrees git lists under our folder that the registry does not know. Never touched. */
  untracked: UntrackedFolder[];
  /** Task ids whose stale record (folder and branch both gone) was dropped because forget was asked for. */
  forgotten: string[];
}

export interface ListedWorktree {
  path: string;
  branch?: string;
  locked: boolean;
  prunable: boolean;
}

/** Parses `git worktree list --porcelain`. */
export function parseWorktreeList(porcelain: string): ListedWorktree[] {
  const found: ListedWorktree[] = [];
  let current: ListedWorktree | undefined;
  for (const line of lines(porcelain)) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), locked: false, prunable: false };
      found.push(current);
    } else if (current && line.startsWith("branch ")) current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    else if (current && (line === "locked" || line.startsWith("locked "))) current.locked = true;
    else if (current && (line === "prunable" || line.startsWith("prunable "))) current.prunable = true;
  }
  return found;
}

export function folderNote(state: FolderState, taskId: string, branch: string, folder: string, outside = false): string {
  switch (state) {
    case "ok":
      return "";
    case "missing":
      return `The folder for ${taskId} was deleted outside Perfect Planner. Its work is safe on the branch ${branch}; recreate the folder from that branch to carry on.`;
    case "gone":
      return `The folder and the branch ${branch} for ${taskId} were both deleted outside Perfect Planner, so there is nothing to recreate. Starting a worker makes a fresh folder.`;
    case "unlinked":
      return outside
        ? `Perfect Planner's record for ${taskId} names a folder outside its own worktree folder (${folder}), so it will not recreate, move or remove anything there.`
        : `The folder for ${taskId} is still there (${folder}), but git no longer tracks it as a task folder. Perfect Planner has not changed it and will not remove it; your files are untouched.`;
  }
}

/** What stands between a task folder and its removal. Empty arrays and zero mean "nothing at risk". */
export interface WorktreeFacts {
  /** `git status` lines: changes not committed, and files git does not track (ignored files excluded). */
  uncommitted: string[];
  /** Ignored files that hold work (anything but node_modules and untouched placeholder settings). */
  ignored: string[];
  /** Commits on the branch or the folder's HEAD that are neither merged into the base nor on any remote. */
  atRisk: number;
  /** The branch is fully merged into the base, so removing the folder may delete the branch as well. */
  merged: boolean;
  baseGone: boolean;
  locked: boolean;
  /** The folder's HEAD is on a branch or tag, so removing the folder cannot lose commits. */
  headSafe: boolean;
  /** Set when git could not answer; then nothing is assumed safe. */
  unknown?: string;
}

/**
 * Plain-words reasons a folder must stay. `hard` ones mean removing it could lose work or break the task
 * (the person cannot choose past them); `soft` ones mean the work is only on the branch, which a removal
 * keeps (the person may choose to go ahead). Both empty: nothing would be lost.
 */
export function keepReasons(facts: WorktreeFacts, branch: string, baseRef: string, options: { needMerged?: boolean } = {}): { hard: string[]; soft: string[] } {
  const hard: string[] = [];
  const soft: string[] = [];
  if (facts.unknown) hard.push(`Could not check it (${facts.unknown}), so it is kept.`);
  if (facts.uncommitted.length) {
    const some = facts.uncommitted.slice(0, 5).map((line) => line.replace(/^\S+\s+/, "")).join(", ");
    hard.push(`Has ${facts.uncommitted.length} uncommitted or untracked ${facts.uncommitted.length === 1 ? "file" : "files"} (${some}${facts.uncommitted.length > 5 ? ", ..." : ""}).`);
  }
  if (facts.ignored.length) hard.push(`Has ignored files that would be deleted with the folder (${facts.ignored.slice(0, 5).join(", ")}${facts.ignored.length > 5 ? ", ..." : ""}).`);
  if (!facts.headSafe) hard.push("Its current commit is not on any branch, so removing the folder could lose it.");
  if (facts.locked) hard.push("Git has this folder locked.");
  if (facts.baseGone) soft.push(`Its base branch ${baseRef} no longer exists, so it cannot tell whether the work was merged.`);
  else if (facts.atRisk > 0) soft.push(`Has ${facts.atRisk} ${facts.atRisk === 1 ? "commit" : "commits"} not merged into ${baseRef} or pushed anywhere (${facts.atRisk === 1 ? "it is" : "they are"} on ${branch}).`);
  // An open task whose branch survives the removal could never get a new folder (a branch is used once).
  if (options.needMerged && !facts.merged) hard.push(`Its task is still open and ${branch} is not merged into ${baseRef}: removing the folder would leave no way to start a worker on it.`);
  return { hard, soft };
}

/**
 * Reads the facts about one task folder. Never changes anything: `git status` runs with git's optional
 * locks off, so looking cannot make a worker's own git command fail.
 */
export async function readFacts(options: { repoRoot: string; folder: string; branch: string; baseRef: string; locked: boolean; ignoredWork: (folder: string) => Promise<string[]> }): Promise<WorktreeFacts> {
  const { repoRoot, folder, branch, baseRef } = options;
  const facts: WorktreeFacts = { uncommitted: [], ignored: [], atRisk: 0, merged: false, baseGone: false, locked: options.locked, headSafe: true };
  try {
    const status = await runGit(folder, ["status", "--porcelain=v1", "--untracked-files=all"], { env: { GIT_OPTIONAL_LOCKS: "0" } });
    if (status.code !== 0) return { ...facts, unknown: oneLine(status.stderr) || "git status failed" };
    facts.uncommitted = lines(status.stdout);
    facts.ignored = await options.ignoredWork(folder);
    const base = await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
    facts.baseGone = base.code !== 0;
    const head = await runGit(folder, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    const tips = [head.code === 0 ? head.stdout.trim() : "", (await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`])).stdout.trim()].filter(Boolean);
    if (!facts.baseGone) facts.merged = (await runGit(repoRoot, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, baseRef])).code === 0;
    if (!facts.baseGone && tips.length) {
      // Commits reachable from either tip but from neither the base nor any remote-tracking branch.
      const count = await runGit(repoRoot, ["rev-list", "--count", ...tips, "--not", baseRef, "--remotes"]);
      if (count.code !== 0) return { ...facts, unknown: oneLine(count.stderr) || "git rev-list failed" };
      facts.atRisk = Number.parseInt(count.stdout.trim(), 10) || 0;
    }
    if (head.code === 0) {
      const holders = await runGit(repoRoot, ["for-each-ref", "--count=1", "--format=%(refname)", "--contains", head.stdout.trim(), "refs/heads", "refs/remotes", "refs/tags"]);
      facts.headSafe = holders.code === 0 && holders.stdout.trim() !== "";
    }
  } catch (error) {
    return { ...facts, unknown: oneLine((error as Error).message) };
  }
  return facts;
}

const oneLine = (text: string): string => text.trim().split(/\r?\n/)[0]?.slice(0, 200) ?? "";

/** Bytes under a folder, without following links. Stops counting after `limit` entries and says so. */
export async function directorySize(dir: string, limit = 200_000): Promise<{ bytes: number; approximate: boolean }> {
  let bytes = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length) {
    const here = stack.pop()!;
    let handle;
    try {
      handle = await opendir(here);
    } catch {
      continue;
    }
    for await (const entry of handle) {
      if (++seen > limit) return { bytes, approximate: true };
      const full = path.join(here, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) bytes += (await lstat(full).catch(() => ({ size: 0 }))).size;
    }
  }
  return { bytes, approximate: false };
}

/** True when `file` names the same folder as any listed worktree. */
export function isListed(listed: ListedWorktree[], file: string): ListedWorktree | undefined {
  return listed.find((item) => samePath(item.path, file));
}

