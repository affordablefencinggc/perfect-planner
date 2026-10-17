// Decisions: every call the project is waiting on, with Jev's recommendation,
// and every call already made. Everything is folded from the ledger:
//   question.asked / question.answered  (relay and deep-planning questions)
//   decision.made                        (D-n: answers, settings, people)
//   review.verdict                       (Jev and the release pipeline)
// Accepting or overriding writes a D-n decision through the numbering rules
// and answers the question the way the relay does, so the worker that asked
// is woken by the relay's own ledger subscription.
//
// Recommendations come from, in order: Jev (a review.verdict it recorded for
// the question), deep planning's question pack, or the offline reviewer below,
// which only reads the ledger and says so. The Jev key is never read here:
// only its stored/not-stored status is asked of the key provider.
import { isAuthoritative, type Actor, type Ledger, type LedgerEntry } from "../../ledger/index";
import { createJevTransport, createOsKeyProvider, JevReviewer, JEV_MODEL, type JevCallResult, type JevKeyProvider, type JevRequest, type JevSettings } from "../../jev/index";
import { clausesAt, sortedClauses } from "../../lookup/index";
import { appendNumbered } from "../../numbering/index";
import { currentBudget, formatCents, monthOf, monthSpend } from "../../release/budget";
import type { Roster } from "../../people/index";
import { PlanningError, PlanningSession, planningMeta } from "../../planning/index";
import { questionKey } from "../../relay/index";
import type { CoreProject } from "../project";
import { fingerprintOf, requireFingerprint } from "../fingerprint";
import { HttpError, type Router } from "../router";
import { localPerson, rosterOf } from "./people";

// ---------- Jev connection (status only; the key stays with the provider) ----------

type Transport = (request: JevRequest) => Promise<JevCallResult>;

interface JevWiring {
  keys: JevKeyProvider;
  transport?: Transport;
  /** Thresholds and a Jev-only monthly limit (dollars). The person's monthly budget lowers the limit further. */
  settings?: Partial<JevSettings>;
  /** How long a review waits for Jev before it counts as unavailable. Tests make it short. */
  deadlineMs?: number;
  now?: () => Date;
}

let wiring: JevWiring | null = null;

/** Swaps the key provider (and optionally the transport). Tests use a MemoryKeyProvider and a fake transport. */
export function setDecisionJev(next: JevWiring | null): void {
  wiring = next;
  statusCache.clear();
}

/** True once something (the app's startup or a test) chose the key provider; tests use it to avoid the real key store. */
export function jevConfigured(): boolean {
  return wiring !== null;
}

export function jevWiring(): JevWiring {
  if (!wiring) wiring = { keys: createOsKeyProvider() };
  return wiring;
}

export interface JevConnection {
  connected: boolean;
  model: string | null;
  /** Plain words for the screen. */
  note: string;
}

const statusCache = new Map<string, { at: number; value: JevConnection }>();
const STATUS_TTL = 60_000;
/** One request to TypeSafe (the transport retries a busy answer once), and the whole review. */
const JEV_CALL_TIMEOUT_MS = 20_000;
const JEV_DEADLINE_MS = 45_000;

/**
 * Jev's test review is required once Jev is set up (a key saved in Settings), and not before, so the
 * loop runs without Jev. Called on every request; the key store's answer is cached for a minute.
 * The Tasks buttons that ask Jev pass fresh, so a key saved a few seconds ago counts at once.
 */
export async function syncJevPolicy(project: CoreProject, options: { fresh?: boolean } = {}): Promise<JevConnection> {
  const connection = await jevConnection(project, options);
  project.policy.requireJevTestReview = connection.connected;
  return connection;
}

