import { describe, expect, it } from "vitest";
import { Ledger, MemoryStore, type Actor } from "../ledger/index";
import { appendNumbered, installNumberingRules } from "../numbering/index";
import { installPlanningRules } from "./rules";
import { PlanningError, PlanningSession } from "./session";
import { profileIdea } from "./profile";
import { openBlockers, planningAnswers } from "./state";
import type { PlanningQuestion } from "./types";

const NOW = new Date("2026-10-09T05:00:00Z");
const owner: Actor = { kind: "person", id: "looplet-spare" };
const agent: Actor = { kind: "agent", id: "claude-code", model: "test-model" };

const storeQ: PlanningQuestion = {
  id: "data.store",
  area: "data",
  text: "Where does the data live?",
  why: "Moving data later means a migration for every user.",
  blocking: true,
  options: [
    { id: "sqlite-sync", label: "SQLite on device, synced", fit: "Offline-first apps" },
    { id: "postgres", label: "Postgres", fit: "Server-first apps" },
  ],
  recommendation: { option: "sqlite-sync", reason: "The idea must work offline.", confidence: 0.85, sources: [{ title: "SQLite", url: "https://sqlite.org" }] },
};
const taxQ: PlanningQuestion = {
  id: "money.tax-refunds",
  area: "money",
  text: "How are tax and refunds handled?",
  why: "Nice to know.",
  blocking: false,
  options: [{ id: "none", label: "Not in v1", fit: "No payments" }],
  recommendation: { option: "none", reason: "No payments yet.", confidence: 0.5 },
};

async function setup() {
  const ledger = await Ledger.open(new MemoryStore());
  installNumberingRules(ledger);
  installPlanningRules(ledger, { now: () => NOW });
  const session = new PlanningSession(ledger, { person: "looplet-spare", now: () => NOW });
  return { ledger, session };
}

function approve(ledger: Ledger) {
  return appendNumbered(ledger, { actor: owner, type: "plan.approved", summary: "Plan approved", refs: [] });
}

