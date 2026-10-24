// Looking after the task folders (lane L10): what the Tasks screen shows when a folder is gone, the safe
// clean-up of folders nobody works in any more, and the plain reason "Check the work" cannot run.
//
// The rules, in order of weight (AGENTS.md: preserve first):
//   - A folder is removed only when its task is finished or released AND nothing in it can be lost
//     (core/worktrees keepReasons). Everything else is kept, listed with its owner, size and why, and the
//     person chooses.
//   - Nothing here deletes a branch except the one rule already in WorktreeManager.remove: fully merged.
//   - Dispatch and the sweep never run at the same time (withHygieneLock), and a task whose worker holds a
//     token, or was dispatched in this session, is never swept.
import fs from "node:fs";
import { deriveState } from "../../gate/index";
import { attemptLabel, type TaskView } from "../../mcp/index";
import { lines, runGit, WorktreeError, type FolderClass, type Leftover, type WorktreeInfo, type WorktreeManager } from "../../worktrees/index";
import type { CoreProject } from "../project";
import { HttpError, type Router } from "../router";
import { tokenFilePath } from "./agents";
import { localPerson, localPersonId } from "./people";

const LOCK = "tasks.hygieneLock";
const HANDLED = new WeakSet<WorktreeManager>();
const SEEN = new WeakMap<WorktreeManager, string>();

/** Dispatch, the sweep, recreate and a chosen removal run one after another per project, never interleaved. */
export function withHygieneLock<T>(project: CoreProject, work: () => Promise<T>): Promise<T> {
  const previous = (project.state.get(LOCK) as Promise<unknown> | undefined) ?? Promise.resolve();
  const next = previous.then(work, work);
  project.state.set(LOCK, next.catch(() => undefined));
  return next;
}

const QUIET = "tasks.watcherQuiet";

/** Task folders the git watcher stays out of right now because a clean-up is removing them. */
export function quietLabels(project: CoreProject): ReadonlySet<string> {
  return (project.state.get(QUIET) as Set<string> | undefined) ?? new Set();
}

/**
 * Runs a removal with the git watcher kept out of `labels`. Windows will not finish deleting a folder while a git
 * process has it open: the folder lingers, no longer tracked by git, and the next dispatch for the task refuses it.
 * A watcher pass already running is waited for first; a later one skips these folders. Callers hold the hygiene lock,
 * and the watcher never takes it (its listing does not tidy), so the wait cannot deadlock.
 */
export async function withWatcherAway<T>(project: CoreProject, labels: readonly string[], work: () => Promise<T>): Promise<T> {
  const quiet = (project.state.get(QUIET) as Set<string> | undefined) ?? new Set<string>();
  project.state.set(QUIET, quiet);
  for (const label of labels) quiet.add(label);
  try {
    await project.watch?.tick().catch(() => undefined);
    return await work();
  } finally {
    for (const label of labels) quiet.delete(label);
  }
}

export type CareMode = "change" | "start" | "manual";

/** Plain-words state of a task for the clean-up: being worked on, finished, released, or not clear. */
export function classifyFolder(project: CoreProject, dispatched: ReadonlyMap<string, unknown>, mode: CareMode = "manual"): (info: WorktreeInfo) => FolderClass {
  return (info) => {
    const label = info.taskId;
    const entries = project.entries();
    const gate = deriveState(entries, label);
    if (gate.done || gate.reopenedAs) return "finished";
    const task = [...project.service.board().values()].find((item) => attemptLabel(item) === label);
    if (!task) return { keep: "Its task is not on the board any more, so it cannot be told whether the work is finished." };
    if (task.status === "done") return "finished";
    // A worker that was started here, or still holds a token file, is on its way or at work: never swept.
    if (dispatched.has(label) || fs.existsSync(tokenFilePath(project, label))) return "active";
    if ((task.status === "claimed" || task.status === "blocked") && task.owner) return "active";
    if (releasedSinceClaim(entries, label)) return mode === "change" ? { keep: "Its claim was released. It is cleaned up the next time Perfect Planner starts, or when you press Clean up." } : "released";
    return { keep: `${label} is open and no worker holds it. If the worker was closed, its folder is a leftover.` };
  };
}

function releasedSinceClaim(entries: readonly { subject: string; type: string; data?: Record<string, unknown> }[], label: string): boolean {
  let claimed = -1;
  let released = -1;
  entries.forEach((entry, index) => {
    if (entry.subject !== label) return;
    if (entry.type === "task.claimed") claimed = index;
    if (entry.data?.released === true) released = index;
  });
  return released > claimed;
}

