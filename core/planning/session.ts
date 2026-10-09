// The planning session: asks the hard questions through the ledger, takes
// answers (one tap on a recommendation, a pick, or free text), turns
// deferrals into dated spike tasks, and hands the settled answers to the
// mind map and roadmap. Questions are ordinary question.asked entries, so
// they show up in the one-chat relay's inbox next to workers' questions.
import type { Actor, Ledger, LedgerEntry } from "../ledger/index";
import { appendNumbered } from "../numbering/index";
import { catchDeferral, findDeferrals, spikeProblem, type SpikePlan } from "./catcher";
import { buildMindMap } from "./mindmap";
import {
  FINAL_TASK_KEY,
  OWN_TASK_SOURCE,
  buildRoadmap,
  droppedRoadmapTasks,
  ownTasks,
  roadmapTasks,
  withoutTasks,
  writeRoadmap,
  type OwnTask,
} from "./roadmap";
import { depthCheck, type DepthFinding } from "./depth";
import { findQuestion, questionsFor } from "./packs";
import type { RepoFact } from "./repo";
import { researchQuestion, type ResearchedQuestion, type ResearchProvider } from "./research";
import { latestByQuestionId, openBlockers, planningAnswers, planningQuestions, type PlanningQuestionState } from "./state";
import type { IdeaProfile, MindMap, PhaseId, PlanningQuestion, Roadmap } from "./types";

/** Subject used in refs and in data.task for questions about the plan itself. */
export const PLAN_TASK = "plan";

/** A task the person adds to the plan by hand. */
export interface OwnTaskInput {
  title: string;
  /** What proves it is done, in the person's words. */
  doneWhen?: string;
  /** Clauses or other numbers it belongs to ("C-3"); they become the entry's refs. */
  refs?: string[];
  /** Roadmap phase; "core" when left out. */
  phase?: PhaseId;
}

export class PlanningError extends Error {
  constructor(
    readonly code:
      | "DEFERRED"
      | "PERSON_ONLY"
      | "BAD_SPIKE"
      | "UNKNOWN_QUESTION"
      | "ALREADY_ANSWERED"
      | "BAD_CHOICE"
      | "EMPTY"
      | "STILL_OPEN"
      | "UNKNOWN_TASK"
      | "ROADMAP_WRITTEN"
      | "KEEP_RELEASE",
    message: string,
  ) {
    super(message);
    this.name = "PlanningError";
  }
}

export interface AnswerInput {
  /** An option id from the question. */
  choice?: string;
  /** Free text, or extra detail on top of a choice. */
  text?: string;
  reason?: string;
  /** Files or URLs that back the answer, recorded on the decision. */
  evidence?: string[];
  /** "repo" when the answer was read from the existing code, "description" when the person's own description settled it. */
  source?: "repo" | "description";
  /** For a description answer: the person's words that settled it. */
  phrase?: string;
  /** Turn a deferral into a dated spike task instead of a decision. */
  spike?: SpikePlan;
}

export type AnswerResult =
  | { q: string; status: "decided"; decision: string; answer: string }
  | { q: string; status: "spiked"; task: string; due: string; answer: string };

export interface PlanningSessionOptions {
  /** Whose main chat the questions land in (the relay's `person`). */
  person: string;
  /** Clock for spike dates; tests pin it. */
  now?: () => Date;
}

export class PlanningSession {
  private readonly person: string;
  private readonly now: () => Date;

  constructor(
    private readonly ledger: Ledger,
    options: PlanningSessionOptions,
  ) {
    this.person = options.person;
    this.now = options.now ?? (() => new Date());
  }

  get entries(): readonly LedgerEntry[] {
    return this.ledger.entries();
  }

  /** Asks every question the packs pick for this idea that is not already asked and open. Returns the Q numbers. */
  start(actor: Actor, profile: IdeaProfile): string[] {
    return questionsFor(profile).map((question) => this.ask(actor, question));
  }

  /**
   * Live research first: runs every comparison question through the provider
   * in parallel, attaches the sources to its recommendation, then asks. A
   * failed lookup never blocks planning; that question is asked without sources.
   */
  async startWithResearch(actor: Actor, profile: IdeaProfile, provider: ResearchProvider, signal?: AbortSignal): Promise<{ asked: string[]; researched: number; failed: string[] }> {
    const results = await Promise.all(
      questionsFor(profile).map((question) => (question.research ? researchQuestion(provider, question, profile, signal) : Promise.resolve<ResearchedQuestion>({ question, result: null }))),
    );
    const failed = results.filter((r) => r.error).map((r) => r.question.id);
    return {
      asked: results.map((r) => this.ask(actor, r.question)),
      researched: results.filter((r) => r.result).length,
      failed,
    };
  }

