import type { LedgerEntry } from "../ledger/index";
import { baseNumber, currentAttempt, findRelease, releaseRange, releaseStamp, taskLabel } from "../numbering/index";
import { clausesAt, oneLine, planClauses, planIndex, sortedClauses, clauseNumber } from "./clauses";
import { parseRef, refMatchesClause } from "./refs";

export type LookupKind = "clause" | "plan" | "task" | "question" | "decision" | "release" | "entry";

export interface LookupResult {
  ref: string;
  kind?: LookupKind;
  found: boolean;
  /** Why nothing was found, in plain words. */
  problem?: string;
  /** The reference's current text: clause text, task summary, release stamp… */
  text?: string;
  status?: string;
  /** Entries about this reference itself, oldest first. */
  history: LedgerEntry[];
  /** Entries elsewhere that cite it in refs, corrects or answers. */
  citedBy: LedgerEntry[];
  /** Tasks that implement it (clauses, plans) or the task itself. */
  tasks: string[];
  /** Commit shas observed for those tasks or citing it. */
  commits: string[];
  /** Releases only: the ledger entries the release covers. */
  range?: LedgerEntry[];
}

function empty(ref: string, problem: string, kind?: LookupKind): LookupResult {
  return { ref, kind, found: false, problem, history: [], citedBy: [], tasks: [], commits: [] };
}

/**
 * Resolves any reference (spec §3.6) to its text, its history and everything
 * that cites it. Pure: pass ledger.entries().
 */
export function lookup(entries: readonly LedgerEntry[], input: string): LookupResult {
  const ref = parseRef(input);
  if (!ref) return empty(String(input), `"${input}" is not a reference (try §3.1, P-2 §3.1, T-14, D-3, R-1 or L-000231)`);
  if (ref.kind === "clause") return lookupClause(entries, ref.text, ref.clause, ref.plan);
  switch (ref.series) {
    case "P":
      return lookupPlan(entries, ref.id);
    case "T":
      return lookupTask(entries, ref.id, ref.text);
    case "Q":
      return lookupQuestion(entries, ref.id);
    case "D":
      return lookupDecision(entries, ref.id);
    case "R":
      return lookupRelease(entries, ref.id);
    case "L":
      return lookupEntry(entries, ref.id);
  }
}

function lookupClause(entries: readonly LedgerEntry[], text: string, clause: string, plan?: string): LookupResult {
  const map = planClauses(entries, plan);
  if (!map) return empty(text, `${plan} has not been approved`, "clause");
  const found = map.get(clause);
  if (!found) {
    const later = clausesAt(entries).get(clause);
    return empty(text, later ? `§${clause} was added after ${plan}` : `§${clause} does not exist`, "clause");
  }
  const history = entries.filter((e) => e.type.startsWith("clause.") && clauseOfEntry(e) === clause);
  const citedBy = entries.filter((e) => !e.type.startsWith("clause.") && e.refs.some((r) => refMatchesClause(r, clause, plan)));
  const tasks = unique(citedBy.filter((e) => e.subject.startsWith("T-")).map((e) => baseNumber(e.subject)));
  const commits = commitsFor(entries, tasks, (e) => e.refs.some((r) => refMatchesClause(r, clause, plan)));
  return {
    ref: text,
    kind: "clause",
    found: true,
    text: found.text,
    status: found.status,
    history,
    citedBy,
    tasks,
    commits,
  };
}

function lookupPlan(entries: readonly LedgerEntry[], plan: string): LookupResult {
  const index = planIndex(entries, plan);
  if (index < 0) return empty(plan, `${plan} has not been approved`, "plan");
  const clauses = sortedClauses(clausesAt(entries, index + 1)).filter((c) => c.status === "active");
  const citedBy = entries.filter((e) => e.refs.some((r) => r === plan || r.startsWith(`${plan} `)));
  const tasks = unique(citedBy.filter((e) => e.subject.startsWith("T-")).map((e) => baseNumber(e.subject)));
  return {
    ref: plan,
    kind: "plan",
    found: true,
    text: clauses.map((c) => `§${c.clause} ${c.text}`).join("\n"),
    status: entries.some((e, i) => i > index && e.type === "plan.approved") ? "superseded" : "current",
    history: [entries[index]],
    citedBy,
    tasks,
    commits: commitsFor(entries, tasks),
  };
}

function lookupTask(entries: readonly LedgerEntry[], task: string, written: string): LookupResult {
  const created = entries.find((e) => e.type === "task.created" && e.subject === task);
  if (!created) return empty(written, `${task} was never created`, "task");
  const history = entries.filter((e) => baseNumber(e.subject) === task);
  const lastTask = [...history].reverse().find((e) => e.type.startsWith("task."));
  const citedBy = entries.filter((e) => baseNumber(e.subject) !== task && (e.refs.some((r) => baseNumber(r) === task) || e.data?.task === task));
  return {
    ref: taskLabel(entries, task),
    kind: "task",
    found: true,
    text: created.summary,
    status: `${lastTask?.type.slice("task.".length) ?? "created"}, attempt ${currentAttempt(entries, task)}`,
    history,
    citedBy,
    tasks: [task],
    commits: commitsFor(entries, [task]),
  };
}

