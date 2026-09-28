import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateCompletionReport, renderCompletionMarkdown, verifyCompletionReport, writeCompletionReport } from "../src/node/completionReport.mjs";

const base = { planId: "PP-014", title: "Guardrail planner", approved: true, openGates: 0, truthCoreValid: true, ciTier3: "green", completenessReview: true, items: [{ id: "B01-1", title: "Truth", built: true, tested: true, proven: true }] };

test("reports reject missing and duplicate item identities", () => {
  assert.throws(() => generateCompletionReport({ planId: "PP", items: [] }), /at least one item/);
  assert.throws(() => generateCompletionReport({ planId: "PP", items: [{ id: "A" }, { id: "A" }] }), /unique/);
});

test("totals are computed from items and cannot be hand-inflated", () => {
  const report = generateCompletionReport({ ...base, counts: { proven: 99 }, items: [...base.items, { id: "B01-2", built: true, tested: false, proven: false }] });
  assert.deepEqual(report.counts, { total: 2, built: 2, tested: 1, proven: 1 });
  assert.equal(report.verdict, "NO-GO");
});

test("every missing completion conjunction becomes an explicit blocker", () => {
  const report = generateCompletionReport({ ...base, approved: false, openGates: 2, truthCoreValid: false, ciTier3: "grey", completenessReview: false, items: [{ id: "B", built: false, tested: false, proven: false }] });
  assert.equal(report.blockers.length, 6);
  assert.equal(report.notProven[0].missing.length, 3);
});

test("GO exists only when every item and global gate is proven", () => {
  const report = generateCompletionReport(base, { generatedAt: "2026-09-02T00:00:00.000Z" });
  assert.equal(report.ready, true); assert.equal(report.verdict, "GO"); assert.match(renderCompletionMarkdown(report), /What is not proven\n\n- None/);
});

test("verification recomputes all report truth and rejects forged summaries", () => {
  const report = generateCompletionReport(base, { generatedAt: "2026-09-02T00:00:00.000Z" });
  assert.equal(verifyCompletionReport(report).valid, true);
  for (const changed of [
    { ...report, counts: { ...report.counts, proven: 99 } },
    { ...report, blockers: ["invented"] },
    { ...report, notProven: [{ id: "x", title: "x", missing: [] }] },
    { ...report, items: [...report.items, report.items[0]] },
    { schemaVersion: 1, generatedAt: report.generatedAt, verdict: "GO", ready: true, blockers: [] },
  ]) assert.throws(() => verifyCompletionReport(changed), /invalid|inconsistent/);
});

test("JSON and Markdown artifacts are generated from the same immutable report", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pp-completion-"));
  const { report, jsonPath, markdownPath } = await writeCompletionReport(directory, { ...base, ciTier3: "grey" }, { generatedAt: "2026-09-02T00:00:00.000Z" });
  const json = JSON.parse(await readFile(jsonPath, "utf8")); const markdown = await readFile(markdownPath, "utf8");
  assert.equal(json.digest, report.digest); assert.ok(markdown.includes(report.digest)); assert.match(markdown, /Verdict: NO-GO/);
  assert.equal(createHash("sha256").update(JSON.stringify({ ...json, digest: undefined })).digest("hex").length, 64);
});