  /**
   * Records what an existing repo already decided (see readRepoStack) as
   * answered questions, each with the files that show it, so the mind map and
   * roadmap build on the real stack. Only a person answers planning
   * questions, so `actor` is the person confirming what the repo shows. Call
   * before start(); a question already answered is left alone. Returns the
   * decision numbers.
   */
  recordRepoFacts(actor: Actor, profile: IdeaProfile, facts: readonly RepoFact[]): string[] {
    const decided: string[] = [];
    for (const fact of facts) {
      const question = findQuestion(profile, fact.id);
      if (!question || this.questions().some((x) => x.id === fact.id && x.status !== "open")) continue;
      const q = this.ask(actor, question);
      if (this.questions().find((x) => x.q === q)?.status !== "open") continue;
      const label = fact.choice ? question.options.find((o) => o.id === fact.choice)?.label : undefined;
      const result = this.answer(actor, q, {
        ...(label ? { choice: fact.choice } : {}),
        // "TypeScript everywhere" already says "TypeScript"; add the repo's words only when they say more.
        ...(!label || !label.toLowerCase().includes(fact.text.toLowerCase()) ? { text: fact.text } : {}),
        reason: `Found in the repo: ${fact.evidence.join(", ")}`,
        source: "repo",
        evidence: fact.evidence,
      });
      if (result.status === "decided") decided.push(result.decision);
    }
    return decided;
  }

  /**
   * Records what the person's own description settles (profile.described,
   * from readDescription) as their answers, each with the words that settled
   * it: "No accounts" answers "Who signs in?" with "No sign-in". The
   * description is the person's, so `actor` must be the person. Questions
   * already answered (or settled and then reopened) are left alone. Call
   * after start(), which skips them. Returns the decision numbers.
   */
  recordDescriptionFacts(actor: Actor, profile: IdeaProfile): string[] {
    if (actor.kind !== "person") throw new PlanningError("PERSON_ONLY", `What the description settles is for the person to record, not ${actor.kind} ${actor.id}.`);
    const decided: string[] = [];
    for (const fact of profile.described ?? []) {
      const question = findQuestion(profile, fact.id);
      if (!question || this.questions().some((x) => x.id === fact.id && x.status !== "open")) continue;
      const q = this.ask(actor, question);
      if (this.questions().find((x) => x.q === q)?.status !== "open") continue;
      const label = fact.choice ? question.options.find((o) => o.id === fact.choice)?.label : undefined;
      const text = fact.text ?? (label ? undefined : fact.phrase);
      const result = this.answer(actor, q, {
        ...(label ? { choice: fact.choice } : {}),
        ...(text ? { text } : {}),
        reason: `From your description: "${fact.phrase}"`,
        source: "description",
        phrase: fact.phrase,
      });
      if (result.status === "decided") decided.push(result.decision);
    }
    return decided;
  }

  /**
   * Asks a settled question again, so the person can answer it themselves
   * (for example one their description settled). The new question replaces
   * the old one in the mind map, roadmap and approval gate. Returns its Q number.
   */
  reopen(actor: Actor, q: string): string {
    const question = this.questions().find((x) => x.q === q);
    if (!question) throw new PlanningError("UNKNOWN_QUESTION", `${q} is not a planning question.`);
    if (question.status === "open") throw new PlanningError("STILL_OPEN", `${q} is still open; answer it instead.`);
    const latest = latestByQuestionId(this.entries).get(question.id);
    if (latest && latest.q !== q) throw new PlanningError("STILL_OPEN", `${q} was already asked again as ${latest.q}.`);
    const asked = this.entries.find((e) => e.type === "question.asked" && e.subject === q)!;
    const entry = appendNumbered(this.ledger, {
      actor,
      type: "question.asked",
      summary: asked.summary,
      refs: [PLAN_TASK, q],
      data: { ...asked.data, reopens: q },
    });
    return entry.subject;
  }

  // ---------- The person's own roadmap changes ----------

  /** Adds the person's own task to the plan: a person-signed task.created with the next T- number. */
  addTask(actor: Actor, input: OwnTaskInput): { task: string; entry: string } {
    if (actor.kind !== "person") throw new PlanningError("PERSON_ONLY", `Only the person adds their own tasks, not ${actor.kind} ${actor.id}.`);
    const title = oneLine(String(input.title ?? ""));
    if (!title) throw new PlanningError("EMPTY", "A task needs a title.");
    const doneWhen = String(input.doneWhen ?? "").trim();
    const refs = [...new Set((input.refs ?? []).map((r) => String(r).trim()).filter(Boolean))];
    const entry = appendNumbered(this.ledger, {
      actor,
      type: "task.created",
      summary: title,
      refs,
      data: {
        title,
        change: "feature",
        phase: input.phase ?? "core",
        owner: this.person,
        ...(doneWhen ? { doneWhen } : {}),
        source: OWN_TASK_SOURCE,
      },
    });
    return { task: entry.subject, entry: entry.n };
  }