function lookupQuestion(entries: readonly LedgerEntry[], question: string): LookupResult {
  const asked = entries.find((e) => e.type === "question.asked" && e.subject === question);
  if (!asked) return empty(question, `${question} was never asked`, "question");
  const history = entries.filter((e) => e.subject === question || (e.type === "decision.made" && e.data?.question === question));
  const answered = history.some((e) => e.type === "question.answered" || e.type === "decision.made");
  const task = typeof asked.data?.task === "string" ? baseNumber(asked.data.task) : undefined;
  return {
    ref: question,
    kind: "question",
    found: true,
    text: typeof asked.data?.question === "string" ? asked.data.question : asked.summary,
    status: answered ? "answered" : "open",
    history,
    citedBy: entries.filter((e) => !history.includes(e) && e.refs.includes(question)),
    tasks: task ? [task] : [],
    commits: [],
  };
}

function lookupDecision(entries: readonly LedgerEntry[], decision: string): LookupResult {
  const made = entries.find((e) => e.type === "decision.made" && e.subject === decision);
  if (!made) return empty(decision, `${decision} was never made`, "decision");
  const corrections = entries.filter((e) => e.corrects === made.n);
  return {
    ref: decision,
    kind: "decision",
    found: true,
    text: typeof made.data?.text === "string" ? made.data.text : made.summary,
    status: corrections.length ? "corrected" : "standing",
    history: [made, ...corrections],
    citedBy: entries.filter((e) => e !== made && e.refs.includes(decision)),
    tasks: [],
    commits: [],
  };
}

function lookupRelease(entries: readonly LedgerEntry[], release: string): LookupResult {
  const record = findRelease(entries, release);
  if (!record) return empty(release, `${release} was never released`, "release");
  const range = releaseRange(entries, release);
  const tasks = unique(range.filter((e) => e.type === "task.done").map((e) => baseNumber(e.subject)));
  return {
    ref: release,
    kind: "release",
    found: true,
    text: releaseStamp(entries, release),
    status: record.restores ? `rollback to ${record.restores}` : "release",
    history: entries.filter((e) => e.subject === release),
    citedBy: entries.filter((e) => e.subject !== release && (e.refs.includes(release) || e.data?.restores === release)),
    tasks,
    commits: unique([record.commit, ...commitsFor(entries, tasks)].filter(Boolean)),
    range,
  };
}

function lookupEntry(entries: readonly LedgerEntry[], n: string): LookupResult {
  const entry = entries.find((e) => e.n === n);
  if (!entry) return empty(n, `${n} does not exist`, "entry");
  const corrections = entries.filter((e) => e.corrects === n);
  return {
    ref: n,
    kind: "entry",
    found: true,
    text: entry.summary,
    status: corrections.length ? `corrected by ${corrections.map((e) => e.n).join(", ")}` : entry.type,
    history: [entry, ...corrections],
    citedBy: entries.filter((e) => e.corrects !== n && (e.refs.includes(n) || e.evidence.includes(n))),
    tasks: entry.subject.startsWith("T-") ? [baseNumber(entry.subject)] : [],
    commits: entry.type === "commit.observed" && typeof entry.data?.sha === "string" ? [entry.data.sha] : [],
  };
}

function clauseOfEntry(entry: LedgerEntry): string | undefined {
  const fromData = entry.data?.clause;
  return typeof fromData === "string" ? clauseNumber(fromData) : clauseNumber(entry.subject);
}

function commitsFor(entries: readonly LedgerEntry[], tasks: string[], extra?: (e: LedgerEntry) => boolean): string[] {
  const set = new Set(tasks);
  return unique(
    entries
      .filter((e) => e.type === "commit.observed" && (set.has(baseNumber(e.subject)) || (extra?.(e) ?? false)))
      .map((e) => String(e.data?.sha ?? ""))
      .filter(Boolean),
  );
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export interface SearchHit {
  ref: string;
  kind: LookupKind;
  text: string;
  score: number;
}

/**
 * App search (spec §3.6). A reference resolves directly; anything else
 * matches words in clause text and entry summaries and reasons.
 */
export function search(entries: readonly LedgerEntry[], query: string, limit = 20): SearchHit[] {
  const direct = lookup(entries, query);
  if (direct.found) return [{ ref: direct.ref, kind: direct.kind!, text: oneLine(direct.text ?? ""), score: 100 }];
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (words.length === 0) return [];
  const score = (text: string) => {
    const lower = text.toLowerCase();
    let total = 0;
    for (const word of words) if (lower.includes(word)) total += 1;
    if (total === words.length && lower.includes(query.toLowerCase())) total += 1;
    return total;
  };
  const hits: SearchHit[] = [];
  for (const clause of clausesAt(entries).values()) {
    const s = score(clause.text);
    if (s > 0) hits.push({ ref: `§${clause.clause}`, kind: "clause", text: oneLine(clause.text), score: s + (clause.status === "active" ? 0.5 : 0) });
  }
  for (const entry of entries) {
    if (entry.type.startsWith("clause.")) continue;
    const s = score(`${entry.summary} ${entry.reason ?? ""}`);
    if (s > 0) hits.push({ ref: entry.n, kind: "entry", text: oneLine(entry.summary), score: s });
  }
  return hits.sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref)).slice(0, limit);
}