/** What each registered folder stands at, for the task cards: registry against git against disk. */
export async function annotate(worktrees: WorktreeManager, infos: WorktreeInfo[]): Promise<(WorktreeInfo & { state: string; note: string })[]> {
  if (!infos.length) return [];
  const { folders } = await worktrees.reconcileWithDisk().catch(() => ({ folders: [] }));
  return infos.map((info) => {
    const found = folders.find((item) => item.taskId === info.taskId);
    return { ...info, state: found?.state ?? "ok", note: found?.note ?? "" };
  });
}

/**
 * Before a dispatch: registry against git against disk. A folder deleted by hand gets the offer to recreate
 * it from its branch instead of a command for a folder that is not there; a record whose folder and branch
 * are both gone is dropped so a fresh folder can be made.
 */
export async function prepareForDispatch(worktrees: WorktreeManager, label: string): Promise<void> {
  const { folders } = await worktrees.reconcileWithDisk({ forget: true });
  const mine = folders.find((item) => item.taskId === label);
  if (mine?.state === "missing") throw new HttpError(409, "WORKTREE_MISSING", `${mine.note} Press "Recreate the folder" on this task, then start the worker.`);
  if (mine?.state === "unlinked") throw new HttpError(409, "WORKTREE_UNLINKED", mine.note);
}

/** The first Tasks request after the app starts, and each change in who is finished: forget stale records, then the safe sweep. */
export async function tidy(project: CoreProject, worktrees: WorktreeManager, dispatched: ReadonlyMap<string, unknown>): Promise<void> {
  const first = !HANDLED.has(worktrees);
  HANDLED.add(worktrees);
  const mode: CareMode = first ? "start" : "change";
  const classify = classifyFolder(project, dispatched, mode);
  const infos = await worktrees.list().catch(() => []);
  const fingerprint = infos.map((info) => `${info.taskId}:${typeof classify(info) === "string" ? classify(info) : "keep"}`).sort().join("|");
  if (!first && SEEN.get(worktrees) === fingerprint) return;
  if (!infos.length && !first) return;
  await withHygieneLock(project, async () => {
    const labels = (await worktrees.list().catch(() => [])).filter((info) => classify(info) !== "active").map((info) => info.taskId);
    await withWatcherAway(project, labels, async () => {
      await worktrees.reconcileWithDisk({ forget: first });
      await worktrees.sweep({ classify });
    });
  }).catch(() => undefined);
  SEEN.set(worktrees, (await worktrees.list().catch(() => [])).map((info) => `${info.taskId}:${typeof classify(info) === "string" ? classify(info) : "keep"}`).sort().join("|"));
}

export interface Readiness {
  ok: boolean;
  note?: string;
}

/**
 * Why "Check the work" can or cannot run now, in plain words. Only reads (git's optional locks are off, so
 * looking cannot make the worker's own git command fail). If git cannot answer, the button stays on and the
 * gate itself gives the reason when pressed.
 */
export async function checkReadiness(task: { proofs: unknown[]; worktree: { path: string; state?: string; note?: string } }): Promise<Readiness> {
  const tree = task.worktree;
  if (tree.state && tree.state !== "ok") return { ok: false, note: tree.note || "This task's folder is not usable, so nothing can be checked." };
  try {
    const status = await runGit(tree.path, ["status", "--porcelain=v1", "--untracked-files=normal"], { env: { GIT_OPTIONAL_LOCKS: "0" } });
    const dirty = status.code === 0 ? lines(status.stdout) : [];
    if (dirty.length) {
      const names = dirty.slice(0, 4).map((line) => line.slice(3).trim()).join(", ");
      return { ok: false, note: `The worker has unsaved changes in ${dirty.length} ${dirty.length === 1 ? "file" : "files"} (${names}${dirty.length > 4 ? ", ..." : ""}). The check only counts saved (committed) work: ask the worker to commit them, then check again.` };
    }
  } catch {
    /* cannot tell: leave the button on */
  }
  return task.proofs.length ? { ok: true } : { ok: true, note: "The worker has not said it is done yet (it has not attached its commit). You can still check what it has saved so far." };
}

export interface CareContext {
  requireRepo(project: CoreProject, name?: string | null): Promise<string>;
  manager(project: CoreProject, root: string, name?: string | null): Promise<WorktreeManager>;
  /** The repo names of the project, the first repo first (null), and the repo a task folder belongs to. */
  repoNames(project: CoreProject): (string | null)[];
  repoOf(project: CoreProject, label: string): string | null;
  dispatched(project: CoreProject): ReadonlyMap<string, unknown>;
  findTask(project: CoreProject, id: string): TaskView;
  overview(project: CoreProject): Promise<unknown>;
}

