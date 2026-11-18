// POST /tasks/:id/terminal: one read-only command, in one task's own worktree, from the Tasks screen.
//
// The screen never sends a folder and never sends a program: it sends the text the person typed.
// This route finds the task on the board, requires the worktree the board already recorded, resolves
// it to a real path and refuses it unless it is inside the task's repository. Only then does
// core/terminal decide whether the command is one of the few read-only forms it runs.
//
// Nothing is appended to the signed ledger here. The returned transcriptHash is the audit handle:
// it covers the exact command, exit code and the stdout and stderr the person was shown, so a later
// copy of the transcript can be checked against the hash the app returned.
import fs from "node:fs";
import path from "node:path";
import { isLocalWindowsPath, isWithin } from "../../exec/index";
import { MAX_COMMAND_CHARS, runTaskCommand, TaskCommandError } from "../../terminal/taskTerminal";
import type { CoreProject } from "../project";
import { HttpError, type Router } from "../router";
import { overview } from "./tasks";

export type WorktreeConfinement = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Resolve a task's recorded worktree against its repository. The path may be absolute or relative to
 * the repository (the board records both). It is refused when it is missing, is not a folder, or
 * reaches outside the repository either as written or through a link or junction.
 */
export function confineWorktree(repoRoot: string, worktree: string): WorktreeConfinement {
  if (typeof repoRoot !== "string" || !repoRoot.trim() || !path.isAbsolute(repoRoot)) {
    return { ok: false, reason: "This task's repository folder is not a full path, so no command was run." };
  }
  let root: string;
  try {
    root = fs.realpathSync.native(repoRoot);
  } catch {
    return { ok: false, reason: `This task's repository folder (${repoRoot}) is not there, so no command was run.` };
  }
  if (process.platform === "win32" && !isLocalWindowsPath(root)) {
    return { ok: false, reason: "This task's repository is on a network or device path, so no command was run." };
  }
  const candidate = path.isAbsolute(worktree) ? path.resolve(worktree) : path.resolve(root, worktree);
  if (!isWithin(root, candidate)) {
    return { ok: false, reason: `This task's folder (${worktree}) is outside the repository (${root}), so no command was run.` };
  }
  let real: string;
  try {
    real = fs.realpathSync.native(candidate);
  } catch {
    return { ok: false, reason: `This task's folder (${worktree}) is not there, so no command was run.` };
  }
  if (!isWithin(root, real)) {
    return { ok: false, reason: `This task's folder leads outside the repository (${root}), so no command was run.` };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch {
    return { ok: false, reason: `This task's folder (${worktree}) cannot be read, so no command was run.` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, reason: `This task's folder (${worktree}) is not a folder, so no command was run.` };
  }
  return { ok: true, path: real };
}

/** One command at a time per task: two npm test runs in one worktree would fight over its files. */
const RUNNING = new WeakMap<CoreProject, Set<string>>();

export function registerTaskTerminalRoutes(router: Router): void {
  /** POST /tasks/:id/terminal { command }: run one read-only command in the task's worktree. */
  router.post("/tasks/:id/terminal", async ({ project, params, body }) => {
    const id = params.id!;
    const raw = body && typeof body === "object" && !Array.isArray(body) ? (body as { command?: unknown }).command : undefined;
    if (typeof raw !== "string" || !raw.trim()) throw new HttpError(400, "INVALID", "Type a command to run in this task's folder.");
    if (raw.length > MAX_COMMAND_CHARS) throw new HttpError(400, "INVALID", `Keep the command under ${MAX_COMMAND_CHARS} characters.`);

    // The board's own view: the task, the worktree it recorded, and the repository that worktree
    // belongs to. No folder or program is accepted from the window.
    const view = await overview(project);
    const task = view.tasks.find((item) => item.id === id || item.label === id);
    if (!task) throw new HttpError(404, "NOT_FOUND", `${id} is not on the board. Approve the plan or add the task first.`);
    if (task.worktree === undefined) {
      throw new HttpError(409, "WORKTREE_UNKNOWN", `Perfect Planner is still checking this project's Git folders for ${task.label}. Try again in a moment; nothing was run.`);
    }
    if (!task.worktree) {
      throw new HttpError(409, "NO_WORKTREE", `${task.label} has no worktree yet, so there is no task folder to run a command in. Start a worker on it first.`);
    }
    const repo = view.repos.find((candidate) => candidate.name === task.repo);
    if (!repo?.ok || !repo.root) {
      throw new HttpError(409, "NO_REPO", repo?.reason ?? "This task's repository is not available, so no command was run.");
    }
    const confined = confineWorktree(repo.root, task.worktree.path);
    if (!confined.ok) throw new HttpError(409, "WORKTREE_OUTSIDE", confined.reason);

    let running = RUNNING.get(project);
    if (!running) {
      running = new Set();
      RUNNING.set(project, running);
    }
    if (running.has(task.label)) throw new HttpError(409, "BUSY", `A command is already running in ${task.label}'s folder. Wait for it to finish.`);
    running.add(task.label);
    try {
      return { task: task.label, ...(await runTaskCommand({ cwd: confined.path, command: raw })) };
    } catch (error) {
      if (error instanceof TaskCommandError) throw new HttpError(error.status, error.code, error.message);
      throw error;
    } finally {
      running.delete(task.label);
    }
  });
}