export async function jevConnection(project: CoreProject, options: { fresh?: boolean } = {}): Promise<JevConnection> {
  const cached = statusCache.get(project.key);
  if (!options.fresh && cached && Date.now() - cached.at < STATUS_TTL) return cached.value;
  let value: JevConnection;
  try {
    const status = await jevWiring().keys.status();
    value = status.stored
      ? { connected: true, model: JEV_MODEL, note: "Jev is connected. New questions are sent to Jev when the plan may settle them, and Jev must review each task's test and each change before it is approved." }
      : { connected: false, model: null, note: status.available ? "Jev is not connected: no TypeSafe key is saved in Settings. Recommendations shown are from the offline reviewer. Once the key is saved, Jev must review each task's test and each change before it is approved." : "Jev is not connected: this computer has no secure key store Perfect Planner can use. Recommendations shown are from the offline reviewer." };
  } catch {
    // An error is not "no key": if Jev was connected a moment ago, it stays required until the store answers.
    value = cached?.value.connected
      ? { connected: true, model: JEV_MODEL, note: "Jev was connected and the key store did not answer just now, so Jev's review is still required." }
      : { connected: false, model: null, note: "Jev is not connected: the key store did not answer. Recommendations shown are from the offline reviewer." };
  }
  statusCache.set(project.key, { at: Date.now(), value });
  return value;
}

/**
 * The reviewer every Jev call goes through: the saved key (read only by the transport), a deadline so a
 * slow Jev counts as unavailable instead of hanging the screen, and the monthly cap. The cap is the
 * smaller of the Jev limit in the wiring and what is left of the person's own monthly budget (Settings),
 * so reviews wait in a queue at 100% and nothing is approved because of the cap (spec 6.7).
 */
export function jevReviewerFor(project: CoreProject): JevReviewer {
  const w = jevWiring();
  const now = w.now ?? (() => new Date());
  const deadline = w.deadlineMs ?? JEV_DEADLINE_MS;
  const base = w.transport ?? createJevTransport({ keys: w.keys, timeoutMs: JEV_CALL_TIMEOUT_MS });
  const transport: Transport = (request) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, problem: "request_failed", detail: `Jev did not answer within ${Math.max(1, Math.round(deadline / 1000))} seconds.` }), deadline);
      timer.unref?.();
      base(request).then(
        (result) => (clearTimeout(timer), resolve(result)),
        async (error: Error) => {
          clearTimeout(timer);
          // The error text goes on the ledger: the saved key is scrubbed out of it first, wherever it came from.
          const key = await w.keys.read().catch(() => null);
          const text = String(error?.message ?? error).slice(0, 200);
          resolve({ ok: false, problem: "request_failed", detail: `Jev could not be reached: ${key ? key.scrub(text) : text}` });
        },
      );
    });
  const entries = project.entries();
  const budget = currentBudget(entries);
  let monthlyLimit = w.settings?.monthlyLimit ?? null;
  if (budget) {
    const others = monthSpend(entries.filter((e) => isAuthoritative(e)), monthOf(now())).totalCents;
    const left = Math.max(0, budget.monthlyCents - others) / 100;
    monthlyLimit = monthlyLimit === null ? left : Math.min(monthlyLimit, left);
  }
  return new JevReviewer({ ledger: project.ledger, transport, now, settings: { ...w.settings, monthlyLimit } });
}

// ---------- card shapes ----------

export type CardStatus = "open" | "accepted" | "overridden" | "decided";
export type RecommendationSource = "jev" | "planning" | "offline";

export interface Recommendation {
  option: string;
  optionId?: string;
  reasons: string[];
  confidence: number;
  source: RecommendationSource;
  /** Who produced it, in plain words ("Jev", "Offline reviewer", "Deep planning"). */
  producedBy: string;
  /** The model that produced it, only when a model did. */
  model: string | null;
  cost: Money | null;
  entry?: string;
}

export interface Money {
  cents: number;
  label: string;
}

export interface Who {
  kind: Actor["kind"];
  id: string;
  name: string;
  model?: string;
}

export interface EntryRef {
  n: string;
  hash: string;
}

export interface DecisionCard {
  id: string;
  kind: "question" | "decision" | "review";
  title: string;
  status: CardStatus;
  q?: string;
  d?: string;
  task?: string;
  topic?: string;
  blocking: boolean;
  planning: boolean;
  options: { id: string; label: string }[];
  recommendation: Recommendation | null;
  /** Shown when there is no recommendation: why the call is the person's. */
  noRecommendation?: string;
  askedBy?: Who;
  askedAt?: string;
  outcome?: { answer: string; reason?: string; by: Who; at: string; via?: string; decision?: string };
  cost: Money | null;
  entries: EntryRef[];
  at: string;
  /** Binds an approval to the question and recommendation shown here. */
  fingerprint?: string;
}

