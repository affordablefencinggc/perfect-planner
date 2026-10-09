import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalRef,
  lookup,
  matchKeys,
  numberPlan,
  parseImplements,
  parsePlanBlocks,
  parseRef,
  planApprovalEntries,
  approvePlan,
} from "../src/core/clauses/index.mjs";
import { openLedger } from "../src/core/ledger/index.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ids = (result) => result.clauses.map((clause) => `${clause.id}|${clause.status}`);

test("a fresh plan gets structural clause numbers for headings, paragraphs and items", () => {
  const markdown = [
    "# Scope",
    "",
    "The app saves plans.",
    "",
    "- First item",
    "- Second item",
    "  continued here",
    "  - nested detail",
    "",
    "## Details",
    "",
    "Detail paragraph.",
    "",
  ].join("\n");

  const result = numberPlan(markdown);
  assert.deepEqual(result.clauses.map((clause) => clause.id), [
    "§1",
    "§1.1",
    "§1.2",
    "§1.3",
    "§1.3.1",
    "§1.4",
    "§1.4.1",
  ]);
  assert.deepEqual(result.clauses.map((clause) => clause.kind), [
    "heading",
    "paragraph",
    "item",
    "item",
    "item",
    "heading",
    "paragraph",
  ]);
  assert.equal(result.clauses[3].text, "Second item continued here");
  assert.ok(result.clauses.every((clause) => clause.status === "active"));
  assert.equal(result.changes.length, result.clauses.length);
  assert.ok(result.changes.every((change) => change.type === "clause.added"));
  assert.deepEqual(result.changes[0], { type: "clause.added", clause: "§1", newText: "Scope" });
});

test("top-level paragraphs before any heading are numbered as top-level clauses", () => {
  const result = numberPlan("First paragraph.\n\n# Heading\n\nBody.");
  assert.deepEqual(result.clauses.map((clause) => clause.id), ["§1", "§2", "§2.1"]);
});

test("a second heading at the same level starts a new top-level clause", () => {
  const result = numberPlan("# One\n\nA.\n\n# Two\n\nB.\n\n## Deep\n\nC.");
  assert.deepEqual(result.clauses.map((clause) => clause.id), ["§1", "§1.1", "§2", "§2.1", "§2.2", "§2.2.1"]);
});

test("sub-headings nest under the nearest higher heading", () => {
  const result = numberPlan("# One\n\n## Sub\n\n### Leaf\n\nText.\n\n## Sub two");
  assert.deepEqual(result.clauses.map((clause) => clause.id), ["§1", "§1.1", "§1.1.1", "§1.1.1.1", "§1.2"]);
});

test("list items are siblings unless indented under a previous item", () => {
  const result = numberPlan("# List\n\n1. one\n2. two\n   1. two-a\n   2. two-b\n3. three");
  assert.deepEqual(result.clauses.map((clause) => clause.id), ["§1", "§1.1", "§1.2", "§1.2.1", "§1.2.2", "§1.3"]);
});

test("fenced code, thematic breaks, blank lines and empty items produce clauses only for real text", () => {
  const markdown = [
    "# Code",
    "",
    "```js",
    "const a = 1;",
    "```",
    "",
    "---",
    "",
    "-",
    "- ",
    "- Real item",
    "",
    "~~~",
    "unclosed tail",
  ].join("\n");
  const result = numberPlan(markdown);
  assert.deepEqual(result.clauses.map((clause) => [clause.id, clause.kind, clause.text]), [
    ["§1", "heading", "Code"],
    ["§1.1", "paragraph", "const a = 1;"],
    ["§1.2", "item", "Real item"],
    ["§1.3", "paragraph", "unclosed tail"],
  ]);
});

test("CRLF line endings and extra whitespace give the same clauses", () => {
  const unix = numberPlan("# Title\n\nSome   text\nwrapped.\n");
  const windows = numberPlan("# Title\r\n\r\nSome   text\r\nwrapped.\r\n");
  assert.deepEqual(windows.clauses, unix.clauses);
  assert.equal(unix.clauses[1].text, "Some text wrapped.");
});

test("trailing hashes on headings are not part of the clause text", () => {
  const result = numberPlan("## Heading ##\n\n# \n");
  assert.equal(result.clauses[0].text, "Heading");
  assert.equal(result.clauses.length, 1);
});

test("an empty plan has no clauses and no changes", () => {
  assert.deepEqual(numberPlan(""), { clauses: [], changes: [] });
  assert.deepEqual(numberPlan("\n\n   \n"), { clauses: [], changes: [] });
});

test("non-string plan markdown is refused", () => {
  assert.throws(() => numberPlan(42), TypeError);
  assert.throws(() => parsePlanBlocks(undefined), TypeError);
});

