// Private sharing (core/share): send work to a teammate as a file and receive theirs, with no server.
// Files live in two fixed folders inside the project (outbox, inbox); no request ever names a path.
import fs from "node:fs";
import path from "node:path";
import { BundleError, checkMerge, exportBundle, importBundle, readBundle } from "../../share/index";
import { runGit } from "../../worktrees/index";
import { HttpError, type Router } from "../router";
import type { CoreProject } from "../project";
import { localPersonId } from "./people";
import { repoState } from "./tasks";

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,76}\.ppb$/;
const PART = /^[A-Za-z0-9._-]{1,64}$/;

function shareDir(project: CoreProject, which: "outbox" | "inbox"): string {
  const dir = path.join(project.root, ".perfect-planner", "share", which);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function bodyOf(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function listFiles(dir: string): { name: string; bytes: number }[] {
  return fs
    .readdirSync(dir)
    .filter((name) => FILE_NAME.test(name))
    .map((name) => ({ name, bytes: fs.statSync(path.join(dir, name)).size }));
}

async function repoRoot(project: CoreProject): Promise<string> {
  const state = await repoState(project);
  if (!state.ok || !state.root) throw new HttpError(409, "NO_REPO", "Sharing needs the project's git folder. Open the Tasks page and choose it first.");
  return state.root;
}

async function wrap<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof BundleError) throw new HttpError(400, "BUNDLE", error.message);
    throw error;
  }
}

export function registerShareRoutes(router: Router): void {
  /** GET /share: the two folders' files, the work received so far, and the branches that can be sent. */
  router.get("/share", async ({ project }) => {
    const root = await repoRoot(project);
    const heads = await runGit(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads/pp/"]);
    const inbox = await runGit(root, ["for-each-ref", "--format=%(refname)", "refs/pp-inbox/"]);
    return {
      outbox: listFiles(shareDir(project, "outbox")),
      inbox: listFiles(shareDir(project, "inbox")),
      branches: heads.stdout.split(/\r?\n/).filter(Boolean),
      received: inbox.stdout.split(/\r?\n/).filter(Boolean).map((ref) => ref.replace(/^refs\/pp-inbox\//, "")),
      signed: false,
    };
  });

  /** POST /share/export { name, branches[] }: writes outbox/<name>.ppb with those branches and the ledger so far. */
  router.post("/share/export", ({ project, body }) =>
    wrap(async () => {
      const b = bodyOf(body);
      const name = typeof b.name === "string" ? b.name.trim() : "";
      if (!FILE_NAME.test(`${name}.ppb`)) throw new HttpError(400, "INVALID", "Name the file with letters, numbers, dots or dashes.");
      const branches = Array.isArray(b.branches) ? b.branches.filter((x): x is string => typeof x === "string") : [];
      if (branches.some((x) => !x.startsWith("pp/") || x.includes(".."))) throw new HttpError(400, "INVALID", "Only task branches (pp/...) can be sent.");
      const outFile = path.join(shareDir(project, "outbox"), `${name}.ppb`);
      const manifest = await exportBundle({ repoRoot: await repoRoot(project), project: path.basename(project.root), sender: localPersonId(project), branches, entries: project.entries(), outFile });
      return { file: `${name}.ppb`, branches: Object.keys(manifest.branches), entries: manifest.entries.length, signed: false };
    }),
  );

  /** POST /share/import { file }: checks inbox/<file> and keeps its branches apart from yours. */
  router.post("/share/import", ({ project, body }) =>
    wrap(async () => {
      const file = typeof bodyOf(body).file === "string" ? (bodyOf(body).file as string) : "";
      if (!FILE_NAME.test(file)) throw new HttpError(400, "INVALID", "Pick a bundle file from the inbox.");
      const full = path.join(shareDir(project, "inbox"), file);
      if (!fs.existsSync(full)) throw new HttpError(404, "NOT_FOUND", `${file} is not in the inbox.`);
      readBundle(full);
      return importBundle(await repoRoot(project), full);
    }),
  );

  /** POST /share/check { sender, branch }: would received work merge cleanly into your main branch, and if not, which files clash. */
  router.post("/share/check", ({ project, body }) =>
    wrap(async () => {
      const b = bodyOf(body);
      const sender = typeof b.sender === "string" ? b.sender : "";
      const branch = typeof b.branch === "string" ? b.branch : "";
      if (!PART.test(sender) || !branch.startsWith("pp/") || branch.includes("..")) throw new HttpError(400, "INVALID", "Pick received work to check.");
      const root = await repoRoot(project);
      const base = (await runGit(root, ["symbolic-ref", "--short", "HEAD"])).stdout.trim() || "HEAD";
      return { base, ...(await checkMerge(root, base, `refs/pp-inbox/${sender}/${branch}`)) };
    }),
  );
}
