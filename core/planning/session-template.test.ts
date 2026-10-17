import { describe, expect, it } from "vitest";
import { Ledger, MemoryStore, type Actor, type LedgerEntry } from "../ledger/index";
import { appendNumbered, installNumberingRules } from "../numbering/index";
import { installPlanningRules } from "./rules";
import { EMPTY_CONTEXT, type RepoContext } from "./seed";
import { PlanningError, PlanningSession, templateChoice } from "./session";
import { profileIdea } from "./profile";
import { openBlockers, planningAnswers } from "./state";
import { roadmapTasks } from "./roadmap";
import { TEMPLATES } from "./templates";

const NOW = new Date("2026-10-17T05:00:00Z");
const owner: Actor = { kind: "person", id: "looplet-spare" };
const agent: Actor = { kind: "agent", id: "claude-code", model: "test-model" };
const system: Actor = { kind: "system", id: "deep-planning" };
const IDEA = "A habit tracker where people sign in";

async function setup() {
  const ledger = await Ledger.open(new MemoryStore());
  installNumberingRules(ledger);
  installPlanningRules(ledger, { now: () => NOW });
  const session = new PlanningSession(ledger, { person: "looplet-spare", now: () => NOW });
  return { ledger, session };
}

async function started(idea = IDEA) {
  const made = await setup();
  made.session.start(system, profileIdea(idea));
  return made;
}

const jsContext: RepoContext = { ...EMPTY_CONTEXT, kind: "js", manifest: true, tests: true, srcDir: "src", testDir: "tests" };
const pick = (session: PlanningSession, id: string | null, extra: { depth?: unknown; context?: RepoContext } = {}) => session.chooseTemplate(owner, { id, context: jsContext, ...extra });
const types = (ledger: Ledger, type: string) => ledger.entries().filter((e) => e.type === type);

