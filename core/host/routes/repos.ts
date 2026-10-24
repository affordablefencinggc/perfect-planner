// Several git repos in one project (core/repos): the person adds a repo by name and folder, or removes one.
// Everything else (tasks, worktrees, merges) is the Tasks routes, which follow each task's own repo.
import path from "node:path";
import { MAX_REPOS, PRIMARY_REPO, readRepos, repoNameProblem, writeRepos } from "../../repos/index";
import { folderIdentity } from "../folderIdentity";
import { protectRepository, type CoreProject } from "../project";
import { repoClaimRefusal, commonDirOf } from "../repoClaim";
import { repoRefusal } from "../protectedRoots";
import { HttpError, type Router } from "../router";
import { isNetworkPath } from "../tokenFile";
import { gitTop, overview, repoState } from "./tasks";

function bodyOf(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** The shared git folder identity of every repo the project already has, to catch one repo added under two names. */
async function knownIdentities(project: CoreProject): Promise<Map<string, string>> {
  const known = new Map<string, string>();
  const names = [PRIMARY_REPO, ...readRepos(project.root).repos.map((repo) => repo.name)];
  for (const name of names) {
    const state = await repoState(project, name);
    const dir = state.root ? await commonDirOf(state.root) : null;
    if (dir) known.set(folderIdentity(dir), name);
  }
  return known;
}

export function registerRepoRoutes(router: Router): void {
  /** GET /repos: every repo of the project with whether it can be used and how many worktrees it holds. */
  router.get("/repos", async ({ project }) => {
    const view = await overview(project);
    return { repos: view.repos, ignored: readRepos(project.root).ignored };
  });

  /** POST /repos { name, root }: the person adds another git folder to this project. */
  router.post("/repos", async ({ project, body }) => {
    const b = bodyOf(body);
    const name = typeof b.name === "string" ? b.name.trim() : "";
    const problem = repoNameProblem(name);
    if (problem) throw new HttpError(400, "INVALID", problem);
    const raw = typeof b.root === "string" ? b.root.trim() : "";
    if (!raw || !path.isAbsolute(raw)) throw new HttpError(400, "INVALID", "Give the full path of the repo's git folder.");
    if (isNetworkPath(raw)) throw new HttpError(400, "INVALID", "A repo on a network share cannot be used. Pick a folder on this computer.");
    const current = readRepos(project.root).repos;
    if (current.some((repo) => repo.name === name)) throw new HttpError(409, "NAME_TAKEN", `This project already has a repo called "${name}".`);
    if (current.length + 1 >= MAX_REPOS) throw new HttpError(409, "TOO_MANY", `A project holds at most ${MAX_REPOS} repos.`);
    const top = await gitTop(raw);
    if (!top) throw new HttpError(400, "NOT_GIT", `${raw} is not a git repository with at least one commit.`);
    const refusal = repoRefusal(top);
    if (refusal) throw new HttpError(400, "NOT_A_PROJECT", refusal);
    // The same repo under another name, or through a link, would give two names one set of branches and ports.
    const dir = await commonDirOf(top);
    const same = dir ? (await knownIdentities(project)).get(folderIdentity(dir)) : undefined;
    if (same) throw new HttpError(409, "SAME_REPO", `That folder is already this project's repo "${same}".`);
    const refused = await repoClaimRefusal(project, top, { write: false });
    if (refused) throw new HttpError(409, "REPO_IN_USE", refused);
    // Recorded before the claim is taken (another project tells whether this one still uses a folder by that file).
    const before = current;
    writeRepos(project.root, [...current, { name, root: top, addedAt: new Date().toISOString() }]);
    const lost = await repoClaimRefusal(project, top, { write: true });
    if (lost) {
      writeRepos(project.root, before);
      throw new HttpError(409, "REPO_IN_USE", lost);
    }
    project.protectRoots([top]);
    // Shipping safety follows the folder: the pre-push secret scan is installed there too.
    const protection = await protectRepository(project.ledger, top);
    return { protection, ...(await overview(project)) };
  });

  /** POST /repos/remove { name }: the person stops using a repo. Refused while it holds worktrees or unfinished tasks. */
  router.post("/repos/remove", async ({ project, body }) => {
    const name = typeof bodyOf(body).name === "string" ? (bodyOf(body).name as string).trim() : "";
    if (name === PRIMARY_REPO) throw new HttpError(400, "INVALID", `"${PRIMARY_REPO}" is the project's first repo and cannot be removed. Choose another git folder for it instead.`);
    const current = readRepos(project.root).repos;
    if (!current.some((repo) => repo.name === name)) throw new HttpError(404, "NOT_FOUND", `This project has no repo called "${name.slice(0, 40)}".`);
    const view = await overview(project);
    const open = view.tasks.filter((task) => task.repo === name && task.status !== "done").map((task) => task.id);
    const trees = view.repos.find((repo) => repo.name === name)?.worktrees ?? 0;
    if (open.length || trees) {
      throw new HttpError(409, "REPO_BUSY", `Repo "${name}" still has ${open.length ? `unfinished tasks (${open.slice(0, 5).join(", ")}${open.length > 5 ? ", ..." : ""})` : ""}${open.length && trees ? " and " : ""}${trees ? `${trees} worktree${trees === 1 ? "" : "s"}` : ""}. Merge them or send them back first.`);
    }
    writeRepos(project.root, current.filter((repo) => repo.name !== name));
    return overview(project);
  });
}