export interface DecisionsView {
  jev: JevConnection;
  summary: { open: number; decided: number; month: string; spend: Money };
  open: DecisionCard[];
  decided: DecisionCard[];
}

// ---------- folding ----------

const money = (cents: number): Money => ({ cents, label: formatCents(cents) });

/** Cost on an entry: { cents, kind } (core/release/budget) or Jev's dollars number. */
export function entryCents(entry: LedgerEntry): number | null {
  const cost = entry.data?.cost as unknown;
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) return Math.round(cost * 100 * 100) / 100;
  if (cost && typeof cost === "object") {
    const cents = (cost as { cents?: unknown }).cents;
    if (typeof cents === "number" && Number.isFinite(cents) && cents >= 0) return cents;
  }
  return null;
}

/** Model spend this month: budget-style costs plus Jev's own review costs. Only signed (authoritative) entries count. */
export function spendThisMonth(entries: readonly LedgerEntry[], month: string): number {
  const signed = entries.filter((e) => isAuthoritative(e));
  let jevDollars = 0;
  for (const e of signed) if (e.at.slice(0, 7) === month && typeof e.data?.cost === "number") jevDollars += e.data.cost;
  return Math.round(monthSpend(signed, month).modelCents + jevDollars * 100);
}

/** Plan clauses from signed entries only: an unsigned clause line cannot steer a recommendation. */
const signedClauses = (entries: readonly LedgerEntry[]) => clausesAt(entries.filter((e) => isAuthoritative(e)));

/**
 * Jev, when Jev produced this verdict. A Jev verdict counts only when Perfect Planner wrote
 * and signed it (core/jev/reviewer) naming Jev in data.reviewer; an entry that merely
 * names Jev as its actor, or an unsigned line written into the ledger file, never does.
 */
function jevReviewer(e: LedgerEntry): Actor | undefined {
  if (e.type !== "review.verdict" || e.actor.kind !== "system" || !isAuthoritative(e)) return undefined;
  const reviewer = e.data?.reviewer as Actor | string | undefined;
  if (reviewer === "jev") return { kind: "jev", id: "jev" };
  return reviewer && typeof reviewer === "object" && reviewer.kind === "jev" ? reviewer : undefined;
}

/** The question and recommendation as the person sees them. */
function cardFingerprint(card: DecisionCard): string {
  const r = card.recommendation;
  return fingerprintOf({
    id: card.id,
    title: card.title,
    options: card.options,
    noRecommendation: card.noRecommendation ?? null,
    recommendation: r ? { option: r.option, optionId: r.optionId, reasons: r.reasons, confidence: r.confidence, producedBy: r.producedBy, model: r.model, source: r.source, entry: r.entry } : null,
  });
}

const ref = (e: LedgerEntry): EntryRef => ({ n: e.n, hash: e.hash.slice(0, 12) });

function who(actor: Actor, roster: Roster): Who {
  const member = actor.kind === "person" ? roster.members.get(actor.id) : undefined;
  const name = member?.name ?? (actor.kind === "jev" ? "Jev" : actor.kind === "system" ? "Perfect Planner" : actor.id);
  return { kind: actor.kind, id: actor.id, name, ...(actor.model ? { model: actor.model } : {}) };
}

const clamp01 = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const STOP = new Set("a an the and or of to for in on at by with we our should do does is are be it this that which what how use using".split(" "));
const stem = (w: string) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const words = (s: string) => new Set(norm(s).split(" ").filter((w) => w.length > 1 && !STOP.has(w)).map(stem));

function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

function matchOption(options: { id: string; label: string }[], text: string): { id: string; label: string } | undefined {
  const t = norm(text);
  return options.find((o) => norm(o.label) === t || norm(o.id) === t) ?? options.find((o) => norm(o.label).length >= 3 && t.startsWith(norm(o.label)));
}

interface Asked {
  entry: LedgerEntry;
  q: string;
  question: string;
  task: string;
  person: string;
  blocking: boolean;
  options: { id: string; label: string }[];
  planning: ReturnType<typeof planningMeta>;
  answered?: LedgerEntry;
  decision?: LedgerEntry;
  jevVerdict?: LedgerEntry;
}

