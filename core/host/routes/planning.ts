// Deep planning routes: drive a PlanningSession for the project. The session
// keeps no state of its own (it replays from the ledger); project.state holds
// it with the idea text, and the idea is also saved next to the ledger so a
// restart can redraw the mind map with the same root.
import fs from "node:fs";
import path from "node:path";
import type { Actor, LedgerEntry } from "../../ledger/index";
import { appendNumbered } from "../../numbering/index";
import {
  AREAS,
  AREA_TITLES,
  PlanningError,
  PlanningSession,
  catchDeferral,
  depthCheck,
  droppedRoadmapTasks,
  isPhase,
  latestByQuestionId,
  openBlockers,
  ownTasks,
  planningAnswers,
  profileIdea,
  toMermaid,
  type AnswerInput,
  type IdeaProfile,
  type PlanningQuestionState,
} from "../../planning/index";
import type { CoreProject } from "../project";
import { HttpError, type Router } from "../router";
import { localPerson, localPersonId } from "./people";

const STATE_KEY = "planning";
const IDEA_FILE = "planning-idea.json";
/** Who asks the packs' questions: the built-in, offline question packs (no live research, no model). */
const ASKER: Actor = { kind: "system", id: "deep-planning" };
const RESEARCH_NOTE =
  "Recommendations come from Perfect Planner's built-in question packs, read from your idea. Live web research is off: it needs a research key (Perplexity Sonar or Firecrawl), so no sources are attached yet.";

interface PlanningState {
  session: PlanningSession;
  person: string;
  idea: string | null;
  profile: IdeaProfile | null;
}

function ideaPath(project: CoreProject): string {
  return path.join(project.root, ".perfect-planner", IDEA_FILE);
}

function readIdea(project: CoreProject): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(ideaPath(project), "utf8")) as { idea?: unknown };
    return typeof parsed.idea === "string" && parsed.idea.trim() ? parsed.idea : null;
  } catch {
    return null;
  }
}

function saveIdea(project: CoreProject, idea: string): void {
  try {
    fs.mkdirSync(path.dirname(ideaPath(project)), { recursive: true });
    fs.writeFileSync(ideaPath(project), JSON.stringify({ idea, at: new Date().toISOString() }, null, 2));
  } catch {
    // The idea also lives in project.state; losing the file only loses the mind map's root label after a restart.
  }
}

function planning(project: CoreProject): PlanningState {
  const person = localPersonId(project);
  let state = project.state.get(STATE_KEY) as PlanningState | undefined;
  if (!state || state.person !== person) {
    const idea = state?.idea ?? readIdea(project);
    state = { session: new PlanningSession(project.ledger, { person }), person, idea, profile: idea ? profileIdea(idea) : null };
    project.state.set(STATE_KEY, state);
  }
  return state;
}

function actorFor(project: CoreProject): Actor {
  return localPerson(project);
}

/** The idea label used for the mind map root: the saved idea, or a neutral title. */
function ideaLabel(state: PlanningState): string {
  return state.idea ?? "Your idea";
}

function refuse(error: unknown): never {
  if (error instanceof PlanningError) {
    const status =
      error.code === "UNKNOWN_QUESTION" || error.code === "UNKNOWN_TASK"
        ? 404
        : error.code === "ALREADY_ANSWERED" || error.code === "STILL_OPEN" || error.code === "ROADMAP_WRITTEN" || error.code === "KEEP_RELEASE"
          ? 409
          : 422;
    throw new HttpError(status, error.code, error.message);
  }
  throw error;
}

/** Ledger entry numbers (L-...) that touch a question: when it was asked, decided and closed. */
function entryNumbers(entries: readonly LedgerEntry[]): Map<string, { asked?: string; decided?: string; answered?: string; spike?: string }> {
  const out = new Map<string, { asked?: string; decided?: string; answered?: string; spike?: string }>();
  const at = (q: string) => {
    let v = out.get(q);
    if (!v) out.set(q, (v = {}));
    return v;
  };
  for (const e of entries) {
    if (e.type === "question.asked") at(e.subject).asked = e.n;
    else if (e.type === "question.answered") at(e.subject).answered = e.n;
    else if (e.type === "decision.made" && typeof e.data?.question === "string") at(e.data.question).decided = e.n;
    else if (e.type === "task.created" && e.data?.spike && typeof (e.data.spike as { question?: unknown }).question === "string") at(String((e.data.spike as { question: string }).question)).spike = e.n;
  }
  return out;
}

function approvals(entries: readonly LedgerEntry[]) {
  return entries
    .filter((e) => e.type === "plan.approved")
    .map((e) => ({ plan: e.subject, entry: e.n, at: e.at, by: e.actor.id, summary: e.summary }));
}

