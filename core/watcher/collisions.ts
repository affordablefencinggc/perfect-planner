import { normalizeSurface } from "../../src/engine/collisionEngine.js";
import { byCodePoint } from "./changes";
import { toRepoPath } from "../worktrees/platform";

export interface TaskChanges {
  taskId: string;
  files: string[];
}

export interface Collision {
  /** The two task ids, sorted. */
  tasks: [string, string];
  /** Every spelling of the shared files, sorted. Case-only variants both appear. */
  files: string[];
}

/** Collision key for one file. Case-insensitive on every OS: a case-only pair cannot coexist on a Windows or macOS checkout. */
export function fileKey(file: string): string {
  return normalizeSurface("file", toRepoPath(file)) as string;
}

export function compareTaskIds(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true }) || byCodePoint(a, b);
}

export function pairKey(tasks: readonly [string, string] | readonly string[]): string {
  return [...tasks].sort(compareTaskIds).join("+");
}

/** Stable identity of a collision's file set, for dedupe. */
export function fileSetKey(files: readonly string[]): string {
  return [...new Set(files.map(fileKey))].sort(byCodePoint).join("\n");
}

/** Pure: every pair of tasks that changed at least one same file. Deterministic order. */
export function findCollisions(changes: TaskChanges[]): Collision[] {
  const perTask = new Map<string, Map<string, Set<string>>>();
  for (const { taskId, files } of changes) {
    const keys = perTask.get(taskId) ?? new Map<string, Set<string>>();
    for (const raw of files) {
      const file = toRepoPath(raw);
      if (!file) continue;
      const key = fileKey(file);
      const spellings = keys.get(key) ?? new Set<string>();
      spellings.add(file);
      keys.set(key, spellings);
    }
    perTask.set(taskId, keys);
  }
  const tasks = [...perTask.keys()].sort(compareTaskIds);
  const collisions: Collision[] = [];
  for (let i = 0; i < tasks.length; i += 1) {
    for (let j = i + 1; j < tasks.length; j += 1) {
      const left = perTask.get(tasks[i])!;
      const right = perTask.get(tasks[j])!;
      const [small, large] = left.size <= right.size ? [left, right] : [right, left];
      const files = new Set<string>();
      for (const [key, spellings] of small) {
        const other = large.get(key);
        if (!other) continue;
        for (const name of spellings) files.add(name);
        for (const name of other) files.add(name);
      }
      if (files.size) collisions.push({ tasks: [tasks[i], tasks[j]], files: [...files].sort(byCodePoint) });
    }
  }
  return collisions;
}
