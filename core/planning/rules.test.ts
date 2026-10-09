import { describe, expect, it } from "vitest";
import { Ledger, LedgerError, MemoryStore, type Actor } from "../ledger/index";
import { appendNumbered, installNumberingRules } from "../numbering/index";
import { installPlanningRules } from "./rules";

const NOW = new Date("2026-10-09T05:00:00Z");
const person: Actor = { kind: "person", id: "looplet-spare" };
const worker: Actor = { kind: "agent", id: "worker-1", model: "test-model" };

async function setup(scope?: "planning" | "all") {
  const ledger = await Ledger.open(new MemoryStore());
  installNumberingRules(ledger);
  const remove = installPlanningRules(ledger, { now: () => NOW, ...(scope ? { scope } : {}) });
  return { ledger, remove };
}

function ask(ledger: Ledger, opts: { planning: boolean; blocking: boolean }) {
  return appendNumbered(ledger, {
    actor: worker,
    type: "question.asked",
    summary: "Which store?",
    data: {
      task: "plan",
      person: "looplet-spare",
      question: "Which store?",
      options: [],
      blocking: opts.blocking,
      ...(opts.planning ? { planning: { id: "data.store", area: "data", options: [], recommendation: { option: "", reason: "", confidence: 0 } } } : {}),
    },
  }).subject;
}

function approve(ledger: Ledger) {
  return appendNumbered(ledger, { actor: person, type: "plan.approved", summary: "Plan approved", refs: [] });
}

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(LedgerError);
    expect((e as LedgerError).code).toBe("RULE");
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("planning ledger rules", () => {
  it("gates plan.approved on open planning blockers only, by default", async () => {
    const { ledger } = await setup();
    ask(ledger, { planning: false, blocking: true });
    ask(ledger, { planning: true, blocking: false });
    expect(approve(ledger).subject).toBe("P-1");
    const q = ask(ledger, { planning: true, blocking: true });
    expect(refusal(() => approve(ledger))).toMatch(new RegExp(`open: ${q}`));
  });

  it("with scope all, any open blocking question gates approval", async () => {
    const { ledger } = await setup("all");
    ask(ledger, { planning: false, blocking: true });
    expect(refusal(() => approve(ledger))).toMatch(/Q-1/);
  });

  it("refuses a deferring decision or answer however it is written (for example by the relay)", async () => {
    const { ledger } = await setup();
    const q = ask(ledger, { planning: true, blocking: true });
    expect(
      refusal(() =>
        appendNumbered(ledger, { actor: person, type: "decision.made", summary: "TBD later", reason: "Answer", data: { question: q, answer: "We'll figure it out later" } }),
      ),
    ).toMatch(/deferral/);
    expect(refusal(() => ledger.append({ actor: person, type: "question.answered", subject: q, summary: "not sure", data: { answer: "not sure", via: "main" } }))).toMatch(
      /deferral/,
    );
    const d = appendNumbered(ledger, { actor: person, type: "decision.made", summary: "Postgres", reason: "Answer", data: { question: q, answer: "Postgres" } });
    ledger.append({ actor: person, type: "question.answered", subject: q, summary: "Postgres", data: { answer: "Postgres", decision: d.subject, via: "main" } });
    expect(refusal(() => ledger.append({ actor: person, type: "question.answered", subject: q, summary: "SQLite", data: { answer: "SQLite" } }))).toMatch(/already answered/);
    expect(approve(ledger).subject).toBe("P-1");
  });

  it("leaves relay questions alone", async () => {
    const { ledger } = await setup();
    const q = ask(ledger, { planning: false, blocking: true });
    ledger.append({ actor: person, type: "question.answered", subject: q, summary: "maybe later", data: { answer: "maybe later" } });
    expect(ledger.entries()).toHaveLength(2);
  });

  it("a spike answer must point at a real spike task with a date and a risk", async () => {
    const { ledger } = await setup();
    const q = ask(ledger, { planning: true, blocking: true });
    expect(refusal(() => ledger.append({ actor: person, type: "question.answered", subject: q, summary: "Spike", data: { via: "spike", spike: { task: "T-1" } } }))).toMatch(
      /not a spike task/,
    );
    expect(
      refusal(() => appendNumbered(ledger, { actor: person, type: "task.created", summary: "Spike", data: { spike: { question: q, due: "2026-10-01", risk: "A real risk here." } } })),
    ).toMatch(/already past/);
    appendNumbered(ledger, { actor: person, type: "task.created", summary: "Ordinary task", data: { change: "feature" } });
    expect(refusal(() => ledger.append({ actor: person, type: "question.answered", subject: q, summary: "Spike", data: { via: "spike", spike: { task: "T-1" } } }))).toMatch(
      /not a spike task/,
    );
    const t = appendNumbered(ledger, { actor: person, type: "task.created", summary: "Spike", data: { spike: { question: q, due: "2026-10-12", risk: "A wrong pick forces a migration." } } });
    ledger.append({ actor: person, type: "question.answered", subject: q, summary: "Spike", data: { via: "spike", spike: { task: t.subject, due: "2026-10-12", risk: "x" } } });
    expect(approve(ledger).subject).toBe("P-1");
  });

  it("can be removed", async () => {
    const { ledger, remove } = await setup();
    ask(ledger, { planning: true, blocking: true });
    remove();
    expect(approve(ledger).subject).toBe("P-1");
  });
});