function blockerMessage(open: string[]): string {
  return open.length === 1
    ? `The plan cannot be approved yet: 1 blocking question is still open (${open[0]}). Answer it, or set a dated spike for it.`
    : `The plan cannot be approved yet: ${open.length} blocking questions are still open (${open.join(", ")}). Answer them, or set a dated spike for each.`;
}

function questionView(q: PlanningQuestionState, numbers: ReturnType<typeof entryNumbers>) {
  return {
    q: q.q,
    id: q.id,
    area: q.area,
    text: q.text,
    blocking: q.blocking,
    options: q.options,
    recommendation: { ...q.recommendation, sources: q.recommendation.sources ?? [] },
    status: q.status,
    ...(q.answer !== undefined ? { answer: q.answer } : {}),
    ...(q.choice !== undefined ? { choice: q.choice } : {}),
    ...(q.decision ? { decision: q.decision } : {}),
    ...(q.spike ? { spike: q.spike } : {}),
    ...(q.source ? { source: q.source } : {}),
    ...(q.phrase ? { phrase: q.phrase } : {}),
    entries: numbers.get(q.q) ?? {},
  };
}

/** What the person's own description settled and ruled out, so the screen can say why a question was skipped. */
function descriptionView(state: PlanningState, questions: readonly PlanningQuestionState[]) {
  return {
    ruledOut: state.profile?.ruledOut ?? [],
    settled: questions
      .filter((q) => q.source === "description" && q.status !== "open")
      .map((q) => ({ q: q.q, id: q.id, area: q.area, areaTitle: AREA_TITLES[q.area], text: q.text, answer: q.answer ?? "", phrase: q.phrase ?? "", ...(q.decision ? { decision: q.decision } : {}) })),
  };
}

/** The person's own tasks and the draft roadmap tasks they left out. */
function tasksView(entries: readonly LedgerEntry[]) {
  return {
    own: ownTasks(entries),
    dropped: [...droppedRoadmapTasks(entries).values()],
  };
}

function overview(project: CoreProject) {
  const state = planning(project);
  const entries = project.entries();
  // A question asked again (reopened) replaces the older one: list only the newest per id.
  const questions = [...latestByQuestionId(entries).values()];
  const numbers = entryNumbers(entries);
  const why = new Map<string, string>();
  for (const e of entries) {
    const meta = e.type === "question.asked" ? (e.data?.planning as { why?: unknown } | undefined) : undefined;
    if (meta && typeof meta.why === "string") why.set(e.subject, meta.why);
  }
  const open = openBlockers(entries);
  const areas = AREAS.map((area) => ({
    area,
    title: AREA_TITLES[area],
    questions: questions.filter((q) => q.area === area).map((q) => ({ ...questionView(q, numbers), why: why.get(q.q) ?? "" })),
  })).filter((a) => a.questions.length > 0);
  const answered = questions.filter((q) => q.status !== "open").length;
  return {
    started: questions.length > 0,
    idea: state.idea,
    signals: state.profile?.signals ?? [],
    person: state.person,
    research: { live: false, note: RESEARCH_NOTE },
    progress: { answered, total: questions.length, open: questions.length - answered, blockingOpen: open.length },
    blockers: questions.filter((q) => open.includes(q.q)).map((q) => ({ q: q.q, id: q.id, area: q.area, areaTitle: AREA_TITLES[q.area], text: q.text, recommendation: q.recommendation })),
    areas,
    description: descriptionView(state, questions),
    tasks: tasksView(entries),
    approval: {
      canApprove: questions.length > 0 && open.length === 0,
      message: questions.length === 0 ? "Start with your idea first; there is nothing to approve yet." : open.length ? blockerMessage(open) : "Every blocking question is settled. The plan can be approved.",
      approved: approvals(entries),
    },
  };
}

function mindMapView(project: CoreProject) {
  const state = planning(project);
  const map = state.session.mindMap(ideaLabel(state));
  return {
    idea: state.idea,
    answered: planningAnswers(project.entries()).length,
    map,
    mermaid: toMermaid(map),
    depth: depthCheck(map, planningAnswers(project.entries())),
  };
}

function writtenTasks(entries: readonly LedgerEntry[]): Map<string, { task: string; entry: string }> {
  const out = new Map<string, { task: string; entry: string }>();
  for (const e of entries) {
    if (e.type === "task.created" && e.data?.source === "planning" && typeof e.data.key === "string") out.set(e.data.key, { task: e.subject, entry: e.n });
  }
  return out;
}

