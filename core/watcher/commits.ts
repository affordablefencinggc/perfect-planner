import { git } from "../worktrees/git";
import { normalizeFileList } from "./changes";

export interface ObservedCommit {
  sha: string;
  /** "Name <email>" */
  author: string;
  /** Author date, strict ISO 8601. */
  at: string;
  subject: string;
  /** Clause refs from `Implements:` trailers, e.g. "P-2 §3.1". In order, de-duplicated. */
  refs: string[];
  /** Task ids named in the trailers' parentheses, e.g. "T-14". */
  taskIds: string[];
}

const TRAILER = /^\s*implements\s*:\s*(.*?)\s*$/i;
const TASK_IN_PARENS = /\(\s*(T-[0-9][0-9A-Za-z.\-]*(?:\s*,\s*T-[0-9][0-9A-Za-z.\-]*)*)\s*\)/g;

/**
 * Read `Implements:` trailers from a commit body. Accepts LF or CRLF, several
 * trailer lines, several comma/semicolon separated clauses per line, a task id
 * in parentheses after any clause, and "P-2 §3.1, §3.2" shorthand (the second
 * clause inherits "P-2").
 */
export function parseImplements(body: string): { refs: string[]; taskIds: string[] } {
  const refs: string[] = [];
  const taskIds: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = TRAILER.exec(line);
    if (!match) continue;
    let value = match[1];
    value = value.replace(TASK_IN_PARENS, (_whole, ids: string) => {
      for (const id of ids.split(",")) {
        const trimmed = id.trim();
        if (trimmed && !taskIds.includes(trimmed)) taskIds.push(trimmed);
      }
      return ",";
    });
    let doc: string | undefined;
    for (const piece of value.split(/[,;]/)) {
      let ref = piece.trim().replace(/\s+/g, " ");
      if (!ref) continue;
      const own = /^(.+?)\s*§/.exec(ref);
      if (own) doc = own[1].trim();
      else if (ref.startsWith("§") && doc) ref = `${doc} ${ref}`;
      if (!refs.includes(ref)) refs.push(ref);
    }
  }
  return { refs, taskIds };
}

const FIELD = "\x1f";
const RECORD = "\x1e";

/**
 * Commits on the task branch since `baseSha`, oldest first. Follows the first
 * parent only, so a merge of the base branch into the task does not report the
 * base branch's own commits as task work.
 */
export async function commitsSince(worktreePath: string, baseSha: string): Promise<ObservedCommit[]> {
  const format = ["%H", "%an <%ae>", "%aI", "%s", "%B"].join("%x1f") + "%x1e";
  const out = await git(worktreePath, ["log", "--first-parent", "--reverse", "--no-color", `--format=${format}`, `${baseSha}..HEAD`, "--"]);
  const commits: ObservedCommit[] = [];
  for (const record of out.split(RECORD)) {
    const trimmed = record.replace(/^[\r\n]+/, "");
    if (!trimmed) continue;
    const [sha, author, at, subject, ...rest] = trimmed.split(FIELD);
    if (!sha || !/^[0-9a-f]{40,64}$/.test(sha.trim())) continue;
    const { refs, taskIds } = parseImplements(rest.join(FIELD));
    commits.push({ sha: sha.trim(), author: author ?? "", at: at ?? "", subject: (subject ?? "").trim(), refs, taskIds });
  }
  return commits;
}

/** Files one commit changed against its first parent (root commits: against the empty tree). */
export async function commitFiles(worktreePath: string, sha: string): Promise<string[]> {
  const out = await git(worktreePath, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", "--no-renames", "-m", "--first-parent", sha]);
  return normalizeFileList(out.split("\0"));
}