function askedQuestions(entries: readonly LedgerEntry[]): Map<string, Asked> {
  const out = new Map<string, Asked>();
  const decisions = new Map<string, LedgerEntry>();
  // A decision counts only when the ledger verified a person or the system wrote it, never from actor.kind alone.
  for (const e of entries) if (e.type === "decision.made" && isAuthoritative(e)) decisions.set(e.subject, e);
  for (const e of entries) {
    const d = e.data ?? {};
    if (e.type === "question.asked") {
      const planning = planningMeta(e);
      const options = planning?.options?.length
        ? planning.options.map((o) => ({ id: o.id, label: o.label }))
        : (Array.isArray(d.options) ? d.options.map(String) : []).map((label, i) => ({ id: `option_${i + 1}`, label }));
      out.set(e.subject, { entry: e, q: e.subject, question: String(d.question ?? e.summary), task: String(d.task ?? ""), person: String(d.person ?? ""), blocking: d.blocking === true, options, planning });
    } else if (e.type === "question.answered") {
      const q = out.get(e.subject);
      if (!q) continue;
      if (!isAuthoritative(e)) continue;
      q.answered = e;
      if (typeof d.decision === "string") q.decision = decisions.get(d.decision);
    } else if (e.type === "review.verdict" && d.review === "question") {
      if (!jevReviewer(e)) continue;
      for (const r of e.refs) {
        const q = out.get(r);
        if (q) q.jevVerdict = e;
      }
    }
  }
  return out;
}

function jevRecommendation(q: Asked): Recommendation | null {
  const e = q.jevVerdict;
  if (!e) return null;
  const answers = e.data?.answers as Record<string, { choice?: string; confidence?: number | null; reason?: string }> | undefined;
  const settled = answers?.settled;
  const index = /^option_(\d+)$/.exec(settled?.choice ?? "")?.[1];
  const option = index ? q.options[Number(index) - 1] : undefined;
  if (!option) return null;
  const cents = entryCents(e);
  const model = typeof e.data?.jevModel === "string" ? e.data.jevModel : e.actor.model ?? null;
  return {
    option: option.label,
    optionId: option.id,
    reasons: [settled?.reason, e.reason].filter((r): r is string => typeof r === "string" && r.trim().length > 0),
    confidence: clamp01(settled?.confidence),
    source: "jev",
    producedBy: "Jev",
    model,
    cost: cents === null ? null : money(cents),
    entry: e.n,
  };
}

function planningRecommendation(q: Asked): Recommendation | null {
  const rec = q.planning?.recommendation;
  if (!rec || !rec.option) return null;
  const option = q.options.find((o) => o.id === rec.option);
  if (!option) return null;
  const why = (q.entry.data?.planning as { why?: unknown } | undefined)?.why;
  return {
    option: option.label,
    optionId: option.id,
    reasons: [rec.reason, typeof why === "string" ? why : ""].filter((r) => r && r.trim().length > 0),
    confidence: clamp01(rec.confidence),
    source: "planning",
    producedBy: "Deep planning",
    model: q.entry.actor.model ?? null,
    cost: null,
  };
}

/**
 * The offline reviewer: no model, no network. It recommends an option only
 * when the ledger points to one, an earlier decision on a similar question
 * or a plan clause that names exactly one option, and says which.
 */