test("parsePlanBlocks returns kind, indent and text in document order", () => {
  const blocks = parsePlanBlocks("# H\n- a\n  - b\n\ntext");
  assert.deepEqual(blocks, [
    { kind: "heading", level: 1, indent: 0, text: "H" },
    { kind: "item", indent: 0, text: "a" },
    { kind: "item", indent: 2, text: "b" },
    { kind: "paragraph", indent: 0, text: "text" },
  ]);
});

test("re-numbering an unchanged plan keeps every id and reports no changes", () => {
  const markdown = "# Scope\n\nAlpha.\n\n- Beta\n- Gamma\n";
  const first = numberPlan(markdown);
  const second = numberPlan(markdown, first);
  assert.deepEqual(second.clauses, first.clauses);
  assert.deepEqual(second.changes, []);
});

test("previous can be plan markdown, a clause array, or a numbering result", () => {
  const markdown = "# Scope\n\nAlpha.\n";
  const first = numberPlan(markdown);
  const fromMarkdown = numberPlan("# Scope\n\nAlpha changed.\n", markdown);
  const fromArray = numberPlan("# Scope\n\nAlpha changed.\n", first.clauses);
  const fromResult = numberPlan("# Scope\n\nAlpha changed.\n", first);
  assert.deepEqual(fromMarkdown, fromArray);
  assert.deepEqual(fromArray, fromResult);
  assert.deepEqual(fromResult.changes, [
    { type: "clause.changed", clause: "§1.1", oldText: "Alpha.", newText: "Alpha changed." },
  ]);
});

test("a changed clause keeps its published id and reports old and new text", () => {
  const previous = numberPlan("# Scope\n\nThe app saves plans.\n\n- First item\n");
  const next = numberPlan("# Scope\n\nThe app saves plans locally.\n\n- First item\n", previous);
  assert.deepEqual(ids(next), ["§1|active", "§1.1|active", "§1.2|active"]);
  assert.deepEqual(next.changes, [
    { type: "clause.changed", clause: "§1.1", oldText: "The app saves plans.", newText: "The app saves plans locally." },
  ]);
});

test("an insertion right after a published clause becomes its sub-clause and never moves published ids", () => {
  const base = numberPlan("# Plan\n\n## Three\n\nAlpha.\n\n## Four\n\nDelta.\n");
  assert.deepEqual(base.clauses.map((clause) => clause.id), ["§1", "§1.1", "§1.1.1", "§1.2", "§1.2.1"]);
  const next = numberPlan("# Plan\n\n## Three\n\nInserted first.\n\nAlpha.\n\n## Four\n\nDelta.\n", base);
  // The new paragraph follows §1.1 (Three), so it is its sub-clause; 1.1.1 is taken by Alpha.
  assert.deepEqual(next.clauses.map((clause) => [clause.id, clause.text]), [
    ["§1", "Plan"],
    ["§1.1", "Three"],
    ["§1.1.2", "Inserted first."],
    ["§1.1.1", "Alpha."],
    ["§1.2", "Four"],
    ["§1.2.1", "Delta."],
  ]);
  assert.deepEqual(next.changes, [{ type: "clause.added", clause: "§1.1.2", newText: "Inserted first." }]);
});

test("insertion after a published clause keeps the published numbers and uses a sub-clause id", () => {
  const previous = numberPlan("# Plan\n\n## Three\n\nAlpha.\n\nBeta.\n");
  const next = numberPlan("# Plan\n\n## Three\n\nAlpha.\n\nNew one.\n\nBeta.\n", previous);
  const added = next.clauses.find((clause) => clause.text === "New one.");
  assert.equal(added.id, "§1.1.1.1");
  assert.equal(next.clauses.find((clause) => clause.text === "Beta.").id, "§1.1.2");
});

test("two consecutive insertions become sibling sub-clauses of the same published clause", () => {
  const previous = numberPlan("# Plan\n\nAnchor.\n");
  const next = numberPlan("# Plan\n\nAnchor.\n\nOne.\n\nTwo.\n", previous);
  assert.deepEqual(next.clauses.map((clause) => clause.id), ["§1", "§1.1", "§1.1.1", "§1.1.2"]);
  assert.deepEqual(next.changes.map((change) => [change.type, change.clause]), [
    ["clause.added", "§1.1.1"],
    ["clause.added", "§1.1.2"],
  ]);
});

test("insertions before the first published clause use the virtual §0 parent", () => {
  const previous = numberPlan("# Plan\n\nAnchor.\n");
  const next = numberPlan("Opening note.\n\n# Plan\n\nAnchor.\n", previous);
  assert.deepEqual(next.clauses.map((clause) => clause.id), ["§0.1", "§1", "§1.1"]);
  assert.deepEqual(next.changes, [{ type: "clause.added", clause: "§0.1", newText: "Opening note." }]);
});

