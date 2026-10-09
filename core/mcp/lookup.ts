// lookup(ref): resolve any reference to its text, history and everything that
// cites it (spec §3.6). Pure over ledger entries.
import type { LedgerEntry } from "../ledger/index";

export type RefKind = "ledger" | "plan" | "clause" | "task" | "question" | "decision" | "release";

export interface ParsedRef {
  kind: RefKind;
  /** Canonical form: "L-000231", "P-2", "P-2 §3.1", "§3.1", "T-14", "Q-3"… */
  ref: string;
  /** For clauses: the plan version, when given. */
  plan?: string;
  /** For clauses: "§3.1". */
  clause?: string;
  /** For tasks written as T-14.a2. */
  attempt?: number;
}

const PATTERNS: [RegExp, (m: RegExpMatchArray) => ParsedRef][] = [
  [/^L-(\d{1,9})$/, (m) => ({ kind: "ledger", ref: `L-${m[1]!.padStart(6, "0")}` })],
  [/^(P-\d+)\s*§\s*(\d+(?:\.\d+)*)$/, (m) => ({ kind: "clause", ref: `${m[1]} §${m[2]}`, plan: m[1]!, clause: `§${m[2]}` })],
  [/^§\s*(\d+(?:\.\d+)*)$/, (m) => ({ kind: "clause", ref: `§${m[1]}`, clause: `§${m[1]}` })],
  [/^P-\d+$/, (m) => ({ kind: "plan", ref: m[0] })],
  [/^(T-\d+)(?:\.a(\d+))?$/, (m) => ({ kind: "task", ref: m[1]!, ...(m[2] ? { attempt: Number(m[2]) } : {}) })],
  [/^Q-\d+$/, (m) => ({ kind: "question", ref: m[0] })],
  [/^D-\d+$/, (m) => ({ kind: "decision", ref: m[0] })],
  [/^R-\d+$/, (m) => ({ kind: "release", ref: m[0] })],
];

export function parseRef(raw: string): ParsedRef | null {
  const text = raw.trim().replace(/\s+/g, " ");
  for (const [pattern, build] of PATTERNS) {
    const match = text.match(pattern);
    if (match) return build(match);
  }
  return null;
}

export interface LookupResult {
  ref: ParsedRef;
  found: boolean;
  /** The text of the thing: a clause's current wording, a task's title, a question… */
  text: string | null;
  /** Entries about this reference, oldest first. */
  history: LedgerEntry[];
  /** Entries that cite it in `refs`, plus the commits of the tasks that cite it. */
  citedBy: LedgerEntry[];
}

function citesClause(entry: LedgerEntry, ref: ParsedRef): boolean {
  return (entry.refs).some((r) => {
    if (ref.plan) return r === ref.ref;
    return r === ref.clause || r.endsWith(` ${ref.clause}`);
  });
}

function clauseAbout(entry: LedgerEntry, ref: ParsedRef): boolean {
  if (!entry.type.startsWith("clause.")) return false;
  return entry.subject === ref.ref || (!ref.plan && entry.subject.endsWith(` ${ref.clause}`)) || entry.subject === ref.clause;
}

function textOf(history: LedgerEntry[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!;
    if (entry.type === "clause.withdrawn") return null;
    const text = entry.data?.text ?? entry.data?.title ?? entry.data?.question;
    if (typeof text === "string") return text;
  }
  return history[0]?.summary ?? null;
}

export function lookup(entries: readonly LedgerEntry[], raw: string): LookupResult | { error: string } {
  const ref = parseRef(raw);
  if (!ref) return { error: `"${raw}" is not a reference. Try §3.1, P-2 §3.1, T-14, Q-3, D-3, R-1 or L-000231.` };

  let history: LedgerEntry[];
  let citedBy: LedgerEntry[];
  if (ref.kind === "ledger") {
    history = entries.filter((e) => e.n === ref.ref);
    citedBy = entries.filter((e) => e.corrects === ref.ref || e.evidence.includes(ref.ref) || e.refs.includes(ref.ref));
  } else if (ref.kind === "clause") {
    history = entries.filter((e) => clauseAbout(e, ref));
    const direct = entries.filter((e) => !clauseAbout(e, ref) && citesClause(e, ref));
    const tasks = new Set(direct.filter((e) => e.type === "task.created").map((e) => e.subject));
    const work = entries.filter((e) => !direct.includes(e) && (tasks.has(e.subject) || (e.type === "commit.observed" && e.refs.some((r) => tasks.has(r)))));
    citedBy = [...new Set([...direct, ...work])].sort((a, b) => a.n.localeCompare(b.n));
  } else {
    history = entries.filter((e) => e.subject === ref.ref);
    citedBy = entries.filter((e) => e.subject !== ref.ref && e.refs.includes(ref.ref));
  }
  return { ref, found: history.length > 0 || citedBy.length > 0, text: textOf(history), history, citedBy };
}
