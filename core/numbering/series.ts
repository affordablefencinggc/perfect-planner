import type { EntryType, LedgerEntry } from "../ledger/index";

/** Number series in the core loop (spec §3.1). */
export type Series = "L" | "P" | "T" | "Q" | "D" | "R";

export interface ParsedNumber {
  series: Series;
  n: number;
  /** Task attempts only: 1 for "T-14", 2 for "T-14.a2". */
  attempt?: number;
}

const PATTERN = /^(L|P|T|Q|D|R)-(\d+)(?:\.a(\d+))?$/;

export function parseNumber(text: string): ParsedNumber | undefined {
  const match = PATTERN.exec(String(text).trim());
  if (!match) return undefined;
  const series = match[1] as Series;
  if (series === "L" && match[2].length < 6) return undefined;
  if (match[3] !== undefined && series !== "T") return undefined;
  const n = Number(match[2]);
  if (!Number.isSafeInteger(n) || n < 1) return undefined;
  if (series === "T") {
    const attempt = match[3] === undefined ? 1 : Number(match[3]);
    if (attempt < 1) return undefined;
    return { series, n, attempt };
  }
  return { series, n };
}

export function formatNumber(series: Series, n: number, attempt?: number): string {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`not a valid number: ${n}`);
  if (series === "L") return `L-${String(n).padStart(6, "0")}`;
  if (series === "T" && attempt !== undefined && attempt > 1) return `T-${n}.a${attempt}`;
  return `${series}-${n}`;
}

/** "T-14.a2" → "T-14"; other numbers unchanged. */
export function baseNumber(text: string): string {
  return String(text).trim().replace(/\.a\d+$/, "");
}

/** Which entry type hands out a number in each series; its subject is that number. */
export const ALLOCATING_TYPES: Readonly<Record<Exclude<Series, "L">, readonly EntryType[]>> = {
  P: ["plan.approved"],
  T: ["task.created"],
  Q: ["question.asked"],
  D: ["decision.made"],
  R: ["release.cut", "release.rollback"],
};

const TYPE_TO_SERIES = new Map<EntryType, Exclude<Series, "L">>();
for (const [series, types] of Object.entries(ALLOCATING_TYPES) as [Exclude<Series, "L">, readonly EntryType[]][]) {
  for (const type of types) TYPE_TO_SERIES.set(type, series);
}

export function seriesAllocatedBy(type: EntryType): Exclude<Series, "L"> | undefined {
  return TYPE_TO_SERIES.get(type);
}

/**
 * Highest number ever handed out in a series. Corrected or withdrawn numbers
 * still count, so a number is never reused.
 */
export function highestNumber(entries: readonly LedgerEntry[], series: Series): number {
  if (series === "L") return entries.length;
  let highest = 0;
  for (const entry of entries) {
    if (TYPE_TO_SERIES.get(entry.type) !== series) continue;
    const parsed = parseNumber(entry.subject);
    if (parsed && parsed.series === series && parsed.n > highest) highest = parsed.n;
  }
  return highest;
}

export function nextNumber(entries: readonly LedgerEntry[], series: Series): string {
  return formatNumber(series, highestNumber(entries, series) + 1);
}

/** Attempt 1 plus one per task.reopened (spec §3.1: ".a2 on retries"). */
export function currentAttempt(entries: readonly LedgerEntry[], task: string): number {
  const base = baseNumber(task);
  return 1 + entries.filter((entry) => entry.type === "task.reopened" && baseNumber(entry.subject) === base).length;
}

/** The task's current label, "T-14" or "T-14.a2". */
export function taskLabel(entries: readonly LedgerEntry[], task: string): string {
  const parsed = parseNumber(baseNumber(task));
  if (!parsed || parsed.series !== "T") throw new RangeError(`not a task number: ${task}`);
  return formatNumber("T", parsed.n, currentAttempt(entries, task));
}
