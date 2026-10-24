import { createHash } from "node:crypto";

// A task that touches several repos is written as one ordinary task per repo, so each runs its own test,
// diff approval and merge. The tasks of one split share a group key.

/**
 * The parts a roadmap task becomes. No repos, or one, is the task unchanged (the repo is recorded only when
 * it is named). Repeats are dropped. Titles of a split task say which repo each part is for.
 */
export function splitByRepo(key: string, title: string, repos: readonly string[] | undefined): { repo?: string; title: string; group?: string }[] {
  const unique = [...new Set((repos ?? []).filter((name) => typeof name === "string" && name))];
  if (unique.length === 0) return [{ title }];
  if (unique.length === 1) return [{ repo: unique[0]!, title }];
  return unique.map((repo) => ({ repo, title: `${title} (${repo})`, group: key }));
}

/** A group key the board accepts: plain characters, at most 40, still unique per source key. */
export function groupKey(key: string): string {
  const plain = key.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "g").slice(0, 30);
  return `${plain}-${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
}
