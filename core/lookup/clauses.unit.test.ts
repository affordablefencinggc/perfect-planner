import { describe, expect, it } from "vitest";
import { Ledger, MemoryStore } from "../ledger/index";
import { appendNumbered, installNumberingRules } from "../numbering/index";
import {
  addClause,
  addPlanText,
  changeClause,
  clauseNumber,
  clausesAt,
  compareClauses,
  installClauseRules,
  numberForInsert,
  numberMarkdown,
  planClauses,
  sortedClauses,
  withdrawClause,
} from "./clauses";

const owner = { kind: "person" as const, id: "owner" };

function open(): Ledger {
  const ledger = Ledger.openSync(new MemoryStore(), { now: () => new Date("2026-10-09T00:00:00Z") });
  installNumberingRules(ledger);
  installClauseRules(ledger);
  return ledger;
}

describe("numberMarkdown", () => {
  const plan = [
    "# Title",
    "",
    "## 1. Scope",
    "",
    "The first paragraph",
    "continues here.",
    "",
    "- first item",
    "- second item",
    "",
    "### sub",
    "",
    "A paragraph under sub.",
    "",
  ].join("\n");

  it("skips the document title and numbers headings, paragraphs and items", () => {
    const blocks = numberMarkdown(plan);
    expect(blocks.map((b) => [b.clause, b.kind, b.text])).toEqual([
      ["1", "heading", "Scope"],
      ["1.1", "paragraph", "The first paragraph continues here."],
      ["1.2", "item", "first item"],
      ["1.3", "item", "second item"],
      ["1.4", "heading", "sub"],
      ["1.4.1", "paragraph", "A paragraph under sub."],
    ]);
  });

  it("keeps the number a heading was written with (doc comment: \"## 3. Title\" keeps its own number)", () => {
    // numberMarkdown's doc comment promises this; the implementation renumbers automatically.
    const blocks = numberMarkdown("## 1. Scope\n\nBody.\n\n## 3. Pricing\n\nBody.");
    expect(blocks.filter((b) => b.kind === "heading").map((b) => b.clause)).toEqual(["1", "3"]);
  });

  it("numbers top-level content before any heading as top-level clauses", () => {
    const blocks = numberMarkdown("Intro line.\n\n## 2. Next\n\nBody.");
    expect(blocks.map((b) => [b.clause, b.kind])).toEqual([
      ["1", "paragraph"],
      ["2", "heading"],
      ["2.1", "paragraph"],
    ]);
  });

  it("keeps a plain text document as paragraphs with no headings", () => {
    expect(numberMarkdown("One.\n\nTwo.").map((b) => b.clause)).toEqual(["1", "2"]);
  });

  it("returns nothing for an empty document", () => {
    expect(numberMarkdown("")).toEqual([]);
    expect(numberMarkdown("# Only a title\n")).toEqual([]);
  });
});

describe("clauseNumber and compareClauses", () => {
  it("accepts a section sign or a bare number", () => {
    expect(clauseNumber("§3.1")).toBe("3.1");
    expect(clauseNumber("3.1")).toBe("3.1");
    expect(clauseNumber("§ 3.1")).toBe("3.1");
    expect(clauseNumber("3.x")).toBeUndefined();
    expect(clauseNumber("§")).toBeUndefined();
  });

  it("sorts numerically, so 3.2 comes before 3.10 and 3.1 before 3.1.1", () => {
    const sorted = ["3.10", "3.2", "3.1.1", "3.1", "1", "2.9"].sort(compareClauses);
    expect(sorted).toEqual(["1", "2.9", "3.1", "3.1.1", "3.2", "3.10"]);
    expect(compareClauses("3.1", "3.1")).toBe(0);
  });

  it("sortedClauses orders a clause map the same way", () => {
    const ledger = open();
    addPlanText(ledger, owner, "## A\n\n- item\n\n## B\n\n## C\n\n## D\n\n## E\n\n## F\n\n## G\n\n## H\n\n## I\n\n## J\n\n## K");
    const sorted = sortedClauses(clausesAt(ledger.entries())).map((c) => c.clause);
    // 1..9 come before 10; 1.1 (a child of 1) comes straight after 1.
    expect(sorted.slice(0, 3)).toEqual(["1", "1.1", "2"]);
    expect(sorted.at(-1)).toBe("11");
  });
});

