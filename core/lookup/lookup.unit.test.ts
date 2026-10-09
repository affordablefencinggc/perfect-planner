import { describe, expect, it } from "vitest";
import { Ledger, MemoryStore, type LedgerEntry } from "../ledger/index";
import { appendNumbered, cutRelease, installNumberingRules, rollbackRelease } from "../numbering/index";
import { addClause, addPlanText, installClauseRules, withdrawClause } from "./clauses";
import { lookup, search } from "./lookup";
import { renderLedger, renderPlan, renderReleaseNotes, renderTask } from "./views";

const owner = { kind: "person" as const, id: "owner" };
const agent = { kind: "agent" as const, id: "claude-code", model: "m1" };
const gate = { kind: "system" as const, id: "gate" };

const PLAN = "# Plan\n\n## 1. Scope\n\nBuild the thing.\n\n- Must be fast\n";

function open(): Ledger {
  const ledger = Ledger.openSync(new MemoryStore(), { now: () => new Date("2026-10-09T00:00:00Z") });
  installNumberingRules(ledger);
  installClauseRules(ledger);
  return ledger;
}

/**
 * L-000001..L-000003 plan clauses; L-000004 P-1; L-000005..L-000010 T-1 done
 * (commit abc1234); L-000011 Q-1; L-000012 D-1; L-000013 correction of D-1;
 * L-000014 R-1 (v1.0.0, covering L-000001..L-000013); L-000015 Q-2 still open.
 */
function shipped(): Ledger {
  const ledger = open();
  addPlanText(ledger, owner, PLAN);
  appendNumbered(ledger, { actor: owner, type: "plan.approved", summary: "Plan approved", evidence: [], refs: [] });
  appendNumbered(ledger, {
    actor: gate,
    type: "task.created",
    summary: "Build the thing",
    evidence: [],
    refs: ["P-1 §1.1"],
    data: { change: "feature" },
  });
  ledger.append({ actor: owner, type: "test.defined", subject: "T-1", summary: "test defined", evidence: [], refs: [], data: { test: "npm test" } });
  ledger.append({ actor: owner, type: "test.approved", subject: "T-1", summary: "test approved", evidence: [], refs: [], data: { test: "npm test" } });
  ledger.append({ actor: gate, type: "commit.observed", subject: "T-1", summary: "commit observed", evidence: ["commit:abc1234"], refs: [], data: { sha: "abc1234" } });
  ledger.append({ actor: gate, type: "test.passed", subject: "T-1", summary: "test passed", evidence: [], refs: [], data: { test: "npm test" } });
  ledger.append({ actor: gate, type: "task.done", subject: "T-1", summary: "task finished", evidence: [], refs: [] });
  appendNumbered(ledger, {
    actor: agent,
    type: "question.asked",
    summary: "Which database?",
    evidence: [],
    refs: [],
    data: { question: "Which database?", task: "T-1" },
  });
  const question = ledger.entries().find((e) => e.type === "question.asked")!;
  const decision = appendNumbered(ledger, {
    actor: owner,
    type: "decision.made",
    summary: "Use SQLite for storage",
    reason: "simplest",
    evidence: [],
    refs: [],
    data: { question: question.subject, text: "Use SQLite" },
  });
  ledger.append({ actor: owner, type: "correction", subject: "D-1", summary: "Reworded decision", reason: "typo", evidence: [], refs: [], corrects: decision.n });
  cutRelease(ledger, owner, { commit: "abc1234" });
  appendNumbered(ledger, { actor: agent, type: "question.asked", summary: "Which region?", evidence: [], refs: [], data: { question: "Which region?" } });
  return ledger;
}

const byType = (entries: readonly LedgerEntry[], type: LedgerEntry["type"]) => entries.filter((e) => e.type === type);

describe("lookup: clauses", () => {
  it("resolves a plan-qualified clause with its text, history, citing tasks and commits", () => {
    const entries = shipped().entries();
    const result = lookup(entries, "P-1 §1.1");
    expect(result).toMatchObject({ found: true, kind: "clause", text: "Build the thing.", status: "active", tasks: ["T-1"], commits: ["abc1234"] });
    expect(result.history.map((e) => e.n)).toEqual(["L-000002"]);
    expect(result.citedBy.map((e) => e.subject)).toEqual(["T-1"]);
  });

  it("resolves a bare clause against the current draft", () => {
    const result = lookup(shipped().entries(), "§1.2");
    expect(result).toMatchObject({ found: true, kind: "clause", text: "Must be fast", status: "active" });
  });

  it("reports an unapproved plan", () => {
    const result = lookup(shipped().entries(), "P-2 §1.1");
    expect(result).toMatchObject({ found: false, kind: "clause", problem: "P-2 has not been approved" });
  });

  it("reports a clause added after the plan was approved", () => {
    const ledger = shipped();
    addClause(ledger, owner, { after: "1", text: "Late clause" });
    const entries = ledger.entries();
    expect(lookup(entries, "P-1 §1.3")).toMatchObject({ found: false, problem: "§1.3 was added after P-1" });
    expect(lookup(entries, "§1.3")).toMatchObject({ found: true, text: "Late clause" });
  });

  it("reports a clause that does not exist at all", () => {
    expect(lookup(shipped().entries(), "§9")).toMatchObject({ found: false, problem: "§9 does not exist" });
  });
});