describe("choosing a template", () => {
  it("is the person's decision.made, recorded with what the template saw, and nothing else", async () => {
    const { ledger, session } = await started();
    const before = ledger.entries().length;
    const result = pick(session, "web-app");
    expect(result.changed).toBe(true);
    const added = ledger.entries().slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ type: "decision.made", subject: "D-1", actor: owner, summary: 'Start from the "New web app" template' });
    expect(added[0]!.reason).toMatch(/only suggests/);
    expect(added[0]!.data).toEqual({ template: { id: "web-app", depth: "standard", context: jsContext, previous: null } });
    expect(added[0]!.refs).toEqual(["plan"]);
    expect(session.templateChoice()).toMatchObject({ id: "web-app", depth: "standard", decision: "D-1", previous: null, by: "looplet-spare" });
    expect(session.template()?.title).toBe("New web app");
  });

  it("answers nothing, approves nothing and writes no task", async () => {
    const { ledger, session } = await started();
    const blockers = session.blockers();
    expect(blockers.length).toBeGreaterThan(0);
    const answers = planningAnswers(ledger.entries());
    for (const t of TEMPLATES) pick(session, t.id);
    expect(types(ledger, "plan.approved")).toHaveLength(0);
    expect(types(ledger, "question.answered")).toHaveLength(0);
    expect(types(ledger, "task.created")).toHaveLength(0);
    expect(types(ledger, "decision.made").every((e) => e.data?.question === undefined && e.data?.template)).toBe(true);
    expect(session.blockers()).toEqual(blockers);
    expect(planningAnswers(ledger.entries())).toEqual(answers);
    // The gate still refuses an approval while a blocker is open, whatever template is in use.
    expect(() => appendNumbered(ledger, { actor: owner, type: "plan.approved", summary: "Plan approved", refs: [] })).toThrow(/blocking/);
    expect(() => session.writeRoadmap(owner, session.roadmap(IDEA))).toThrow(PlanningError);
    expect(types(ledger, "task.created")).toHaveLength(0);
  });

  it("is the person's alone: an agent or the system is refused and nothing is written", async () => {
    const { ledger, session } = await started();
    const before = ledger.entries().length;
    for (const actor of [agent, system]) {
      expect(() => session.chooseTemplate(actor, { id: "web-app", context: jsContext })).toThrow(/Only the person/);
      expect(() => session.skipUsual(actor, [])).toThrow(/Only the person/);
    }
    expect(ledger.entries()).toHaveLength(before);
    // And the ledger itself refuses an agent's decision.
    expect(() => ledger.append({ actor: agent, type: "decision.made", subject: "D-1", summary: "Start from web-app", reason: "sneaky", refs: ["plan"], data: { template: { id: "web-app" } } })).toThrow();
  });

  it("refuses an unknown template or depth before writing anything", async () => {
    const { ledger, session } = await started();
    const before = ledger.entries().length;
    for (const id of ["nope", "", "__proto__", "constructor", "Web-App", 7, undefined, {}, ["web-app"]]) {
      expect(() => session.chooseTemplate(owner, { id })).toThrow(PlanningError);
    }
    for (const depth of ["deep", "", 3, {}, "QUICK"]) expect(() => session.chooseTemplate(owner, { id: "web-app", depth })).toThrow(/Depth/);
    expect(ledger.entries()).toHaveLength(before);
    expect(session.templateChoice()).toBeNull();
  });

  it("twice with the same pick changes nothing and writes nothing", async () => {
    const { ledger, session } = await started();
    expect(pick(session, "fix-bug").changed).toBe(true);
    const after = ledger.entries().length;
    const again = pick(session, "fix-bug");
    expect(again.changed).toBe(false);
    expect(again.choice.decision).toBe("D-1");
    expect(ledger.entries()).toHaveLength(after);
    expect(types(ledger, "decision.made")).toHaveLength(1);
    // The same template seen differently (another depth, or the folder changed) is a new pick.
    expect(pick(session, "fix-bug", { depth: "thorough" }).changed).toBe(true);
    expect(pick(session, "fix-bug", { depth: "thorough" }).changed).toBe(false);
    expect(session.chooseTemplate(owner, { id: "fix-bug", depth: "thorough", context: { ...jsContext, ci: true } }).changed).toBe(true);
    expect(types(ledger, "decision.made")).toHaveLength(3);
  });

  it("remembers what came before, and the last pick wins", async () => {
    const { session } = await started();
    pick(session, "web-app");
    pick(session, "library");
    pick(session, "web-app");
    expect(session.templateChoice()).toMatchObject({ id: "web-app", previous: "library", decision: "D-3" });
    expect(session.template()?.id).toBe("web-app");
  });

  it("can start blank, on purpose, and that is recorded too", async () => {
    const { ledger, session } = await started();
    expect(session.templateChoice()).toBeNull();
    expect(pick(session, null).changed).toBe(true);
    expect(session.templateChoice()).toMatchObject({ id: null });
    expect(session.template()).toBeUndefined();
    expect(pick(session, "blank").changed).toBe(false);
    expect(types(ledger, "decision.made")).toHaveLength(1);
    expect(types(ledger, "decision.made")[0]!.data).toEqual({ template: { id: null, previous: null } });
    // A roadmap with no template is the plain one.
    expect(roadmapTasks(session.roadmap(IDEA)).every((t) => !t.template)).toBe(true);
    pick(session, "web-app");
    expect(pick(session, null).changed).toBe(true);
    expect(session.templateChoice()).toMatchObject({ id: null, previous: "web-app" });
    expect(roadmapTasks(session.roadmap(IDEA)).every((t) => !t.template)).toBe(true);
  });
});