test("a removed clause stays listed as withdrawn and its number is never reused", () => {
  const previous = numberPlan("# Plan\n\nKeep.\n\nDrop me.\n\n- Item\n");
  const removed = numberPlan("# Plan\n\nKeep.\n\n- Item\n", previous);
  assert.deepEqual(removed.clauses.map((clause) => [clause.id, clause.status]), [
    ["§1", "active"],
    ["§1.1", "active"],
    ["§1.2", "withdrawn"],
    ["§1.3", "active"],
  ]);
  assert.deepEqual(removed.changes, [{ type: "clause.withdrawn", clause: "§1.2", oldText: "Drop me." }]);

  const reinserted = numberPlan("# Plan\n\nKeep.\n\nFresh text.\n\n- Item\n", removed);
  assert.deepEqual(reinserted.clauses.map((clause) => [clause.id, clause.status]), [
    ["§1", "active"],
    ["§1.1", "active"],
    ["§1.1.1", "active"],
    ["§1.2", "withdrawn"],
    ["§1.3", "active"],
  ]);
  assert.deepEqual(reinserted.changes, [{ type: "clause.added", clause: "§1.1.1", newText: "Fresh text." }]);
});

test("a withdrawn clause does not come back when the same text is written again", () => {
  const previous = numberPlan("# Plan\n\nGone.\n");
  const removed = numberPlan("# Plan\n", previous);
  const again = numberPlan("# Plan\n\nGone.\n", removed);
  const gone = again.clauses.find((clause) => clause.id === "§1.1" && clause.status === "withdrawn");
  assert.ok(gone);
  const revived = again.clauses.find((clause) => clause.text === "Gone." && clause.status === "active");
  assert.equal(revived.id, "§1.2");
  assert.deepEqual(again.changes, [{ type: "clause.added", clause: "§1.2", newText: "Gone." }]);
});

test("previously withdrawn clauses are carried forward without a new change event", () => {
  const previous = [
    { id: "§1", text: "Plan", kind: "heading", status: "active" },
    { id: "§1.1", text: "Old", kind: "paragraph", status: "withdrawn" },
    { id: "§1.2", text: "Keep.", kind: "paragraph", status: "active" },
  ];
  const result = numberPlan("# Plan\n\nKeep.\n", previous);
  assert.deepEqual(result.clauses, [
    { id: "§1", text: "Plan", kind: "heading", status: "active" },
    { id: "§1.1", text: "Old", kind: "paragraph", status: "withdrawn" },
    { id: "§1.2", text: "Keep.", kind: "paragraph", status: "active" },
  ]);
  assert.deepEqual(result.changes, []);
});

test("a kind change at the same position is treated as a withdrawal plus an insertion", () => {
  const previous = numberPlan("# Plan\n\nSame words.\n");
  const next = numberPlan("# Plan\n\n- Same words.\n", previous);
  assert.deepEqual(next.clauses.map((clause) => [clause.id, clause.kind, clause.status]), [
    ["§1", "heading", "active"],
    ["§1.2", "item", "active"],
    ["§1.1", "paragraph", "withdrawn"],
  ]);
  assert.deepEqual(next.changes.map((change) => change.type), ["clause.added", "clause.withdrawn"]);
});

test("ids stay unique and published when a whole section is rewritten", () => {
  const previous = numberPlan("# Plan\n\nOne.\n\nTwo.\n");
  const next = numberPlan("# Plan\n\nEntirely new.\n", previous);
  const activeIds = next.clauses.filter((clause) => clause.status === "active").map((clause) => clause.id);
  assert.equal(new Set(next.clauses.map((clause) => clause.id)).size, next.clauses.length);
  assert.ok(activeIds.includes("§1"));
  // The single paragraph is paired with the first old paragraph, so its published id is kept.
  assert.deepEqual(next.clauses.find((clause) => clause.text === "Entirely new."), {
    id: "§1.1",
    text: "Entirely new.",
    kind: "paragraph",
    status: "active",
  });
  assert.ok(next.clauses.some((clause) => clause.id === "§1.2" && clause.status === "withdrawn"));
  assert.deepEqual(next.changes.map((change) => [change.type, change.clause]), [
    ["clause.changed", "§1.1"],
    ["clause.withdrawn", "§1.2"],
  ]);
});