describe("lookup: plans", () => {
  it("resolves an approved plan with its clauses and the tasks citing it", () => {
    const result = lookup(shipped().entries(), "P-1");
    expect(result).toMatchObject({ found: true, kind: "plan", status: "current", tasks: ["T-1"], commits: ["abc1234"] });
    expect(result.text).toContain("§1 Scope");
    expect(result.text).toContain("§1.1 Build the thing.");
    expect(result.text).toContain("§1.2 Must be fast");
    expect(result.history.map((e) => e.type)).toEqual(["plan.approved"]);
  });

  it("does not show clauses added after the plan was approved", () => {
    const ledger = shipped();
    addClause(ledger, owner, { after: "1", text: "Late clause" });
    expect(lookup(ledger.entries(), "P-1").text).not.toContain("Late clause");
  });

  it("marks an older plan superseded once a newer one is approved", () => {
    const ledger = shipped();
    appendNumbered(ledger, { actor: owner, type: "plan.approved", summary: "Plan two", evidence: [], refs: [] });
    expect(lookup(ledger.entries(), "P-1").status).toBe("superseded");
    expect(lookup(ledger.entries(), "P-2").status).toBe("current");
  });

  it("reports a plan that was never approved", () => {
    expect(lookup(shipped().entries(), "P-2")).toMatchObject({ found: false, kind: "plan", problem: "P-2 has not been approved" });
  });
});

describe("lookup: tasks", () => {
  it("resolves a finished task with its history and commits", () => {
    const result = lookup(shipped().entries(), "T-1");
    expect(result).toMatchObject({ found: true, kind: "task", ref: "T-1", text: "Build the thing", status: "done, attempt 1", tasks: ["T-1"], commits: ["abc1234"] });
    expect(result.history.map((e) => e.type)).toEqual(["task.created", "test.defined", "test.approved", "commit.observed", "test.passed", "task.done"]);
  });

  it("follows the attempt after a reopen", () => {
    const ledger = shipped();
    ledger.append({ actor: owner, type: "task.reopened", subject: "T-1", summary: "regressed", reason: "login broke", evidence: [], refs: [] });
    const result = lookup(ledger.entries(), "T-1.a2");
    expect(result).toMatchObject({ found: true, ref: "T-1.a2", status: "reopened, attempt 2" });
  });

  it("reports a task that was never created", () => {
    expect(lookup(shipped().entries(), "T-99")).toMatchObject({ found: false, kind: "task", problem: "T-99 was never created" });
  });
});

describe("lookup: questions and decisions", () => {
  it("resolves an answered question with its decision in the history", () => {
    const result = lookup(shipped().entries(), "Q-1");
    expect(result).toMatchObject({ found: true, kind: "question", text: "Which database?", status: "answered", tasks: ["T-1"] });
    expect(result.history.map((e) => e.type)).toEqual(["question.asked", "decision.made"]);
  });

  it("reports an open question", () => {
    expect(lookup(shipped().entries(), "Q-2")).toMatchObject({ found: true, status: "open" });
  });

  it("reports a question that was never asked", () => {
    expect(lookup(shipped().entries(), "Q-9")).toMatchObject({ found: false, kind: "question", problem: "Q-9 was never asked" });
  });

  it("resolves a corrected decision with its correction and the decision text", () => {
    const result = lookup(shipped().entries(), "D-1");
    expect(result).toMatchObject({ found: true, kind: "decision", text: "Use SQLite", status: "corrected" });
    expect(result.history.map((e) => e.type)).toEqual(["decision.made", "correction"]);
  });

  it("reports a decision that was never made", () => {
    expect(lookup(shipped().entries(), "D-9")).toMatchObject({ found: false, problem: "D-9 was never made" });
  });
});

describe("lookup: ledger entries", () => {
  it("resolves an entry by number and shows the correction that corrects it", () => {
    const entries = shipped().entries();
    const decision = byType(entries, "decision.made")[0];
    const correction = byType(entries, "correction")[0];
    const result = lookup(entries, decision.n);
    expect(result).toMatchObject({ found: true, kind: "entry", status: `corrected by ${correction.n}` });
    expect(result.history.map((e) => e.n)).toEqual([decision.n, correction.n]);
  });

  it("resolves an uncorrected entry by its summary and type", () => {
    const entries = shipped().entries();
    const result = lookup(entries, "L-000002");
    expect(result).toMatchObject({ found: true, kind: "entry", text: "Added §1.1: Build the thing.", status: "clause.added" });
  });

  it("reports an entry number that does not exist", () => {
    expect(lookup(shipped().entries(), "L-999999")).toMatchObject({ found: false, kind: "entry", problem: "L-999999 does not exist" });
  });
});