describe("switching template after there are answers", () => {
  it("keeps every answer, the person's own tasks and what they left out; only the suggestions change", async () => {
    const { ledger, session } = await started();
    pick(session, "web-app");
    const answered = session.open().slice(0, 3).map((q) => session.answer(owner, q.q, q.options.length ? { choice: q.options[0]!.id } : { text: "Decided in writing." }));
    expect(answered.length).toBe(3);
    const own = session.addTask(owner, { title: "Write the launch post", doneWhen: "the post is published" });
    const draftBefore = session.roadmap(IDEA, "looplet-spare");
    const mindMapTask = roadmapTasks(draftBefore).find((t) => !t.template && t.key !== "K-first-release")!;
    session.dropRoadmapTask(owner, mindMapTask.key, "not now", IDEA);
    const templateTask = roadmapTasks(draftBefore).find((t) => t.template)!;
    session.dropRoadmapTask(owner, templateTask.key, "I do not want this one", IDEA);

    const answersBefore = planningAnswers(ledger.entries());
    const entriesBefore = ledger.entries().map((e) => e.hash);
    const ownBefore = session.ownTasks();
    const droppedBefore = session.droppedRoadmapKeys();
    const blockersBefore = session.blockers();

    pick(session, "cli-tool");

    // Nothing the person decided is gone or changed.
    expect(planningAnswers(ledger.entries())).toEqual(answersBefore);
    expect(ledger.entries().slice(0, entriesBefore.length).map((e) => e.hash)).toEqual(entriesBefore);
    expect(session.ownTasks()).toEqual(ownBefore);
    expect(session.ownTasks()[0]!.task).toBe(own.task);
    expect(session.droppedRoadmapKeys()).toEqual(droppedBefore);
    expect(session.blockers()).toEqual(blockersBefore);
    expect(session.questions().filter((q) => q.status !== "open")).toHaveLength(answersBefore.length);

    // The suggestions are the new template's, the old template's are gone from the draft.
    const draft = roadmapTasks(session.roadmap(IDEA, "looplet-spare"));
    const templated = draft.filter((t) => t.template);
    expect(templated.length).toBeGreaterThan(0);
    expect(templated.every((t) => t.template!.id === "cli-tool")).toBe(true);
    expect(draft.some((t) => t.key.startsWith("K-tpl-web-app-"))).toBe(false);
    // The mind map's task the person left out is still out.
    expect(draft.some((t) => t.key === mindMapTask.key)).toBe(false);

    // Going back remembers that they left that suggestion out.
    pick(session, "web-app");
    const back = roadmapTasks(session.roadmap(IDEA, "looplet-spare"));
    expect(back.some((t) => t.key === templateTask.key)).toBe(false);
    expect(back.some((t) => t.key.startsWith("K-tpl-web-app-"))).toBe(true);
  });

  it("keeps a spiked question's spike task", async () => {
    const { ledger, session } = await started();
    const q = session.open()[0]!;
    session.answer(owner, q.q, { spike: { due: "2026-10-20", risk: "Choosing wrong here would cost a week of rework." } });
    const spikes = types(ledger, "task.created").filter((e) => e.data?.spike);
    expect(spikes).toHaveLength(1);
    pick(session, "library");
    pick(session, "fix-bug");
    expect(types(ledger, "task.created").filter((e) => e.data?.spike)).toEqual(spikes);
    expect(session.questions().find((x) => x.q === q.q)!.status).toBe("spiked");
  });

  it("is refused once the roadmap is on the board; the same pick is still fine", async () => {
    const { ledger, session } = await started();
    pick(session, "web-app");
    for (const q of session.open()) session.answer(owner, q.q, q.options.length ? { choice: q.options[0]!.id } : { text: "Decided in writing." });
    expect(openBlockers(ledger.entries())).toEqual([]);
    appendNumbered(ledger, { actor: owner, type: "plan.approved", summary: "Plan approved", refs: [] });
    const written = session.writeRoadmap(owner, session.roadmap(IDEA, "looplet-spare"));
    expect(Object.keys(written).some((k) => k.startsWith("K-tpl-web-app-"))).toBe(true);
    const before = ledger.entries().length;
    expect(() => pick(session, "library")).toThrow(/already added to the board/);
    expect(() => pick(session, null)).toThrow(PlanningError);
    expect(pick(session, "web-app").changed).toBe(false);
    expect(ledger.entries()).toHaveLength(before);
    // Each written task keeps the template it came from.
    const first = types(ledger, "task.created").find((e) => e.data?.key === "K-tpl-web-app-first-screen")!;
    expect(first.data).toMatchObject({ source: "planning", template: { id: "web-app", step: "first-screen", size: "small" } });
    expect((first.data!.template as { files: string[] }).files.length).toBeGreaterThan(0);
  });
});