test("a large plan keeps published numbers when one clause is edited (single-gap path, not the greedy matcher)", () => {
  const lines = ["# Big"];
  for (let i = 0; i < 7000; i += 1) lines.push(`Clause text number ${i}.`, "");
  const markdown = lines.join("\n");
  const previous = numberPlan(markdown);
  const edited = numberPlan(markdown.replace("Clause text number 6500.", "Clause text changed 6500."), previous);
  const changed = edited.clauses.find((clause) => clause.text === "Clause text changed 6500.");
  assert.equal(changed.id, previous.clauses.find((clause) => clause.text === "Clause text number 6500.").id);
  assert.equal(edited.clauses.length, previous.clauses.length);
  assert.equal(edited.changes.length, 1);
  assert.equal(edited.changes[0].type, "clause.changed");
});

test("matchKeys pairs the longest common subsequence in increasing order", () => {
  assert.deepEqual(matchKeys(["a", "b", "c", "d"], ["a", "x", "c", "d"]), [[0, 0], [2, 2], [3, 3]]);
  assert.deepEqual(matchKeys(["a", "b"], ["c"]), []);
  assert.deepEqual(matchKeys([], ["a"]), []);
  assert.deepEqual(matchKeys(["x", "y", "z"], ["y", "z", "x"]).length, 2);
});

test("previous clause lists are validated", () => {
  assert.throws(() => numberPlan("# A", 42), TypeError);
  assert.throws(() => numberPlan("# A", [null]), TypeError);
  assert.throws(() => numberPlan("# A", [{ id: "1", text: "A", kind: "heading", status: "active" }]), TypeError);
  assert.throws(() => numberPlan("# A", [{ id: "§1", text: "A", kind: "table", status: "active" }]), TypeError);
  assert.throws(() => numberPlan("# A", [{ id: "§1", text: "A", kind: "heading", status: "gone" }]), TypeError);
  assert.throws(() => numberPlan("# A", [
    { id: "§1", text: "A", kind: "heading", status: "active" },
    { id: "§1", text: "B", kind: "heading", status: "active" },
  ]), TypeError);
});

test("parseRef reads clause refs", () => {
  assert.deepEqual(parseRef("§3.1"), { kind: "clause", clause: "§3.1", id: "§3.1" });
  assert.deepEqual(parseRef("§1"), { kind: "clause", clause: "§1", id: "§1" });
  assert.deepEqual(parseRef("§0.1"), { kind: "clause", clause: "§0.1", id: "§0.1" });
  assert.deepEqual(parseRef("§3.1.1"), { kind: "clause", clause: "§3.1.1", id: "§3.1.1" });
  assert.deepEqual(parseRef("  §3.1  "), { kind: "clause", clause: "§3.1", id: "§3.1" });
});

test("parseRef reads plan-clause refs with a single space or several", () => {
  assert.deepEqual(parseRef("P-2 §3.1"), { kind: "plan-clause", plan: "P-2", clause: "§3.1", id: "P-2 §3.1" });
  assert.deepEqual(parseRef("P-12   §3.1.1"), { kind: "plan-clause", plan: "P-12", clause: "§3.1.1", id: "P-12 §3.1.1" });
});

test("parseRef reads task refs with and without an attempt suffix", () => {
  assert.deepEqual(parseRef("T-14"), { kind: "task", id: "T-14" });
  assert.deepEqual(parseRef("T-14.a2"), { kind: "task", id: "T-14", attempt: 2 });
  assert.deepEqual(parseRef("T-14.a12"), { kind: "task", id: "T-14", attempt: 12 });
});

test("parseRef reads plan, question, decision, release and entry ids", () => {
  assert.deepEqual(parseRef("P-2"), { kind: "plan", id: "P-2" });
  assert.deepEqual(parseRef("Q-2"), { kind: "question", id: "Q-2" });
  assert.deepEqual(parseRef("D-3"), { kind: "decision", id: "D-3" });
  assert.deepEqual(parseRef("R-1"), { kind: "release", id: "R-1" });
  assert.deepEqual(parseRef("L-000231"), { kind: "entry", id: "L-000231" });
});

test("parseRef refuses malformed, zero, leading-zero and foreign refs", () => {
  const invalid = [
    "",
    "   ",
    null,
    undefined,
    42,
    {},
    "3.1",
    "§",
    "§03",
    "§3.",
    "§3..1",
    "§0",
    "§3.0",
    "P-0",
    "P-02",
    "T-0",
    "T-14.a1",
    "T-14.a0",
    "T-14.a",
    "T-14.2",
    "T-14 §3.1",
    "X-1",
    "Q-",
    "D-3.a2",
    "R-0",
    "L-00231",
    "L-0000001",
    "L-000000",
    "P-2 3.1",
    "P-2 §3.1 extra",
    "P-2§3.1",
    "P-2 T-14",
  ];
  for (const value of invalid) assert.equal(parseRef(value), null, `expected null for ${String(value)}`);
});

test("canonicalRef restores the attempt suffix for tasks", () => {
  assert.equal(canonicalRef(parseRef("T-14.a3")), "T-14.a3");
  assert.equal(canonicalRef(parseRef("P-2 §3.1")), "P-2 §3.1");
  assert.equal(canonicalRef(null), null);
});