function roadmapView(project: CoreProject) {
  const state = planning(project);
  const roadmap = state.session.roadmap(ideaLabel(state), state.person);
  const entries = project.entries();
  const written = writtenTasks(entries);
  const number = (key: string) => written.get(key)?.task;
  const own = ownTasks(entries);
  return {
    written: written.size > 0,
    answered: planningAnswers(entries).length,
    phases: roadmap.phases.map((p) => ({
      id: p.id,
      title: p.title,
      tasks: [
        ...p.tasks.map((t) => ({
          ...t,
          ...(written.get(t.key) ? { task: written.get(t.key)!.task, entry: written.get(t.key)!.entry } : {}),
          dependsOnTasks: t.dependsOn.map((d) => number(d) ?? d),
        })),
        // The person's own tasks are already on the board (T-n), whether or not the plan is approved.
        ...own
          .filter((t) => t.phase === p.id)
          .map((t) => ({
            key: t.task,
            title: t.title,
            phase: t.phase,
            owner: t.owner,
            doneWhen: t.doneWhen ?? "",
            node: "",
            change: "feature" as const,
            dependsOn: [],
            dependsOnTasks: [],
            refs: t.refs,
            task: t.task,
            entry: t.entry,
            own: true,
          })),
      ],
    })),
    dropped: [...droppedRoadmapTasks(entries).values()],
  };
}

function text(value: unknown, field: string, max = 4000): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new HttpError(400, "INVALID", `${field} must be text.`);
  if (value.length > max) throw new HttpError(400, "INVALID", `${field} is too long (at most ${max} characters).`);
  return value;
}

