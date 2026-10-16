import path from "node:path";
import { git } from "../worktrees/git";
import { makeRepo } from "../worktrees/testing";
import { branchFor, type WorktreeInfo } from "../worktrees/types";

export interface Fixture {
  root: string;
  baseSha: string;
  tasks: Record<string, WorktreeInfo>;
  cleanup: () => void;
}

/** A repo on main plus one `git worktree add` per task, on branch pp/<task>, beside the repo in the temp folder. */
export async function makeTaskRepo(taskIds: string[] = ["T-1", "T-2"], files?: Record<string, string>): Promise<Fixture> {
  const repo = await makeRepo(files ?? { "README.md": "hello\n", "src/shared.ts": "export const a = 1;\n", "src/other.ts": "export const b = 2;\n" });
  try {
    const baseSha = await git(repo.root, ["rev-parse", "HEAD"]);
    const tasks: Record<string, WorktreeInfo> = {};
    for (const [index, taskId] of taskIds.entries()) {
      const wt = path.join(path.dirname(repo.root), `wt-${taskId}`);
      await git(repo.root, ["worktree", "add", "-q", "-b", branchFor(taskId), wt, "main"]);
      tasks[taskId] = {
        taskId,
        branch: branchFor(taskId),
        path: wt,
        baseSha,
        baseRef: "main",
        port: 4100 + index,
        actor: "agent: test",
        createdAt: new Date(0).toISOString(),
        claims: [],
      };
    }
    return { root: repo.root, baseSha, tasks, cleanup: repo.cleanup };
  } catch (error) {
    repo.cleanup();
    throw error;
  }
}