export function offlineRecommendation(entries: readonly LedgerEntry[], q: Pick<Asked, "q" | "question" | "options">): Recommendation | string {
  if (q.options.length === 0) return "This question has no options to choose between, so it needs your answer in your own words.";
  let best: { sim: number; e: LedgerEntry; option: { id: string; label: string } } | null = null;
  for (const e of entries) {
    if (e.type !== "decision.made" || !isAuthoritative(e) || typeof e.data?.questionText !== "string" || e.data.question === q.q) continue;
    const option = matchOption(q.options, String(e.data.answer ?? e.summary));
    if (!option) continue;
    const sim = similarity(q.question, e.data.questionText);
    if (sim >= 0.5 && (!best || sim > best.sim)) best = { sim, e, option };
  }
  if (best) {
    return {
      option: best.option.label,
      optionId: best.option.id,
      reasons: [
        `${best.e.subject} already decided a similar question ("${String(best.e.data?.questionText)}") with "${String(best.e.data?.answer ?? best.e.summary)}".`,
        `The two questions share ${Math.round(best.sim * 100)}% of their key words, so the same answer probably still applies.`,
      ],
      confidence: Math.round(Math.min(0.9, best.sim) * 100) / 100,
      source: "offline",
      producedBy: "Offline reviewer",
      model: null,
      cost: null,
    };
  }
  const clauses = sortedClauses(signedClauses(entries)).filter((c) => c.status === "active");
  const named = q.options
    .map((o) => ({ o, hits: norm(o.label).length >= 3 ? clauses.filter((c) => ` ${norm(c.text)} `.includes(` ${norm(o.label)} `)) : [] }))
    .filter((x) => x.hits.length > 0);
  if (named.length === 1) {
    const { o, hits } = named[0]!;
    const clause = hits[0]!;
    return {
      option: o.label,
      optionId: o.id,
      reasons: [`The plan names "${o.label}" in §${clause.clause}: "${clause.text.length > 140 ? `${clause.text.slice(0, 137)}...` : clause.text}".`, "No other option is mentioned in the plan."],
      confidence: 0.6,
      source: "offline",
      producedBy: "Offline reviewer",
      model: null,
      cost: null,
    };
  }
  return "Nothing in the plan or earlier decisions points to one option, so this call is yours.";
}

function storedRecommendation(decision: LedgerEntry | undefined): Recommendation | null {
  const r = decision?.data?.recommendation as Partial<Recommendation> | undefined;
  if (!r || typeof r.option !== "string") return null;
  return {
    option: r.option,
    ...(typeof r.optionId === "string" ? { optionId: r.optionId } : {}),
    reasons: Array.isArray(r.reasons) ? r.reasons.map(String) : [],
    confidence: clamp01(r.confidence),
    source: r.source === "jev" || r.source === "planning" ? r.source : "offline",
    producedBy: typeof r.producedBy === "string" ? r.producedBy : "Offline reviewer",
    model: typeof r.model === "string" ? r.model : null,
    cost: r.cost && typeof r.cost === "object" && typeof (r.cost as Money).cents === "number" ? money((r.cost as Money).cents) : null,
  };
}

function recommendationFor(entries: readonly LedgerEntry[], q: Asked): Recommendation | string {
  return jevRecommendation(q) ?? planningRecommendation(q) ?? offlineRecommendation(entries, q);
}

function questionCard(entries: readonly LedgerEntry[], roster: Roster, q: Asked): DecisionCard {
  const open = !q.answered;
  const rec = open ? recommendationFor(entries, q) : storedRecommendation(q.decision) ?? jevRecommendation(q) ?? planningRecommendation(q);
  const recommendation = rec && typeof rec === "object" ? rec : null;
  const card: DecisionCard = {
    id: q.q,
    kind: "question",
    title: q.question,
    status: "open",
    q: q.q,
    task: q.task,
    blocking: q.blocking,
    planning: Boolean(q.planning),
    options: q.options,
    recommendation,
    ...(typeof rec === "string" ? { noRecommendation: rec } : {}),
    askedBy: who(q.entry.actor, roster),
    askedAt: q.entry.at,
    cost: recommendation?.cost ?? null,
    entries: [q.entry, q.jevVerdict, q.decision, q.answered].filter((e): e is LedgerEntry => Boolean(e)).map(ref),
    at: q.answered?.at ?? q.entry.at,
  };
  if (q.answered) {
    const source = q.decision ?? q.answered;
    const d = q.answered.data ?? {};
    const answer = String(q.decision?.data?.answer ?? d.answer ?? q.answered.summary);
    const via = d.via === "decision" ? `Answered automatically: ${String(d.decision)} already decided the same question.` : d.via === "settled" ? "Answered automatically: the approved plan settles it." : d.via === "spike" ? "Turned into a dated spike task." : undefined;
    card.outcome = { answer, ...(source.reason ? { reason: source.reason } : {}), by: who(source.actor, roster), at: source.at, ...(via ? { via } : {}), ...(q.decision ? { decision: q.decision.subject } : {}) };
    if (q.decision) card.d = q.decision.subject;
    const stored = q.decision?.data?.question === q.q ? q.decision.data.outcome : undefined;
    card.status = stored === "accepted" || stored === "overridden" ? stored : recommendation && d.via !== "decision" && d.via !== "settled" && d.via !== "spike" ? (norm(answer).startsWith(norm(recommendation.option)) ? "accepted" : "overridden") : "decided";
  }
  card.fingerprint = cardFingerprint(card);
  return card;
}

