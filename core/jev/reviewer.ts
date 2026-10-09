// Jev's two jobs in the core loop (spec §6.2, §6.3), plus answering worker
// questions the plan already settles. Jev scores and recommends; Perfect
// Planner turns the scores into a verdict with fixed rules it owns (policy
// below), writes one review.verdict entry per review (§6.8), and never lets a
// failure, a low score or the cost cap turn into an approval (§6.7, §6.9).
import type { Actor, Ledger, LedgerEntry } from "../ledger/index";
import type { Question, SettledAnswer, SettledAnswerer } from "../relay/relay";
import { checkDiff, parseDiff, type LineNote } from "./diffChecks";
import { JEV_MODEL, type JevAnswer, type JevCallResult, type JevRequest } from "./transport";

export const REVIEW_POLICY = "pp-review-v1";

export type Verdict = "approve" | "reject" | "escalate" | "unavailable" | "queued";

export interface JevSettings {
  model: string;
  /** Every answer must reach this confidence for an approval. */
  approveConfidence: number;
  /** Below this, Jev's view is too weak to act on: the verdict goes to the main chat (§6.9). */
  escalateBelow: number;
  /** Monthly spend cap in US dollars; null = no cap. */
  monthlyLimit: number | null;
  /** Used when Jev's reply does not say what the call cost. */
  estimatedCostPerCall: number;
}

export const DEFAULT_SETTINGS: JevSettings = { model: JEV_MODEL, approveConfidence: 0.8, escalateBelow: 0.6, monthlyLimit: null, estimatedCostPerCall: 0.02 };

export interface ReviewResult {
  verdict: Verdict;
  /** Gaps (test review) or line notes (diff review), in plain words. */
  notes: LineNote[] | string[];
  reason: string;
  entry?: string;
  confidence: number | null;
}

export interface TestReviewInput {
  task: string;
  title: string;
  clauses: { ref: string; text: string }[];
  test: { command: string; source?: string };
  /** Perfect Planner ran the test on the current code: true when it failed, as it must (§6.2). */
  failsFirst: boolean;
  /** Who wrote the test, with their model. Jev only approves work built by a different model (§6.4). */
  author: Actor;
  /**
   * Ledger number of the test.defined entry under review. When given, an approve or reject verdict
   * carries the test gate's evidence (scope:test, verdict, definition, gaps), so the gate counts it
   * and refuses the owner's approval while Jev's gaps are open.
   */
  definition?: string;
}

export interface DiffReviewInput {
  task: string;
  clauses: { ref: string; text: string }[];
  diff: string;
  testOutput: string;
  /** Paths or folders ("src/invoice/") the task may touch. Empty = no scope rule. */
  allowedFiles: string[];
  /** Who built the change, with their model. Jev only approves work built by a different model (§6.4). */
  author: Actor;
  attempt?: number;
}

type Transport = (request: JevRequest) => Promise<JevCallResult>;

