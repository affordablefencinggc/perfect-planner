// The names of a project's repos, read without running git: the first repo ("main") and the extra ones.
import { PRIMARY_REPO, readRepos } from "../repos/index";

export function knownRepoNames(project: { root: string }): string[] {
  return [PRIMARY_REPO, ...readRepos(project.root).repos.map((repo) => repo.name)];
}