test("parseImplements reads a single trailer with a task", () => {
  assert.deepEqual(parseImplements("Fix the thing\n\nImplements: P-2 §3.1 (T-14)"), [
    { ref: "P-2 §3.1", task: "T-14" },
  ]);
});

test("parseImplements reads several comma-separated refs and ignores other lines", () => {
  const message = [
    "Subject",
    "",
    "Body line mentioning P-2 §9 (T-99).",
    "Implements: P-2 §3.1 (T-14), P-2 §4.2 (T-15)",
    "Co-Authored-By: someone <x@example.com>",
  ].join("\n");
  assert.deepEqual(parseImplements(message), [
    { ref: "P-2 §3.1", task: "T-14" },
    { ref: "P-2 §4.2", task: "T-15" },
  ]);
});

test("parseImplements allows refs without a task, is case-insensitive on the key, and accepts CRLF", () => {
  assert.deepEqual(parseImplements("implements: §2.1\r\nIMPLEMENTS:P-1 §1 (T-2.a2)\r\n"), [
    { ref: "§2.1", task: null },
    { ref: "P-1 §1", task: "T-2" },
  ]);
});

test("parseImplements skips items that are not clause refs or have an invalid task", () => {
  assert.deepEqual(parseImplements([
    "Implements: T-14, P-2, Q-1, P-2 §3.1 (not-a-task), P-2 §3.1 (D-3), , P-2 §5 (T-16)",
  ].join("\n")), [{ ref: "P-2 §5", task: "T-16" }]);
});

test("parseImplements returns nothing for non-strings or messages without trailers", () => {
  assert.deepEqual(parseImplements(undefined), []);
  assert.deepEqual(parseImplements(null), []);
  assert.deepEqual(parseImplements("No trailer here"), []);
  assert.deepEqual(parseImplements("Implements:"), []);
});

const plans = {
  "P-1": {
    clauses: [
      { id: "§3", text: "Old section", kind: "heading", status: "active" },
      { id: "§3.1", text: "Old wording", kind: "paragraph", status: "active" },
    ],
  },
  "P-2": {
    clauses: [
      { id: "§3", text: "Saving", kind: "heading", status: "active" },
      { id: "§3.1", text: "The app saves plans locally.", kind: "paragraph", status: "active" },
      { id: "§3.1.1", text: "Inserted rule.", kind: "paragraph", status: "active" },
      { id: "§4", text: "Removed later", kind: "heading", status: "withdrawn" },
    ],
  },
};

const entries = [
  { n: "L-000001", type: "plan.approved", subject: "P-2", summary: "Plan two approved", refs: [] },
  { n: "L-000002", type: "task.created", subject: "T-14", summary: "Save plans locally", refs: ["P-2 §3.1"] },
  { n: "L-000003", type: "clause.added", subject: "P-2", summary: "Insert rule", refs: ["P-2 §3.1.1"] },
  { n: "L-000004", type: "clause.changed", subject: "P-2", summary: "Reword save clause", refs: ["P-2 §3.1"] },
  { n: "L-000005", type: "question.asked", subject: "Q-2", summary: "Local or cloud?", refs: ["P-2 §3.1"] },
  { n: "L-000006", type: "decision.made", subject: "D-3", summary: "Local first", refs: ["P-2 §3.1"] },
  { n: "L-000007", type: "commit.observed", subject: "T-14", summary: "Commit abc", refs: ["P-2 §3.1.1"] },
  { n: "L-000008", type: "task.done", subject: "T-14", summary: "Done", refs: ["T-14"] },
  { n: "L-000009", type: "clause.withdrawn", subject: "P-2", summary: "Remove section four", refs: ["P-2 §4"] },
  { n: "L-000010", type: "release.cut", subject: "R-1", summary: "Release one", refs: ["P-2"] },
];

test("lookup returns the text, clause history and citing entries for a plan-clause ref", () => {
  const result = lookup("P-2 §3.1", { entries, plans });
  assert.equal(result.ref, "P-2 §3.1");
  assert.equal(result.text, "The app saves plans locally.");
  assert.deepEqual(result.history.map((entry) => entry.n), ["L-000004"]);
  assert.deepEqual(result.citedBy.map((entry) => entry.n), ["L-000002", "L-000005", "L-000006"]);
});

test("lookup of a bare clause reads the latest plan that has it", () => {
  const result = lookup("§3.1", { entries, plans });
  assert.equal(result.ref, "§3.1");
  assert.equal(result.text, "The app saves plans locally.");
  assert.deepEqual(result.history.map((entry) => entry.n), ["L-000004"]);
});

