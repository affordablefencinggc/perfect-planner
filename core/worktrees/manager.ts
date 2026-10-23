import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { surfacesOverlap } from "../../src/engine/collisionEngine.js";
import { ensureRequiredIgnores, privatePaths } from "./ignores";
import { INSTALL_SCRIPTS_HINT, NPM_CONFIG_HINT, runNpm } from "./npm";
import { git, GitError, runGit } from "./git";
import { isWithin, lines, realDir, samePath, toRepoPath } from "./platform";
import { type Actor, type LedgerPort, WORKTREES_ACTOR } from "./ports";
import { copyLocalSettings, placeholderSecrets } from "./settings";
import { branchFor, TASK_ID, type WorktreeInfo } from "./types";

export type Installer = (worktreePath: string) => Promise<void>;

export interface WorktreeManagerOptions {
  repoRoot: string;
  ledger: LedgerPort;
  /** Worktrees live here, relative to the repo root (spec 5.3). */
  worktreeDir?: string;
  /** Cap on parallel worktrees to protect disk and CPU (spec 5.6). */
  maxParallel?: number;
  /** Inclusive dev-server port range handed out one per worktree. */
  ports?: [number, number];
  /**
   * "auto" runs `npm ci --prefer-offline --ignore-scripts` when the worktree has a package-lock.json,
   * through Node with no shell and an npm never taken from the project; false skips; a function replaces it.
   */
  install?: "auto" | false | Installer;
  /** Let "auto" run packages' install scripts. Only a person turns this on; default false. */
  allowInstallScripts?: boolean;
  /** Shared npm cache directory, passed as npm_config_cache. */
  npmCache?: string;
  /** Install the commit-time secret scan in each worktree (default true). */
  secretScan?: boolean;
  now?: () => Date;
}

export interface CreateOptions {
  taskId: string;
  actor: Actor;
  /** Ref to branch from and merge back into. Defaults to the main checkout's current branch. */
  baseRef?: string;
  claims?: string[];
}

export interface ClaimConflict {
  taskId: string;
  mine: string;
  theirs: string;
}

export interface RemoveResult {
  taskId: string;
  branchDeleted: boolean;
  /** Why the branch was kept (unmerged work is never deleted). */
  branchKeptReason?: string;
}

export type UpdateRefusal = "dirty" | "conflict" | "unfinished" | "folder-missing" | "wrong-branch" | "base-missing" | "would-overwrite" | "identity" | "git-too-old" | "failed";

/** What bringing a task up to date with its integration branch did. Nothing is thrown for a refusal: the folder was left as it was. */
export interface UpdateFromMainResult {
  status: "updated" | "up-to-date" | "refused";
  taskId: string;
  branch: string;
  /** The integration branch brought in (the task's baseRef, for example "main"). */
  base: string;
  /** Plain words for the person. */
  message: string;
  /** refused only. */
  reason?: UpdateRefusal;
  /** refused: the files that stopped it (changed files, conflicting files, files that would be overwritten). updated: files the update brought in. */
  files?: string[];
  /** updated: the branch tip before and after, and the integration commit that was merged in. */
  before?: string;
  after?: string;
  mergedIn?: string;
  /** updated: how many commits of the integration branch the task did not have. */
  commits?: number;
  /** updated: true when the branch only moved forward (it had no commits of its own the integration branch lacked). */
  fastForward?: boolean;
}

interface Registry {
  schemaVersion: 1;
  worktrees: WorktreeInfo[];
}

const HOOK_SOURCE = fileURLToPath(new URL("./hooks/secret-scan.mjs", import.meta.url));

/**
 * The pre-commit hook git runs in a task worktree. The desktop app ships its own Node
 * (PP_NODE_BINARY), so the hook calls that one; git's sh wants forward slashes on Windows.
 */
export function preCommitHook(env: NodeJS.ProcessEnv = process.env): string {
  // Single quotes, so nothing in the path ($, backticks) is expanded by sh.
  const node = env.PP_NODE_BINARY ? `'${env.PP_NODE_BINARY.replaceAll("\\", "/").replaceAll("'", `'\\''`)}'` : "node";
  return `#!/bin/sh\nexec ${node} "$(dirname "$0")/secret-scan.mjs"\n`;
}

