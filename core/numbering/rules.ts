import type { Actor, EntryDraft, Ledger, LedgerEntry } from "../ledger/index";
import { baseNumber, currentAttempt, nextNumber, parseNumber, seriesAllocatedBy } from "./series";
import { findRelease, parseVersion, releases } from "./release";

/**
 * Ledger rules for spec §3.1: numbers only go up and are never reused,
 * skipped or renumbered. Returns a function that removes the rules.
 */
export function installNumberingRules(ledger: Ledger): () => void {
  return ledger.addRule((draft, current) => numberingRefusal(draft, current.entries()));
}

export function numberingRefusal(draft: EntryDraft, entries: readonly LedgerEntry[]): string | null {
  const series = seriesAllocatedBy(draft.type);
  if (series) {
    const expected = nextNumber(entries, series);
    if (draft.subject.trim() !== expected) {
      return `${draft.type} must take the next ${series} number, ${expected}, not "${draft.subject}"`;
    }
  }
  if (draft.type === "release.cut" || draft.type === "release.rollback") {
    const refusal = releaseRefusal(draft, entries);
    if (refusal) return refusal;
  }
  if (draft.type === "decision.made") {
    const question = draft.data?.question;
    if (question !== undefined && !entries.some((e) => e.type === "question.asked" && e.subject === question)) {
      return `decision.made answers ${String(question)}, which was never asked`;
    }
  }
  if (draft.type.startsWith("task.") && draft.type !== "task.created") {
    const parsed = parseNumber(draft.subject);
    if (!parsed || parsed.series !== "T") return `${draft.type} needs a task number as its subject`;
    const base = baseNumber(draft.subject);
    if (!entries.some((e) => e.type === "task.created" && e.subject === base)) return `${base} was never created`;
    const attempt = currentAttempt(entries, base);
    if (draft.subject.trim() !== base && parsed.attempt !== attempt) {
      return `${base} is on attempt ${attempt}, not ${parsed.attempt}`;
    }
  }
  return null;
}

function releaseRefusal(draft: EntryDraft, entries: readonly LedgerEntry[]): string | null {
  const data = draft.data ?? {};
  const version = String(data.version ?? "");
  const parsed = parseVersion(version);
  if (!parsed) return `a release needs a version like v1.0.0, not "${version}"`;
  if (typeof data.commit !== "string" || data.commit.trim() === "") return "a release needs the commit it shipped";
  const previous = releases(entries).at(-1);
  const before = previous ? parseVersion(previous.version) : undefined;
  if (before && compare(parsed, before) <= 0) return `version ${version} must be above ${previous!.version}`;
  if (draft.type === "release.rollback") {
    const restores = data.restores;
    if (typeof restores !== "string" || !findRelease(entries, restores)) return "a rollback must name the release it restores";
  }
  return null;
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Appends an entry that hands out the next number in its series and returns
 * it; the subject is filled in from the ledger.
 */
export function appendNumbered(ledger: Ledger, draft: Omit<EntryDraft, "subject"> & { actor: Actor }): LedgerEntry {
  const series = seriesAllocatedBy(draft.type);
  if (!series) throw new RangeError(`${draft.type} does not hand out a number`);
  return ledger.append({ ...draft, subject: nextNumber(ledger.entries(), series) });
}