function decisionCard(e: LedgerEntry, roster: Roster): DecisionCard {
  const d = e.data ?? {};
  const people = d.people as { op?: string } | undefined;
  const topic = typeof d.topic === "string" ? d.topic : people ? "people" : undefined;
  const cents = entryCents(e);
  return {
    id: e.subject,
    kind: "decision",
    title: e.summary,
    status: "decided",
    d: e.subject,
    ...(topic ? { topic } : {}),
    blocking: false,
    planning: false,
    options: [],
    recommendation: null,
    outcome: { answer: e.summary, ...(e.reason ? { reason: e.reason } : {}), by: who(e.actor, roster), at: e.at, decision: e.subject },
    cost: cents === null ? null : money(cents),
    entries: [ref(e)],
    at: e.at,
  };
}

const VERDICT_WORDS: Record<string, string> = { approve: "Approve", reject: "Reject", escalate: "Ask a person", unavailable: "Could not review", queued: "Waiting for budget", gaps: "Gaps found", pass: "Pass", fail: "Fail" };

function reviewCard(e: LedgerEntry, roster: Roster): DecisionCard {
  const d = e.data ?? {};
  const verdict = String(d.verdict ?? "");
  const notes = [d.notes, d.gaps].flatMap((list) => (Array.isArray(list) ? list : [])).map((n) => (typeof n === "string" ? n : typeof (n as { message?: unknown })?.message === "string" ? String((n as { message: string }).message) : JSON.stringify(n)));
  const cents = entryCents(e);
  const model = typeof d.jevModel === "string" ? d.jevModel : e.actor.model ?? null;
  // Jev's counted verdicts are written (signed) by Perfect Planner, naming Jev in data.reviewer.
  const jevActor = jevReviewer(e);
  const by = who(jevActor ?? e.actor, roster);
  return {
    id: e.n,
    kind: "review",
    title: e.summary,
    status: "decided",
    task: e.subject,
    blocking: false,
    planning: false,
    options: [],
    recommendation: {
      option: VERDICT_WORDS[verdict] ?? (verdict || "Recorded"),
      reasons: notes.length ? notes : e.reason ? [e.reason] : [],
      confidence: clamp01(d.confidence),
      source: jevActor ? "jev" : "offline",
      producedBy: by.name,
      model,
      cost: cents === null ? null : money(cents),
      entry: e.n,
    },
    outcome: { answer: VERDICT_WORDS[verdict] ?? (verdict || e.summary), ...(e.reason ? { reason: e.reason } : {}), by, at: e.at },
    cost: cents === null ? null : money(cents),
    entries: [ref(e)],
    at: e.at,
  };
}

export async function buildDecisionsView(project: CoreProject, now = new Date()): Promise<DecisionsView> {
  const entries = project.entries();
  const roster = rosterOf(project);
  const questions = askedQuestions(entries);
  const answeredDecisions = new Set<string>();
  const open: DecisionCard[] = [];
  const decided: DecisionCard[] = [];
  for (const q of questions.values()) {
    if (q.decision) answeredDecisions.add(q.decision.subject);
    const card = questionCard(entries, roster, q);
    (card.status === "open" ? open : decided).push(card);
  }
  for (const e of entries) {
    // Only entries the ledger verified as written by a person or the system become cards.
    if (!isAuthoritative(e)) continue;
    if (e.type === "decision.made" && !answeredDecisions.has(e.subject) && typeof e.data?.question !== "string") decided.push(decisionCard(e, roster));
    else if (e.type === "review.verdict" && e.data?.review !== "question") decided.push(reviewCard(e, roster));
  }
  const byNumber = (a: DecisionCard, b: DecisionCard) => a.id.localeCompare(b.id, undefined, { numeric: true });
  open.sort((a, b) => Number(b.blocking) - Number(a.blocking) || byNumber(a, b));
  decided.sort((a, b) => b.at.localeCompare(a.at) || byNumber(b, a));
  const month = monthOf(now);
  return {
    jev: await jevConnection(project),
    summary: { open: open.length, decided: decided.length, month, spend: money(spendThisMonth(entries, month)) },
    open,
    decided,
  };
}

