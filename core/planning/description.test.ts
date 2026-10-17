import { describe, expect, it } from "vitest";
import { Ledger, MemoryStore, type Actor } from "../ledger/index";
import { foldBoard } from "../mcp/board";
import { installNumberingRules } from "../numbering/index";
import { readDescription } from "./description";
import { questionsFor } from "./packs";
import { profileIdea } from "./profile";
import { installPlanningRules } from "./rules";
import { PlanningError, PlanningSession } from "./session";
import { planningAnswers } from "./state";

const owner: Actor = { kind: "person", id: "looplet-spare" };
const asker: Actor = { kind: "system", id: "deep-planning" };
const agent: Actor = { kind: "agent", id: "claude-code", model: "test-model" };
const HABITS = "A personal habit tracker for one person on one phone. No accounts, no login, no cloud sync.";

const factIds = (idea: string) => readDescription(idea).facts.map((f) => f.id);
const fact = (idea: string, id: string) => readDescription(idea).facts.find((f) => f.id === id);

async function setup() {
  const ledger = await Ledger.open(new MemoryStore());
  installNumberingRules(ledger);
  installPlanningRules(ledger);
  const session = new PlanningSession(ledger, { person: "looplet-spare" });
  return { ledger, session };
}

/** Starts like the host does: ask what the description leaves open, record what it settles, answer the rest. */
async function planned(idea: string) {
  const { ledger, session } = await setup();
  const profile = profileIdea(idea);
  session.start(asker, profile);
  const described = session.recordDescriptionFacts(owner, profile);
  for (const q of session.open()) session.answer(owner, q.q, q.recommendation.option ? { choice: q.recommendation.option } : { choice: q.options[0]!.id });
  return { ledger, session, profile, described };
}

describe("readDescription: explicit negatives", () => {
  it("reads no accounts / no login / no sign-in as no sign-in", () => {
    for (const idea of ["A notes app. No accounts.", "notes app with no login", "notes app without sign-in", "notes app, no sign up and no passwords", "It doesn't need accounts."]) {
      expect(factIds(idea)).toEqual(expect.arrayContaining(["auth.signin", "auth.provider", "auth.roles"]));
      expect(fact(idea, "auth.signin")).toMatchObject({ choice: "no-login" });
      expect(fact(idea, "auth.provider")).toMatchObject({ choice: "none" });
    }
    expect(readDescription("No accounts, no login.").ruledOut.map((r) => r.id)).toContain("accounts");
  });

  it("reads single user as one person with no sign-in", () => {
    const d = readDescription("A single-user budgeting tool");
    expect(d.ruledOut.map((r) => r.id)).toContain("single-user");
    expect(fact("A single-user budgeting tool", "auth.signin")).toMatchObject({ choice: "no-login" });
    expect(profileIdea("A single user tool to share recipes").team).toBe("solo");
  });

  it("lets a stated sign-in method beat single user, but never an explicit no login", () => {
    expect(fact("A single user app with Google sign-in", "auth.signin")).toMatchObject({ choice: "oauth" });
    expect(fact("A notes app with magic link sign-in", "auth.signin")).toMatchObject({ choice: "magic-link" });
    expect(fact("No login. Magic link maybe one day.", "auth.signin")).toMatchObject({ choice: "no-login" });
  });

  it("reads lists after one negation", () => {
    const ids = readDescription("A recipe box with no accounts, payments or AI").ruledOut.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(["accounts", "payments", "ai"]));
  });

  it("does not stretch a negation past its words", () => {
    const d = readDescription("A diary with no login that syncs to the cloud");
    expect(d.ruledOut.map((r) => r.id)).toEqual(["accounts"]);
    expect(profileIdea("A diary with no login that syncs to the cloud").signals).toContain("offline");
  });

  it("reads no cloud sync, no backend, offline only, no payments and no AI", () => {
    expect(fact("no cloud sync", "offline.sync-engine")).toMatchObject({ choice: "none" });
    expect(fact("no cloud sync", "offline.conflicts")?.text).toMatch(/not needed/i);
    expect(fact("no backend at all", "stack.hosting")).toMatchObject({ choice: "no-server" });
    expect(fact("no server", "offline.sync-engine")).toMatchObject({ choice: "none" });
    expect(fact("offline only", "offline.required")?.text).toMatch(/offline/i);
    expect(fact("offline only", "offline.sync-engine")).toMatchObject({ choice: "none" });
    expect(fact("free app, no payments", "money.payments")).toMatchObject({ choice: "not-v1" });
    expect(fact("free app, no payments", "money.pricing")).toMatchObject({ choice: "free" });
    expect(fact("free app, no payments", "money.tax-refunds")).toMatchObject({ choice: "not-needed" });
    expect(fact("a plain checklist, no AI", "ai.use")).toMatchObject({ choice: "no" });
    expect(factIds("a plain checklist, no AI")).toEqual(expect.arrayContaining(["ai.model", "ai.fallback", "ai.cost-cap"]));
  });

  it("drops the signals a negation rules out", () => {
    expect(profileIdea(HABITS).signals).not.toContain("offline");
    expect(profileIdea("An invoice tracker. No payments.").signals).not.toContain("payments");
    expect(profileIdea("A chatbot-free planner with no AI").signals).not.toContain("ai");
    expect(profileIdea("works offline, no internet needed").signals).toContain("offline");
  });

  it("finds nothing in an idea that says nothing explicit", () => {
    expect(readDescription("A todo list")).toEqual({ facts: [], ruledOut: [] });
    expect(readDescription("")).toEqual({ facts: [], ruledOut: [] });
  });
});