describe("lookup: releases", () => {
  it("resolves a release with its stamp, covered range, tasks and commits", () => {
    const entries = shipped().entries();
    const result = lookup(entries, "R-1");
    expect(result).toMatchObject({ found: true, kind: "release", status: "release", tasks: ["T-1"], commits: ["abc1234"] });
    expect(result.text).toBe("R-1 · v1.0.0 · P-1 · L-000014 · abc1234");
    expect(result.range!.map((e) => e.n)[0]).toBe("L-000001");
    expect(result.range!.at(-1)!.n).toBe("L-000013");
  });

  it("reports a release that was never cut", () => {
    expect(lookup(shipped().entries(), "R-5")).toMatchObject({ found: false, kind: "release", problem: "R-5 was never released" });
  });

  it("marks a rollback with what it restores", () => {
    const ledger = shipped();
    appendNumbered(ledger, { actor: agent, type: "question.asked", summary: "Another question", evidence: [], refs: [] });
    cutRelease(ledger, owner, { commit: "def5678" }); // R-2
    rollbackRelease(ledger, owner, { to: "R-1", reason: "bad deploy" }); // R-3
    expect(lookup(ledger.entries(), "R-3")).toMatchObject({ found: true, status: "rollback to R-1" });
  });
});

describe("lookup: input that is not a reference", () => {
  it("explains what a reference looks like", () => {
    const result = lookup(shipped().entries(), "garbage");
    expect(result.found).toBe(false);
    expect(result.kind).toBeUndefined();
    expect(result.problem).toMatch(/is not a reference/);
  });
});

describe("search", () => {
  it("finds clauses by words", () => {
    const hits = search(shipped().entries(), "fast");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ ref: "§1.2", kind: "clause", text: "Must be fast" });
  });

  it("finds ledger entries by words in their summary or reason", () => {
    const entries = shipped().entries();
    const decision = byType(entries, "decision.made")[0];
    const hits = search(entries, "sqlite");
    expect(hits.map((h) => h.ref)).toContain(decision.n);
    expect(hits.find((h) => h.ref === decision.n)).toMatchObject({ kind: "entry" });
  });

  it("resolves a reference directly", () => {
    expect(search(shipped().entries(), "P-1")).toEqual([{ ref: "P-1", kind: "plan", text: expect.any(String), score: 100 }]);
    expect(search(shipped().entries(), "§1.1")[0]).toMatchObject({ ref: "§1.1", kind: "clause", text: "Build the thing." });
    expect(search(shipped().entries(), "T-1")[0]).toMatchObject({ ref: "T-1", kind: "task", text: "Build the thing" });
  });

  it("returns nothing for words that match nothing or for a blank query", () => {
    expect(search(shipped().entries(), "zzzzqqq")).toEqual([]);
    expect(search(shipped().entries(), "   ")).toEqual([]);
  });

  it("respects the limit", () => {
    expect(search(shipped().entries(), "thing", 1)).toHaveLength(1);
    expect(search(shipped().entries(), "thing").length).toBeGreaterThan(1);
  });

  it("still finds a withdrawn clause by its words", () => {
    const ledger = shipped();
    withdrawClause(ledger, owner, "1.2", "dropped");
    const hits = search(ledger.entries(), "fast");
    expect(hits.map((h) => h.ref)).toContain("§1.2");
  });
});

describe("render: plan", () => {
  it("lists an approved plan's clauses with their numbers", () => {
    const text = renderPlan(shipped().entries(), "P-1");
    expect(text).toContain("# Plan P-1");
    expect(text).toContain("Approved ");
    expect(text).toContain("by owner in L-000004.");
    expect(text).toContain("## §1 Scope");
    expect(text).toContain("§1.1 Build the thing.");
    expect(text).toContain("- §1.2 Must be fast");
    expect(text).not.toContain("## Withdrawn");
  });

  it("shows withdrawn clauses in a Withdrawn section of the draft, struck through", () => {
    const ledger = shipped();
    withdrawClause(ledger, owner, "1.2", "not doing it");
    const draft = renderPlan(ledger.entries());
    expect(draft).toContain("# Plan (draft)");
    expect(draft).toContain("## Withdrawn");
    expect(draft).toContain("- §1.2 withdrawn in L-000016: ~~Must be fast~~");
    expect(draft).not.toMatch(/^- §1\.2 Must be fast$/m);
    // The approved version still shows the clause as it was approved.
    expect(renderPlan(ledger.entries(), "P-1")).toContain("- §1.2 Must be fast");
  });

  it("says so for a plan that was never approved", () => {
    expect(renderPlan(shipped().entries(), "P-7")).toContain("P-7 has not been approved.");
  });
});

