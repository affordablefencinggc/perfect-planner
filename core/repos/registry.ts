// The git folders of one project. The project's first repo is the one it always had (repo.json, else the
// project folder) and is named "main"; further repos the person adds are kept in repos.json beside it.
// Reading never trusts the file: a hand-edited name or folder that would not be accepted by add is left out
// and reported with the reason, never used.
import fs from "node:fs";
import path from "node:path";
import { isLocalWindowsPath } from "../exec/index";

export const PRIMARY_REPO = "main";
export const MAX_REPOS = 12;
const REPOS_FILE = "repos.json";
const NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;
/** Names Windows treats as devices (with or without an extension). */
const DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;

export interface RepoEntry {
  name: string;
  root: string;
  addedAt: string;
}

export interface RepoFile {
  repos: RepoEntry[];
  /** Entries in the file that were left out, and why. */
  ignored: { name: string; reason: string }[];
}

export function repoNameProblem(name: unknown): string | undefined {
  if (typeof name !== "string" || !NAME.test(name) || name.endsWith(".") || DEVICE.test(name)) {
    return "A repo name is 1 to 32 letters, digits, dots, dashes or underscores, starts with a letter or digit, and is not a name Windows reserves (con, nul, aux, prn, com1, lpt1).";
  }
  if (name === PRIMARY_REPO) return `"${PRIMARY_REPO}" is the project's first repo. Pick another name.`;
  return undefined;
}

function networkPath(value: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? !isLocalWindowsPath(value) : value.startsWith("//");
}

export function repoFilePath(projectRoot: string): string {
  return path.join(projectRoot, ".perfect-planner", REPOS_FILE);
}

/** The extra repos of a project. A missing file is no extra repos; an unreadable one is none, said in `ignored`. */
export function readRepos(projectRoot: string, platform: NodeJS.Platform = process.platform): RepoFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(repoFilePath(projectRoot), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { repos: [], ignored: [] };
    return { repos: [], ignored: [{ name: REPOS_FILE, reason: "repos.json cannot be read, so no extra repos are used. Remove and add them again." }] };
  }
  const list = (parsed as { repos?: unknown } | null)?.repos;
  const out: RepoFile = { repos: [], ignored: [] };
  if (!Array.isArray(list)) return out;
  const names = new Set<string>();
  for (const item of list.slice(0, 200)) {
    const raw = item as { name?: unknown; root?: unknown; addedAt?: unknown } | null;
    const label = typeof raw?.name === "string" ? raw.name.slice(0, 40) : "(no name)";
    const problem = repoNameProblem(raw?.name);
    if (problem) {
      out.ignored.push({ name: label, reason: problem });
    } else if (names.has(raw!.name as string)) {
      out.ignored.push({ name: label, reason: "Listed twice; the first one is used." });
    } else if (typeof raw?.root !== "string" || !path.isAbsolute(raw.root) || networkPath(raw.root, platform)) {
      out.ignored.push({ name: label, reason: "Its folder is not a full path on this computer." });
    } else if (out.repos.length >= MAX_REPOS - 1) {
      out.ignored.push({ name: label, reason: `A project holds at most ${MAX_REPOS} repos.` });
    } else {
      names.add(raw.name as string);
      out.repos.push({ name: raw.name as string, root: raw.root, addedAt: typeof raw.addedAt === "string" ? raw.addedAt : "" });
    }
  }
  return out;
}

export function writeRepos(projectRoot: string, repos: readonly RepoEntry[]): void {
  const file = repoFilePath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ repos }, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Every registered extra repo folder, for the callers that only protect or compare folders. */
export function extraRepoRoots(projectRoot: string): string[] {
  return readRepos(projectRoot).repos.map((repo) => repo.root);
}