describe("readDescription: explicit positives", () => {
  it("records the stack the person names", () => {
    expect(fact("A shop on Next.js with Postgres", "stack.framework")).toMatchObject({ choice: "nextjs" });
    expect(fact("A shop on Next.js with Postgres", "data.store")).toMatchObject({ choice: "postgres" });
    expect(fact("Written in TypeScript", "stack.language")).toMatchObject({ choice: "typescript" });
    expect(fact("Uses SQLite, no cloud sync", "data.store")).toMatchObject({ choice: "sqlite-local" });
    expect(fact("Uses SQLite", "data.store")).toMatchObject({ text: "SQLite" });
    expect(fact("A React Native app", "platforms.mobile-stack")).toMatchObject({ text: "React Native" });
    expect(fact("A React Native app", "platforms.mobile-stack")?.choice).toBeUndefined();
    expect(fact("An Expo app", "platforms.mobile-stack")).toMatchObject({ choice: "expo" });
    expect(fact("A Tauri desktop app", "platforms.desktop-shell")).toMatchObject({ choice: "tauri" });
    expect(fact("Takes payments with Stripe", "money.payments")).toMatchObject({ choice: "stripe-checkout" });
    expect(fact("A React app built with Vite", "stack.framework")).toMatchObject({ choice: "vite-react" });
    expect(profileIdea("A React Native app").signals).toContain("mobile");
  });

  it("keeps the person's phrase on every fact", () => {
    expect(fact("Uses SQLite", "data.store")?.phrase).toBe("SQLite");
    expect(fact(HABITS, "auth.signin")?.phrase).toBe("No accounts, no login");
  });

  it("puts what the description settles into known, so it is not asked", () => {
    const profile = profileIdea(HABITS);
    const asked = questionsFor(profile).map((q) => q.id);
    expect(asked.filter((id) => id.startsWith("auth."))).toEqual([]);
    expect(asked).not.toContain("offline.sync-engine");
    expect(profile.described?.map((f) => f.id)).toEqual(expect.arrayContaining(["auth.signin", "offline.sync-engine"]));
  });
});

describe("planning from a description", () => {
  it("a single-person habit tracker gets no sign-in questions and no Sign-in tasks", async () => {
    const { session, ledger } = await planned(HABITS);
    const questions = session.questions();
    for (const q of questions.filter((x) => x.area === "auth")) expect(q).toMatchObject({ status: "decided", source: "description" });
    const asked = ledger.entries().filter((e) => e.type === "question.asked").map((e) => String(e.data?.question));
    expect(asked.some((text) => /sign|log ?in|account/i.test(text) && !questions.find((q) => q.text === text && q.source === "description"))).toBe(false);
    expect(session.blockers()).toEqual([]);
    const roadmap = session.roadmap(HABITS, "looplet-spare");
    const titles = roadmap.phases.flatMap((p) => p.tasks.map((t) => t.title));
    expect(titles.some((t) => /sign[- ]?in|login|account|users and roles/i.test(t))).toBe(false);
    expect(titles).not.toContain("Build Sync engine");
    const labels = Object.values(session.mindMap(HABITS).nodes).map((n) => n.label);
    expect(labels).not.toContain("Sign-in");
  });

  it("records each settled question as the person's decision, with the phrase", async () => {
    const { session, ledger } = await planned("A Tauri desktop app with SQLite. No accounts, no payments.");
    const store = session.questions().find((q) => q.id === "data.store")!;
    expect(store).toMatchObject({ status: "decided", source: "description", phrase: "SQLite" });
    const decision = ledger.bySubject(store.decision!)[0]!;
    expect(decision.actor).toEqual(owner);
    expect(decision.reason).toContain('From your description: "SQLite"');
    expect(decision.data).toMatchObject({ source: "description", phrase: "SQLite" });
    const titles = session.roadmap("x").phases.flatMap((p) => p.tasks.map((t) => t.title));
    expect(titles).not.toContain("Integrate Payments");
  });

  it("does not settle twice, and only a person can settle", async () => {
    const { ledger, session } = await setup();
    const profile = profileIdea(HABITS);
    session.start(asker, profile);
    expect(session.recordDescriptionFacts(owner, profile).length).toBeGreaterThan(0);
    expect(session.recordDescriptionFacts(owner, profile)).toEqual([]);
    const before = ledger.entries().length;
    session.start(asker, profile);
    expect(ledger.entries().length).toBe(before);
    const other = await setup();
    expect(() => other.session.recordDescriptionFacts(agent, profile)).toThrow(/person/);
  });

  it("reopens a settled question so the person can answer it themselves", async () => {
    const { session, ledger } = await setup();
    const profile = profileIdea(HABITS);
    session.start(asker, profile);
    session.recordDescriptionFacts(owner, profile);
    const signin = session.questions().find((q) => q.id === "auth.signin")!;
    const again = session.reopen(owner, signin.q);
    expect(again).not.toBe(signin.q);
    const latest = session.questions().filter((q) => q.id === "auth.signin");
    expect(latest.at(-1)).toMatchObject({ q: again, status: "open", blocking: true });
    expect(planningAnswers(ledger.entries()).find((a) => a.questionId === "auth.signin")).toBeUndefined();
    expect(session.blockers()).toContain(again);
    expect(() => session.reopen(owner, again)).toThrow(PlanningError);
    session.answer(owner, again, { choice: "magic-link" });
    expect(Object.values(session.mindMap(HABITS).nodes).map((n) => n.label)).toContain("Sign-in");
    // Recording the description again leaves the person's own answer alone.
    expect(session.recordDescriptionFacts(owner, profile)).toEqual([]);
  });
});