// ---------- writing ----------

const text = (value: unknown, field: string, max = 2000): string => {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new HttpError(400, "INVALID", `${field} must be text.`);
  const t = value.trim();
  if (t.length > max) throw new HttpError(400, "INVALID", `${field} is too long (at most ${max} characters).`);
  return t;
};

function openQuestion(project: CoreProject, body: unknown): Asked {
  const q = text((body as { q?: unknown })?.q, "q", 40);
  if (!q) throw new HttpError(400, "INVALID", "Say which question this is about (q).");
  const asked = askedQuestions(project.entries()).get(q);
  if (!asked) throw new HttpError(404, "NOT_FOUND", `${q} is not a question in this project.`);
  if (asked.answered) throw new HttpError(409, "ALREADY_DECIDED", `${q} was already decided: ${String(asked.answered.data?.answer ?? asked.answered.summary)}`);
  return asked;
}

/** The card as it is now must be the card the person approved. */
function checkFingerprint(project: CoreProject, asked: Asked, body: unknown): void {
  const entries = project.entries();
  const card = questionCard(entries, rosterOf(project), asked);
  requireFingerprint(body, card.fingerprint ?? "", "question and recommendation");
}

function refuse(error: unknown): never {
  if (error instanceof PlanningError) throw new HttpError(422, error.code, error.message);
  throw error;
}

/** Writes the decision and answers the question, as the relay does, with the person's reason. */
function decide(project: CoreProject, asked: Asked, input: { answer: string; choiceId?: string; reason: string; outcome: "accepted" | "overridden"; recommendation: Recommendation | null }): { q: string; decision: string; answer: string; status: string } {
  const actor = localPerson(project);
  if (asked.planning) {
    try {
      const session = new PlanningSession(project.ledger, { person: asked.person || actor.id });
      const choice = input.choiceId && asked.options.some((o) => o.id === input.choiceId) ? input.choiceId : undefined;
      const result = session.answer(actor, asked.q, { ...(choice ? { choice } : { text: input.answer }), reason: input.reason });
      if (result.status !== "decided") throw new HttpError(422, "NOT_DECIDED", `${asked.q} became a spike, not a decision.`);
      return { q: asked.q, decision: result.decision, answer: result.answer, status: input.outcome };
    } catch (error) {
      refuse(error);
    }
  }
  const ledger: Ledger = project.ledger;
  const { cost: _cost, entry: _entry, ...rec } = input.recommendation ?? ({} as Partial<Recommendation>);
  const decision = appendNumbered(ledger, {
    actor,
    type: "decision.made",
    summary: input.answer.length > 140 ? `${input.answer.slice(0, 137)}...` : input.answer,
    reason: input.reason,
    evidence: [],
    refs: [asked.q, ...(asked.task ? [asked.task] : [])],
    data: {
      key: questionKey(asked.question, asked.options.map((o) => o.label)),
      question: asked.q,
      questionText: asked.question,
      answer: input.answer,
      outcome: input.outcome,
      ...(input.recommendation ? { recommendation: { ...rec, ...(input.recommendation.cost ? { cost: { cents: input.recommendation.cost.cents } } : {}) } } : {}),
    },
  });
  ledger.append({
    actor,
    type: "question.answered",
    subject: asked.q,
    summary: decision.summary,
    evidence: [],
    refs: [decision.subject, ...(asked.task ? [asked.task] : [])],
    data: { answer: input.answer, decision: decision.subject, via: "main" },
  });
  return { q: asked.q, decision: decision.subject, answer: input.answer, status: input.outcome };
}

const pending = new Map<string, Promise<unknown>>();

/** Waits for Jev calls started by "Ask for a decision" (tests and shutdown). */
export async function settleDecisionJev(project: CoreProject): Promise<void> {
  await pending.get(project.key);
}