  ownTasks(): OwnTask[] {
    return ownTasks(this.entries);
  }

  droppedRoadmapKeys(): string[] {
    return [...droppedRoadmapTasks(this.entries).keys()];
  }

  /**
   * Leaves a draft roadmap task out, as the person's decision (D-n). Only
   * before the roadmap is written; the release task always stays.
   */
  dropRoadmapTask(actor: Actor, key: string, reason?: string, idea = "Your idea"): string {
    if (actor.kind !== "person") throw new PlanningError("PERSON_ONLY", `Only the person changes the roadmap, not ${actor.kind} ${actor.id}.`);
    this.refuseWrittenRoadmap();
    if (key === FINAL_TASK_KEY) throw new PlanningError("KEEP_RELEASE", "The release task closes every roadmap and cannot be left out.");
    const task = roadmapTasks(buildRoadmap(this.mindMap(idea))).find((t) => t.key === key);
    if (!task) throw new PlanningError("UNKNOWN_TASK", `${key} is not a task in the draft roadmap.`);
    if (droppedRoadmapTasks(this.entries).has(key)) return droppedRoadmapTasks(this.entries).get(key)!.decision;
    return appendNumbered(this.ledger, {
      actor,
      type: "decision.made",
      summary: oneLine(`Leave "${task.title}" out of the roadmap`),
      reason: reason?.trim() || "The person does not want this task in the plan.",
      refs: [PLAN_TASK],
      data: { roadmap: { drop: key, title: task.title } },
    }).subject;
  }

  /** Puts a dropped draft roadmap task back. */
  restoreRoadmapTask(actor: Actor, key: string): string {
    if (actor.kind !== "person") throw new PlanningError("PERSON_ONLY", `Only the person changes the roadmap, not ${actor.kind} ${actor.id}.`);
    this.refuseWrittenRoadmap();
    const dropped = droppedRoadmapTasks(this.entries).get(key);
    if (!dropped) throw new PlanningError("UNKNOWN_TASK", `${key} was not left out of the roadmap.`);
    return appendNumbered(this.ledger, {
      actor,
      type: "decision.made",
      summary: oneLine(`Put "${dropped.title}" back in the roadmap`),
      reason: "The person wants this task in the plan after all.",
      refs: [PLAN_TASK, dropped.decision],
      data: { roadmap: { restore: key, title: dropped.title } },
    }).subject;
  }

  private refuseWrittenRoadmap(): void {
    if (this.entries.some((e) => e.type === "task.created" && e.data?.source === "planning" && typeof e.data.key === "string")) {
      throw new PlanningError("ROADMAP_WRITTEN", "The roadmap was already added to the board when the plan was approved; change the tasks there instead.");
    }
  }

  /** Asks one question; an identical open question is not asked twice. */
  ask(actor: Actor, question: PlanningQuestion): string {
    const existing = latestByQuestionId(this.entries).get(question.id);
    if (existing && existing.status === "open") return existing.q;
    const entry = appendNumbered(this.ledger, {
      actor,
      type: "question.asked",
      summary: oneLine(question.text),
      refs: [PLAN_TASK],
      data: {
        task: PLAN_TASK,
        person: this.person,
        question: question.text,
        options: question.options.map((o) => o.label),
        blocking: question.blocking,
        planning: { id: question.id, area: question.area, options: question.options, recommendation: question.recommendation, why: question.why },
      },
    });
    return entry.subject;
  }

  /**
   * Catches every deferral in a plan or note ("auth: TBD") and asks it as a
   * blocking question, so it must become a decision or a spike before approval.
   */
  catchText(actor: Actor, text: string, source = "plan"): string[] {
    return findDeferrals(text).map((hit) =>
      this.ask(actor, {
        id: `deferral.${slug(source)}-${hit.line}`,
        area: "stack",
        text: `${source} line ${hit.line} puts a decision off: "${hit.text}". What is the decision?`,
        why: `It says ${hit.matches.join(", ")}. Deferred decisions come back as rework.`,
        blocking: true,
        options: [],
        recommendation: { option: "", reason: "Decide now, or set a dated spike with its risk.", confidence: 0 },
      }),
    );
  }

  questions(): PlanningQuestionState[] {
    return planningQuestions(this.entries);
  }

  open(): PlanningQuestionState[] {
    return this.questions().filter((q) => q.status === "open");
  }

  blockers(): string[] {
    return openBlockers(this.entries);
  }

