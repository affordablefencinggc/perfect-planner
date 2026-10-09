import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "../ledger/index";
import { markVerified, needsSignature } from "../ledger/signing";
import { openBlockers, planningAnswers, planningQuestions } from "./state";

// Entries as they might sit in a stored ledger written before the rules were
// installed: the views must still only take a person's answer as the user's.
function entry(n: number, partial: Partial<LedgerEntry>): LedgerEntry {
  const e = { n: `L-${String(n).padStart(6, "0")}`, at: "2026-10-09T06:00:00Z", evidence: [], refs: [], prev: "", hash: "", summary: "x", subject: "", type: "question.asked", actor: { kind: "system", id: "test" }, ...partial } as LedgerEntry;
  // As if the ledger had checked a person's or the system's signature on open.
  if (needsSignature(e.actor)) markVerified(e);
  return e;
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

  it("takes a person's answer", () => {
    const entries = [
      asked,
      entry(2, { type: "decision.made", subject: "D-1", actor: { kind: "person", id: "looplet-spare" }, data: { question: "Q-1", answer: "SQLite", choice: "sqlite" } }),
      entry(3, { type: "question.answered", subject: "Q-1", actor: { kind: "person", id: "looplet-spare" }, data: { answer: "SQLite", decision: "D-1", via: "main" } }),
    ];
    expect(openBlockers(entries)).toEqual([]);
    expect(planningAnswers(entries)).toMatchObject([{ questionId: "data.store", choice: "sqlite", text: "SQLite", decision: "D-1" }]);
  });
});
