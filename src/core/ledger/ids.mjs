// Number series (Core Spec §3): L-000001 entries, P-1 plans, T-1 tasks (attempt
// suffix .a2 after a reopen), Q-1 questions, D-1 decisions, R-1 releases.
// Numbers are never reused, skipped or renumbered; the next id is derived from replay.

export const SERIES = Object.freeze(["P", "T", "Q", "D", "R"]);

const ENTRY_RE = /^L-(\d{6,})$/;
const SERIES_RE = /^([PTQDR])-([1-9]\d*)$/;
const TASK_RE = /^T-([1-9]\d*)(?:\.a([2-9]|[1-9]\d+))?$/;
const CLAUSE_SUBJECT_RE = /^(P-[1-9]\d*) (§\d+(?:\.\d+)*)$/;

export function formatEntryNumber(number) {
  if (!Number.isSafeInteger(number) || number < 1) throw new RangeError(`invalid ledger number ${number}`);
  return `L-${String(number).padStart(6, "0")}`;
}

export function parseEntryNumber(value) {
  const match = typeof value === "string" ? ENTRY_RE.exec(value) : null;
  return match ? Number(match[1]) : null;
}

export function parseSeriesId(value) {
  const match = typeof value === "string" ? SERIES_RE.exec(value) : null;
  return match ? { series: match[1], number: Number(match[2]), id: value } : null;
}

/** Parses "T-14" or "T-14.a2" → { id: "T-14", number: 14, attempt: 1|2.. } */
export function parseTaskId(value) {
  const match = typeof value === "string" ? TASK_RE.exec(value) : null;
  if (!match) return null;
  return { id: `T-${match[1]}`, number: Number(match[1]), attempt: match[2] ? Number(match[2]) : null };
}

export function taskAttemptId(id, attempt) {
  return attempt > 1 ? `${id}.a${attempt}` : id;
}

/** Parses a clause subject such as "P-2 §3.1" → { plan: "P-2", clause: "§3.1" } */
export function parseClauseSubject(value) {
  const match = typeof value === "string" ? CLAUSE_SUBJECT_RE.exec(value) : null;
  return match ? { plan: match[1], clause: match[2] } : null;
}

/**
 * Full stamp, e.g. "R-1 · v1.0.0 · P-1 · L-000231 · 9f3c2e1". Missing parts are omitted;
 * the version gains a leading "v" and the commit is shortened to 7 characters.
 */
export function formatStamp({ release, version, plan, entry, commit } = {}) {
  const parts = [];
  if (release) parts.push(String(release));
  if (version) parts.push(/^v/i.test(String(version)) ? String(version) : `v${version}`);
  if (plan) parts.push(String(plan));
  if (entry !== undefined && entry !== null && entry !== "") parts.push(typeof entry === "number" ? formatEntryNumber(entry) : String(entry));
  if (commit) parts.push(String(commit).slice(0, 7));
  if (parts.length === 0) throw new TypeError("formatStamp: at least one part is required");
  return parts.join(" · ");
}