const asHttp = (error: unknown): never => {
  if (error instanceof WorktreeError) throw new HttpError(409, "WORKTREE", error.message);
  throw error;
};

function row(project: CoreProject, item: Leftover) {
  const task = [...project.service.board().values()].find((candidate) => attemptLabel(candidate) === item.taskId);
  return { task: item.taskId, state: item.state, branch: item.branch, path: item.path, owner: task?.owner ?? (item.launchedBy === localPersonId(project) ? "you" : item.launchedBy), launchedBy: item.launchedBy, sizeBytes: item.sizeBytes, sizeApproximate: item.sizeApproximate, why: item.why, removable: item.removable };
}

export function registerWorktreeCareRoutes(router: Router, ctx: CareContext): void {
  /** GET /worktrees: the folders nobody is working in, with owner, size and why each is kept. Reads only. */
  router.get("/worktrees", async ({ project }) => {
    const classify = classifyFolder(project, ctx.dispatched(project));
    const folders: ReturnType<typeof row>[] = [];
    const untrackedAll: unknown[] = [];
    for (const name of ctx.repoNames(project)) {
      // The first repo must be set; a later repo whose folder is gone is skipped here (the Tasks screen says so).
      const root = name === null ? await ctx.requireRepo(project) : await ctx.requireRepo(project, name).catch(() => null);
      if (!root) continue;
      const worktrees = await ctx.manager(project, root, name);
      const [{ kept }, { untracked }] = await Promise.all([worktrees.sweep({ classify, dryRun: true }), worktrees.reconcileWithDisk()]);
      folders.push(...kept.map((item) => row(project, item)));
      untrackedAll.push(...untracked);
    }
    return { folders, untracked: untrackedAll };
  });

  /** POST /worktrees/clean: the safe sweep. Removes only finished or released folders with nothing to lose. */
  router.post("/worktrees/clean", ({ project }) =>
    withHygieneLock(project, async () => {
      const removed: { task: string; path: string; branchDeleted: boolean; branchKept?: string }[] = [];
      const folders: ReturnType<typeof row>[] = [];
      for (const name of ctx.repoNames(project)) {
        const root = name === null ? await ctx.requireRepo(project) : await ctx.requireRepo(project, name).catch(() => null);
        if (!root) continue;
        const worktrees = await ctx.manager(project, root, name);
        const classify = classifyFolder(project, ctx.dispatched(project));
        const labels = (await worktrees.list().catch(() => [])).filter((info) => classify(info) !== "active").map((info) => info.taskId);
        const result = await withWatcherAway(project, labels, async () => {
          await worktrees.reconcileWithDisk({ forget: true });
          return worktrees.sweep({ classify, actor: localPerson(project) });
        });
        removed.push(...result.removed.map((item) => ({ task: item.taskId, path: item.path, branchDeleted: item.branchDeleted, ...(item.branchKeptReason ? { branchKept: item.branchKeptReason } : {}) })));
        folders.push(...result.kept.map((item) => row(project, item)));
      }
      return { removed, folders };
    }).catch(asHttp),
  );

  /** POST /worktrees/:id/remove: the person's own choice to remove a kept folder. Refuses anything with work that would be lost. */
  router.post("/worktrees/:id/remove", ({ project, params }) =>
    withHygieneLock(project, async () => {
      const label = params.id!;
      const repo = ctx.repoOf(project, label);
      const root = await ctx.requireRepo(project, repo);
      const classify = classifyFolder(project, ctx.dispatched(project));
      const worktrees = await ctx.manager(project, root, repo);
      return withWatcherAway(project, [label], () =>
        worktrees.removeChecked(label, localPerson(project), (info) => {
          const kind = classify(info);
          if (kind === "active") return { refuse: `${label} is still being worked on. Release its claim first.` };
          return { needMerged: kind !== "finished" };
        }),
      ).then((removed) => ({ task: label, branchDeleted: removed.branchDeleted, ...(removed.branchKeptReason ? { branchKept: removed.branchKeptReason } : {}) }));
    }).catch(asHttp),
  );

  /** POST /tasks/:id/recreate-folder: bring a deleted task folder back from its branch, work and all. */
  router.post("/tasks/:id/recreate-folder", ({ project, params }) =>
    withHygieneLock(project, async () => {
      const task = ctx.findTask(project, params.id!);
      const label = attemptLabel(task);
      const root = await ctx.requireRepo(project, task.repo ?? null);
      const result = await (await ctx.manager(project, root, task.repo ?? null)).recreate(label, localPerson(project));
      return { recreated: label, branch: result.info.branch, ...(result.ledgerNote ? { ledgerNote: result.ledgerNote } : {}), ...((await ctx.overview(project)) as object) };
    }).catch(asHttp),
  );
}