  answer(actor: Actor, q: string, input: AnswerInput): AnswerResult {
    // The hard questions are the user's. installPlanningRules enforces the same on every writer.
    if (actor.kind !== "person") throw new PlanningError("PERSON_ONLY", `${q} is for a person to answer, not ${actor.kind} ${actor.id}.`);
    const question = this.questions().find((x) => x.q === q);
    if (!question) throw new PlanningError("UNKNOWN_QUESTION", `${q} is not a planning question.`);
    if (question.status !== "open") throw new PlanningError("ALREADY_ANSWERED", `${q} was already answered: ${question.answer}`);

    let choice = "custom";
    let answer = String(input.text ?? "").trim();
    if (input.choice !== undefined) {
      const option = question.options.find((o) => o.id === input.choice);
      if (!option) throw new PlanningError("BAD_CHOICE", `${input.choice} is not an option for ${q}.`);
      choice = option.id;
      answer = answer ? `${option.label}: ${answer}` : option.label;
    }

    if (input.spike) return this.spike(actor, question, answer, input.spike);
    if (!answer) throw new PlanningError("EMPTY", `${q} needs an answer.`);
    const check = catchDeferral(answer);
    if (check.deferred) {
      throw new PlanningError(
        "DEFERRED",
        `"${answer}" puts ${q} off (${check.matches.join(", ")}). Make a decision, or pass a spike with a due date and the risk.`,
      );
    }

    const reason =
      input.reason?.trim() ||
      (choice === question.recommendation.option && question.recommendation.reason
        ? `Recommended: ${question.recommendation.reason}`
        : `Answer to ${q} (${question.id})`);
    const decision = appendNumbered(this.ledger, {
      actor,
      type: "decision.made",
      summary: oneLine(answer),
      reason,
      refs: [q, PLAN_TASK],
      evidence: [...(input.evidence ?? []), ...(question.recommendation.sources ?? []).map((s) => s.url)],
      data: { question: q, questionText: question.text, answer, choice, planning: { id: question.id, area: question.area }, ...(input.source ? { source: input.source } : {}), ...(input.phrase ? { phrase: input.phrase } : {}) },
    });
    this.ledger.append({
      actor,
      type: "question.answered",
      subject: q,
      summary: oneLine(answer),
      refs: [decision.subject, PLAN_TASK],
      data: { answer, decision: decision.subject, via: "main" },
    });
    return { q, status: "decided", decision: decision.subject, answer };
  }

  /** One tap: takes every open recommendation at or above the confidence bar. Returns what it decided. */
  acceptRecommendations(actor: Actor, minConfidence = 0.75): AnswerResult[] {
    return this.open()
      .filter((q) => q.recommendation.option && q.recommendation.confidence >= minConfidence)
      .map((q) => this.answer(actor, q.q, { choice: q.recommendation.option }));
  }

  private spike(actor: Actor, question: PlanningQuestionState, answer: string, spike: SpikePlan): AnswerResult {
    const problem = spikeProblem(spike, this.now());
    if (problem) throw new PlanningError("BAD_SPIKE", `${question.q}: ${problem}.`);
    const owner = spike.owner?.trim() || this.person;
    const task = appendNumbered(this.ledger, {
      actor,
      type: "task.created",
      summary: oneLine(`Spike: decide ${question.id} by ${spike.due}`),
      refs: [question.q],
      data: {
        change: "fix",
        phase: "foundation",
        owner,
        doneWhen: `A decision for ${question.q} is recorded in the ledger`,
        spike: { question: question.q, due: spike.due, risk: spike.risk.trim(), owner },
        source: "planning",
      },
    });
    const text = answer && !catchDeferral(answer).deferred ? answer : `Spike ${task.subject} due ${spike.due}`;
    this.ledger.append({
      actor,
      type: "question.answered",
      subject: question.q,
      summary: oneLine(text),
      refs: [task.subject, PLAN_TASK],
      data: { answer: text, via: "spike", spike: { task: task.subject, due: spike.due, risk: spike.risk.trim() } },
    });
    return { q: question.q, status: "spiked", task: task.subject, due: spike.due, answer: text };
  }

  mindMap(idea: string): MindMap {
    return buildMindMap(idea, planningAnswers(this.entries));
  }

  depth(idea: string): DepthFinding[] {
    return depthCheck(this.mindMap(idea), planningAnswers(this.entries));
  }

  /** The draft roadmap, without the tasks the person left out. */
  roadmap(idea: string, owner?: string): Roadmap {
    return withoutTasks(buildRoadmap(this.mindMap(idea), owner ? { owner } : {}), this.droppedRoadmapKeys());
  }

  /** Writes the roadmap's tasks; refused while blockers are open, since tasks built on open questions get rebuilt. */
  writeRoadmap(actor: Actor, roadmap: Roadmap): Record<string, string> {
    const open = this.blockers();
    if (open.length) throw new PlanningError("DEFERRED", `Answer the blocking questions first: ${open.join(", ")}.`);
    return writeRoadmap(this.ledger, actor, roadmap);
  }
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 140 ? `${line.slice(0, 137)}...` : line;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "text";
}
