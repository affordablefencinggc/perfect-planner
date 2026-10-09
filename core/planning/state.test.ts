import { describe, expect, it } from "vitest";
import { Ledger, MemoryStore, type LedgerEntry } from "../ledger/index";
import { appendNumbered } from "../numbering/index";
import { openBlockers, planningAnswers, planningQuestions } from "./state";

// Entries as they might sit in a stored ledger written before the rules were
// installed: the views must still only take a person's answer as the user's.
function entry(n: number, partial: Partial<LedgerEntry>): LedgerEntry {
  return { n: `L-${String(n).padStart(6, "0")}`, at: "2026-10-09T06:00:00Z", evidence: [], refs: [], prev: "", hash: "", summary: "x", subject: "", type: "question.asked", actor: { kind: "system", id: "test" }, ...partial } as LedgerEntry;
}

const asked = entry(1, {
  type: "question.asked",
  subject: "Q-1",
  actor: { kind: "agent", id: "claude-code", model: "m" },
  data: { question: "Where does data live?", blocking: true, planning: { id: "data.store", area: "data", options: [], recommendation: { option: "", reason: "", confidence: 0 } } },
});

describe("planning views trust only a person's answer", () => {
  it("ignores an agent's or Jev's answer and decision, even with a payload claiming a person", () => {
    const entries = [
      asked,
      entry(2, { type: "decision.made", subject: "D-1", actor: { kind: "jev", id: "jev", model: "j" }, data: { question: "Q-1", answer: "Postgres", answeredBy: "person" } }),
      entry(3, { type: "question.answered", subject: "Q-1", actor: { kind: "agent", id: "claude-code", model: "m" }, data: { answer: "Postgres", via: "main", person: "looplet-spare" } }),
      entry(4, { type: "question.answered", subject: "Q-1", actor: { kind: "system", id: "watcher" }, data: { answer: "Postgres", via: "main" } }),
    ];
    expect(openBlockers(entries)).toEqual(["Q-1"]);
    expect(planningQuestions(entries)[0].status).toBe("open");
    expect(planningAnswers(entries)).toEqual([]);
  });

  it("takes a person's answer written through the signed person path", async () => {
    const ledger = await Ledger.open(new MemoryStore());
    const agent = { kind: "agent" as const, id: "claude-code", model: "m" };
    const person = { kind: "person" as const, id: "looplet-spare" };
    appendNumbered(ledger, { actor: agent, type: "question.asked", summary: "Where does data live?", data: asked.data });
    const d = appendNumbered(ledger, { actor: person, type: "decision.made", summary: "SQLite", reason: "Answer to Q-1", data: { question: "Q-1", answer: "SQLite", choice: "sqlite" } });
    ledger.append({ actor: person, type: "question.answered", subject: "Q-1", summary: "SQLite", data: { answer: "SQLite", decision: d.subject, via: "main" } });
    expect(d.sig).toBeDefined();
    expect(openBlockers(ledger.entries())).toEqual([]);
    expect(planningAnswers(ledger.entries())).toMatchObject([{ questionId: "data.store", choice: "sqlite", text: "SQLite", decision: "D-1" }]);
  });

  it("does not take a copy of a person's entry that was never verified by a ledger", async () => {
    const ledger = await Ledger.open(new MemoryStore());
    const person = { kind: "person" as const, id: "looplet-spare" };
    appendNumbered(ledger, { actor: { kind: "agent", id: "claude-code", model: "m" }, type: "question.asked", summary: "Where does data live?", data: asked.data });
    const d = appendNumbered(ledger, { actor: person, type: "decision.made", summary: "SQLite", reason: "Answer to Q-1", data: { question: "Q-1", answer: "SQLite" } });
    const answered = ledger.append({ actor: person, type: "question.answered", subject: "Q-1", summary: "SQLite", data: { answer: "SQLite", decision: d.subject, via: "main" } });
    const copies = ledger.entries().map((e) => JSON.parse(JSON.stringify(e)) as LedgerEntry);
    expect(answered.sig).toBeDefined();
    expect(openBlockers(copies)).toEqual(["Q-1"]);
  });
});
