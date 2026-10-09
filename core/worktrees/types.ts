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
}

export const TASK_ID = /^T-[1-9]\d{0,6}(?:\.a[2-9]\d{0,3})?$/;

export function branchFor(taskId: string): string {
  return `pp/${taskId}`;
}
