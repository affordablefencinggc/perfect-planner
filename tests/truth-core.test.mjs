import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { censusRepository } from "../src/node/repositoryCensus.mjs";
import { appendJournalEvent, readJournal, verifyJournal } from "../src/node/journalStore.mjs";
import { acquirePlanLock, clearInspectedStalePlanLock, inspectPlanLock, releasePlanLock } from "../src/node/planLock.mjs";
import { inspectStalePlanLockForOperator, recoverInspectedStalePlanLock } from "../src/node/planLockRecovery.mjs";
import { publishVerifiedTruthGeneration } from "../scripts/generate-truth-report.mjs";

async function truthPublicationFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pp-truth-publication-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "generated"); const staging = path.join(root, "staging");
  await mkdir(staging, { recursive: true });
  const files = { "truth-core-report.json": "{}\n", "completion-report.json": "{}\n", "completion-report.md": "# completion\n", "evidence-bundle.html": "<!doctype html><title>evidence</title>" };
  for (const [name, value] of Object.entries(files)) await writeFile(path.join(staging, name), value);
  return { output, staging };
}

test("truth publication verifies one immutable generation before atomically committing its pointer", async (t) => {
  const fixture = await truthPublicationFixture(t); const published = await publishVerifiedTruthGeneration(fixture.output, fixture.staging, { generatedAt: "2026-09-02T00:00:00.000Z" });
  const pointer = JSON.parse(await readFile(published.pointerPath, "utf8"));
  assert.equal(pointer.generationId, published.manifest.generationId); assert.equal(pointer.artifacts.length, 4);
  for (const artifact of pointer.artifacts) assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
});

test("truth publication refuses missing or malformed staged artifacts without committing a pointer", async (t) => {
  const missing = await truthPublicationFixture(t); await rm(path.join(missing.staging, "evidence-bundle.html"));
  await assert.rejects(() => publishVerifiedTruthGeneration(missing.output, missing.staging), /evidence-bundle/);
  await assert.rejects(() => readFile(path.join(missing.output, "current-generation.json")), /ENOENT/);
  const malformed = await truthPublicationFixture(t); await writeFile(path.join(malformed.staging, "truth-core-report.json"), "not-json");
  await assert.rejects(() => publishVerifiedTruthGeneration(malformed.output, malformed.staging), /JSON/);
  await assert.rejects(() => readFile(path.join(malformed.output, "current-generation.json")), /ENOENT/);
});

test("census hashes readable artifacts, recognizes plan manifests, and ignores dependency folders", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pp-census-"));
  await mkdir(path.join(root, "docs"));
  await mkdir(path.join(root, "node_modules"));
  await writeFile(path.join(root, "docs", "brief.md"), "# Brief\n");
  await writeFile(path.join(root, "plan.json"), JSON.stringify({ schemaVersion: 1, planId: "PP-T", tasks: [] }));
  await writeFile(path.join(root, "node_modules", "ignored.js"), "throw new Error('never read')");
  const census = await censusRepository(root, { generatedAt: "2026-09-02T00:00:00.000Z" });
  assert.equal(census.fileCount, 2);
  assert.equal(census.summary.plan, 1);
  assert.ok(census.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.ok(!census.files.some((file) => file.path.includes("node_modules")));
});

test("census refuses symlinks and records the reason", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pp-link-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "pp-outside-"));
  await writeFile(path.join(outside, "secret.md"), "outside");
  try {
    await symlink(outside, path.join(root, "linked-outside"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error.code === "EPERM") { t.skip("Host policy prevents creating a link fixture"); return; }
    throw error;
  }
  const census = await censusRepository(root);
  assert.equal(census.fileCount, 0);
  assert.ok(census.skipped.some((item) => item.path === "linked-outside" && item.reason.includes("refused")));
});

test("a second actor times out without stealing an active lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pp-lock-"));
  const target = path.join(root, "journal.jsonl");
  const first = await acquirePlanLock(target, { actor: "agent-a", timeoutMs: 100 });
  await assert.rejects(() => acquirePlanLock(target, { actor: "agent-b", timeoutMs: 40, retryMs: 5 }), /ACTIVE holder agent-a/);
  await releasePlanLock(first);
});

test("stale locks clear only after exact inspection and never through automatic stealing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pp-stale-lock-")); const target = path.join(root, "journal.jsonl");
  const lock = await acquirePlanLock(target, { actor: "crashed-agent" }); const holderPath = path.join(lock.lockDirectory, "holder.json"); const holder = JSON.parse(await readFile(holderPath, "utf8")); holder.acquiredAt = "2020-01-01T00:00:00.000Z"; await writeFile(holderPath, JSON.stringify(holder));
  await assert.rejects(() => acquirePlanLock(target, { actor: "new-agent", timeoutMs: 20, retryMs: 5, staleMs: 1 }), /STALE holder crashed-agent/);
  const inspection = await inspectPlanLock(target, { staleMs: 1 }); assert.equal(inspection.state, "STALE"); assert.equal(inspection.holder.token, "REDACTED");
  await clearInspectedStalePlanLock(target, inspection, { actor: "operator", staleMs: 1 }); assert.equal((await inspectPlanLock(target)).state, "MISSING");
});

