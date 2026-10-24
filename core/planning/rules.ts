// Ledger rules for deep planning. They hold whoever writes: the planning
// session, the relay's answer(), the MCP tools or a person in the app.
//   1. Blockers gate approval: plan.approved is refused while a blocking
//      planning question is open.
//   2. No silent deferral: a decision or answer to a planning question that
//      says "TBD", "later" and the like is refused unless it is a spike.
//   3. The hard questions are the user's: only a person actor answers a
//      planning question. The actor is the entry's own, never a payload field.
//   4. A spike is a real task: it names a task.created that carries a due
//      date within MAX_SPIKE_DAYS and a written risk.
//   5. Contracts: a task planning writes carries a valid contract whose digest
//      matches, and only a person can widen a task's contract (see contract.ts).
import type { EntryDraft, Ledger, LedgerEntry } from "../ledger/index";
import { catchDeferral, spikeProblem, type SpikePlan } from "./catcher";
import { contractWriteRefusal } from "./contract";
import { allQuestions, openBlockers } from "./state";

export interface PlanningRuleOptions {
  /** Which blocking questions gate approval: deep planning only (default), or every blocking question. */
  scope?: "planning" | "all";
  /** Clock for the spike due-date check; tests pin it. */
  now?: () => Date;
}

export function installPlanningRules(ledger: Ledger, options: PlanningRuleOptions = {}): () => void {
  return ledger.addRule((draft, current) => planningRefusal(draft, current.entries(), options));
}

export function planningRefusal(draft: EntryDraft, entries: readonly LedgerEntry[], options: PlanningRuleOptions = {}): string | null {
  const now = options.now ?? (() => new Date());
  const data = draft.data ?? {};

  const contract = contractWriteRefusal(draft, entries);
  if (contract) return contract;

  if (draft.type === "plan.approved") {
    const open = openBlockers(entries, options.scope ?? "planning");
    if (open.length) {
      return `the plan cannot be approved while ${open.length === 1 ? "a blocking question is" : `${open.length} blocking questions are`} open: ${open.join(", ")}`;
    }
    return null;
  }

  if (draft.type === "task.created" && data.spike !== undefined) {
    const problem = spikeProblem(data.spike as SpikePlan, now());
    return problem ? `spike task refused: ${problem}` : null;
  }

  if (draft.type === "decision.made" && typeof data.question === "string") {
    if (!isPlanningQuestion(entries, data.question)) return null;
    if (draft.actor?.kind !== "person") return personOnlyMessage(data.question, draft.actor?.kind);
    const text = String(data.answer ?? draft.summary);
    const check = catchDeferral(text);
    if (check.deferred) return deferralMessage(data.question, check.matches);
    return null;
  }

  if (draft.type === "question.answered") {
    if (!isPlanningQuestion(entries, draft.subject)) return null;
    const question = allQuestions(entries).get(draft.subject);
    if (question && !question.open) return `${draft.subject} is already answered`;
    if (draft.actor?.kind !== "person") return personOnlyMessage(draft.subject, draft.actor?.kind);
    if (data.via === "spike") {
      const spike = data.spike as { task?: unknown } | undefined;
      const task = typeof spike?.task === "string" ? spike.task : "";
      const created = entries.find((e) => e.type === "task.created" && e.subject === task);
      if (!created || created.data?.spike === undefined) return `${draft.subject} is deferred to "${task}", which is not a spike task in the ledger`;
      return null;
    }
    const text = String(data.answer ?? draft.summary);
    const check = catchDeferral(text);
    if (check.deferred) return deferralMessage(draft.subject, check.matches);
  }
  return null;
}

function isPlanningQuestion(entries: readonly LedgerEntry[], q: string): boolean {
  return allQuestions(entries).get(q)?.planning !== undefined;
}

function personOnlyMessage(q: string, kind: string | undefined): string {
  return `${q} is a planning question for the person to answer, not ${kind ? `an actor of kind "${kind}"` : "an unknown actor"}`;
}

function deferralMessage(q: string, matches: string[]): string {
  return `${q} cannot be answered with a deferral (${matches.join(", ")}); make a decision, or a dated spike task with its risk written down`;
}