describe("render: release notes", () => {
  it("lists the stamp, the range and the tasks, decisions and corrections in it", () => {
    const text = renderReleaseNotes(shipped().entries(), "R-1");
    expect(text).toContain("# R-1 v1.0.0");
    expect(text).toContain("`R-1 · v1.0.0 · P-1 · L-000014 · abc1234`");
    expect(text).toContain("Ledger range L-000001 to L-000013 (13 entries).");
    expect(text).toContain("## Done");
    expect(text).toContain("- T-1: Build the thing (L-000010)");
    expect(text).toContain("## Decisions");
    expect(text).toContain("- D-1: Use SQLite for storage (L-000012)");
    expect(text).toContain("## Corrections");
    expect(text).toContain("- L-000013 corrects L-000012: Reworded decision");
  });

  it("says a rollback restores another release, and notes an empty range", () => {
    const ledger = shipped();
    appendNumbered(ledger, { actor: agent, type: "question.asked", summary: "Another question", evidence: [], refs: [] });
    cutRelease(ledger, owner, { commit: "def5678" }); // R-2
    rollbackRelease(ledger, owner, { to: "R-1", reason: "bad deploy" }); // R-3
    const text = renderReleaseNotes(ledger.entries(), "R-3");
    expect(text).toContain("Rolls back to R-1.");
    expect(text).toContain("No ledger entries in range.");
  });

  it("says so for a release that was never cut", () => {
    expect(renderReleaseNotes(shipped().entries(), "R-8")).toContain("R-8 was never released.");
  });
});

describe("render: task", () => {
  it("shows the task, its status, the clauses it implements, history and commits", () => {
    const text = renderTask(shipped().entries(), "T-1");
    expect(text).toContain("# T-1 Build the thing");
    expect(text).toContain("Status: done, attempt 1.");
    expect(text).toContain("Implements: P-1 §1.1");
    expect(text).toContain("## History");
    expect(text).toContain("task.created by gate: Build the thing");
    expect(text).toContain("## Commits");
    expect(text).toContain("- abc1234");
  });

  it("says so for a task that was never created", () => {
    expect(renderTask(shipped().entries(), "T-99")).toBe("# T-99\n\nT-99 was never created.\n");
  });
});

describe("render: ledger table", () => {
  it("escapes pipes and flattens newlines so every row keeps its columns", () => {
    const ledger = Ledger.openSync(new MemoryStore(), { now: () => new Date("2026-10-09T00:00:00Z") });
    ledger.append({ actor: owner, type: "question.asked", subject: "Q-1", summary: "Pick A | B", reason: undefined, evidence: [], refs: [] });
    ledger.append({ actor: owner, type: "decision.made", subject: "D-1", summary: "Choose | this", reason: "two\nlines | here", evidence: [], refs: [] });
    const table = renderLedger(ledger.entries());
    const rows = table.trimEnd().split("\n");
    expect(rows[0]).toBe("| n | at | actor | type | subject | summary | reason | hash |");
    expect(rows).toHaveLength(4);
    expect(rows[2]).toContain("Pick A \\| B");
    expect(rows[3]).toContain("Choose \\| this");
    expect(rows[3]).toContain("two lines \\| here");
    for (const row of rows) {
      // Unescaped pipes only: a leading and trailing pipe plus eight columns.
      expect(row.split(/(?<!\\)\|/)).toHaveLength(10);
    }
  });
});

describe("review fixes: plan-qualified lookup", () => {
  it("counts only citations of that plan version (or unversioned ones)", () => {
    const ledger = Ledger.openSync(new MemoryStore(), { now: () => new Date("2026-10-09T00:00:00Z") });
    const owner = { kind: "person" as const, id: "owner" };
    addPlanText(ledger, owner, "## 1. Scope\n\nDo the thing.\n");
    appendNumbered(ledger, { actor: owner, type: "plan.approved", summary: "P-1" });
    appendNumbered(ledger, { actor: owner, type: "plan.approved", summary: "P-2" });
    appendNumbered(ledger, { actor: owner, type: "task.created", summary: "old", refs: ["P-1 §1.1"] });
    appendNumbered(ledger, { actor: owner, type: "task.created", summary: "new", refs: ["P-2 §1.1"] });
    expect(lookup(ledger.entries(), "P-1 §1.1").tasks).toEqual(["T-1"]);
    expect(lookup(ledger.entries(), "P-2 §1.1").tasks).toEqual(["T-2"]);
    expect(lookup(ledger.entries(), "§1.1").tasks).toEqual(["T-1", "T-2"]);
  });
});
