// One git folder, one project. Worktrees, the pp/* branches, the dev-server ports and the registry of task
// folders belong to the git folder, not to a project. Two projects that handed workers the same git folder
// would share their T-1: the second dispatch would find the first project's worktree and hand its worker
// that checkout, and checks and approvals would be made against the other project's commits.
//
// The first project to use a git folder writes a small record into the repo's own git folder
// (<git common dir>/perfect-planner/project.json, never committed). Another project is refused while the
// first still uses the folder. When the first project stopped using it (its folder is gone, or it points
// at another git folder) the record is stale and can be taken over, but only if no worktree registered in
// the repo came from somewhere else: work started by another project is preserved and named, never
// adopted, moved or removed.
import fs from "node:fs";
import path from "node:path";
import { runGit } from "../worktrees/index";
import { folderIdentity } from "./folderIdentity";
import type { CoreProject } from "./project";
import { chosenRepoRoot } from "./protectedRoots";
import { extraRepoRoots } from "../repos/index";

const CLAIM_FILE = "project.json";
const REGISTRY_FILE = "worktrees.json";

interface Claim {
  /** The folder that holds the project's .perfect-planner/ledger. */
  folder: string;
  key: string;
  at: string;
}

type Read = { state: "absent" } | { state: "unreadable" } | { state: "ok"; claim: Claim };

/** git is asked once in a while, not on every poll of the Tasks screen. */
const COMMON_DIR_TTL_MS = 10_000;
const commonDirs = new Map<string, { dir: string; at: number }>();

/** The git folder shared by every checkout of the repo that contains `from` (the main one and each worktree). */
export async function commonDirOf(from: string): Promise<string | null> {
  const known = commonDirs.get(from);
  if (known && Date.now() - known.at < COMMON_DIR_TTL_MS) return known.dir;
  const result = await runGit(from, ["rev-parse", "--git-common-dir"]).catch(() => null);
  if (!result || result.code !== 0 || !result.stdout.trim()) return null;
  const dir = path.resolve(from, result.stdout.trim());
  commonDirs.set(from, { dir, at: Date.now() });
  return dir;
}

function readClaim(file: string): Read {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { state: "absent" };
  }
  try {
    const parsed = JSON.parse(text) as Partial<Claim>;
    if (typeof parsed.folder === "string" && typeof parsed.key === "string" && path.isAbsolute(parsed.folder)) return { state: "ok", claim: { folder: parsed.folder, key: parsed.key, at: String(parsed.at ?? "") } };
  } catch {
    // falls through
  }
  return { state: "unreadable" };
}

/**
 * Whether the project that holds the record still works in this repo. A project that picked a git folder
 * uses exactly that repo; otherwise git finds the repo around the project's own folder. Compared by the
 * repo's shared git folder, so a worktree, a link or another spelling of the same repo counts as the same.
 */
async function ownerStillUses(ownerFolder: string, dir: string): Promise<boolean> {
  if (!fs.existsSync(ownerFolder)) return false;
  // Every repo the other project works in counts: its first one and the extra ones it registered.
  const probes = [chosenRepoRoot(ownerFolder) ?? ownerFolder, ...extraRepoRoots(ownerFolder)];
  for (const probe of probes) {
    if (!fs.existsSync(probe)) continue;
    const theirs = await commonDirOf(probe);
    if (theirs !== null && folderIdentity(theirs) === folderIdentity(dir)) return true;
  }
  return false;
}

/** Task ids registered in the repo (by whichever project started them). */
function registeredTasks(dir: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "perfect-planner", REGISTRY_FILE), "utf8")) as { worktrees?: { taskId?: unknown }[] };
    return (parsed.worktrees ?? []).map((w) => w.taskId).filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

/**
 * Null when `project` may hand workers the git folder `top`; otherwise the plain-words reason it may not.
 * With `write` the project also records itself as the folder's user (the first dispatch, or the person
 * choosing the folder). Without it nothing is written, so a screen can look at the folder safely.
 */
export async function repoClaimRefusal(project: CoreProject, top: string, { write }: { write: boolean }): Promise<string | null> {
  const dir = await commonDirOf(top);
  // Not a repo git can describe: the callers' own git checks refuse it.
  if (!dir) return null;
  const file = path.join(dir, "perfect-planner", CLAIM_FILE);
  const mine = folderIdentity(project.root);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const found = readClaim(file);
    if (found.state === "ok" && folderIdentity(found.claim.folder) === mine) return null;
    if (found.state === "ok" && (await ownerStillUses(found.claim.folder, dir))) {
      return `Another project on this computer (${found.claim.key}) already uses this git folder, and workers there would share its worktrees and branches. Choose a different git folder for this project, or stop using this one in the other project first. Nothing was changed.`;
    }
    if (found.state === "unreadable") {
      return `This git folder keeps a note of which project uses it (${file}), and that note cannot be read, so it was not handed to this project. If no other project uses this folder, move that one small file aside and try again. Nothing was changed.`;
    }
    // No record, or the project that wrote it moved on: only work this project started may already be here.
    const started = new Set(project.entries().filter((e) => e.type === "worktree.created").map((e) => e.subject));
    const foreign = registeredTasks(dir).filter((id) => !started.has(id));
    if (foreign.length) {
      return `This git folder already holds worktrees that this project did not start (${foreign.join(", ")}). They belong to another project's work, so they were left exactly as they are. Merge or remove them first, or choose another git folder.`;
    }
    if (!write) return null;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // A record of a project that moved on is moved aside, not deleted (one racer wins the rename), and the
      // new record is created exclusively, so two projects choosing the folder at once cannot both get it.
      if (found.state === "ok") {
        try {
          fs.renameSync(file, `${file}.replaced.${Date.now()}.${process.pid}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      const record: Claim = { folder: fs.realpathSync.native(project.root), key: project.key, at: new Date().toISOString() };
      fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return "Another project just took this git folder. Choose a different one.";
}