describe("PlanningSession", () => {
  it("asks questions as relay-compatible question.asked entries, once", async () => {
    const { ledger, session } = await setup();
    const q = session.ask(agent, storeQ);
    expect(q).toBe("Q-1");
    expect(session.ask(agent, storeQ)).toBe("Q-1");
    const entry = ledger.entries()[0];
    expect(entry.type).toBe("question.asked");
    expect(entry.data).toMatchObject({ task: "plan", person: "looplet-spare", question: storeQ.text, blocking: true, options: ["SQLite on device, synced", "Postgres"] });
    expect(entry.data?.planning).toMatchObject({ id: "data.store", area: "data" });
    expect(session.blockers()).toEqual(["Q-1"]);
  });

  it("blocks plan approval until the blocker is decided", async () => {
    const { ledger, session } = await setup();
    session.ask(agent, storeQ);
    session.ask(agent, taxQ);
    expect(() => approve(ledger)).toThrow(/blocking question is open: Q-1/);
    const result = session.answer(owner, "Q-1", { choice: "sqlite-sync" });
    expect(result).toEqual({ q: "Q-1", status: "decided", decision: "D-1", answer: "SQLite on device, synced" });
    const decision = ledger.get("L-000003")!;
    expect(decision.reason).toBe("Recommended: The idea must work offline.");
    expect(decision.evidence).toEqual(["https://sqlite.org"]);
    expect(approve(ledger).subject).toBe("P-1");
  });

  it("refuses deferrals and keeps the question open", async () => {
    const { session } = await setup();
    session.ask(agent, storeQ);
    for (const text of ["TBD", "we'll figure it out later", "not sure"]) {
      const error = (() => {
        try {
          session.answer(owner, "Q-1", { text });
        } catch (e) {
          return e as PlanningError;
        }
      })();
      expect(error?.code).toBe("DEFERRED");
    }
    expect(session.open().map((q) => q.q)).toEqual(["Q-1"]);
  });

  it("turns a deferral into a dated spike task, which unblocks approval", async () => {
    const { ledger, session } = await setup();
    session.ask(agent, storeQ);
    const result = session.answer(owner, "Q-1", { text: "TBD", spike: { due: "2026-10-16", risk: "A wrong store choice forces a migration for every user." } });
    expect(result).toMatchObject({ status: "spiked", task: "T-1", due: "2026-10-16" });
    const task = ledger.bySubject("T-1")[0];
    expect(task.type).toBe("task.created");
    expect(task.data).toMatchObject({ spike: { question: "Q-1", due: "2026-10-16" }, owner: "looplet-spare", change: "fix" });
    expect(session.questions()[0]).toMatchObject({ status: "spiked", spike: { task: "T-1" } });
    expect(openBlockers(ledger.entries())).toEqual([]);
    expect(approve(ledger).subject).toBe("P-1");
  });

  it("refuses a bad spike", async () => {
    const { session } = await setup();
    session.ask(agent, storeQ);
    expect(() => session.answer(owner, "Q-1", { spike: { due: "soon", risk: "Something real breaks." } })).toThrow(PlanningError);
    expect(() => session.answer(owner, "Q-1", { spike: { due: "2026-10-16", risk: "tbd" } })).toThrow(/risk/);
  });

  it("validates choices and refuses double answers", async () => {
    const { session } = await setup();
    session.ask(agent, storeQ);
    expect(() => session.answer(owner, "Q-1", { choice: "mongo" })).toThrow(/not an option/);
    expect(() => session.answer(owner, "Q-9", { text: "Postgres" })).toThrow(/not a planning question/);
    expect(() => session.answer(owner, "Q-1", {})).toThrow(/needs an answer/);
    session.answer(owner, "Q-1", { choice: "postgres", text: "on Supabase", reason: "Team already runs it." });
    expect(session.questions()[0]).toMatchObject({ status: "decided", answer: "Postgres: on Supabase", choice: "postgres", decision: "D-1" });
    expect(() => session.answer(owner, "Q-1", { text: "SQLite" })).toThrow(/already answered/);
  });

  it("one tap accepts confident recommendations only", async () => {
    const { session } = await setup();
    session.ask(agent, storeQ);
    session.ask(agent, taxQ);
    const decided = session.acceptRecommendations(owner);
    expect(decided.map((d) => d.q)).toEqual(["Q-1"]);
    expect(session.open().map((q) => q.q)).toEqual(["Q-2"]);
  });

  it("catches TBD lines in a plan and asks each as a blocker", async () => {
    const { ledger, session } = await setup();
    const asked = session.catchText(agent, "Stack: Tauri\nAuth: TBD\nPayments: later", "P-1 draft");
    expect(asked).toEqual(["Q-1", "Q-2"]);
    expect(session.blockers()).toEqual(["Q-1", "Q-2"]);
    expect(() => approve(ledger)).toThrow(/2 blocking questions are open/);
    session.answer(owner, "Q-1", { text: "Email magic link" });
    session.answer(owner, "Q-2", { text: "Not in v1", reason: "No paying users yet" });
    expect(approve(ledger).subject).toBe("P-1");
  });

  it("runs the whole loop: idea, packs, answers, mind map, roadmap, tasks", async () => {
    const { ledger, session } = await setup();
    const profile = profileIdea("A desktop invoice app with payments that works offline");
    const asked = session.start(agent, profile);
    expect(asked.length).toBeGreaterThanOrEqual(30);
    expect(session.start(agent, profile)).toEqual(asked);
    expect(() => session.writeRoadmap(owner, session.roadmap(profile.idea))).toThrow(/blocking questions first/);
    for (const q of session.open()) {
      const choice = q.recommendation.option || q.options[0].id;
      session.answer(owner, q.q, { choice });
    }
    expect(session.blockers()).toEqual([]);
    expect(planningAnswers(ledger.entries())).toHaveLength(asked.length);
    const map = session.mindMap(profile.idea);
    expect(Object.keys(map.nodes).length).toBeGreaterThan(3);
    const roadmap = session.roadmap(profile.idea, "looplet-spare");
    const written = session.writeRoadmap(owner, roadmap);
    const tasks = Object.values(written);
    expect(tasks[0]).toMatch(/^T-\d+$/);
    expect(ledger.bySubject(tasks[0])[0].data).toMatchObject({ source: "planning", owner: "looplet-spare" });
    expect(Array.isArray(session.depth(profile.idea))).toBe(true);
    expect(approve(ledger).subject).toBe("P-1");
  });
});

describe("PlanningSession.startWithResearch", () => {
  it("attaches research sources to the asked questions and survives a failing lookup", async () => {
    const { createMockProvider } = await import("./research");
    const { ledger, session } = await setup();
    const profile = profileIdea("A desktop invoice app with payments");
    let calls = 0;
    const provider = createMockProvider(() => {
      calls += 1;
      if (calls === 1) throw new Error("rate limited");
      return { answer: "Compared.", sources: [{ title: "Docs", url: "https://example.com/docs" }] };
    });
    const { asked, researched, failed } = await session.startWithResearch(agent, profile, provider);
    expect(asked.length).toBeGreaterThan(0);
    expect(failed).toHaveLength(1);
    expect(researched).toBeGreaterThan(0);
    const withSources = ledger.entries().filter((e) => {
      const meta = e.data?.planning as { recommendation?: { sources?: { url: string }[] } } | undefined;
      return meta?.recommendation?.sources?.some((s) => s.url === "https://example.com/docs");
    });
    expect(withSources).toHaveLength(researched);
  });
});