describe("numberForInsert", () => {
  it("inserts a child after 3.1 as 3.1.1, then 3.1.2", () => {
    const ledger = open();
    addPlanText(ledger, owner, "## 3. Pricing\n\n- one\n\n## 3.x\n");
    const base = ledger.entries().length;
    expect(base).toBeGreaterThan(0);
    const map = () => clausesAt(ledger.entries());
    // build 3.1 explicitly as the parent, then insert children under it
    const parentLedger = open();
    addClause(parentLedger, owner, { text: "Top" }); // 1
    addClause(parentLedger, owner, { text: "Second" }); // 2
    addClause(parentLedger, owner, { text: "Third" }); // 3
    addClause(parentLedger, owner, { after: "3", text: "Sub of three" }); // 3.1
    expect(numberForInsert(clausesAt(parentLedger.entries()), "3.1")).toBe("3.1.1");
    expect(addClause(parentLedger, owner, { after: "3.1", text: "first child" }).subject).toBe("§3.1.1");
    expect(numberForInsert(clausesAt(parentLedger.entries()), "3.1")).toBe("3.1.2");
    expect(addClause(parentLedger, owner, { after: "3.1", text: "second child" }).subject).toBe("§3.1.2");
    expect(map().size).toBeGreaterThan(0);
  });

  it("gives the next top-level number when there is no parent", () => {
    const ledger = open();
    addClause(ledger, owner, { text: "One" });
    addClause(ledger, owner, { text: "Two" });
    expect(numberForInsert(clausesAt(ledger.entries()))).toBe("3");
    expect(addClause(ledger, owner, { text: "Three" }).subject).toBe("§3");
  });

  it("refuses a parent that does not exist or is not a clause number", () => {
    const map = clausesAt(open().entries());
    expect(() => numberForInsert(map, "9")).toThrow(/§9 does not exist/);
    expect(() => numberForInsert(map, "nope")).toThrow(RangeError);
  });

  it("never reuses a withdrawn clause number", () => {
    const ledger = open();
    addClause(ledger, owner, { text: "One" }); // 1
    withdrawClause(ledger, owner, "1", "dropped");
    expect(numberForInsert(clausesAt(ledger.entries()))).toBe("2");
  });
});