test("operator stale-lock recovery exposes no token and records authorization in a separate journal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pp-lock-recovery-")); const target = path.join(root, "authority.json"); const recoveryJournalPath = path.join(root, "recovery", "journal.jsonl"); const lock = await acquirePlanLock(target, { actor: "crashed-agent" }); const holderPath = path.join(lock.lockDirectory, "holder.json"); const holder = JSON.parse(await readFile(holderPath, "utf8")); holder.acquiredAt = "2020-01-01T00:00:00.000Z"; await writeFile(holderPath, JSON.stringify(holder));
  const inspected = await inspectStalePlanLockForOperator(target, { staleMs: 1 }); assert.equal(inspected.view.holder.token, "REDACTED"); assert.equal(JSON.stringify(inspected.view).includes(holder.token), false); const receipt = await recoverInspectedStalePlanLock(target, inspected, { operator: "Danie", reason: "holder process confirmed terminated", recoveryJournalPath }, { staleMs: 1, timestamp: "2026-09-02T00:00:00.000Z" }); assert.match(receipt.receiptHash, /^[a-f0-9]{64}$/); assert.equal(receipt.clearedHolder.token, "REDACTED"); const journal = await readJournal(recoveryJournalPath); assert.equal(journal[0].action, "plan-lock.stale-clearance-authorized"); assert.equal(JSON.stringify(journal).includes(holder.token), false);
});

test("stale clearance refuses changed holders and lock path links", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pp-lock-safety-")); const target = path.join(root, "journal.jsonl"); const lock = await acquirePlanLock(target, { actor: "crashed-agent" }); const holderPath = path.join(lock.lockDirectory, "holder.json"); const holder = JSON.parse(await readFile(holderPath, "utf8")); holder.acquiredAt = "2020-01-01T00:00:00.000Z"; await writeFile(holderPath, JSON.stringify(holder)); const inspection = await inspectPlanLock(target, { staleMs: 1 }); holder.token = "replacement-token"; await writeFile(holderPath, JSON.stringify(holder)); await assert.rejects(() => clearInspectedStalePlanLock(target, inspection, { actor: "operator", staleMs: 1 }), /holder identity changed/);
  await import("node:fs/promises").then(({ rm }) => rm(lock.lockDirectory, { recursive: true, force: true })); const outside = await mkdtemp(path.join(os.tmpdir(), "pp-lock-outside-"));
  try { await symlink(outside, lock.lockDirectory, process.platform === "win32" ? "junction" : "dir"); } catch (error) { if (error.code === "EPERM") { t.skip("Host policy prevents creating a lock-link fixture"); return; } throw error; }
  await assert.rejects(() => acquirePlanLock(target, { actor: "agent", timeoutMs: 20 }), /not a safe regular directory/);
});

test("concurrent writers serialize into one valid journal chain", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pp-journal-"));
  const journalPath = path.join(root, "evidence", "journal.jsonl");
  await Promise.all(Array.from({ length: 24 }, (_, index) => appendJournalEvent(journalPath, { action: "prove", payload: { index } }, { actor: `agent-${index % 4}`, timeoutMs: 5000 })));
  const entries = await readJournal(journalPath);
  assert.equal(entries.length, 24);
  assert.deepEqual(await verifyJournal(journalPath), { valid: true, brokenAt: null });
  assert.deepEqual([...entries.map((entry) => entry.sequence)].sort((a, b) => a - b), Array.from({ length: 24 }, (_, index) => index + 1));
});

test("journal append returns only after the durable entry can be reopened and verified", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pp-journal-sync-")); const journalPath = path.join(root, "journal.jsonl"); const entry = await appendJournalEvent(journalPath, { action: "durable", payload: { item: "B01" } }, { actor: "agent-a" }); const reopened = await readJournal(journalPath); assert.equal(reopened[0].hash, entry.hash); assert.deepEqual(await verifyJournal(journalPath), { valid: true, brokenAt: null });
});

test("tampering is detected and blocks the next append", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pp-tamper-"));
  const journalPath = path.join(root, "journal.jsonl");
  await appendJournalEvent(journalPath, { action: "claim", payload: { task: "B07" } }, { actor: "agent-a" });
  const line = JSON.parse((await readFile(journalPath, "utf8")).trim());
  line.payload.task = "B99";
  await writeFile(journalPath, `${JSON.stringify(line)}\n`);
  assert.deepEqual(await verifyJournal(journalPath), { valid: false, brokenAt: 1 });
  await assert.rejects(() => appendJournalEvent(journalPath, { action: "prove" }, { actor: "agent-b" }), /append refused/);
});
