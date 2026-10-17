// Ledger and clause search (workspace "lookup") and the header search box.
// GET /lookup?ref=   resolves an exact reference to its entry, clause or release.
// GET /search?q=     free-text matches across entries and clauses, paged.
// GET /recent        the last entries, for the empty state, plus clickable examples.
// GET /verify        whether the ledger's chain is intact.
import type { LedgerEntry } from "../../ledger/index";
import { clausesAt, compareClauses, lookup, parseRef, search, type LookupResult } from "../../lookup/index";
import { findRelease, releases } from "../../numbering/index";
import { HttpError, type Router } from "../router";

const MAX_HITS = 200;
const MAX_RANGE = 200;
const MAX_LIST = 100;

export interface EntryView {
  n: string;
  at: string;
  type: string;
  subject: string;
  summary: string;
  reason?: string;
  actor: { kind: string; id: string; model?: string };
  evidence: string[];
  refs: string[];
  corrects?: string;
  hash: string;
  shortHash: string;
}

export function entryView(entry: LedgerEntry): EntryView {
  return {
    n: entry.n,
    at: entry.at,
    type: entry.type,
    subject: entry.subject,
    summary: entry.summary,
    reason: entry.reason,
    actor: { ...entry.actor },
    evidence: [...entry.evidence],
    refs: [...entry.refs],
    corrects: entry.corrects,
    hash: entry.hash,
    shortHash: entry.hash.slice(0, 12),
  };
}

/**
 * Turns what people type into a reference lookup() accepts:
 * "P-12 3.2" → "P-12 §3.2", "s3.2" / "sec 3.2" → "§3.2", "3.2" → "§3.2",
 * "l-231" → "L-000231", "t-14.A2" → "T-14.a2". Returns undefined for free text.
 */
export function normalizeRef(raw: string): string | undefined {
  let text = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!text) return undefined;
  text = text.replace(/(^|\s)(?:section|sec\.?|s)\s*(?=\d)/gi, "$1§");
  text = text.replace(/§\s+/g, "§");
  text = text.replace(/^([lptqdr])\s*-?\s*(\d)/i, (_m, s: string, d: string) => `${s.toUpperCase()}-${d}`);
  text = text.replace(/\.A(\d+)$/, ".a$1");
  text = text.replace(/^(P-\d+)\s*§?\s*(\d+(?:\.\d+)*)$/, "$1 §$2");
  if (/^\d+(?:\.\d+)+$/.test(text)) text = `§${text}`;
  const shortL = /^L-(\d{1,5})$/.exec(text);
  if (shortL) text = `L-${shortL[1].padStart(6, "0")}`;
  return parseRef(text) ? text : undefined;
}

function primaryEntry(result: LookupResult): LedgerEntry | undefined {
  if (result.kind === "clause") return result.history[result.history.length - 1];
  if (result.kind === "release") return result.history.find((e) => e.type === "release.cut" || e.type === "release.rollback") ?? result.history[0];
  return result.history[0];
}

function titleFor(result: LookupResult): string {
  switch (result.kind) {
    case "clause": return `Clause ${result.ref}`;
    case "plan": return `Plan ${result.ref}`;
    case "task": return `Task ${result.ref}`;
    case "question": return `Question ${result.ref}`;
    case "decision": return `Decision ${result.ref}`;
    case "release": return `Release ${result.ref}`;
    case "entry": return `Ledger entry ${result.ref}`;
    default: return result.ref;
  }
}

function clauseDetail(entries: readonly LedgerEntry[], result: LookupResult) {
  const ref = parseRef(result.ref);
  if (!ref || ref.kind !== "clause") return undefined;
  const current = clausesAt(entries).get(ref.clause);
  const versions = result.history.map((e, i) => ({
    version: i + 1,
    n: e.n,
    at: e.at,
    type: e.type,
    actor: { ...e.actor },
    text: e.type === "clause.added" ? String(e.data?.text ?? "") : e.type === "clause.changed" ? String(e.data?.new ?? "") : null,
    reason: e.reason,
    shortHash: e.hash.slice(0, 12),
  }));
  return {
    number: ref.clause,
    plan: ref.plan,
    kind: current?.kind,
    textInPlan: result.text,
    current: current ? { text: current.text, status: current.status } : undefined,
    versions,
  };
}

function releaseDetail(entries: readonly LedgerEntry[], result: LookupResult) {
  const record = findRelease(entries, result.ref);
  if (!record) return undefined;
  const range = result.range ?? [];
  return {
    release: record.release,
    version: record.version,
    plan: record.plan,
    commit: record.commit,
    from: record.from,
    to: record.to,
    restores: record.restores,
    count: range.length,
    entries: range.slice(0, MAX_RANGE).map(entryView),
    truncated: range.length > MAX_RANGE,
  };
}