describe("installClauseRules", () => {
  it("never hands out a withdrawn clause's number again", () => {
    const ledger = open();
    addClause(ledger, owner, { text: "Original" }); // §1
    withdrawClause(ledger, owner, "1", "dropped");
    expect(addClause(ledger, owner, { text: "Replacement" }).subject).toBe("§2");
  });

  it("refuses clause.added with a number that already exists", () => {
    const ledger = open();
    ledger.append({ actor: owner, type: "clause.added", subject: "§2", summary: "Added §2", data: { clause: "2", kind: "paragraph", text: "Two" }, evidence: [], refs: [] });
    expect(() =>
      ledger.append({ actor: owner, type: "clause.added", subject: "§2", summary: "Added §2 again", data: { clause: "2", kind: "paragraph", text: "Two again" }, evidence: [], refs: [] }),
    ).toThrow(/§2 was already used.*never reused/);
  });

  it("refuses a reuse after withdrawal", () => {
    const ledger = open();
    addClause(ledger, owner, { text: "Original" }); // §1
    withdrawClause(ledger, owner, "1", "no longer needed");
    expect(() =>
      ledger.append({ actor: owner, type: "clause.added", subject: "§1", summary: "Added §1 again", data: { clause: "1", kind: "paragraph", text: "Back" }, evidence: [], refs: [] }),
    ).toThrow(/§1 was already used/);
  });

  it("refuses a child whose parent is missing", () => {
    const ledger = open();
    expect(() =>
      ledger.append({ actor: owner, type: "clause.added", subject: "§9.1", summary: "Added §9.1", data: { clause: "9.1", kind: "paragraph", text: "Orphan" }, evidence: [], refs: [] }),
    ).toThrow(/§9\.1 has no parent §9/);
  });

  it("refuses clause.changed when the old text is not the current text", () => {
    const ledger = open();
    addClause(ledger, owner, { text: "Current text" }); // §1
    expect(() =>
      ledger.append({
        actor: owner,
        type: "clause.changed",
        subject: "§1",
        summary: "Changed §1",
        reason: "reword",
        data: { clause: "1", old: "Stale text", new: "New text" },
        evidence: [],
        refs: [],
      }),
    ).toThrow(/the old text does not match §1/);
  });

  it("refuses a change to a withdrawn clause", () => {
    const ledger = open();
    addClause(ledger, owner, { text: "Gone soon" }); // §1
    withdrawClause(ledger, owner, "1", "dropped");
    expect(() => changeClause(ledger, owner, "1", "Revived", "reword")).toThrow(/§1 was withdrawn/);
    expect(() =>
      ledger.append({
        actor: owner,
        type: "clause.changed",
        subject: "§1",
        summary: "Changed §1",
        reason: "reword",
        data: { clause: "1", old: "Gone soon", new: "Revived" },
        evidence: [],
        refs: [],
      }),
    ).toThrow(/§1 was withdrawn in L-000002/);
  });

  it("refuses a change or withdrawal of a clause that does not exist", () => {
    const ledger = open();
    expect(() => changeClause(ledger, owner, "5", "text", "reword")).toThrow(/§5 does not exist/);
    expect(() => withdrawClause(ledger, owner, "5", "gone")).toThrow(/§5 does not exist/);
  });

  it("requires a reason to change or withdraw a clause", () => {
    const ledger = open();
    addClause(ledger, owner, { text: "One" });
    expect(() =>
      ledger.append({ actor: owner, type: "clause.changed", subject: "§1", summary: "Changed", data: { clause: "1", old: "One", new: "Two" }, evidence: [], refs: [] }),
    ).toThrow(/clause.changed needs a reason/);
  });

  it("can be removed with the function it returns", () => {
    const ledger = Ledger.openSync(new MemoryStore(), { now: () => new Date("2026-10-09T00:00:00Z") });
    const remove = installClauseRules(ledger);
    addClause(ledger, owner, { text: "One" });
    remove();
    ledger.append({ actor: owner, type: "clause.added", subject: "§1", summary: "again", data: { clause: "1", kind: "paragraph", text: "Again" }, evidence: [], refs: [] });
    expect(clausesAt(ledger.entries()).get("1")?.text).toBe("Again");
  });
});