export function registerPlanningRoutes(router: Router): void {
  /** GET /planning: progress, open blockers, questions by area, approval gate. */
  router.get("/planning", ({ project }) => overview(project));

  /** POST /planning/start { idea }: profiles the idea and asks every question the packs pick. */
  router.post("/planning/start", ({ project, body }) => {
    const idea = text((body as { idea?: unknown })?.idea, "idea").trim();
    if (idea.length < 3) throw new HttpError(400, "EMPTY", "Describe your idea in a sentence first.");
    const state = planning(project);
    const profile = profileIdea(idea);
    const asked = state.session.start(ASKER, profile);
    // The idea is the person's own words: what it settles ("no accounts", "uses SQLite") is their answer, not a question.
    let described: string[] = [];
    try {
      described = state.session.recordDescriptionFacts(actorFor(project), profile);
    } catch (error) {
      refuse(error);
    }
    state.idea = idea;
    state.profile = profile;
    saveIdea(project, idea);
    return { asked, described, signals: profile.signals, research: { live: false, note: RESEARCH_NOTE }, overview: overview(project) };
  });

  /**
   * POST /planning/reopen { q }: asks a question the description settled
   * again, so the person can answer it themselves. Only description answers
   * reopen here; a person's own decision stays.
   */
  router.post("/planning/reopen", ({ project, body }) => {
    const q = text((body as { q?: unknown })?.q, "q", 40).trim();
    if (!q) throw new HttpError(400, "INVALID", "Say which question to reopen.");
    const state = planning(project);
    const question = state.session.questions().find((x) => x.q === q);
    if (question && question.status !== "open" && question.source !== "description") {
      throw new HttpError(409, "NOT_FROM_DESCRIPTION", `${q} was answered by you, not settled by your description, so it stays decided.`);
    }
    try {
      const reopened = state.session.reopen(actorFor(project), q);
      return { q: reopened, overview: overview(project) };
    } catch (error) {
      refuse(error);
    }
  });

  /**
   * POST /planning/tasks { title, doneWhen?, clause? | refs?, phase? }: the
   * person's own task, written as a person-signed task.created (T-n), so it
   * is on the agent board straight away.
   */
  router.post("/planning/tasks", ({ project, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const title = text(b.title, "title", 200).trim();
    if (!title) throw new HttpError(400, "EMPTY", "Give the task a title.");
    const doneWhen = text(b.doneWhen, "doneWhen", 1000).trim();
    const refs: string[] = [];
    const clause = text(b.clause, "clause", 40).trim();
    if (clause) refs.push(clause);
    if (b.refs !== undefined && b.refs !== null) {
      if (!Array.isArray(b.refs) || b.refs.length > 20) throw new HttpError(400, "INVALID", "refs must be a list of at most 20 numbers.");
      for (const r of b.refs) {
        const ref = text(r, "ref", 40).trim();
        if (ref) refs.push(ref);
      }
    }
    if (b.phase !== undefined && b.phase !== null && b.phase !== "" && !isPhase(b.phase)) {
      throw new HttpError(400, "INVALID", "phase must be one of foundation, core, integrations, hardening or release.");
    }
    const state = planning(project);
    try {
      const added = state.session.addTask(actorFor(project), { title, ...(doneWhen ? { doneWhen } : {}), refs, ...(isPhase(b.phase) ? { phase: b.phase } : {}) });
      return { ...added, overview: overview(project) };
    } catch (error) {
      refuse(error);
    }
  });

  /** POST /planning/roadmap/drop { key, reason? }: leaves a draft roadmap task out, before approval. */
  router.post("/planning/roadmap/drop", ({ project, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const key = text(b.key, "key", 200).trim();
    if (!key) throw new HttpError(400, "INVALID", "Say which roadmap task to leave out.");
    const reason = text(b.reason, "reason", 1000).trim();
    const state = planning(project);
    try {
      const decision = state.session.dropRoadmapTask(actorFor(project), key, reason || undefined, ideaLabel(state));
      return { decision, roadmap: roadmapView(project) };
    } catch (error) {
      refuse(error);
    }
  });

  /** POST /planning/roadmap/restore { key }: puts a dropped draft roadmap task back. */
  router.post("/planning/roadmap/restore", ({ project, body }) => {
    const key = text((body as { key?: unknown })?.key, "key", 200).trim();
    if (!key) throw new HttpError(400, "INVALID", "Say which roadmap task to put back.");
    const state = planning(project);
    try {
      const decision = state.session.restoreRoadmapTask(actorFor(project), key);
      return { decision, roadmap: roadmapView(project) };
    } catch (error) {
      refuse(error);
    }
  });

  /** POST /planning/answer { q, choice?, text?, spike?: { due, risk, owner? } }. */
  router.post("/planning/answer", ({ project, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const q = text(b.q, "q", 40).trim();
    if (!q) throw new HttpError(400, "INVALID", "Say which question you are answering.");
    const input: AnswerInput = {};
    if (b.choice !== undefined && b.choice !== null && b.choice !== "") input.choice = text(b.choice, "choice", 80);
    if (b.text !== undefined) input.text = text(b.text, "text");
    if (b.reason !== undefined) input.reason = text(b.reason, "reason");
    if (b.spike && typeof b.spike === "object") {
      const s = b.spike as Record<string, unknown>;
      input.spike = { due: text(s.due, "spike due date", 20), risk: text(s.risk, "spike risk", 1000), ...(s.owner ? { owner: text(s.owner, "spike owner", 80) } : {}) };
    }
    const state = planning(project);
    try {
      const result = state.session.answer(actorFor(project), q, input);
      return { ...result, overview: overview(project) };
    } catch (error) {
      refuse(error);
    }
  });

  /** POST /planning/check { text }: what the deferral catcher says about an answer, before sending it. */
  router.post("/planning/check", ({ body }) => {
    const value = text((body as { text?: unknown })?.text, "text");
    return catchDeferral(value);
  });

  /** POST /planning/accept { minConfidence? }: takes every open recommendation at or above the bar. */
  router.post("/planning/accept", ({ project, body }) => {
    const raw = Number((body as { minConfidence?: unknown })?.minConfidence ?? 0.75);
    const min = Number.isFinite(raw) ? Math.min(1, Math.max(0.5, raw)) : 0.75;
    const state = planning(project);
    try {
      const decided = state.session.acceptRecommendations(actorFor(project), min);
      return { decided, overview: overview(project) };
    } catch (error) {
      refuse(error);
    }
  });

  router.get("/planning/mindmap", ({ project }) => mindMapView(project));
  router.get("/planning/roadmap", ({ project }) => roadmapView(project));

  /**
   * POST /planning/approve: plan.approved P-n, then the roadmap's tasks (T-n)
   * the first time. Refused with the gate's reason while a blocker is open.
   */
  router.post("/planning/approve", ({ project }) => {
    const state = planning(project);
    const entries = project.entries();
    if (!state.session.questions().length) throw new HttpError(409, "NOT_STARTED", "Start with your idea first; there is nothing to approve yet.");
    const open = openBlockers(entries);
    if (open.length) throw new HttpError(409, "BLOCKERS_OPEN", blockerMessage(open));
    const actor = actorFor(project);
    const already = writtenTasks(entries).size > 0;
    // The ledger's planning rule refuses this too if a blocker is open (LedgerError -> 422).
    const plan = appendNumbered(project.ledger, {
      actor,
      type: "plan.approved",
      summary: `Plan approved: ${(state.idea ?? "deep planning").replace(/\s+/g, " ").slice(0, 100)}`,
      refs: ["plan"],
      data: { source: "planning", idea: state.idea, answered: state.session.questions().filter((q) => q.status !== "open").length },
    });
    let tasks: Record<string, string> = {};
    if (!already) {
      try {
        tasks = state.session.writeRoadmap(actor, state.session.roadmap(ideaLabel(state), state.person));
      } catch (error) {
        refuse(error);
      }
    }
    return { plan: plan.subject, entry: plan.n, tasks, overview: overview(project) };
  });
}
