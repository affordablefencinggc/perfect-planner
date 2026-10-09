import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { surfacesOverlap } from "../../src/engine/collisionEngine.js";
import { git, GitError, runGit } from "./git";
import { isWithin, lines, realDir, samePath, toRepoPath } from "./platform";
import { type Actor, type LedgerPort, WORKTREES_ACTOR } from "./ports";
import { copyLocalSettings } from "./settings";
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
  /** "auto" runs `npm ci --prefer-offline` when the worktree has a package-lock.json; false skips; a function replaces it. */
  install?: "auto" | false | Installer;
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

interface Registry {
  schemaVersion: 1;
  worktrees: WorktreeInfo[];
}

const HOOK_SOURCE = fileURLToPath(new URL("./hooks/secret-scan.mjs", import.meta.url));

export class WorktreeError extends Error {}

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
        actor,
        subject: taskId,
        summary: `Worktree for ${taskId} on ${branch}, port ${port}`,
        data: { branch, baseRef: base, baseSha, port, path: toRepoPath(path.relative(this.repoRoot, realPath)), claims: info.claims },
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
        actor,
        subject: taskId,
        summary: branchDeleted ? `Removed worktree and merged branch ${info.branch}` : `Removed worktree; kept unmerged branch ${info.branch}`,
        reason: branchKeptReason,
        evidence: [`branch:${info.branch}`, `port:${info.port}`],
        data: { branch: info.branch, branchDeleted },
      });
      return { taskId, branchDeleted, branchKeptReason };
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

  /** Keep task worktrees out of the main checkout's status without touching the tracked .gitignore. */
  private async excludeWorktreeDir(): Promise<void> {
    const relative = toRepoPath(path.relative(this.repoRoot, this.worktreeRoot));
    if (relative.startsWith("..")) return;
    const exclude = path.join(await this.gitCommonDir(), "info", "exclude");
    const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    const pattern = `/${relative}/`;
    if (current.split(/\r?\n/).includes(pattern)) return;
    mkdirSync(path.dirname(exclude), { recursive: true });
    writeFileSync(exclude, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${pattern}\n`);
  }

  private async freePort(taken: WorktreeInfo[]): Promise<number> {
    const used = new Set(taken.map((info) => info.port));
    for (let port = this.portRange[0]; port <= this.portRange[1]; port += 1) {
      if (!used.has(port) && (await portIsFree(port))) return port;
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
    writeFileSync(hook, '#!/bin/sh\nexec node "$(dirname "$0")/secret-scan.mjs"\n');
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
    const env = { ...process.env, ...(this.npmCache ? { npm_config_cache: this.npmCache } : {}) };
    await new Promise<void>((resolve, reject) => {
      // Fixed command string; a shell is needed to run npm.cmd on Windows.
      const child = spawn("npm ci --prefer-offline --no-audit --no-fund", { cwd: worktreePath, env, shell: true, windowsHide: true, stdio: "ignore" });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new WorktreeError(`npm ci failed in ${path.basename(worktreePath)} (exit ${code}).`))));
    });
  }
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