export class WorktreeError extends Error {}

/** Dev-server ports handed out in this process, by repo. Two projects open at once must not share one while neither server is listening yet. */
const PORT_LEASES = new Map<number, string>();

/**
 * One git worktree per task (spec 5.3 and 5.6). Each gets branch pp/T-n, a folder under
 * .perfect-planner/worktrees, a free dev-server port, local settings with placeholder
 * secrets, dependencies from the shared cache and a commit-time secret scan.
 * Work is never discarded: removal refuses a dirty worktree and keeps unmerged branches.
 */
export class WorktreeManager {
  readonly repoRoot: string;
  readonly worktreeRoot: string;
  private readonly ledger: LedgerPort;
  private readonly maxParallel: number;
  private readonly portRange: [number, number];
  private readonly install: "auto" | false | Installer;
  private readonly npmCache?: string;
  private readonly allowInstallScripts: boolean;
  private readonly secretScan: boolean;
  private readonly now: () => Date;
  private commonDir?: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: WorktreeManagerOptions) {
    this.repoRoot = realDir(options.repoRoot);
    this.worktreeRoot = path.join(this.repoRoot, ...(options.worktreeDir ?? ".perfect-planner/worktrees").split("/"));
    this.ledger = options.ledger;
    this.maxParallel = options.maxParallel ?? 4;
    this.portRange = options.ports ?? [5200, 5999];
    this.install = options.install ?? "auto";
    this.npmCache = options.npmCache;
    this.allowInstallScripts = options.allowInstallScripts ?? false;
    this.secretScan = options.secretScan ?? true;
    this.now = options.now ?? (() => new Date());
  }

  /** Mutations run one at a time so two launches can't take the same port or slot. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async list(): Promise<WorktreeInfo[]> {
    return (await this.readRegistry()).worktrees;
  }

  async get(taskId: string): Promise<WorktreeInfo | undefined> {
    return (await this.list()).find((info) => info.taskId === taskId);
  }

  create(options: CreateOptions): Promise<WorktreeInfo> {
    return this.serial(() => this.createNow(options));
  }

  private async createNow({ taskId, actor, baseRef, claims = [] }: CreateOptions): Promise<WorktreeInfo> {
    if (!TASK_ID.test(taskId)) throw new WorktreeError(`"${taskId}" is not a task id like T-14 or T-14.a2.`);
    const registry = await this.readRegistry();
    if (registry.worktrees.some((info) => info.taskId === taskId)) throw new WorktreeError(`${taskId} already has a worktree.`);
    if (registry.worktrees.length >= this.maxParallel) throw new WorktreeError(`${this.maxParallel} worktrees are already running; finish or remove one first.`);

    const branch = branchFor(taskId);
    const worktreePath = path.join(this.worktreeRoot, taskId);
    const base = baseRef ?? (await git(this.repoRoot, ["symbolic-ref", "--short", "HEAD"]));
    const baseSha = await git(this.repoRoot, ["rev-parse", "--verify", `${base}^{commit}`]).catch(() => {
      throw new WorktreeError(`Base "${base}" is not a commit in this repo.`);
    });
    if ((await runGit(this.repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0) {
      throw new WorktreeError(`Branch ${branch} already exists. Use the next attempt id instead of reusing it.`);
    }
    if (existsSync(worktreePath)) throw new WorktreeError(`${toRepoPath(path.relative(this.repoRoot, worktreePath))} already exists on disk.`);
    const conflicts = this.conflictsWith(registry.worktrees, taskId, claims);
    if (conflicts.length) throw new WorktreeError(`${taskId} claims files already claimed: ${conflicts.map((c) => `${c.mine} (${c.taskId})`).join(", ")}.`);

    await this.excludeWorktreeDir();
    mkdirSync(this.worktreeRoot, { recursive: true });
    // git itself refuses a branch already checked out in another worktree; -b also refuses an existing branch.
    await git(this.repoRoot, ["worktree", "add", "-b", branch, worktreePath, baseSha]);
    try {
      const realPath = realDir(worktreePath);
      if (!isWithin(realDir(this.worktreeRoot), realPath)) throw new WorktreeError("Worktree folder was redirected outside .perfect-planner/worktrees.");
      const port = await this.freePort(registry.worktrees);
      const tracked = new Set(lines(await git(this.repoRoot, ["ls-files", "--", ".env*"])));
      const settings = copyLocalSettings(this.repoRoot, realPath, tracked);
      if (this.secretScan) await this.installSecretScan(realPath);
      await this.installDependencies(realPath);
      const info: WorktreeInfo = { taskId, branch, path: realPath, baseSha, baseRef: base, port, actor: actor.id, createdAt: this.now().toISOString(), claims: claims.map(toRepoPath).sort() };
      registry.worktrees.push(info);
      await this.writeRegistry(registry);
      this.ledger.append({
        type: "worktree.created",
        // Agents may not write git entries; the manager records the launch and names who asked.
        actor: WORKTREES_ACTOR,
        subject: taskId,
        summary: `Worktree for ${taskId} on ${branch}, port ${port}`,
        data: { launchedBy: actor, branch, baseRef: base, baseSha, port, path: toRepoPath(path.relative(this.repoRoot, realPath)), claims: info.claims },
        evidence: [`branch:${branch}`, `base:${base}`, `commit:${baseSha}`, `port:${port}`, `path:${toRepoPath(path.relative(this.repoRoot, realPath))}`, ...settings.map((name) => `settings:${name}`), ...info.claims.map((file) => `claim:${file}`)],
      });
      return info;
    } catch (error) {
      // Nothing has been written in a worktree this young, so a forced rollback discards no one's work.
      await runGit(this.repoRoot, ["worktree", "remove", "--force", worktreePath]);
      await runGit(this.repoRoot, ["branch", "-D", branch]);
      throw error;
    }
  }

  /** Add file claims to a running task. Returns the conflicts and records nothing if there are any. */
  claim(taskId: string, files: string[]): Promise<ClaimConflict[]> {
    return this.serial(async () => {
      const registry = await this.readRegistry();
      const info = registry.worktrees.find((item) => item.taskId === taskId);
      if (!info) throw new WorktreeError(`${taskId} has no worktree.`);
      const conflicts = this.conflictsWith(registry.worktrees, taskId, files);
      if (conflicts.length) return conflicts;
      info.claims = [...new Set([...info.claims, ...files.map(toRepoPath)])].sort();
      await this.writeRegistry(registry);
      return [];
    });
  }

  private conflictsWith(worktrees: WorktreeInfo[], taskId: string, files: string[]): ClaimConflict[] {
    const conflicts: ClaimConflict[] = [];
    for (const other of worktrees) {
      if (other.taskId === taskId) continue;
      for (const mine of files) for (const theirs of other.claims) {
        if (surfacesOverlap({ kind: "file", surface: mine }, { kind: "file", surface: theirs })) conflicts.push({ taskId: other.taskId, mine: toRepoPath(mine), theirs });
      }
    }
    return conflicts;
  }

  /** Drop file claims a task holds (all of them, or just the given files). Returns what was released and what it still holds. */
  releaseClaims(taskId: string, files?: string[]): Promise<{ released: string[]; remaining: string[] }> {
    return this.serial(async () => {
      const registry = await this.readRegistry();
      const info = registry.worktrees.find((item) => item.taskId === taskId);
      if (!info) throw new WorktreeError(`${taskId} has no worktree.`);
      const wanted = files ? new Set(files.map(toRepoPath)) : undefined;
      const released = info.claims.filter((file) => !wanted || wanted.has(file));
      if (!released.length) return { released: [], remaining: [...info.claims] };
      info.claims = info.claims.filter((file) => !released.includes(file));
      await this.writeRegistry(registry);
      return { released, remaining: [...info.claims] };
    });
  }

  /**
   * Bring a task's branch up to date with the branch it will merge into, inside its own worktree, without
   * ever touching work in progress. The merge is worked out first with git's in-memory merge
   * (merge-tree --write-tree), which changes no file: a conflict or a dirty worktree is reported and the
   * folder is left exactly as it was. Only a clean merge is applied, as a fast-forward of a clean folder,
   * which git refuses outright (changing nothing) if it would overwrite anything. Nothing is reset,
   * stashed or deleted. On success the task's base moves to the merged-in commit, so "what the worker
   * changed" stays the worker's own changes. The approvals made at the old tip no longer match the new one,
   * so the work must be checked and its diff approved again.
   */
  updateFromMain(taskId: string): Promise<UpdateFromMainResult> {
    return this.serial(() => this.updateNow(taskId));
  }

  private async updateNow(taskId: string): Promise<UpdateFromMainResult> {
    const registry = await this.readRegistry();
    const info = registry.worktrees.find((item) => item.taskId === taskId);
    if (!info) throw new WorktreeError(`${taskId} has no worktree.`);
    const where = { taskId, branch: info.branch, base: info.baseRef };
    const refuse = (reason: UpdateRefusal, message: string, files?: string[]): UpdateFromMainResult => ({ status: "refused", ...where, reason, message: `${message} Nothing in ${taskId}'s folder was changed.`, ...(files?.length ? { files } : {}) });

    if (!existsSync(info.path)) return refuse("folder-missing", `${taskId}'s folder is missing (${toRepoPath(path.relative(this.repoRoot, info.path))}), so there is nothing to update.`);
    const onBranch = (await runGit(info.path, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim();
    if (onBranch !== info.branch) return refuse("wrong-branch", `${taskId}'s folder is on ${onBranch ? `branch ${onBranch}` : "no branch"}, not on ${info.branch}.`);
    for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
      const marker = (await runGit(info.path, ["rev-parse", "--git-path", name])).stdout.trim();
      if (marker && existsSync(path.resolve(info.path, marker))) return refuse("unfinished", `${taskId} is in the middle of a merge, rebase or cherry-pick (${name}). Finish or abort that first.`);
    }

    const before = await snapshot(info.path);
    if (before.status.length) {
      const names = before.status.map((line) => line.slice(3));
      return refuse("dirty", `${taskId} has changes that are not committed yet (${listNames(names)}). Let the worker commit them, or move them aside, then update again.`, names);
    }

    const target = await runGit(this.repoRoot, ["rev-parse", "--verify", "-q", `${info.baseRef}^{commit}`]);
    const tip = target.stdout.trim();
    if (target.code !== 0 || !tip) return refuse("base-missing", `${info.baseRef}, the branch ${taskId} merges into, can no longer be found.`);

    const moveBase = async (): Promise<void> => {
      if (info.baseSha === tip) return;
      info.baseSha = tip;
      await this.writeRegistry(registry);
    };
    if ((await runGit(info.path, ["merge-base", "--is-ancestor", tip, before.head])).code === 0) {
      await moveBase();
      return { status: "up-to-date", ...where, message: `${taskId} already has everything that is in ${info.baseRef}. Nothing was changed.` };
    }
    const commits = Number((await runGit(info.path, ["rev-list", "--count", `${before.head}..${tip}`])).stdout.trim()) || 0;

    let after: string;
    let fastForward = false;
    if ((await runGit(info.path, ["merge-base", "--is-ancestor", before.head, tip])).code === 0) {
      after = tip;
      fastForward = true;
    } else {
      // The merge is worked out in git's object store only: no file, index or branch changes yet.
      const merged = await runGit(info.path, ["merge-tree", "--write-tree", "--no-messages", "--name-only", before.head, tip]);
      if (merged.code === 1) {
        const [, ...rest] = merged.stdout.split(/\r?\n/);
        const conflicted = rest.slice(0, rest.findIndex((line) => line === "") < 0 ? rest.length : rest.findIndex((line) => line === "")).filter(Boolean);
        return refuse("conflict", `${taskId} cannot be brought up to date because the same lines were changed in ${conflicted.length ? listNames(conflicted) : "some files"} here and in ${info.baseRef}. A person has to choose which change to keep.`, conflicted);
      }
      if (merged.code !== 0) {
        return /usage|unknown option|write-tree/i.test(merged.stderr)
          ? refuse("git-too-old", "Updating a task needs Git 2.38 or later (git merge-tree --write-tree). Update Git and try again.")
          : refuse("failed", `Git could not work out the merge (${firstLine(merged.stderr || merged.stdout)}).`);
      }
      const tree = merged.stdout.split(/\r?\n/)[0]!.trim();
      const made = await runGit(info.path, ["commit-tree", tree, "-p", before.head, "-p", tip, "-m", `Bring ${info.branch} up to date with ${info.baseRef}`]);
      if (made.code !== 0) {
        return /identity unknown|unable to auto-detect|no email was given|no name was given|empty ident/i.test(made.stderr)
          ? refuse("identity", "Git on this computer does not know your name and email yet, so it cannot record the merge. Set them with git config --global user.name and user.email, then update again.")
          : refuse("failed", `Git could not record the merge (${firstLine(made.stderr || made.stdout)}).`);
      }
      after = made.stdout.trim();
    }

    // Files the update will write. Ignored files are expendable to git but may be the worker's notes or data.
    const incoming = lines((await runGit(info.path, ["-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", before.head, after])).stdout);
    const ignored = lines((await runGit(info.path, ["--no-optional-locks", "-c", "core.quotePath=false", "status", "--porcelain=v1", "--ignored=matching", "--untracked-files=all"])).stdout)
      .filter((line) => line.startsWith("!! "))
      .map((line) => line.slice(3).replace(/\/$/, ""));
    const clash = incoming.filter((file) => ignored.some((hidden) => file === hidden || file.startsWith(`${hidden}/`) || hidden.startsWith(`${file}/`)));
    if (clash.length) return refuse("would-overwrite", `${info.baseRef} has files at the same place as files ${taskId} keeps out of git (${listNames(clash)}). Move those files first.`, clash);

    const applied = await runGit(info.path, ["merge", "--ff-only", "--quiet", after]);
    if (applied.code !== 0) {
      const now = await snapshot(info.path).catch(() => undefined);
      const intact = now && now.head === before.head && now.status.length === 0;
      return {
        status: "refused",
        ...where,
        reason: "failed",
        message: intact
          ? `Git would not apply the update (${firstLine(applied.stderr || applied.stdout)}). Nothing in ${taskId}'s folder was changed.`
          : `Git stopped part-way through the update (${firstLine(applied.stderr || applied.stdout)}) and ${taskId}'s folder is not as it was. Its commits are all still on ${info.branch}; look at "git status" in the folder before doing anything else.`,
      };
    }
    await moveBase();
    return {
      status: "updated",
      ...where,
      message: `${taskId} now has the ${commits === 1 ? "1 new change" : `${commits} new changes`} from ${info.baseRef}${fastForward ? "" : ", merged with its own work"}. Its own files were not touched.`,
      before: before.head,
      after,
      mergedIn: tip,
      commits,
      fastForward,
      files: incoming.slice(0, 50),
    };
  }

  /**
   * Remove a finished task's worktree (spec 5.6). Refuses if it holds uncommitted work.
   * The branch is deleted only when it is fully merged into its base; otherwise it is kept.
   */
  remove(taskId: string, actor: Actor = WORKTREES_ACTOR): Promise<RemoveResult> {
    return this.serial(async () => {
      const registry = await this.readRegistry();
      const info = registry.worktrees.find((item) => item.taskId === taskId);
      if (!info) throw new WorktreeError(`${taskId} has no worktree.`);
      if (existsSync(info.path)) {
        const dirty = await git(info.path, ["status", "--porcelain=v1", "--untracked-files=all"]);
        if (dirty) throw new WorktreeError(`${taskId} has uncommitted changes; commit or move them before removing the worktree.`);
        // git worktree remove also deletes ignored files, which can be real work (notes, data, edited settings).
        const kept = await this.ignoredWork(info.path);
        if (kept.length) throw new WorktreeError(`${taskId} has ignored files that would be deleted with the worktree; move them first: ${kept.slice(0, 10).join(", ")}`);
        await git(this.repoRoot, ["worktree", "remove", info.path]);
      } else {
        await git(this.repoRoot, ["worktree", "prune"]);
      }
      let branchDeleted = false;
      let branchKeptReason: string | undefined;
      const merged = await runGit(this.repoRoot, ["merge-base", "--is-ancestor", info.branch, info.baseRef]);
      if (merged.code === 0) {
        await git(this.repoRoot, ["branch", "-D", info.branch]);
        branchDeleted = true;
      } else {
        branchKeptReason = `${info.branch} is not merged into ${info.baseRef}, so it was kept.`;
      }
      registry.worktrees = registry.worktrees.filter((item) => item.taskId !== taskId);
      await this.writeRegistry(registry);
      this.ledger.append({
        type: "worktree.removed",
        actor: WORKTREES_ACTOR,
        subject: taskId,
        summary: branchDeleted ? `Removed worktree and merged branch ${info.branch}` : `Removed worktree; kept unmerged branch ${info.branch}`,
        reason: branchKeptReason,
        evidence: [`branch:${info.branch}`, `port:${info.port}`],
        data: { removedBy: actor, branch: info.branch, branchDeleted },
      });
      return { taskId, branchDeleted, branchKeptReason };
    });
  }

  /**
   * Ignored files in a worktree that removal would destroy. Dependencies (node_modules) can be
   * reinstalled, and settings copied in at launch that still match what the copy produced are
   * placeholders; anything else counts as work.
   */
  private async ignoredWork(worktreePath: string): Promise<string[]> {
    const ignored = lines(await git(worktreePath, ["status", "--porcelain=v1", "--ignored=matching", "--untracked-files=all"]))
      .filter((line) => line.startsWith("!! "))
      .map((line) => line.slice(3).replace(/^"(.*)"$/, "$1"));
    return ignored.filter((file) => {
      if (/(^|\/)node_modules(\/|$)/.test(file)) return false;
      if (!/^\.env(?:\..+)?$/.test(file)) return true;
      const source = path.join(this.repoRoot, file);
      return !existsSync(source) || readFileSync(path.join(worktreePath, file), "utf8") !== placeholderSecrets(readFileSync(source, "utf8"));
    });
  }

  /** Compare the registry with git's own worktree list: entries git no longer knows, and pp worktrees we don't track. */
  async reconcile(): Promise<{ missing: string[]; untracked: string[] }> {
    const listed = lines(await git(this.repoRoot, ["worktree", "list", "--porcelain"]))
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
    const registry = await this.readRegistry();
    const missing = registry.worktrees.filter((info) => !listed.some((item) => samePath(item, info.path))).map((info) => info.taskId);
    const untracked = listed
      .filter((item) => isWithin(this.worktreeRoot, path.resolve(item)) || isWithin(realDir(this.worktreeRoot), path.resolve(item)))
      .filter((item) => !registry.worktrees.some((info) => samePath(item, info.path)))
      .map((item) => path.basename(item));
    return { missing, untracked };
  }

  private async gitCommonDir(): Promise<string> {
    if (!this.commonDir) this.commonDir = path.resolve(this.repoRoot, await git(this.repoRoot, ["rev-parse", "--git-common-dir"]));
    return this.commonDir;
  }

  private async registryFile(): Promise<string> {
    return path.join(await this.gitCommonDir(), "perfect-planner", "worktrees.json");
  }

  private async readRegistry(): Promise<Registry> {
    const file = await this.registryFile();
    if (!existsSync(file)) return { schemaVersion: 1, worktrees: [] };
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Registry;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.worktrees)) throw new WorktreeError(`${file} is not a worktree registry this version understands.`);
    return parsed;
  }

  private async writeRegistry(registry: Registry): Promise<void> {
    this.syncLeases(registry);
    const file = await this.registryFile();
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`);
    // Windows can briefly lock the target (indexers, antivirus); retry the atomic swap.
    for (let attempt = 0; ; attempt += 1) {
      try {
        renameSync(temp, file);
        return;
      } catch (error) {
        if (attempt >= 10 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  }

  /** Keep task worktrees, the ledger and worker tokens out of the main checkout's status without touching the tracked .gitignore. */
  private async excludeWorktreeDir(): Promise<void> {
    // The whole planner folder (ledger, worker tokens) is always excluded; a custom worktree folder too.
    const relative = toRepoPath(path.relative(this.repoRoot, this.worktreeRoot));
    const custom = relative.startsWith("..") || privatePaths([relative]).length ? [] : [`/${relative}/`];
    await ensureRequiredIgnores(this.repoRoot, custom);
  }

  /** Keeps this repo's leases equal to the ports its registry holds; a lease with no worktree behind it is dropped. */
  private syncLeases(registry: Registry): void {
    const held = new Set(registry.worktrees.map((info) => info.port));
    for (const [port, holder] of PORT_LEASES) if (holder === this.repoRoot && !held.has(port)) PORT_LEASES.delete(port);
    for (const port of held) PORT_LEASES.set(port, this.repoRoot);
  }

  private async freePort(taken: WorktreeInfo[]): Promise<number> {
    const used = new Set(taken.map((info) => info.port));
    for (let port = this.portRange[0]; port <= this.portRange[1]; port += 1) {
      const holder = PORT_LEASES.get(port);
      if (!used.has(port) && (!holder || holder === this.repoRoot) && (await portIsFree(port))) {
        PORT_LEASES.set(port, this.repoRoot);
        return port;
      }
    }
    throw new WorktreeError(`No free dev-server port between ${this.portRange[0]} and ${this.portRange[1]}.`);
  }

  /**
   * Per-worktree hooksPath, so only task worktrees get the scan and the user's own
   * hooks in the main checkout are untouched. Needs git's worktreeConfig extension.
   */
  private async installSecretScan(worktreePath: string): Promise<void> {
    const hooksDir = path.join(await this.gitCommonDir(), "perfect-planner", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    copyFileSync(HOOK_SOURCE, path.join(hooksDir, "secret-scan.mjs"));
    const hook = path.join(hooksDir, "pre-commit");
    writeFileSync(hook, preCommitHook());
    if (process.platform !== "win32") chmodSync(hook, 0o755);
    if ((await runGit(this.repoRoot, ["config", "--get", "extensions.worktreeConfig"])).stdout.trim() !== "true") {
      const version = (await runGit(this.repoRoot, ["config", "--get", "core.repositoryformatversion"])).stdout.trim();
      if (!version || version === "0") await git(this.repoRoot, ["config", "core.repositoryformatversion", "1"]);
      await git(this.repoRoot, ["config", "extensions.worktreeConfig", "true"]);
    }
    await git(worktreePath, ["config", "--worktree", "core.hooksPath", toRepoPath(hooksDir)]);
  }

  private async installDependencies(worktreePath: string): Promise<void> {
    if (this.install === false) return;
    if (typeof this.install === "function") return this.install(worktreePath);
    if (!existsSync(path.join(worktreePath, "package-lock.json"))) return;
    // npm comes from beside Node or PATH, never from the project or its worktrees, and runs without a shell.
    const { code, output } = await runNpm(["ci", "--prefer-offline", "--no-audit", "--no-fund"], {
      cwd: worktreePath,
      protect: [this.repoRoot, this.worktreeRoot, worktreePath],
      env: this.npmCache ? { npm_config_cache: this.npmCache } : {},
      allowInstallScripts: this.allowInstallScripts,
    }).catch((error: Error) => ({ code: -1, output: error.message }));
    if (code !== 0) {
      const hint = `${this.allowInstallScripts ? "" : ` ${INSTALL_SCRIPTS_HINT}`} ${NPM_CONFIG_HINT}`;
      throw new WorktreeError(`npm ci failed in ${path.basename(worktreePath)} (exit ${code}): ${output.trim().split(/\r?\n/).slice(-3).join(" ")}${hint}`);
    }
  }
}

/** Where a worktree stands: its tip and every changed or untracked file git reports (ignored files are not listed). */
async function snapshot(worktreePath: string): Promise<{ head: string; status: string[] }> {
  const head = await git(worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const status = lines(await git(worktreePath, ["--no-optional-locks", "-c", "core.quotePath=false", "status", "--porcelain=v1", "--untracked-files=all"]));
  return { head, status };
}

function listNames(names: readonly string[], shown = 4): string {
  return names.length <= shown ? names.join(", ") : `${names.slice(0, shown).join(", ")} and ${names.length - shown} more`;
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0]?.slice(0, 200) || "no message";
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => server.close(() => resolve(true)));
  });
}

export { GitError };