export function lookupView(entries: readonly LedgerEntry[], query: string) {
  const ref = normalizeRef(query);
  const result = lookup(entries, ref ?? query);
  const base = { query, ref: result.ref, kind: result.kind ?? null, found: result.found };
  if (!result.found) return { ...base, problem: result.problem ?? `Nothing matches ${query}.` };
  const primary = primaryEntry(result);
  return {
    ...base,
    title: titleFor(result),
    text: result.text ?? "",
    status: result.status ?? "",
    who: primary ? { ...primary.actor } : undefined,
    when: primary?.at,
    what: primary?.summary,
    why: primary?.reason,
    evidence: primary ? [...primary.evidence] : [],
    refs: primary ? [...primary.refs] : [],
    entry: primary ? entryView(primary) : undefined,
    history: result.history.slice(-MAX_LIST).map(entryView),
    citedBy: result.citedBy.slice(-MAX_LIST).map(entryView),
    tasks: result.tasks,
    commits: result.commits,
    clause: result.kind === "clause" ? clauseDetail(entries, result) : undefined,
    release: result.kind === "release" ? releaseDetail(entries, result) : undefined,
  };
}

function intParam(value: string | null, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function searchView(entries: readonly LedgerEntry[], query: string, page = 1, pageSize = 20) {
  const ref = normalizeRef(query);
  const byN = new Map(entries.map((e) => [e.n, e]));
  let hits = search(entries, query, MAX_HITS);
  if (ref && ref !== query) {
    const direct = lookup(entries, ref);
    if (direct.found && !hits.some((h) => h.ref === direct.ref)) {
      hits = [{ ref: direct.ref, kind: direct.kind!, text: (direct.text ?? "").replace(/\s+/g, " ").slice(0, 80), score: 100 }, ...hits];
    }
  }
  hits = hits.slice(0, MAX_HITS);
  const total = hits.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, pages);
  const slice = hits.slice((current - 1) * pageSize, current * pageSize).map((hit) => {
    const entry = byN.get(hit.ref);
    return {
      ref: hit.ref,
      kind: hit.kind,
      text: hit.text,
      score: hit.score,
      exact: hit.score >= 100,
      entry: entry ? { n: entry.n, at: entry.at, type: entry.type, subject: entry.subject, actor: { ...entry.actor }, shortHash: entry.hash.slice(0, 12) } : undefined,
    };
  });
  return { query, ref: ref ?? null, total, capped: total >= MAX_HITS, page: current, pageSize, pages, hits: slice };
}

/** Real references from this ledger that make good clickable examples. */
export function examplesFor(entries: readonly LedgerEntry[]): string[] {
  const out: string[] = [];
  const plans = entries.filter((e) => e.type === "plan.approved");
  const lastPlan = plans[plans.length - 1]?.subject;
  const clauses = [...clausesAt(entries).values()].filter((c) => c.status === "active").sort((a, b) => compareClauses(a.clause, b.clause));
  const clause = clauses.find((c) => c.kind !== "heading") ?? clauses[0];
  if (clause) out.push(lastPlan ? `${lastPlan} §${clause.clause}` : `§${clause.clause}`);
  const lastRelease = releases(entries).at(-1)?.release;
  if (lastRelease) out.push(lastRelease);
  for (const type of ["task.created", "decision.made", "question.asked"] as const) {
    const found = [...entries].reverse().find((e) => e.type === type);
    if (found) out.push(found.subject);
  }
  const last = entries[entries.length - 1];
  if (last) out.push(last.n);
  return out;
}

export function registerSearchRoutes(router: Router): void {
  router.get("/lookup", ({ query, project }) => {
    const ref = (query.get("ref") ?? query.get("q") ?? "").trim();
    if (!ref) throw new HttpError(400, "NO_REF", "Type a reference to look up, like P-1 §2.1, R-1, T-14 or L-000231.");
    if (ref.length > 200) throw new HttpError(400, "TOO_LONG", "That reference is too long to look up.");
    return lookupView(project.entries(), ref);
  });

  router.get("/search", ({ query, project }) => {
    const q = (query.get("q") ?? "").trim();
    if (!q) throw new HttpError(400, "NO_QUERY", "Type something to search for.");
    if (q.length > 200) throw new HttpError(400, "TOO_LONG", "That search is too long.");
    return searchView(project.entries(), q, intParam(query.get("page"), 1, 1, 1000), intParam(query.get("pageSize"), 20, 1, 50));
  });

  router.get("/recent", ({ query, project }) => {
    const entries = project.entries();
    const limit = intParam(query.get("limit"), 12, 1, 50);
    return {
      total: entries.length,
      entries: entries.slice(-limit).reverse().map(entryView),
      examples: examplesFor(entries),
    };
  });

  router.get("/verify", ({ project }) => {
    const status = project.ledger.status;
    const head = project.ledger.last();
    return {
      ok: status.ok,
      entries: status.entries,
      head: status.head ?? null,
      headHash: head ? head.hash.slice(0, 12) : null,
      brokenAt: status.brokenAt ?? null,
      problem: status.problem ?? null,
      detail: status.detail ?? null,
      acknowledged: status.acknowledged,
      writable: status.writable,
    };
  });
}