function askJev(project: CoreProject, q: string): void {
  const run = (async () => {
    const connection = await jevConnection(project);
    if (!connection.connected) return;
    const asked = project.service.relay.get(q);
    if (!asked || asked.status !== "open" || asked.options.length < 2) return;
    const reviewer = jevReviewerFor(project);
    reviewer.planClauses = () => sortedClauses(signedClauses(project.entries())).filter((c) => c.status === "active").map((c) => ({ ref: `§${c.clause}`, text: c.text }));
    // Jev's view is recorded as a review.verdict and shown as the recommendation; the person still decides.
    await reviewer.tryAnswer(asked);
  })().catch(() => undefined);
  const before = pending.get(project.key) ?? Promise.resolve();
  pending.set(project.key, before.then(() => run));
}

export function registerDecisionRoutes(router: Router): void {
  router.get("/decisions", ({ project }) => buildDecisionsView(project));

  // A person raises a decision: it is asked through the relay like any worker question.
  router.post("/decisions/ask", async ({ project, body }) => {
    const b = (body ?? {}) as { question?: unknown; options?: unknown; blocking?: unknown };
    const question = text(b.question, "The question", 500);
    if (!question) throw new HttpError(400, "INVALID", "Write the question you want decided.");
    if (b.options !== undefined && !Array.isArray(b.options)) throw new HttpError(400, "INVALID", "Options must be a list.");
    const options = ((b.options as unknown[] | undefined) ?? []).map((o, i) => text(o, `Option ${i + 1}`, 200)).filter(Boolean);
    if (options.length > 8) throw new HttpError(400, "INVALID", "Give at most 8 options.");
    if (new Set(options.map(norm)).size !== options.length) throw new HttpError(400, "INVALID", "Two options say the same thing.");
    const actor = localPerson(project);
    let result;
    try {
      result = await project.service.relay.ask(actor, actor.id, { task: "project", question, options, blocking: b.blocking === true });
    } catch (error) {
      throw new HttpError(422, "REFUSED", (error as Error).message);
    }
    if (result.status === "open") askJev(project, result.q);
    return result;
  });

  router.post("/decisions/accept", ({ project, body }) => {
    const asked = openQuestion(project, body);
    checkFingerprint(project, asked, body);
    const rec = recommendationFor(project.entries(), asked);
    if (typeof rec === "string") throw new HttpError(409, "NO_RECOMMENDATION", `${asked.q} has no recommendation to accept. ${rec}`);
    const reason = `Accepted the recommendation from ${rec.producedBy}${rec.reasons[0] ? `: ${rec.reasons[0]}` : ""}`;
    return decide(project, asked, { answer: rec.option, ...(rec.optionId ? { choiceId: rec.optionId } : {}), reason, outcome: "accepted", recommendation: rec });
  });

  router.post("/decisions/override", ({ project, body }) => {
    const asked = openQuestion(project, body);
    checkFingerprint(project, asked, body);
    const b = (body ?? {}) as { choice?: unknown; text?: unknown; reason?: unknown };
    const reason = text(b.reason, "The reason", 1000);
    if (!reason) throw new HttpError(400, "REASON_REQUIRED", "Say why you chose something else. The reason is kept with the decision.");
    const choiceText = text(b.choice, "The choice", 200);
    const extra = text(b.text, "The answer", 2000);
    let option: { id: string; label: string } | undefined;
    if (choiceText) {
      option = asked.options.find((o) => o.id === choiceText || o.label === choiceText);
      if (!option) throw new HttpError(400, "BAD_CHOICE", `"${choiceText}" is not one of the options for ${asked.q}.`);
    }
    if (!option && !extra) throw new HttpError(400, "INVALID", "Pick an option or write your own answer.");
    const answer = option ? (extra ? `${option.label}: ${extra}` : option.label) : extra;
    const rec = recommendationFor(project.entries(), asked);
    const recommendation = typeof rec === "string" ? null : rec;
    const outcome = recommendation && option && recommendation.optionId === option.id && !extra ? "accepted" : "overridden";
    return decide(project, asked, { answer, ...(option ? { choiceId: option.id } : {}), reason, outcome, recommendation });
  });
}
