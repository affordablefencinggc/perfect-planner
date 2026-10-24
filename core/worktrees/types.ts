/** One task's worktree as the manager records it. Paths are absolute, OS-native. */
export interface WorktreeInfo {
  taskId: string;
  branch: string;
  path: string;
  /** Commit the branch started from; the watcher diffs against this. */
  baseSha: string;
  /** Ref the task will merge back into, e.g. "main" or an integration branch. */
  baseRef: string;
  port: number;
  /** Who launched the worktree, as a ledger actor id. */
  actor: string;
  createdAt: string;
  /** Repo-relative file claims, forward slashes. Advisory; the watcher reports what really changed. */
  claims: string[];
  /** Set by the host when it lists a project's worktrees over several repos; never stored. */
  repo?: string;
}

export const TASK_ID = /^T-[1-9]\d{0,6}(?:\.a[2-9]\d{0,3})?$/;

/** A ledger sharing a git repo with another one gets its own namespace, e.g. "l-1a2b3c4d" (see core/host/repoClaim.ts). */
export const LEDGER_NAMESPACE = /^l-[0-9a-f]{8}$/;

/** Branch for a task: pp/T-n, or pp/<namespace>/T-n when the repo is shared by several ledgers. */
export function branchFor(taskId: string, namespace?: string | null): string {
  return namespace ? `pp/${namespace}/${taskId}` : `pp/${taskId}`;
}