describe("a template cannot smuggle an approval", () => {
  const hostile = {
    approved: true,
    approve: true,
    plan: "approved",
    answers: { "stack.language": "typescript" },
    answered: ["Q-1"],
    suggestions: [{ q: "stack.language", option: "typescript" }],
    skeleton: [{ step: "evil", title: "Delete everything" }],
    tasks: ["T-1"],
    fingerprint: "x",
  };

  it("ignores anything in the pick but the template and depth", async () => {
    const { ledger, session } = await started();
    const input = { id: "web-app", context: jsContext, ...hostile } as Parameters<typeof session.chooseTemplate>[1];
    session.chooseTemplate(owner, input);
    expect(types(ledger, "plan.approved")).toHaveLength(0);
    expect(types(ledger, "question.answered")).toHaveLength(0);
    expect(types(ledger, "task.created")).toHaveLength(0);
    expect(JSON.stringify(session.templateChoice())).not.toContain("evil");
    expect(Object.keys((types(ledger, "decision.made")[0]!.data as { template: object }).template).sort()).toEqual(["context", "depth", "id", "previous"]);
  });

  it("ignores a pick that an agent, or a hand-written line, claims was the person's", async () => {
    const { ledger, session } = await started();
    const real = pick(session, "library").choice;
    const forged = (e: Partial<LedgerEntry>): LedgerEntry => ({ n: "L-000900", at: NOW.toISOString(), evidence: [], refs: ["plan"], prev: "0", hash: "f".repeat(64), type: "decision.made", subject: "D-9", summary: "Start from the web app", reason: "x", actor: owner, data: { template: { id: "web-app", depth: "thorough", context: jsContext, previous: null } }, ...e });
    const entries = [...ledger.entries()];
    // Not signed by the ledger: a person's name on a copy is not enough.
    expect(templateChoice([...entries, forged({})])).toMatchObject({ id: "library", decision: real.decision });
    expect(templateChoice([...entries, forged({ actor: agent })])).toMatchObject({ id: "library" });
    expect(templateChoice([forged({})])).toBeNull();
    // A decision that is an answer (it names a question) is not a pick, whatever else it says.
    const answer = ledger.entries().find((e) => e.type === "decision.made")!;
    expect(templateChoice([{ ...answer, data: { question: "Q-1", template: { id: "web-app" } } }])).toBeNull();
  });

  it("reads only known ids from the ledger: a planted id, depth or context is not a pick", async () => {
    // Real person-signed lines whose data is hostile, one after another. The last good one wins.
    const { ledger, session } = await started();
    const plant = (template: unknown) => {
      appendNumbered(ledger, { actor: owner, type: "decision.made", summary: "Start from a template", reason: "Planted by a test.", refs: ["plan"], data: { template } });
      return session.templateChoice();
    };
    pick(session, "cleanup", { depth: "quick" });
    expect(session.templateChoice()).toMatchObject({ id: "cleanup", depth: "quick" });
    // Not a known id: the earlier pick stands, nothing is invented.
    for (const id of ["__proto__", "evil", "constructor", "", 7, ["web-app"], {}]) expect(plant({ id }), String(id)).toMatchObject({ id: "cleanup", depth: "quick" });
    expect(plant("web-app")).toMatchObject({ id: "cleanup" });
    expect(plant(["web-app"])).toMatchObject({ id: "cleanup" });
    expect(plant(null)).toMatchObject({ id: "cleanup" });
    // A known id with a made-up depth and context falls back to safe values.
    expect(plant({ id: "web-app", depth: "forever", context: { srcDir: "../../etc", pyPackage: "../x", ci: "yes", kind: "evil" } })).toMatchObject({ id: "web-app", depth: "standard", context: { srcDir: "", pyPackage: "", ci: false, kind: "empty" } });
    expect(plant({ id: null })).toMatchObject({ id: null });
    expect(types(ledger, "plan.approved")).toHaveLength(0);
  });

  it("an approval still needs every blocker settled and the plan approved by the person", async () => {
    const { ledger, session } = await started();
    pick(session, "fix-bug");
    expect(session.skipUsual(owner, []).length).toBeGreaterThan(0);
    // Skipping is answering, and only for the areas the template usually skips. The rest stay open.
    expect(session.blockers().length).toBeGreaterThan(0);
    expect(() => appendNumbered(ledger, { actor: owner, type: "plan.approved", summary: "Plan approved", refs: [] })).toThrow(/blocking/);
    expect(types(ledger, "plan.approved")).toHaveLength(0);
    expect(types(ledger, "task.created")).toHaveLength(0);
  });
});

