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
  openBlockers,
  planningAnswers,
  profileIdea,
  toMermaid,
  type AnswerInput,
  type IdeaProfile,
  type PlanningQuestionState,
} from "../../planning/index";
import type { CoreProject } from "../project";
import { fingerprintOf, requireFingerprint } from "../fingerprint";
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
    const status = error.code === "UNKNOWN_QUESTION" ? 404 : error.code === "ALREADY_ANSWERED" ? 409 : 422;
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
    .map((e) => ({ plan: e.subject, entry: e.n, at: e.at, by: e.actor.id, summary: e.summary, fingerprint: typeof e.data?.fingerprint === "string" ? e.data.fingerprint : undefined }));
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
    entries: numbers.get(q.q) ?? {},
  };
}

function overview(project: CoreProject) {
  const state = planning(project);
  const entries = project.entries();
  const questions = state.session.questions();
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
  const fingerprint = planFingerprint(state.idea, areas);
  const approvedAs = approvals(entries).at(-1)?.fingerprint;
  // Approved and unchanged since: nothing left to approve (trial finding F8).
  const upToDate = approvedAs !== undefined && approvedAs === fingerprint;
  return {
    fingerprint,
    started: questions.length > 0,
    idea: state.idea,
    signals: state.profile?.signals ?? [],
    person: state.person,
    research: { live: false, note: RESEARCH_NOTE },
    progress: { answered, total: questions.length, open: questions.length - answered, blockingOpen: open.length },
    blockers: questions.filter((q) => open.includes(q.q)).map((q) => ({ q: q.q, id: q.id, area: q.area, areaTitle: AREA_TITLES[q.area], text: q.text, recommendation: q.recommendation })),
    areas,
    approval: {
      canApprove: questions.length > 0 && open.length === 0 && !upToDate,
      upToDate,
      changedSinceApproval: approvedAs !== undefined && !upToDate,
      message: questions.length === 0
        ? "Start with your idea first; there is nothing to approve yet."
        : open.length
          ? blockerMessage(open)
          : upToDate
            ? "This plan is approved and has not changed since."
            : approvedAs !== undefined
              ? "The plan changed since it was approved. Review it, then approve the new version."
              : "Every blocking question is settled. The plan can be approved.",
      approved: approvals(entries),
    },
  };
}

/** What the person reviews before approving: the idea and every question as shown (see fingerprint.ts). */
function planFingerprint(idea: unknown, areas: unknown): string {
  return fingerprintOf({ idea: idea ?? null, areas });
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
  const written = writtenTasks(project.entries());
  const number = (key: string) => written.get(key)?.task;
  return {
    written: written.size > 0,
    answered: planningAnswers(project.entries()).length,
    phases: roadmap.phases.map((p) => ({
      id: p.id,
      title: p.title,
      tasks: p.tasks.map((t) => ({
        ...t,
        ...(written.get(t.key) ? { task: written.get(t.key)!.task, entry: written.get(t.key)!.entry } : {}),
        dependsOnTasks: t.dependsOn.map((d) => number(d) ?? d),
      })),
    })),
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
    state.idea = idea;
    state.profile = profile;
    saveIdea(project, idea);
    return { asked, signals: profile.signals, research: { live: false, note: RESEARCH_NOTE }, overview: overview(project) };
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
  router.post("/planning/approve", ({ project, body }) => {
    const state = planning(project);
    const entries = project.entries();
    if (!state.session.questions().length) throw new HttpError(409, "NOT_STARTED", "Start with your idea first; there is nothing to approve yet.");
    const open = openBlockers(entries);
    if (open.length) throw new HttpError(409, "BLOCKERS_OPEN", blockerMessage(open));
    // Bound to the plan the person is looking at: a changed plan needs a fresh look.
    const shown = overview(project);
    requireFingerprint(body, shown.fingerprint, "plan");
    if (shown.approval.upToDate) throw new HttpError(409, "ALREADY_APPROVED", "This plan is already approved and has not changed since.");
    const actor = actorFor(project);
    const already = writtenTasks(entries).size > 0;
    // The ledger's planning rule refuses this too if a blocker is open (LedgerError -> 422).
    const plan = appendNumbered(project.ledger, {
      actor,
      type: "plan.approved",
      summary: `Plan approved: ${(state.idea ?? "deep planning").replace(/\s+/g, " ").slice(0, 100)}`,
      refs: ["plan"],
      data: { source: "planning", idea: state.idea, answered: state.session.questions().filter((q) => q.status !== "open").length, fingerprint: shown.fingerprint },
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