describe("addPlanText / changeClause / withdrawClause", () => {
  it("adds every block of a plan as clause.added entries", () => {
    const ledger = open();
    const entries = addPlanText(ledger, owner, "# Plan\n\n## 1. Scope\n\nBuild it.\n\n- fast\n- cheap", ["P-1"]);
    expect(entries.map((e) => [e.type, e.subject])).toEqual([
      ["clause.added", "§1"],
      ["clause.added", "§1.1"],
      ["clause.added", "§1.2"],
      ["clause.added", "§1.3"],
    ]);
    const clauses = clausesAt(ledger.entries());
    expect(clauses.get("1.1")).toMatchObject({ kind: "paragraph", text: "Build it.", status: "active", addedBy: entries[1].n });
    expect(clauses.get("1.2")).toMatchObject({ kind: "item", text: "fast" });
    expect(entries[0].refs).toEqual(["P-1"]);
  });

  it("changeClause records old and new text and the reason", () => {
    const ledger = open();
    addPlanText(ledger, owner, "## 1. Scope\n\nOld text.");
    const change = changeClause(ledger, owner, "§1.1", "New text.", "tighter wording");
    expect(change.type).toBe("clause.changed");
    expect(change.subject).toBe("§1.1");
    expect(change.reason).toBe("tighter wording");
    expect(change.data).toEqual({ clause: "1.1", old: "Old text.", new: "New text." });
    const clause = clausesAt(ledger.entries()).get("1.1")!;
    expect(clause.text).toBe("New text.");
    expect(clause.changedBy).toEqual([change.n]);
  });

  it("withdrawClause marks the clause withdrawn but keeps it in the map", () => {
    const ledger = open();
    addPlanText(ledger, owner, "## 1. Scope\n\n- drop me");
    const withdrawal = withdrawClause(ledger, owner, "1.1", "not doing it");
    const clause = clausesAt(ledger.entries()).get("1.1")!;
    expect(clause).toMatchObject({ status: "withdrawn", withdrawnBy: withdrawal.n, text: "drop me" });
    expect(withdrawal.reason).toBe("not doing it");
  });
});

describe("clausesAt vs planClauses", () => {
  it("shows the text each approved plan version had, not the text at the latest change", () => {
    const ledger = open();
    addPlanText(ledger, owner, "## 1. Scope\n\nOld text.");
    appendNumbered(ledger, { actor: owner, type: "plan.approved", summary: "P-1 approved", evidence: [], refs: [] }); // P-1
    changeClause(ledger, owner, "1.1", "Middle text.", "second draft");
    appendNumbered(ledger, { actor: owner, type: "plan.approved", summary: "P-2 approved", evidence: [], refs: [] }); // P-2
    changeClause(ledger, owner, "1.1", "Newest text.", "third draft");

    const entries = ledger.entries();
    expect(planClauses(entries, "P-1")!.get("1.1")!.text).toBe("Old text.");
    expect(planClauses(entries, "P-2")!.get("1.1")!.text).toBe("Middle text.");
    expect(clausesAt(entries).get("1.1")!.text).toBe("Newest text.");
    expect(planClauses(entries)!.get("1.1")!.text).toBe("Newest text.");
  });

  it("clausesAt up to a plan approval matches planClauses for that plan", () => {
    const ledger = open();
    addPlanText(ledger, owner, "## 1. Scope\n\nOld text.");
    appendNumbered(ledger, { actor: owner, type: "plan.approved", summary: "P-1 approved", evidence: [], refs: [] });
    changeClause(ledger, owner, "1.1", "Later text.", "later");
    const entries = ledger.entries();
    const index = entries.findIndex((e) => e.type === "plan.approved" && e.subject === "P-1");
    expect(clausesAt(entries, index + 1).get("1.1")!.text).toBe("Old text.");
    expect(planClauses(entries, "P-1")!.get("1.1")!.text).toBe("Old text.");
  });

  it("a clause withdrawn after P-1 is still active in P-1", () => {
    const ledger = open();
    addPlanText(ledger, owner, "## 1. Scope\n\n- item");
    appendNumbered(ledger, { actor: owner, type: "plan.approved", summary: "P-1 approved", evidence: [], refs: [] });
    withdrawClause(ledger, owner, "1.1", "dropped later");
    expect(planClauses(ledger.entries(), "P-1")!.get("1.1")!.status).toBe("active");
    expect(clausesAt(ledger.entries()).get("1.1")!.status).toBe("withdrawn");
  });

  it("returns undefined for a plan that was never approved", () => {
    const ledger = open();
    addPlanText(ledger, owner, "## 1. Scope");
    expect(planClauses(ledger.entries(), "P-4")).toBeUndefined();
  });
});
