// Planning state is a view of the ledger: replaying question.asked,
// decision.made, question.answered and spike task.created entries rebuilds it.
// Nothing here keeps state of its own. A planning question counts as
// answered only by an entry a person wrote (isAuthoritative, personOnly);
// an agent's or Jev's answer is information, never the user's decision.
import { isAuthoritative, type LedgerEntry } from "../ledger/index";
import type { Area, PlanningAnswer, QuestionOption, Recommendation } from "./types";

/** The `data.planning` payload on a question.asked written by deep planning. */
export interface PlanningMeta {
  id: string;
  area: Area;
  options: QuestionOption[];
  recommendation: Recommendation;
}

export interface PlanningQuestionState {
  q: string;
  id: string;
  area: Area;
  text: string;
  blocking: boolean;
  options: QuestionOption[];
  recommendation: Recommendation;
  status: "open" | "decided" | "spiked";
  answer?: string;
  choice?: string;
  decision?: string;
  spike?: { task: string; due: string; risk: string };
}

export interface AnyQuestionState {
  q: string;
  blocking: boolean;
  open: boolean;
  /** Set when deep planning asked it. */
  planning?: PlanningMeta;
}

export function planningMeta(entry: LedgerEntry | undefined): PlanningMeta | undefined {
  const meta = entry?.type === "question.asked" ? entry.data?.planning : undefined;
  if (!meta || typeof meta !== "object") return undefined;
  const m = meta as Partial<PlanningMeta>;
  return typeof m.id === "string" && typeof m.area === "string" ? (m as PlanningMeta) : undefined;
}

/** Every question in the ledger, planning or relay, with whether it is still open. */
export function allQuestions(entries: readonly LedgerEntry[]): Map<string, AnyQuestionState> {
  const questions = new Map<string, AnyQuestionState>();
  for (const e of entries) {
    if (e.type === "question.asked") {
      questions.set(e.subject, { q: e.subject, blocking: e.data?.blocking === true, open: true, planning: planningMeta(e) });
    } else if (e.type === "question.answered") {
      const q = questions.get(e.subject);
      if (q && (!q.planning || isAuthoritative(e, { personOnly: true }))) q.open = false;
    }
  }
  return questions;
}

/** Deep planning questions, in the order they were asked. */
export function planningQuestions(entries: readonly LedgerEntry[]): PlanningQuestionState[] {
  const byQ = new Map<string, PlanningQuestionState>();
  for (const e of entries) {
    const d = e.data ?? {};
    if (e.type === "question.asked") {
      const meta = planningMeta(e);
      if (!meta) continue;
      byQ.set(e.subject, {
        q: e.subject,
        id: meta.id,
        area: meta.area,
        text: String(d.question ?? e.summary),
        blocking: d.blocking === true,
        options: meta.options ?? [],
        recommendation: meta.recommendation,
        status: "open",
      });
    } else if (e.type === "decision.made" && typeof d.question === "string") {
      const q = byQ.get(d.question);
      if (!q || q.status !== "open" || !isAuthoritative(e, { personOnly: true })) continue;
      q.decision = e.subject;
      q.answer = String(d.answer ?? e.summary);
      if (typeof d.choice === "string") q.choice = d.choice;
    } else if (e.type === "question.answered") {
      const q = byQ.get(e.subject);
      if (!q || q.status !== "open" || !isAuthoritative(e, { personOnly: true })) continue;
      q.answer = String(d.answer ?? e.summary);
      const spike = d.spike as PlanningQuestionState["spike"] | undefined;
      if (d.via === "spike" && spike) {
        q.status = "spiked";
        q.spike = { task: String(spike.task), due: String(spike.due), risk: String(spike.risk) };
      } else {
        q.status = "decided";
        if (typeof d.decision === "string") q.decision = d.decision;
      }
    }
  }
  return [...byQ.values()];
}

/** The latest question for each planning id (a re-asked question replaces the older one). */
export function latestByQuestionId(entries: readonly LedgerEntry[]): Map<string, PlanningQuestionState> {
  const latest = new Map<string, PlanningQuestionState>();
  for (const q of planningQuestions(entries)) latest.set(q.id, q);
  return latest;
}

/**
 * Blocking questions still open. With scope "planning" (default) only deep
 * planning questions count; "all" includes every blocking relay question too.
 */
export function openBlockers(entries: readonly LedgerEntry[], scope: "planning" | "all" = "planning"): string[] {
  return [...allQuestions(entries).values()]
    .filter((q) => q.open && q.blocking && (scope === "all" || q.planning))
    .map((q) => q.q);
}

/** Settled answers, the input to the mind map. */
export function planningAnswers(entries: readonly LedgerEntry[]): PlanningAnswer[] {
  return [...latestByQuestionId(entries).values()]
    .filter((q) => q.status !== "open")
    .map((q) => ({
      questionId: q.id,
      area: q.area,
      q: q.q,
      choice: q.choice ?? "custom",
      text: q.answer ?? "",
      ...(q.decision ? { decision: q.decision } : {}),
      ...(q.spike ? { spike: q.spike } : {}),
    }));
}