test("lookup of a clause in an explicit older plan reads that plan's text", () => {
  const result = lookup("P-1 §3.1", { entries, plans });
  assert.equal(result.text, "Old wording");
  assert.deepEqual(result.history, []);
});

test("lookup reports null text for an unknown plan or clause and empty lists for no matches", () => {
  const unknownPlan = lookup("P-9 §3.1", { entries, plans });
  assert.equal(unknownPlan.text, null);
  assert.deepEqual(unknownPlan.history, []);
  const unknownClause = lookup("§77", { entries, plans });
  assert.equal(unknownClause.text, null);
  assert.deepEqual(unknownClause.citedBy, []);
});

test("lookup shows a withdrawn clause's text", () => {
  const result = lookup("P-2 §4", { entries, plans });
  assert.equal(result.text, "Removed later");
  assert.deepEqual(result.history.map((entry) => entry.n), ["L-000009"]);
});

test("lookup of a nested clause matches only that clause in history and citations", () => {
  const result = lookup("P-2 §3.1.1", { entries, plans });
  assert.equal(result.text, "Inserted rule.");
  assert.deepEqual(result.history.map((entry) => entry.n), ["L-000003"]);
  assert.deepEqual(result.citedBy.map((entry) => entry.n), ["L-000007"]);
});

test("lookup of a task returns its summary, its own entries, and entries that cite it", () => {
  const result = lookup("T-14", { entries, plans });
  assert.equal(result.ref, "T-14");
  assert.equal(result.text, "Save plans locally");
  assert.deepEqual(result.history.map((entry) => entry.n), ["L-000002", "L-000007", "L-000008"]);
  assert.deepEqual(result.citedBy, []);
});

test("lookup of a task with an attempt suffix uses the same task history and keeps the attempt in the ref", () => {
  const result = lookup("T-14.a2", { entries, plans });
  assert.equal(result.ref, "T-14.a2");
  assert.equal(result.history.length, 3);
});

test("lookup of a question, decision, and release reads its own entries", () => {
  const question = lookup("Q-2", { entries, plans });
  assert.equal(question.text, "Local or cloud?");
  assert.deepEqual(question.history.map((entry) => entry.n), ["L-000005"]);

  const decision = lookup("D-3", { entries, plans });
  assert.equal(decision.text, "Local first");
  assert.deepEqual(decision.history.map((entry) => entry.n), ["L-000006"]);

  const release = lookup("R-1", { entries, plans });
  assert.equal(release.text, "Release one");
  assert.deepEqual(release.history.map((entry) => entry.n), ["L-000010"]);
});

test("lookup of a plan reads its own entries and every entry that cites one of its clauses", () => {
  const result = lookup("P-2", { entries, plans: { "P-2": { text: "Plan two", clauses: [] } } });
  assert.equal(result.text, "Plan two");
  assert.deepEqual(result.history.map((entry) => entry.n), ["L-000001", "L-000003", "L-000004", "L-000009"]);
  assert.deepEqual(result.citedBy.map((entry) => entry.n), ["L-000002", "L-000005", "L-000006", "L-000007", "L-000010"]);
});

test("lookup of a plan without plan text falls back to its approval summary", () => {
  assert.equal(lookup("P-2", { entries, plans }).text, "Plan two approved");
});

test("lookup of a ledger entry returns that entry's summary and the entries that cite it", () => {
  const withCitation = [...entries, { n: "L-000011", type: "task.progress", subject: "T-14", summary: "See entry", refs: ["L-000002"] }];
  const result = lookup("L-000002", { entries: withCitation, plans });
  assert.equal(result.text, "Save plans locally");
  assert.deepEqual(result.history.map((entry) => entry.n), ["L-000002"]);
  assert.deepEqual(result.citedBy.map((entry) => entry.n), ["L-000011"]);
});

test("lookup accepts missing entries and plans and returns null for invalid refs", () => {
  const bare = lookup("T-3");
  assert.deepEqual(bare, { ref: "T-3", text: null, history: [], citedBy: [], tasks: [], commits: [] });
  assert.equal(lookup("not a ref", { entries, plans }), null);
  assert.equal(lookup(undefined, { entries, plans }), null);
});

test("lookup of a clause with no matching plan map or plan clauses returns null text", () => {
  const result = lookup("§3", { entries, plans: { "P-3": { clauses: "not-an-array" } } });
  assert.equal(result.text, null);
});

