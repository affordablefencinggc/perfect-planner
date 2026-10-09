// Reference parsing for ledger ids, clause ids and commit trailers.
// Pure functions only.

import { CLAUSE_ID_PATTERN } from "./numbering.mjs";

const PLAN_CLAUSE = /^(P-[1-9]\d*)\s+(§(?:0(?:\.[1-9]\d*)+|[1-9]\d*(?:\.[1-9]\d*)*))$/;
const TASK = /^T-([1-9]\d*)(?:\.a([2-9]|[1-9]\d+))?$/;
const SERIES = { P: "plan", Q: "question", D: "decision", R: "release" };
const SERIES_ID = /^([PQDR])-([1-9]\d*)$/;
const ENTRY = /^L-(\d{6})$/;

// parseRef(str) -> { kind, plan?, clause?, id, attempt? } or null.
//   "§3.1"        -> { kind: "clause", clause: "§3.1", id: "§3.1" }
//   "P-2 §3.1"    -> { kind: "plan-clause", plan: "P-2", clause: "§3.1", id: "P-2 §3.1" }
//   "T-14"        -> { kind: "task", id: "T-14" }
//   "T-14.a2"     -> { kind: "task", id: "T-14", attempt: 2 }
//   "Q-2" / "D-3" / "R-1" / "P-2" -> question / decision / release / plan
//   "L-000231"    -> { kind: "entry", id: "L-000231" }
// Attempt suffixes start at .a2 (the first attempt has no suffix).
export function parseRef(input) {
  if (typeof input !== "string") return null;
  const text = input.trim();
  if (!text) return null;

  const planClause = PLAN_CLAUSE.exec(text);
  if (planClause) {
    return { kind: "plan-clause", plan: planClause[1], clause: planClause[2], id: `${planClause[1]} ${planClause[2]}` };
  }
  if (CLAUSE_ID_PATTERN.test(text)) return { kind: "clause", clause: text, id: text };

  const task = TASK.exec(text);
  if (task) {
    const id = `T-${task[1]}`;
    return task[2] === undefined ? { kind: "task", id } : { kind: "task", id, attempt: Number(task[2]) };
  }

  const series = SERIES_ID.exec(text);
  if (series) return { kind: SERIES[series[1]], id: `${series[1]}-${series[2]}` };

  const entry = ENTRY.exec(text);
  if (entry && Number(entry[1]) >= 1) return { kind: "entry", id: `L-${entry[1]}` };

  return null;
}

// Canonical text for a parsed ref, including the attempt suffix when present.
export function canonicalRef(parsed) {
  if (!parsed) return null;
  if (parsed.kind === "task" && parsed.attempt !== undefined) return `${parsed.id}.a${parsed.attempt}`;
  return parsed.id;
}

// parseImplements(commitMessage) -> [{ ref: "P-2 §3.1", task: "T-14" | null }]
// Reads lines of the form "Implements: P-2 §3.1 (T-14)". Several refs may be
// comma-separated. Items that are not clause refs, or whose task is invalid, are skipped.
export function parseImplements(commitMessage) {
  if (typeof commitMessage !== "string") return [];
  const results = [];
  for (const rawLine of commitMessage.split(/\r?\n/)) {
    const line = /^\s*implements:\s*(.*?)\s*$/i.exec(rawLine);
    if (!line) continue;
    for (const part of line[1].split(",")) {
      const item = part.trim();
      if (!item) continue;
      const withTask = /^(.*?)\s*\(([^()]*)\)$/.exec(item);
      const refText = withTask ? withTask[1] : item;
      const parsed = parseRef(refText);
      if (!parsed || (parsed.kind !== "clause" && parsed.kind !== "plan-clause")) continue;
      let task = null;
      if (withTask) {
        const taskRef = parseRef(withTask[2]);
        if (!taskRef || taskRef.kind !== "task") continue;
        task = taskRef.id;
      }
      results.push({ ref: parsed.id, task });
    }
  }
  return results;
}