describe("skipping the usual areas", () => {
  it("answers each open question there as 'Not needed' in the person's name, and nothing else", async () => {
    const { ledger, session } = await started("A tiny script");
    pick(session, "fix-bug");
    const open = session.open();
    const outside = open.filter((q) => q.area === "testing");
    const skippable = open.filter((q) => q.area !== "testing");
    expect(skippable.length).toBeGreaterThan(10);
    const skipped = session.skipUsual(owner, []);
    // Money, AI and offline come back only when the idea raises them; this idea does not.
    expect(skipped.sort()).toEqual(skippable.map((q) => q.q).sort());
    for (const q of session.questions().filter((x) => skipped.includes(x.q))) {
      expect(q).toMatchObject({ status: "decided", answer: "Not needed for fixing a bug." });
    }
    for (const e of types(ledger, "decision.made").filter((x) => x.data?.question)) {
      expect(e.actor).toEqual(owner);
      expect(e.data).toMatchObject({ choice: "custom", skipped: { template: "fix-bug" } });
      expect(e.reason).toMatch(/Skipped at your request: Fix a bug usually skips/);
    }
    expect(session.open().map((q) => q.q).sort()).toEqual(outside.map((q) => q.q).sort());
    // Doing it again finds nothing left to skip; the questions outside the usual areas stay open.
    expect(session.skipUsual(owner, [])).toEqual([]);
    expect(types(ledger, "plan.approved")).toHaveLength(0);
    // The mind map builds nothing from a skipped area.
    const labels = Object.values(session.mindMap("A tiny script").nodes).map((n) => n.label);
    for (const gone of ["Sign-in", "Payments", "AI provider", "Data store", "Sync engine"]) expect(labels).not.toContain(gone);
  });

  it("keeps an area the idea asks for", async () => {
    const { session } = await started("A small invoicing tool with Stripe payments");
    pick(session, "cli-tool");
    const skipped = session.skipUsual(owner, profileIdea("A small invoicing tool with Stripe payments").signals);
    expect(skipped.some((q) => session.questions().find((x) => x.q === q)!.area === "money")).toBe(false);
    expect(session.open().some((q) => q.area === "money")).toBe(true);
  });

  it("needs a template, and the template needs to have been picked by the person", async () => {
    const { session } = await started();
    expect(() => session.skipUsual(owner, [])).toThrow(/Pick a starter/);
    pick(session, null);
    expect(() => session.skipUsual(owner, [])).toThrow(PlanningError);
  });
});

describe("the roadmap a template seeds", () => {
  it("is all draft until the plan is approved, then each task keeps the template it came from", async () => {
    const { ledger, session } = await started();
    pick(session, "web-app");
    const draft = roadmapTasks(session.roadmap(IDEA, "looplet-spare"));
    const seeded = draft.filter((t) => t.template);
    expect(seeded.length).toBeGreaterThanOrEqual(4);
    expect(types(ledger, "task.created")).toHaveLength(0);
    expect(seeded.some((t) => t.title.includes("A habit tracker where people sign in"))).toBe(true);
    expect(seeded.map((t) => t.template!.step)).toContain("signin");
  });

  it("can have a suggested task left out and put back, like any other draft task", async () => {
    const { session } = await started();
    pick(session, "web-app");
    const key = "K-tpl-web-app-error-states";
    expect(roadmapTasks(session.roadmap(IDEA)).some((t) => t.key === key)).toBe(false);
    pick(session, "web-app", { depth: "thorough" });
    expect(roadmapTasks(session.roadmap(IDEA)).some((t) => t.key === key)).toBe(true);
    session.dropRoadmapTask(owner, key, undefined, IDEA);
    expect(roadmapTasks(session.roadmap(IDEA)).some((t) => t.key === key)).toBe(false);
    session.restoreRoadmapTask(owner, key);
    expect(roadmapTasks(session.roadmap(IDEA)).some((t) => t.key === key)).toBe(true);
    // A task a template does not suggest cannot be dropped by name.
    expect(() => session.dropRoadmapTask(owner, "K-tpl-web-app-nonsense", undefined, IDEA)).toThrow(/not a task in the draft/);
  });

  it("has no template tasks for a session that never picked one, whatever the idea", async () => {
    const { session } = await started();
    expect(roadmapTasks(session.roadmap(IDEA)).every((t) => !t.template)).toBe(true);
    expect(roadmapTasks(session.roadmap("")).every((t) => !t.template)).toBe(true);
  });
});