test("lookup cites an entry through its corrects field and its evidence items", () => {
  const extended = [
    ...entries,
    { n: "L-000011", type: "fact.corrected", subject: "T-14", summary: "Correction", refs: [], corrects: "L-000002" },
    { n: "L-000012", type: "evidence.attached", subject: "T-14", summary: "Run evidence", refs: [], evidence: ["P-2 §3.1", "https://example.com/run/1", 7] },
  ];
  const entry = lookup("L-000002", { entries: extended, plans });
  assert.deepEqual(entry.citedBy.map((item) => item.n), ["L-000011"]);
  assert.deepEqual(entry.history.map((item) => item.n), ["L-000002"]);

  const clause = lookup("P-2 §3.1", { entries: extended, plans });
  assert.deepEqual(clause.citedBy.map((item) => item.n), ["L-000002", "L-000005", "L-000006", "L-000012"]);
});

test("lookup ignores a corrects value or evidence list that is malformed", () => {
  const odd = [{ n: "L-000013", type: "note.added", subject: "T-14", summary: "Odd", refs: "not-a-list", corrects: 5, evidence: "P-2 §3.1" }];
  assert.deepEqual(lookup("P-2 §3.1", { entries: odd, plans }).citedBy, []);
});

test("matchKeys uses the exact table exactly up to the cell limit and the greedy match above it", () => {
  const a = ["x", "y", "z"];
  const b = ["y", "z", "x"];
  // 3 x 3 = 9 cells: exact LCS of length 2.
  assert.equal(matchKeys(a, b, { cellLimit: 9 }).length, 2);
  // Over the limit: greedy takes the first x and stops, which is still an increasing match.
  assert.deepEqual(matchKeys(a, b, { cellLimit: 8 }), [[0, 2]]);
});

test("greedy matchKeys output is strictly increasing on both sides and only pairs equal keys", () => {
  const a = ["p", "q", "p", "r", "q", "s", "p"];
  const b = ["q", "p", "s", "r", "p", "q", "p"];
  const pairs = matchKeys(a, b, { cellLimit: 0 });
  assert.ok(pairs.length > 0);
  for (let k = 0; k < pairs.length; k += 1) {
    assert.equal(a[pairs[k][0]], b[pairs[k][1]]);
    if (k > 0) {
      assert.ok(pairs[k][0] > pairs[k - 1][0]);
      assert.ok(pairs[k][1] > pairs[k - 1][1]);
    }
  }
});

test("a rewritten clause keeps the id of the old clause it resembles, not the one in its position", () => {
  const previous = numberPlan([
    "# Plan",
    "",
    "Alpha clause about saving plans locally.",
    "",
    "Beta clause about syncing the ledger cloud.",
    "",
  ].join("\n"));
  // Alpha is removed and Beta is reworded: Beta keeps §1.2, and Alpha is withdrawn.
  const next = numberPlan("# Plan\n\nBeta clause about syncing the ledger to cloud storage.\n", previous);
  assert.deepEqual(next.clauses.map((clause) => [clause.id, clause.status]), [
    ["§1", "active"],
    ["§1.2", "active"],
    ["§1.1", "withdrawn"],
  ]);
  assert.equal(next.clauses[1].text, "Beta clause about syncing the ledger to cloud storage.");
  assert.deepEqual(next.changes.map((change) => [change.type, change.clause]), [
    ["clause.changed", "§1.2"],
    ["clause.withdrawn", "§1.1"],
  ]);
});

test("a same-kind clause with no similar partner falls back to position, so the published id is still kept", () => {
  const previous = numberPlan("# Plan\n\nOne.\n\nTwo.\n");
  const next = numberPlan("# Plan\n\nEntirely new.\n", previous);
  assert.equal(next.clauses.find((clause) => clause.text === "Entirely new.").id, "§1.1");
});

test("content inserted under a new heading nests under that heading, as in a fresh plan", () => {
  const previous = numberPlan("# Plan\n\n## Three\n\nAlpha.\n");
  assert.deepEqual(previous.clauses.map((clause) => clause.id), ["§1", "§1.1", "§1.1.1"]);
  const next = numberPlan("# Plan\n\n## Three\n\n## Inserted\n\nBody of inserted.\n\nAlpha.\n", previous);
  assert.deepEqual(next.clauses.map((clause) => [clause.id, clause.text]), [
    ["§1", "Plan"],
    ["§1.1", "Three"],
    ["§1.1.2", "Inserted"],
    ["§1.1.2.1", "Body of inserted."],
    ["§1.1.1", "Alpha."],
  ]);
  assert.deepEqual(next.changes.map((change) => [change.type, change.clause]), [
    ["clause.added", "§1.1.2"],
    ["clause.added", "§1.1.2.1"],
  ]);
});

test("ATX headings with up to three leading spaces or a closing hash count as headings, bare # does not add text", () => {
  const result = numberPlan("#\n\n   # Indented heading\n\n#tag stays text\n\n# C#\n");
  assert.deepEqual(result.clauses.map((clause) => [clause.id, clause.kind, clause.text]), [
    ["§1", "heading", "Indented heading"],
    ["§1.1", "paragraph", "#tag stays text"],
    ["§2", "heading", "C#"],
  ]);
});