const SYSTEM: Actor = { kind: "system", id: "perfect-planner" };
const MAX_DIFF = 60_000;
const MAX_TEXT = 12_000;

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n[... ${text.length - max} more characters not sent]` : text);

function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

const sameModel = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Spec §6.4 and §6.9: work is never judged by the model that built it. Returns
 * why Jev may not judge this work, or null when the builder is a different,
 * named model. An unknown builder model cannot be shown to be different.
 */
export function independenceProblem(author: Actor | undefined, reviewingModel: string): string | null {
  if (!author) return "nobody is recorded as the builder, so independence cannot be checked";
  if (author.kind === "jev") return "Jev built this, and Jev never approves its own output";
  const model = author.model?.trim();
  if (!model || model.toLowerCase() === "unknown") return `the builder (${author.id}) did not name its model, so independence cannot be checked`;
  if (sameModel(model, reviewingModel) || /^jev\b/i.test(model)) return `the builder used ${model}, the same model that would review it`;
  return null;
}

export class JevReviewer implements SettledAnswerer {
  private readonly ledger: Ledger;
  private readonly transport: Transport;
  private readonly now: () => Date;
  settings: JevSettings;
  private readonly queue: { describe: string; run: () => Promise<ReviewResult> }[] = [];

  constructor(options: { ledger: Ledger; transport: Transport; settings?: Partial<JevSettings>; now?: () => Date }) {
    this.ledger = options.ledger;
    this.transport = options.transport;
    this.settings = { ...DEFAULT_SETTINGS, ...options.settings };
    this.now = options.now ?? (() => new Date());
  }

  // ---------- cost cap (§6.7) ----------

  spentThisMonth(): number {
    const month = this.now().toISOString().slice(0, 7);
    let spent = 0;
    for (const e of this.ledger.entries()) {
      if (e.type === "review.verdict" && monthOf(e.at) === month && typeof e.data?.cost === "number") spent += e.data.cost;
    }
    return Math.round(spent * 1e6) / 1e6;
  }

  private overCap(): boolean {
    const limit = this.settings.monthlyLimit;
    return limit !== null && this.spentThisMonth() >= limit;
  }

  private warnIfNeeded(): void {
    const limit = this.settings.monthlyLimit;
    if (limit === null || limit <= 0) return;
    const month = this.now().toISOString().slice(0, 7);
    const spent = this.spentThisMonth();
    const warned = new Set(this.ledger.entries().filter((e) => e.type === "budget.warning" && e.subject === `jev:${month}`).map((e) => e.data?.level));
    for (const level of [80, 100]) {
      if (spent >= (limit * level) / 100 && !warned.has(level)) {
        this.ledger.append({
          actor: SYSTEM,
          type: "budget.warning",
          subject: `jev:${month}`,
          summary: level === 100 ? `Jev reached its monthly limit of $${limit}; new reviews wait in a queue` : `Jev has used ${level}% of its monthly limit ($${spent.toFixed(2)} of $${limit})`,
          reason: "Jev monthly cost cap (spec §6.7)",
          data: { level, spent, limit, month },
        });
      }
    }
  }

  /** Reviews waiting for the cap to lift. */
  queued(): string[] {
    return this.queue.map((q) => q.describe);
  }

  /** Re-run queued reviews (after the limit is raised or a new month starts). */
  async retryQueued(): Promise<ReviewResult[]> {
    const waiting = this.queue.splice(0);
    const results: ReviewResult[] = [];
    for (const item of waiting) results.push(await item.run());
    return results;
  }

  // ---------- shared plumbing ----------

  private record(task: string, review: "test" | "diff" | "question", result: ReviewResult, extra: { called: JevCallResult | null; refs: string[]; summary: string; data?: Record<string, unknown>; definition?: string }): LedgerEntry {
    const called = extra.called;
    const cost = called?.ok ? (called.cost ?? this.settings.estimatedCostPerCall) : 0;
    // The test gate reads Jev's test verdicts from evidence (core/gate deriveState). Only a real
    // approve or reject is an opinion on the test; escalations and outages are not.
    const gateEvidence =
      review === "test" && extra.definition && (result.verdict === "approve" || result.verdict === "reject")
        ? ["scope:test", `verdict:${result.verdict === "approve" ? "approve" : "gaps"}`, `definition:${extra.definition}`, ...(result.notes as string[]).map((gap) => `gap:${String(gap).replace(/\s+/g, " ").trim()}`)]
        : undefined;
    return this.ledger.append({
      actor: called?.ok ? { kind: "jev", id: "jev", model: called.model } : SYSTEM,
      type: "review.verdict",
      subject: task,
      summary: extra.summary,
      reason: result.reason,
      refs: extra.refs,
      ...(gateEvidence ? { evidence: gateEvidence } : {}),
      data: {
        review,
        verdict: result.verdict,
        policy: REVIEW_POLICY,
        model: this.settings.model,
        jevModel: called?.ok ? called.model : null,
        cost,
        costEstimated: Boolean(called?.ok && called.cost === null),
        confidence: result.confidence,
        notes: result.notes,
        ...(called?.ok ? { answers: called.answers } : called ? { problem: called.problem } : {}),
        ...extra.data,
      },
    });
  }

  private minConfidence(answers: Record<string, JevAnswer>): number | null {
    let min: number | null = 1;
    for (const a of Object.values(answers)) {
      if (a.confidence === null) return null;
      min = Math.min(min ?? 1, a.confidence);
    }
    return min;
  }

  private async callOrQueue(describe: string, again: () => Promise<ReviewResult>, request: JevRequest): Promise<JevCallResult | "queued"> {
    if (this.overCap()) {
      this.warnIfNeeded();
      this.queue.push({ describe, run: again });
      return "queued";
    }
    return this.transport(request);
  }

  // ---------- job 1: test review, before work starts (§6.2) ----------

  async reviewTest(input: TestReviewInput): Promise<ReviewResult> {
    const refs = input.clauses.map((c) => c.ref);
    const notIndependent = independenceProblem(input.author, this.settings.model);
    if (notIndependent) {
      const result: ReviewResult = { verdict: "escalate", notes: [], reason: `Not independent: ${notIndependent} (§6.4)`, confidence: null };
      return { ...result, entry: this.record(input.task, "test", result, { definition: input.definition, called: null, refs, summary: `Test for ${input.task} goes to the main chat: Jev cannot review it independently`, data: { builtBy: input.author ?? null } }).n };
    }
    if (!input.failsFirst) {
      const result: ReviewResult = { verdict: "reject", notes: ["The test passes on the current code, so it cannot prove the task (it must fail first)."], reason: "Test does not fail before the work (§6.2)", confidence: null };
      return { ...result, entry: this.record(input.task, "test", result, { definition: input.definition, called: null, refs, summary: `Test for ${input.task} rejected: it already passes` }).n };
    }

    const clauseChoices: Record<string, string> = { none: "Every cited clause is fully covered" };
    for (const c of input.clauses) clauseChoices[c.ref] = cut(c.text, 300);
    const request: JevRequest = {
      model: this.settings.model,
      state: {
        task: { id: input.task, title: input.title },
        clauses: input.clauses.map((c) => ({ ref: c.ref, text: cut(c.text, 2000) })),
        test: { command: input.test.command, source: cut(input.test.source ?? "", MAX_TEXT) },
      },
      questions: {
        covers_clauses: {
          type: "choice",
          instructions: "Read `clauses` and `test.source`. Would this test fail if any cited clause were not implemented? Judge only the test, not the code.",
          criteria: { all: "Every cited clause is checked by at least one meaningful assertion", some: "Some cited clauses are not checked", none: "The test does not check the cited clauses" },
        },
        trivially_passing: {
          type: "choice",
          instructions: "Could this test pass without the task being done, for example by asserting constants, mocking the thing under test, or catching every error?",
          criteria: { no: "No, it needs the real behaviour", yes: "Yes, it can pass trivially" },
        },
        weakest_clause: {
          type: "choice",
          instructions: "Which cited clause is least covered by the test?",
          criteria: clauseChoices,
        },
      },
    };
    const called = await this.callOrQueue(`Test review for ${input.task}`, () => this.reviewTest(input), request);
    if (called === "queued") return { verdict: "queued", notes: [], reason: "Jev's monthly limit is reached; the review waits in the queue (§6.7)", confidence: null };
    if (!called.ok) {
      const result: ReviewResult = { verdict: "unavailable", notes: [], reason: called.detail, confidence: null };
      return { ...result, entry: this.record(input.task, "test", result, { definition: input.definition, called, refs, summary: `Test review for ${input.task} could not run` }).n };
    }

    const a = called.answers;
    const gaps: string[] = [];
    if (a.covers_clauses!.choice !== "all") {
      const weakest = a.weakest_clause!.choice;
      gaps.push(`Not every cited clause is checked${weakest && weakest !== "none" ? `; weakest: ${weakest}` : ""}.`);
    }
    if (a.trivially_passing!.choice !== "no") gaps.push("The test could pass without the work being done.");
    const confidence = this.minConfidence(a);
    const result = this.independent(this.decide(gaps, confidence, `the test for ${input.task}`), input.author, called.model);
    const summary = result.verdict === "approve" ? `Jev approves the test for ${input.task}` : result.verdict === "reject" ? `Jev found ${gaps.length} gap(s) in the test for ${input.task}` : `Test for ${input.task} goes to the main chat: ${result.reason.startsWith("Not independent") ? "Jev cannot review it independently" : "Jev is unsure"}`;
    const entry = this.record(input.task, "test", result, { definition: input.definition, called, refs, summary });
    this.warnIfNeeded();
    return { ...result, entry: entry.n };
  }

  // ---------- job 2: diff review, before merge (§6.3) ----------

  async reviewDiff(input: DiffReviewInput): Promise<ReviewResult> {
    const refs = input.clauses.map((c) => c.ref);
    const data = input.attempt ? { attempt: input.attempt } : {};
    const notIndependent = independenceProblem(input.author, this.settings.model);
    if (notIndependent) {
      const result: ReviewResult = { verdict: "escalate", notes: [], reason: `Not independent: ${notIndependent} (§6.4)`, confidence: null };
      return { ...result, entry: this.record(input.task, "diff", result, { called: null, refs, summary: `Diff for ${input.task} goes to the main chat: Jev cannot review it independently`, data: { ...data, builtBy: input.author ?? null } }).n };
    }
    const files = parseDiff(input.diff);
    const notes = checkDiff(files, input.allowedFiles);
    if (notes.length) {
      const result: ReviewResult = { verdict: "reject", notes, reason: `Fixed checks failed: ${[...new Set(notes.map((n) => n.rule))].join(", ")}`, confidence: null };
      return { ...result, entry: this.record(input.task, "diff", result, { called: null, refs, summary: `Diff for ${input.task} rejected: ${notes.length} line note(s)`, data }).n };
    }

    const request: JevRequest = {
      model: this.settings.model,
      state: {
        task: { id: input.task },
        clauses: input.clauses.map((c) => ({ ref: c.ref, text: cut(c.text, 2000) })),
        files: files.map((f) => f.path),
        allowed_files: input.allowedFiles,
        diff: cut(input.diff, MAX_DIFF),
        test_output: cut(input.testOutput, MAX_TEXT),
      },
      questions: {
        covers_clauses: {
          type: "choice",
          instructions: "Read `clauses`, `diff` and `test_output`. Does the change implement every cited clause?",
          criteria: { all: "Every cited clause is implemented", some: "Some cited clauses are missing or partial", none: "The change does not implement the cited clauses" },
        },
        weakens_tests: {
          type: "choice",
          instructions: "Does the change remove, loosen or bypass any test or check (deleted assertions, wider tolerances, skipped cases, special-casing test input)?",
          criteria: { no: "No test or check is weakened", yes: "A test or check is weakened" },
        },
        stays_in_scope: {
          type: "choice",
          instructions: "Does the change stay inside the task, without unrelated edits or new behaviour nobody asked for?",
          criteria: { yes: "Only what the task needs", no: "Contains unrelated or unrequested changes" },
        },
      },
    };
    const called = await this.callOrQueue(`Diff review for ${input.task}`, () => this.reviewDiff(input), request);
    if (called === "queued") return { verdict: "queued", notes: [], reason: "Jev's monthly limit is reached; the review waits in the queue (§6.7)", confidence: null };
    if (!called.ok) {
      const result: ReviewResult = { verdict: "unavailable", notes: [], reason: called.detail, confidence: null };
      return { ...result, entry: this.record(input.task, "diff", result, { called, refs, summary: `Diff review for ${input.task} could not run`, data }).n };
    }

    const a = called.answers;
    const gaps: string[] = [];
    if (a.covers_clauses!.choice !== "all") gaps.push(`Not every cited clause is implemented${a.covers_clauses!.reason ? `: ${a.covers_clauses!.reason}` : "."}`);
    if (a.weakens_tests!.choice !== "no") gaps.push(`A test or check is weakened${a.weakens_tests!.reason ? `: ${a.weakens_tests!.reason}` : "."}`);
    if (a.stays_in_scope!.choice !== "yes") gaps.push(`The change goes beyond the task${a.stays_in_scope!.reason ? `: ${a.stays_in_scope!.reason}` : "."}`);
    const confidence = this.minConfidence(a);
    const result = this.independent(this.decide(gaps, confidence, `the diff for ${input.task}`), input.author, called.model);
    const summary = result.verdict === "approve" ? `Jev approves the diff for ${input.task}` : result.verdict === "reject" ? `Jev rejects the diff for ${input.task}` : `Diff for ${input.task} goes to the main chat: ${result.reason.startsWith("Not independent") ? "Jev cannot review it independently" : "Jev is unsure"}`;
    const entry = this.record(input.task, "diff", result, { called, refs, summary, data });
    this.warnIfNeeded();
    return { ...result, entry: entry.n };
  }

  /** Jev reports the model it actually ran; an approval from the builder's own model becomes an escalation. */
  private independent(result: ReviewResult, author: Actor, ranAs: string): ReviewResult {
    if (result.verdict !== "approve") return result;
    const problem = independenceProblem(author, ranAs);
    return problem ? { ...result, verdict: "escalate", reason: `Not independent: ${problem} (§6.4)` } : result;
  }

  /** The fixed verdict rules of REVIEW_POLICY. */
  private decide(gaps: string[], confidence: number | null, what: string): ReviewResult {
    const { approveConfidence, escalateBelow } = this.settings;
    if (confidence === null || confidence < escalateBelow) {
      return { verdict: "escalate", notes: gaps, reason: `Jev's confidence on ${what} is ${confidence === null ? "unknown" : confidence.toFixed(2)}, too low to act on (§6.9)`, confidence };
    }
    if (gaps.length) return { verdict: "reject", notes: gaps, reason: gaps.join(" "), confidence };
    if (confidence < approveConfidence) {
      return { verdict: "escalate", notes: [], reason: `Jev found no gaps in ${what} but its confidence (${confidence.toFixed(2)}) is below ${approveConfidence}`, confidence };
    }
    return { verdict: "approve", notes: [], reason: `No gaps found in ${what}, confidence ${confidence.toFixed(2)}`, confidence };
  }

  // ---------- relay helper: questions the plan already settles ----------

  /** Context for settled answers: the approved plan's clauses. Set by the app. */
  planClauses: () => { ref: string; text: string }[] = () => [];

  /** SettledAnswerer: answers only multiple-choice questions, and only when Jev is confident the plan decides them. */
  async tryAnswer(question: Question): Promise<SettledAnswer | null> {
    const clauses = this.planClauses();
    if (question.options.length < 2 || clauses.length === 0 || this.overCap()) return null;
    const criteria: Record<string, string> = { not_settled: "The plan does not decide this; a person must answer" };
    question.options.forEach((option, i) => (criteria[`option_${i + 1}`] = option));
    const called = await this.transport({
      model: this.settings.model,
      state: { plan: clauses.map((c) => ({ ref: c.ref, text: cut(c.text, 2000) })).slice(0, 200), question: question.question, task: question.task },
      questions: {
        settled: {
          type: "choice",
          instructions: "Does the plan explicitly decide this question? Pick the option the plan requires, or not_settled if the plan is silent, ambiguous or would need a judgement call.",
          criteria,
        },
      },
    });
    if (!called.ok) return null;
    const answer = called.answers.settled!;
    const index = /^option_(\d+)$/.exec(answer.choice)?.[1];
    const chosen = index ? question.options[Number(index) - 1] : undefined;
    const confident = answer.confidence !== null && answer.confidence >= this.settings.approveConfidence;
    const result: ReviewResult = chosen && confident
      ? { verdict: "approve", notes: [], reason: `The plan settles ${question.q}: ${chosen}`, confidence: answer.confidence }
      : { verdict: "escalate", notes: [], reason: `The plan does not clearly settle ${question.q}; it goes to the main chat`, confidence: answer.confidence };
    this.record(question.task, "question", result, { called, refs: [question.q], summary: chosen && confident ? `Jev: the plan settles ${question.q}` : `Jev: ${question.q} needs the main chat` });
    this.warnIfNeeded();
    if (!chosen || !confident) return null;
    return { answer: chosen, reason: `The approved plan settles this (Jev, confidence ${answer.confidence!.toFixed(2)})`, refs: [], actor: { kind: "jev", id: "jev", model: called.model } };
  }
}