describe("the person's own tasks", () => {
  it("adds a numbered task.created the agent board sees, refusing an empty title", async () => {
    const { session, ledger } = await setup();
    expect(() => session.addTask(owner, { title: "   " })).toThrow(/title/);
    expect(() => session.addTask(agent, { title: "Export to CSV" })).toThrow(/person/);
    const added = session.addTask(owner, { title: "Export habits to CSV", doneWhen: "a test exports three habits", refs: ["C-2"], phase: "integrations" });
    expect(added.task).toMatch(/^T-\d+$/);
    const entry = ledger.bySubject(added.task)[0]!;
    expect(entry).toMatchObject({ type: "task.created", actor: owner, summary: "Export habits to CSV", refs: ["C-2"] });
    expect(entry.data).toMatchObject({ title: "Export habits to CSV", doneWhen: "a test exports three habits", phase: "integrations", owner: "looplet-spare", source: "person" });
    expect(foldBoard(ledger.entries()).get(added.task)).toMatchObject({ title: "Export habits to CSV", status: "open", clauses: ["C-2"] });
    expect(session.ownTasks()).toEqual([expect.objectContaining({ task: added.task, title: "Export habits to CSV", phase: "integrations" })]);
  });

  it("drops a draft roadmap task before approval, and the written roadmap leaves it out", async () => {
    const { session, ledger } = await planned(HABITS);
    const draft = session.roadmap(HABITS, "looplet-spare");
    const tasks = draft.phases.flatMap((p) => p.tasks);
    const victim = tasks.find((t) => t.key !== "K-first-release" && tasks.some((o) => o.dependsOn.includes(t.key)))!;
    expect(() => session.dropRoadmapTask(owner, "K-first-release")).toThrow(PlanningError);
    expect(() => session.dropRoadmapTask(owner, "K-nope")).toThrow(PlanningError);
    expect(() => session.dropRoadmapTask(agent, victim.key)).toThrow(/person/);
    session.dropRoadmapTask(owner, victim.key, "Not for v1");
    expect(session.droppedRoadmapKeys()).toEqual([victim.key]);
    const after = session.roadmap(HABITS, "looplet-spare");
    const keys = after.phases.flatMap((p) => p.tasks.map((t) => t.key));
    expect(keys).not.toContain(victim.key);
    for (const t of after.phases.flatMap((p) => p.tasks)) expect(t.dependsOn).not.toContain(victim.key);
    session.restoreRoadmapTask(owner, victim.key);
    expect(session.droppedRoadmapKeys()).toEqual([]);
    session.dropRoadmapTask(owner, victim.key);
    const written = session.writeRoadmap(owner, session.roadmap(HABITS, "looplet-spare"));
    expect(written[victim.key]).toBeUndefined();
    expect(ledger.entries().some((e) => e.type === "task.created" && e.data?.key === victim.key)).toBe(false);
    expect(() => session.dropRoadmapTask(owner, tasks.find((t) => t.key !== victim.key && t.key !== "K-first-release")!.key)).toThrow(/already/);
  });
});
