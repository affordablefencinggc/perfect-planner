// GitHub status for the Release screen: is the commit this project would ship green on GitHub?
//
// Read-only, and honest by construction. The route resolves the git folder the person chose for
// this project (core/host/routes/tasks.ts repoState), then asks core/github/status. No git folder,
// no GitHub remote or no usable sign-in is "not-configured" with the exact next action; it is
// never green. Nothing is written, and no token is returned.
import { githubStatus, type GitHubStatusOptions, type GitHubStatusView } from "../../github/status";
import type { CoreProject } from "../project";
import type { Router } from "../router";
import { repoState } from "./tasks";

/**
 * The status for this project's first repo. `options` is passed straight to githubStatus, so tests
 * can inject git, gh and fetch; the route below uses the real ones.
 */
export async function githubStatusView(project: CoreProject, options: GitHubStatusOptions = {}): Promise<GitHubStatusView> {
  const repo = await repoState(project);
  if (!repo.ok || !repo.root) {
    return {
      state: "not-configured",
      reason: repo.reason ?? "This project has no git folder yet.",
      remote: null,
      branch: null,
      sha: null,
      checks: [],
      nextAction: "Open Tasks, choose your project's git folder (or a different one if another project already uses it), then reload.",
    };
  }
  return githubStatus(repo.root, options);
}

export function registerGitHubRoutes(router: Router): void {
  /** GET /github/status: the GitHub remote, the current commit, its checks, and what to do next. */
  router.get("/github/status", ({ project }) => githubStatusView(project));
}