test("entry numbers past six digits are valid when they have no leading zero", () => {
  assert.deepEqual(parseRef("L-1000000"), { kind: "entry", id: "L-1000000" });
  assert.deepEqual(parseRef("L-10000000"), { kind: "entry", id: "L-10000000" });
  assert.equal(parseRef("L-01000000"), null);
});

test("parseImplements gives a parenthesised task to the earlier refs on the same line that have none", () => {
  assert.deepEqual(parseImplements("Implements: P-2 §3.1, P-2 §3.2 (T-14)"), [
    { ref: "P-2 §3.1", task: "T-14" },
    { ref: "P-2 §3.2", task: "T-14" },
  ]);
});

test("parseImplements lets a bare clause inherit the plan named earlier on the same line", () => {
  assert.deepEqual(parseImplements("Implements: P-2 §3.1, §3.2 (T-14)"), [
    { ref: "P-2 §3.1", task: "T-14" },
    { ref: "P-2 §3.2", task: "T-14" },
  ]);
});

test("parseImplements does not carry a task forward past a later ref that has none", () => {
  assert.deepEqual(parseImplements("Implements: P-2 §3.1 (T-14), P-2 §4.2"), [
    { ref: "P-2 §3.1", task: "T-14" },
    { ref: "P-2 §4.2", task: null },
  ]);
});

test("parseImplements groups within one line only", () => {
  assert.deepEqual(parseImplements("Implements: P-2 §3.1\nImplements: P-2 §3.2 (T-14)"), [
    { ref: "P-2 §3.1", task: null },
    { ref: "P-2 §3.2", task: "T-14" },
  ]);
});

test("lookup reads clause text from the strict ledger board's plan shape", () => {
  const boardPlans = { "P-1": { id: "P-1", clauses: { "§1": { clause: "§1", text: "Save plans locally", state: "active" } } } };
  assert.equal(lookup("P-1 §1", { entries: [], plans: boardPlans }).text, "Save plans locally");
  assert.equal(lookup("§1", { entries: [], plans: boardPlans }).text, "Save plans locally");
});

test("lookup lists the tasks and commits that cite a clause", () => {
  const cited = [
    { n: "L-000001", type: "task.created", subject: "T-1", summary: "Build it", refs: ["P-1 §1"] },
    { n: "L-000002", type: "commit.observed", subject: "T-1", summary: "abc", evidence: ["abc123"], refs: ["P-1 §1"], data: { sha: "abc123" } },
    { n: "L-000003", type: "commit.observed", subject: "T-2.a2", summary: "def", evidence: ["def456"], refs: ["P-1 §1"] },
    { n: "L-000004", type: "task.created", subject: "T-3", summary: "Other", refs: ["P-1 §2"] },
  ];
  const result = lookup("P-1 §1", { entries: cited, plans: {} });
  assert.deepEqual(result.tasks, ["T-1", "T-2"]);
  assert.deepEqual(result.commits, [{ sha: "abc123", task: "T-1", entry: "L-000002" }, { sha: "def456", task: "T-2", entry: "L-000003" }]);
});

test("planApprovalEntries writes a plan the strict ledger accepts, and a new version only writes its changes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pp-core-clauses-"));
  const ledger = await openLedger(dir);
  try {
    const owner = { kind: "person", id: "owner" };
    const first = await approvePlan(ledger, { plan: "P-1", markdown: `# Save

Plans save locally.

# Load

Plans load on start.`, actor: owner, title: "First plan" });
    assert.deepEqual(first.entries.map((entry) => entry.type), ["clause.added", "clause.added", "clause.added", "clause.added", "plan.approved"]);
    const board = ledger.board();
    assert.equal(board.plans["P-1"].state, "approved");
    assert.equal(board.plans["P-1"].clauses["§1.1"].text, "Plans save locally.");
    const second = planApprovalEntries({ plan: "P-2", markdown: `# Save

Plans save locally and to backup.

# Load

Plans load on start.`, previous: first.clauses, actor: owner });
    assert.deepEqual(second.inputs.map((input) => input.type), ["clause.changed", "plan.approved"]);
    for (const input of second.inputs) await ledger.append(input);
    const after = ledger.board();
    assert.equal(after.plans["P-2"].clauses["§1.1"].text, "Plans save locally and to backup.");
    assert.equal(after.plans["P-2"].clauses["§2.1"].text, "Plans load on start.");
    assert.equal(after.plans["P-1"].clauses["§1.1"].text, "Plans save locally.");
    assert.throws(() => planApprovalEntries({ plan: "plan-1", markdown: "x", actor: owner }), TypeError);
  } finally {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});
