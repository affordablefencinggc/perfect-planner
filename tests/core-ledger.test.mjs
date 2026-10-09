import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  canonicalJson,
  entryHash,
  formatStamp,
  ledgerDirectory,
  openLedger,
  replay,
} from "../src/core/ledger/index.mjs";

const owner = { kind: "person", id: "owner" };
const worker = { kind: "agent", id: "worker-1", model: "builder-model" };
const jev = { kind: "jev", id: "jev", model: "jev-latest" };
const system = { kind: "system", id: "perfect-planner" };
const ledgerModuleUrl = pathToFileURL(path.resolve("src/core/ledger/index.mjs")).href;

const repos = [];
async function tempRepo() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pp-core-ledger-"));
  repos.push(dir);
  return dir;
}
test.after(async () => {
  for (const dir of repos) await rm(dir, { recursive: true, force: true });
});

function fakeClock(start = "2026-10-09T10:00:00.000Z") {
  let t = Date.parse(start);
  return {
    now: () => new Date(t),
    advance(ms = 1000) { t += ms; },
    set(iso) { t = Date.parse(iso); },
  };
}

async function open(repo, clock = fakeClock()) {
  const ledger = await openLedger(repo, { now: clock.now });
  return { ledger, clock };
}

async function expectRule(promise, rule) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, "LEDGER_RULE", error.message);
    if (rule) assert.equal(error.rule, rule, error.message);
    return true;
  });
}

async function readyTask(ledger, { title = "Build the ledger", command = "node --test tests/x.test.mjs" } = {}) {
  const id = ledger.nextId("T");
  await ledger.append({ actor: owner, type: "task.created", subject: id, summary: title, refs: ["P-1 §2"] });
  await ledger.append({ actor: system, type: "test.defined", subject: id, summary: "Acceptance test defined", data: { command } });
  await ledger.append({ actor: owner, type: "test.approved", subject: id, summary: "Owner approved the acceptance test" });
  await ledger.append({ actor: worker, type: "task.claimed", subject: id, summary: "Claimed by worker-1" });
  return id;
}

function ledgerFiles(repo) {
  const dir = ledgerDirectory(repo);
  return fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort().map((name) => path.join(dir, name));
}

test("canonicalJson sorts keys recursively without whitespace; entryHash ignores hash", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null }, u: undefined }), '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  const entry = { n: "L-000001", prev: null, summary: "x" };
  assert.equal(entryHash(entry), entryHash({ ...entry, hash: "deadbeef" }));
  assert.notEqual(entryHash(entry), entryHash({ ...entry, prev: "abc" }));
  assert.match(entryHash(entry), /^[0-9a-f]{64}$/);
});

test("append assigns n, at, prev and hash, freezes the entry and persists one JSON line per entry", async () => {
  const repo = await tempRepo();
  const { ledger, clock } = await open(repo);
  const seen = [];
  const unsubscribe = ledger.subscribe((entry) => seen.push(entry.n));
  ledger.subscribe(() => { throw new Error("broken view"); });
  const first = await ledger.append({ actor: owner, type: "plan.approved", subject: "P-1", summary: "Plan v1 approved" });
  clock.advance();
  const second = await ledger.append({ actor: owner, type: "task.created", subject: "T-1", summary: "First task", evidence: ["doc://plan"], refs: ["P-1 §1"] });
  unsubscribe();
  clock.advance();
  await ledger.append({ actor: owner, type: "task.created", subject: "T-2", summary: "Second task" });

  assert.equal(first.n, "L-000001");
  assert.equal(first.prev, null);
  assert.equal(first.at, "2026-10-09T10:00:00.000Z");
  assert.equal(second.n, "L-000002");
  assert.equal(second.prev, first.hash);
  assert.equal(second.hash, entryHash(second));
  assert.equal(second.reason, null);
  assert.equal(second.corrects, null);
  assert.ok(Object.isFrozen(second) && Object.isFrozen(second.evidence) && Object.isFrozen(second.actor));
  assert.deepEqual(seen, ["L-000001", "L-000002"]);

  const files = ledgerFiles(repo);
  assert.deepEqual(files.map((file) => path.basename(file)), ["2026-10.jsonl"]);
  const lines = fs.readFileSync(files[0], "utf8").split("\n");
  assert.equal(lines.length, 4);
  assert.equal(lines[3], "");
  assert.deepEqual(JSON.parse(lines[1]), second);
  assert.equal(lines[1], canonicalJson(second));
  ledger.close();

  const reopened = await openLedger(repo);
  assert.deepEqual(reopened.verify().ok, true);
  assert.deepEqual(reopened.entries(), ledger.entries());
  assert.equal(reopened.nextId("T"), "T-3");
  reopened.close();
});

test("refuses malformed entries and missing reasons", async () => {
  const repo = await tempRepo();
  const { ledger } = await open(repo);
  await expectRule(ledger.append({ actor: owner, type: "task.exploded", subject: "T-1", summary: "x" }), "type-unknown");
  await expectRule(ledger.append({ actor: owner, type: "task.created", subject: "T-1", summary: "TBD" }), "summary-tbd");
  await expectRule(ledger.append({ actor: owner, type: "task.created", subject: "T-1", summary: " tbd " }), "summary-tbd");
  await expectRule(ledger.append({ actor: owner, type: "task.created", subject: "T-1", summary: "" }), "summary-required");
  await expectRule(ledger.append({ actor: owner, type: "task.created", subject: "T-1", summary: "two\nlines" }), "summary-one-line");
  await expectRule(ledger.append({ actor: { kind: "robot", id: "x" }, type: "task.created", subject: "T-1", summary: "x" }), "actor-kind");
  await expectRule(ledger.append({ actor: { kind: "person" }, type: "task.created", subject: "T-1", summary: "x" }), "actor-id");
  await expectRule(ledger.append({ actor: owner, type: "task.created", subject: "T-1", summary: "x", n: "L-000009" }), "input-unknown-field");
  await expectRule(ledger.append({ actor: owner, type: "task.created", subject: "T-1", summary: "x", hash: "abc" }), "input-unknown-field");
  await expectRule(ledger.append({ actor: owner, type: "task.created", subject: "T-1", summary: "x", evidence: [""] }), "evidence-shape");
  await expectRule(ledger.append({ actor: owner, type: "decision.made", subject: "D-1", summary: "Use X" }), "reason-required");
  await expectRule(ledger.append({ actor: owner, type: "decision.made", subject: "D-1", summary: "Use X", reason: "  " }), "reason-required");
  await expectRule(ledger.append({ actor: owner, type: "correction", subject: "L-000001", summary: "fix" }), "reason-required");
  await expectRule(ledger.append({ actor: owner, type: "task.created", subject: "T-2", summary: "skips T-1" }), "number-sequence");
  await expectRule(ledger.append({ actor: owner, type: "task.created", subject: "T-1", summary: "x", corrects: "L-000005" }), "corrects-future");
  await expectRule(ledger.append({ actor: owner, type: "task.claimed", subject: "T-1", summary: "x" }), "task-unknown");
  assert.equal(ledger.entries().length, 0, "refusals write nothing");

  const id = await readyTask(ledger);
  await expectRule(ledger.append({ actor: worker, type: "task.blocked", subject: id, summary: "Blocked" }), "reason-required");
  await expectRule(ledger.append({ actor: owner, type: "task.reopened", subject: id, summary: "Reopen" }), "reason-required");
  await expectRule(ledger.append({ actor: owner, type: "task.created", subject: id, summary: "reuse" }), "number-sequence");
  await expectRule(ledger.append({ actor: worker, type: "task.claimed", subject: id, summary: "double claim" }), "task-state");
  await expectRule(ledger.append({ actor: jev, type: "task.done", subject: id, summary: "Jev cannot finish" }), "jev-scope");
  await expectRule(ledger.append({ actor: jev, type: "merge.done", subject: id, summary: "Jev cannot merge" }), "jev-scope");
  await ledger.append({ actor: jev, type: "review.verdict", subject: id, summary: "Test review: approve", reason: "covers clause", data: { verdict: "approve", cost: 0.01, confidence: 0.9, provider: "TypeSafe", model: "jev-latest" } });
  await expectRule(ledger.append({ actor: owner, type: "correction", subject: "L-000001", summary: "fix", reason: "typo", corrects: "L-000099" }), "corrects-future");
  await ledger.append({ actor: owner, type: "correction", subject: "L-000001", summary: "Title typo fixed", reason: "typo in title", corrects: "L-000001" });
  assert.equal(ledger.board().corrections[0].corrects, "L-000001");
  ledger.close();
});

test("a task cannot start until its acceptance test exists and is approved", async () => {
  const repo = await tempRepo();
  const { ledger } = await open(repo);
  await ledger.append({ actor: owner, type: "task.created", subject: "T-1", summary: "Task" });
  await expectRule(ledger.append({ actor: worker, type: "task.claimed", subject: "T-1", summary: "claim" }), "task-test-not-approved");
  await expectRule(ledger.append({ actor: owner, type: "test.approved", subject: "T-1", summary: "approve" }), "test-undefined");
  await ledger.append({ actor: system, type: "test.defined", subject: "T-1", summary: "npm test -- core" });
  await expectRule(ledger.append({ actor: worker, type: "task.claimed", subject: "T-1", summary: "claim" }), "task-test-not-approved");
  await ledger.append({ actor: system, type: "test.failed", subject: "T-1", summary: "Fails on current code as expected", data: { where: "baseline" } });
  await ledger.append({ actor: owner, type: "test.approved", subject: "T-1", summary: "approve" });
  await ledger.append({ actor: worker, type: "task.claimed", subject: "T-1", summary: "claim" });
  const task = ledger.board().tasks["T-1"];
  assert.equal(task.state, "claimed");
  assert.equal(task.test.command, "npm test -- core");
  assert.equal(task.claimedBy, "worker-1");
  ledger.close();
});

test("task.done requires an approved test that passed after the last observed commit", async () => {
  const repo = await tempRepo();
  const { ledger } = await open(repo);
  const id = await readyTask(ledger);
  await ledger.append({ actor: worker, type: "task.progress", subject: id, summary: "Working" });
  await expectRule(ledger.append({ actor: system, type: "task.done", subject: id, summary: "done?" }), "task-done-gate");

  await ledger.append({ actor: system, type: "test.passed", subject: id, summary: "Passed in worktree", data: { where: "worktree" } });
  await ledger.append({ actor: system, type: "commit.observed", subject: id, summary: "Commit abc1234", data: { sha: "abc1234", files: ["src/a.mjs"] } });
  await expectRule(ledger.append({ actor: system, type: "task.done", subject: id, summary: "pass predates commit" }), "task-done-gate");

  await ledger.append({ actor: system, type: "test.failed", subject: id, summary: "Failed after commit" });
  await expectRule(ledger.append({ actor: system, type: "task.done", subject: id, summary: "latest run failed" }), "task-done-gate");

  // Redefining the test revokes approval; a pass of the old test no longer counts.
  await ledger.append({ actor: system, type: "test.defined", subject: id, summary: "Sharper test", data: { command: "node --test tests/y.test.mjs" } });
  await ledger.append({ actor: system, type: "test.passed", subject: id, summary: "Passed unapproved test" });
  await expectRule(ledger.append({ actor: system, type: "task.done", subject: id, summary: "unapproved" }), "task-done-gate");
  await ledger.append({ actor: owner, type: "test.approved", subject: id, summary: "Approved sharper test" });
  await expectRule(ledger.append({ actor: system, type: "task.done", subject: id, summary: "pass predates approval" }), "task-done-gate");

  await ledger.append({ actor: system, type: "merge.done", subject: id, summary: "Merged into integration", data: { commit: "def5678", into: "pp/integration" } });
  await ledger.append({ actor: system, type: "test.passed", subject: id, summary: "Passed on integration branch", data: { where: "integration" } });
  const done = await ledger.append({ actor: system, type: "task.done", subject: id, summary: "Done" });
  assert.equal(done.type, "task.done");
  await expectRule(ledger.append({ actor: system, type: "task.done", subject: id, summary: "again" }), "task-state");
  const task = ledger.board().tasks[id];
  assert.equal(task.state, "done");
  assert.equal(task.lastCommitEntry, "L-000007");
  assert.deepEqual(task.commits.map((commit) => commit.sha), ["abc1234"]);
  assert.equal(task.merged.commit, "def5678");
  ledger.close();
});

test("reopening bumps the attempt suffix and demands a fresh pass", async () => {
  const repo = await tempRepo();
  const { ledger } = await open(repo);
  const id = await readyTask(ledger);
  await ledger.append({ actor: system, type: "test.passed", subject: id, summary: "Passed" });
  await ledger.append({ actor: jev, type: "review.verdict", subject: id, summary: "Diff review: reject", reason: "touches files outside the task", data: { kind: "diff", verdict: "reject", cost: 0.02, confidence: 0.8, provider: "TypeSafe", model: "jev-latest" } });
  await ledger.append({ actor: system, type: "task.reopened", subject: id, summary: "Returned with notes", reason: "Jev rejected the diff" });
  let task = ledger.board().tasks[id];
  assert.equal(task.attempt, 2);
  assert.equal(task.attemptId, "T-1.a2");
  assert.equal(task.state, "reopened");
  assert.equal(task.claimedBy, null);
  assert.equal(task.reviews[0].verdict, "reject");
  assert.equal(task.reviews[0].model, "jev-latest");

  await expectRule(ledger.append({ actor: worker, type: "task.progress", subject: id, summary: "not claimed" }), "task-state");
  await expectRule(ledger.append({ actor: worker, type: "task.claimed", subject: "T-1.a3", summary: "wrong attempt" }), "task-attempt");
  await ledger.append({ actor: worker, type: "task.claimed", subject: "T-1.a2", summary: "Reclaimed attempt 2" });
  await expectRule(ledger.append({ actor: system, type: "task.done", subject: id, summary: "old pass" }), "task-done-gate");
  await ledger.append({ actor: system, type: "test.passed", subject: id, summary: "Passed again" });
  await expectRule(ledger.append({ actor: system, type: "task.done", subject: id, summary: "not merged" }), "task-done-gate");
  await ledger.append({ actor: system, type: "merge.done", subject: id, summary: "Merged attempt 2", data: { commit: "abc9999", into: "pp/integration" } });
  await ledger.append({ actor: system, type: "test.passed", subject: id, summary: "Passed on integration", data: { where: "integration" } });
  await ledger.append({ actor: system, type: "task.done", subject: "T-1.a2", summary: "Done on attempt 2" });
  await ledger.append({ actor: owner, type: "task.reopened", subject: id, summary: "Regression found", reason: "owner found a regression" });
  task = ledger.board().tasks[id];
  assert.equal(task.attemptId, "T-1.a3");
  assert.equal(ledger.nextId("T"), "T-2", "attempts never consume task numbers");
  ledger.close();
});

test("replay covers every entry type and is deterministic", async () => {
  const repo = await tempRepo();
  const clock = fakeClock();
  const { ledger } = await open(repo, clock);
  const tick = () => clock.advance(60_000);
  const add = async (entry) => { tick(); return ledger.append(entry); };

  await add({ actor: owner, type: "clause.added", subject: "P-1 §1", summary: "Goals", data: { text: "Ship the core loop" } });
  await add({ actor: owner, type: "clause.added", subject: "P-1 §3.1", summary: "Ledger is the source of truth" });
  await add({ actor: owner, type: "plan.approved", subject: "P-1", summary: "Plan v1" });
  await expectRule(ledger.append({ actor: owner, type: "plan.approved", subject: "P-1", summary: "again" }), "plan-already-approved");
  await add({ actor: owner, type: "clause.added", subject: "P-2 §3.1.1", summary: "Inserted after 3.1" });
  await expectRule(ledger.append({ actor: owner, type: "clause.added", subject: "P-2 §3.1", summary: "renumber" }), "clause-exists");
  await add({ actor: owner, type: "clause.changed", subject: "P-2 §3.1", summary: "Ledger is the ONLY source of truth" });
  await add({ actor: owner, type: "clause.withdrawn", subject: "P-2 §1", summary: "Goals moved" });
  await expectRule(ledger.append({ actor: owner, type: "clause.changed", subject: "P-2 §1", summary: "x" }), "clause-withdrawn");
  await add({ actor: owner, type: "plan.approved", subject: "P-2", summary: "Plan v2" });

  const id = await readyTask(ledger);
  await add({ actor: system, type: "worktree.created", subject: id, summary: "Worktree ready", data: { path: path.join(repo, ".perfect-planner", "worktrees", id), branch: `pp/${id}`, port: 5174 } });
  await add({ actor: worker, type: "task.progress", subject: id, summary: "Half way" });
  await add({ actor: worker, type: "question.asked", subject: "Q-1", summary: "Which hash?", data: { task: id, question: "sha256 or blake3?", options: ["sha256", "blake3"], blocking: true } });
  await add({ actor: owner, type: "question.answered", subject: "Q-1", summary: "sha256", data: { answer: "sha256" } });
  await expectRule(ledger.append({ actor: owner, type: "question.answered", subject: "Q-1", summary: "again" }), "question-answered");
  await add({ actor: owner, type: "decision.made", subject: "D-1", summary: "Use sha256", reason: "spec says sha256", data: { question: "Q-1" }, refs: ["P-2 §3.1"] });
  await add({ actor: owner, type: "decision.made", subject: "D-2", summary: "Pause all workers", reason: "owner break", data: { control: "pause-all" } });
  await add({ actor: worker, type: "task.blocked", subject: id, summary: "Waiting on infra", reason: "CI down" });
  await add({ actor: worker, type: "task.progress", subject: id, summary: "Unblocked" });
  await add({ actor: worker, type: "task.proof", subject: id, summary: "Proof attached", data: { kind: "log", link: "file://log.txt" } });
  await add({ actor: system, type: "commit.observed", subject: id, summary: "Commit 1", data: { sha: "1111111", files: ["src/core/ledger/index.mjs"] } });
  await add({ actor: system, type: "commit.observed", subject: id, summary: "Commit 1 seen again", data: { sha: "1111111", files: ["src/core/ledger/index.mjs"] } });
  await add({ actor: system, type: "collision.detected", subject: "src/shared.mjs", summary: "T-1 and T-2 both touch src/shared.mjs", data: { files: ["src/shared.mjs"], tasks: ["T-1", "T-2"] } });
  await expectRule(ledger.append({ actor: system, type: "collision.resolved", subject: "src/other.mjs", summary: "x" }), "collision-unknown");
  await add({ actor: owner, type: "collision.resolved", subject: "src/shared.mjs", summary: "T-2 waits" });
  await add({ actor: system, type: "test.passed", subject: id, summary: "Passed" });
  await add({ actor: system, type: "merge.done", subject: id, summary: "Merged", data: { commit: "2222222" } });
  await add({ actor: system, type: "test.passed", subject: id, summary: "Passed on integration", data: { where: "integration" } });
  await add({ actor: system, type: "task.done", subject: id, summary: "Done" });
  await add({ actor: system, type: "worktree.removed", subject: id, summary: "Worktree removed" });
  await expectRule(ledger.append({ actor: system, type: "worktree.removed", subject: id, summary: "again" }), "worktree-missing");
  await add({ actor: system, type: "budget.warning", subject: "jev-2026-10", summary: "Jev spend at 80% of cap", data: { percent: 80 } });
  await expectRule(ledger.append({ actor: owner, type: "release.cut", subject: "R-1", summary: "bad plan", data: { plan: "P-9" } }), "plan-unknown");
  const cut = await add({ actor: owner, type: "release.cut", subject: "R-1", summary: "v1.0.0", data: { version: "1.0.0", plan: "P-2", commit: "9f3c2e1aa" } });
  await add({ actor: owner, type: "release.rollback", subject: "R-1", summary: "Rolled back" });
  await expectRule(ledger.append({ actor: owner, type: "release.rollback", subject: "R-1", summary: "again" }), "release-rolled-back");

  const board = ledger.board();
  assert.equal(board.plans["P-1"].state, "approved");
  assert.equal(board.plans["P-2"].basedOn, "P-1");
  assert.equal(board.plans["P-1"].clauses["§1"].text, "Ship the core loop");
  assert.equal(board.plans["P-1"].clauses["§3.1"].text, "Ledger is the source of truth", "older versions are untouched");
  assert.equal(board.plans["P-2"].clauses["§3.1"].text, "Ledger is the ONLY source of truth");
  assert.equal(board.plans["P-2"].clauses["§3.1"].ref, "P-2 §3.1");
  assert.equal(board.plans["P-2"].clauses["§1"].state, "withdrawn", "withdrawn clauses stay listed");
  assert.ok(board.plans["P-2"].clauses["§3.1.1"]);
  const task = board.tasks[id];
  assert.equal(task.state, "done");
  assert.equal(task.worktree, null);
  assert.equal(task.commits.length, 1, "duplicate commit observations are ignored");
  assert.equal(task.lastProgress, "Unblocked");
  assert.equal(task.proofs[0].link, "file://log.txt");
  assert.deepEqual(task.refs, ["P-1 §2"]);
  assert.deepEqual(board.questions["Q-1"], {
    ...board.questions["Q-1"],
    task: id, text: "sha256 or blake3?", options: ["sha256", "blake3"], blocking: true, state: "answered", answer: "sha256", decision: "D-1",
  });
  assert.equal(board.decisions["D-1"].reason, "spec says sha256");
  assert.equal(board.control.paused, true);
  assert.equal(board.collisions.length, 1);
  assert.equal(board.collisions[0].state, "resolved");
  assert.deepEqual(board.collisions[0].tasks, ["T-1", "T-2"]);
  assert.equal(board.budgetWarnings[0].percent, 80);
  assert.equal(board.releases["R-1"].state, "rolled-back");
  assert.equal(board.releases["R-1"].stamp, `R-1 · v1.0.0 · P-2 · ${cut.n} · 9f3c2e1`);
  assert.equal(ledger.nextId("P"), "P-3");
  assert.equal(ledger.nextId("Q"), "Q-2");
  assert.equal(ledger.nextId("D"), "D-3");
  assert.equal(ledger.nextId("R"), "R-2");
  assert.equal(ledger.nextId("L"), `L-${String(ledger.entries().length + 1).padStart(6, "0")}`);
  assert.throws(() => ledger.nextId("X"), (error) => error.code === "LEDGER_RULE");

  const entries = ledger.entries();
  assert.deepEqual(replay(entries), replay(entries));
  assert.deepEqual(replay(entries), board);
  assert.deepEqual(replay(JSON.parse(JSON.stringify(entries))), board);
  ledger.close();

  const again = await openLedger(repo);
  assert.deepEqual(again.board(), board, "replay from disk equals the live board");
  again.close();
});

test("tampering with a line on disk is detected at that entry and blocks writes until acknowledged", async () => {
  const repo = await tempRepo();
  const { ledger } = await open(repo);
  for (let index = 1; index <= 5; index += 1) await ledger.append({ actor: owner, type: "task.created", subject: `T-${index}`, summary: `Task ${index}` });
  assert.equal(ledger.verify().ok, true);

  const [file] = ledgerFiles(repo);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const tampered = JSON.parse(lines[2]);
  tampered.summary = "Task 3 (quietly edited)";
  lines[2] = canonicalJson(tampered);
  fs.writeFileSync(file, lines.join("\n"));

  const status = ledger.verify();
  assert.equal(status.ok, false);
  assert.equal(status.firstBad, "L-000003");
  assert.equal(status.reason, "hash-mismatch");
  await assert.rejects(ledger.append({ actor: owner, type: "task.created", subject: "T-6", summary: "x" }), (error) => error.code === "LEDGER_CHAIN_BROKEN" && error.firstBad === "L-000003");
  ledger.close();

  const reopened = await openLedger(repo);
  assert.equal(reopened.verify().firstBad, "L-000003");
  await assert.rejects(reopened.append({ actor: owner, type: "task.created", subject: "T-6", summary: "x" }), (error) => error.code === "LEDGER_CHAIN_BROKEN");
  await assert.rejects(reopened.acknowledgeBreak(""), (error) => error.code === "LEDGER_RULE");
  assert.equal(reopened.board().tasks["T-3"], undefined, "a tampered line never reaches the board");
  assert.equal(reopened.entries().some((entry) => entry.n === "L-000003"), false);
  assert.deepEqual(reopened.board().integrity.rejected.map((item) => [item.n, item.reason]), [["L-000003", "hash-mismatch"]]);
  const correction = await reopened.acknowledgeBreak("Owner confirmed the edit was a manual mistake", { actor: owner });
  assert.equal(reopened.board().tasks["T-3"], undefined, "acknowledging a break does not make the tampered line count");
  assert.equal(reopened.nextId("T"), "T-6", "the rejected line's number stays reserved");
  assert.equal(correction.type, "correction");
  assert.equal(correction.corrects, "L-000003");
  assert.equal(correction.n, "L-000006");
  assert.equal(reopened.verify().ok, true);
  await reopened.append({ actor: owner, type: "task.created", subject: "T-6", summary: "After acknowledgement" });
  await assert.rejects(reopened.acknowledgeBreak("nothing to acknowledge"), (error) => error.rule === "no-break");
  reopened.close();

  const third = await openLedger(repo);
  const final = third.verify();
  assert.equal(third.board().tasks["T-3"], undefined);
  assert.equal(third.board().integrity.rejected[0].acknowledged, true);
  assert.equal(final.ok, true);
  assert.equal(final.breaks.length, 1);
  assert.equal(final.breaks[0].acknowledged, true);

  // A second, different edit to the same line is a new, unacknowledged break.
  third.close();
  const again = fs.readFileSync(file, "utf8").split("\n");
  const edited = JSON.parse(again[2]);
  edited.summary = "Edited twice";
  again[2] = canonicalJson(edited);
  fs.writeFileSync(file, again.join("\n"));
  const fourth = await openLedger(repo);
  assert.equal(fourth.verify().ok, false);
  assert.equal(fourth.verify().firstBad, "L-000003");
  fourth.close();
});

test("a deleted line breaks the chain at the following entry", async () => {
  const repo = await tempRepo();
  const { ledger } = await open(repo);
  for (let index = 1; index <= 4; index += 1) await ledger.append({ actor: owner, type: "task.created", subject: `T-${index}`, summary: `Task ${index}` });
  ledger.close();
  const [file] = ledgerFiles(repo);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.splice(1, 1);
  fs.writeFileSync(file, lines.join("\n"));
  const reopened = await openLedger(repo);
  const status = reopened.verify();
  assert.equal(status.ok, false);
  assert.equal(status.firstBad, "L-000003");
  assert.match(status.reason, /prev-mismatch/);
  assert.match(status.reason, /number-out-of-sequence/);
  reopened.close();
});

test("a torn last line is reported, never silently dropped, and preserved after acknowledgement", async () => {
  const repo = await tempRepo();
  const { ledger } = await open(repo);
  await ledger.append({ actor: owner, type: "task.created", subject: "T-1", summary: "Task 1" });
  await ledger.append({ actor: owner, type: "task.created", subject: "T-2", summary: "Task 2" });
  ledger.close();
  const [file] = ledgerFiles(repo);
  const torn = '{"actor":{"id":"owner","kind":"person"},"at":"2026-10-09T10:0';
  fs.appendFileSync(file, torn);

  const reopened = await openLedger(repo);
  const status = reopened.verify();
  assert.equal(status.ok, false);
  assert.equal(status.reason, "torn-last-line");
  assert.equal(status.firstBad, "L-000003");
  assert.equal(reopened.entries().length, 2);
  await assert.rejects(reopened.append({ actor: owner, type: "task.created", subject: "T-3", summary: "x" }), (error) => error.code === "LEDGER_CHAIN_BROKEN");
  const correction = await reopened.acknowledgeBreak("Crash during write; fragment kept for audit");
  assert.equal(correction.n, "L-000003");
  assert.equal(correction.corrects, null);
  await reopened.append({ actor: owner, type: "task.created", subject: "T-3", summary: "Task 3" });
  reopened.close();

  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.includes(`${torn}\n`), "torn fragment is still on disk on its own line");
  const third = await openLedger(repo);
  assert.equal(third.verify().ok, true);
  assert.equal(third.entries().length, 4);
  assert.equal(third.board().tasks["T-3"].title, "Task 3");
  third.close();
});

test("only one writer: a second openLedger gets LEDGER_LOCKED (same process and another process)", async () => {
  const repo = await tempRepo();
  const first = await openLedger(repo);
  await assert.rejects(openLedger(repo), (error) => error.code === "LEDGER_LOCKED");

  const script = `import(${JSON.stringify(ledgerModuleUrl)}).then((m) => m.openLedger(${JSON.stringify(repo)})).then((l) => { console.log("OPENED"); l.close(); }, (e) => console.log(e.code));`;
  const child = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }).trim();
  assert.equal(child, "LEDGER_LOCKED");

  first.close();
  await assert.rejects(first.append({ actor: owner, type: "task.created", subject: "T-1", summary: "x" }), (error) => error.code === "LEDGER_CLOSED");
  const lockPath = path.join(ledgerDirectory(repo), "ledger.lock");
  assert.equal(fs.existsSync(lockPath), false, "close releases the lock");
  const childAfter = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }).trim();
  assert.equal(childAfter, "OPENED");
  const second = await openLedger(repo);
  second.close();
});

test("a stale lock from a dead process is detected and replaced", async () => {
  const repo = await tempRepo();
  const directory = ledgerDirectory(repo);
  fs.mkdirSync(directory, { recursive: true });
  const dead = spawnSync(process.execPath, ["-e", ""]);
  const lockPath = path.join(directory, "ledger.lock");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: dead.pid, hostname: os.hostname(), startedAt: "2026-01-01T00:00:00.000Z", token: "old" }));
  const ledger = await openLedger(repo);
  const holder = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  assert.equal(holder.pid, process.pid);
  ledger.close();

  // A fresh, unreadable lock (another writer mid-write) is respected.
  fs.writeFileSync(lockPath, "{");
  await assert.rejects(openLedger(repo), (error) => error.code === "LEDGER_LOCKED");
  fs.unlinkSync(lockPath);
});

test("entries roll over into monthly files and the chain continues across them", async () => {
  const repo = await tempRepo();
  const clock = fakeClock("2026-10-31T23:59:59.000Z");
  const { ledger } = await open(repo, clock);
  await ledger.append({ actor: owner, type: "task.created", subject: "T-1", summary: "October" });
  clock.set("2026-11-01T00:00:01.000Z");
  const november = await ledger.append({ actor: owner, type: "task.created", subject: "T-2", summary: "November" });
  clock.set("2026-10-15T00:00:00.000Z"); // clock skew backwards
  const skewed = await ledger.append({ actor: owner, type: "task.created", subject: "T-3", summary: "Skewed clock" });
  clock.set("2027-01-02T00:00:00.000Z");
  await ledger.append({ actor: owner, type: "task.created", subject: "T-4", summary: "January" });
  assert.equal(skewed.at, november.at, "time never runs backwards in the ledger");
  ledger.close();

  assert.deepEqual(ledgerFiles(repo).map((file) => path.basename(file)), ["2026-10.jsonl", "2026-11.jsonl", "2027-01.jsonl"]);
  assert.equal(fs.readFileSync(ledgerFiles(repo)[1], "utf8").trim().split("\n").length, 2);
  const reopened = await openLedger(repo);
  assert.equal(reopened.verify().ok, true);
  assert.equal(reopened.entries()[1].prev, reopened.entries()[0].hash);
  assert.deepEqual(reopened.entries().map((entry) => entry.n), ["L-000001", "L-000002", "L-000003", "L-000004"]);
  reopened.close();
});

test("concurrent appends from one process are serialized into one valid chain", async () => {
  const repo = await tempRepo();
  const { ledger } = await open(repo);
  const results = await Promise.allSettled(Array.from({ length: 40 }, (_, index) =>
    ledger.append({ actor: owner, type: "task.created", subject: `T-${index + 1}`, summary: `Task ${index + 1}` })));
  assert.ok(results.every((result) => result.status === "fulfilled"));
  assert.deepEqual(results.map((result) => result.value.n), Array.from({ length: 40 }, (_, index) => `L-${String(index + 1).padStart(6, "0")}`));
  assert.equal(ledger.verify().ok, true);
  ledger.close();
});

test("a write by something other than the single writer is detected", async () => {
  const repo = await tempRepo();
  const { ledger } = await open(repo);
  const first = await ledger.append({ actor: owner, type: "task.created", subject: "T-1", summary: "Task 1" });
  const intruder = { n: "L-000002", at: first.at, actor: owner, type: "task.created", subject: "T-2", summary: "sneaky", reason: null, evidence: [], refs: [], corrects: null, prev: first.hash };
  intruder.hash = entryHash(intruder);
  fs.appendFileSync(ledgerFiles(repo)[0], `${canonicalJson(intruder)}\n`);
  const status = ledger.verify();
  assert.equal(status.ok, false);
  assert.equal(status.reason, "changed-outside-writer");
  assert.equal(status.firstBad, "L-000002");
  await assert.rejects(ledger.append({ actor: owner, type: "task.created", subject: "T-2", summary: "x" }), (error) => error.code === "LEDGER_CHAIN_BROKEN");
  const correction = await ledger.acknowledgeBreak("Owner reviewed the external entry");
  assert.equal(correction.n, "L-000003");
  assert.equal(ledger.board().tasks["T-2"].title, "sneaky");
  await ledger.append({ actor: owner, type: "task.created", subject: "T-3", summary: "Task 3" });
  ledger.close();
});

test("formatStamp renders the full release stamp", () => {
  assert.equal(formatStamp({ release: "R-1", version: "1.0.0", plan: "P-1", entry: "L-000231", commit: "9f3c2e1d0c" }), "R-1 · v1.0.0 · P-1 · L-000231 · 9f3c2e1");
  assert.equal(formatStamp({ release: "R-2", version: "v2.1.0", plan: "P-3", entry: 12, commit: "abc" }), "R-2 · v2.1.0 · P-3 · L-000012 · abc");
  assert.throws(() => formatStamp({}));
});

test("performance: 10k entries open, verify and replay quickly", async () => {
  const repo = await tempRepo();
  const directory = ledgerDirectory(repo);
  fs.mkdirSync(directory, { recursive: true });
  const lines = [];
  let prev = null;
  let n = 0;
  const base = Date.parse("2026-10-01T00:00:00.000Z");
  const push = (fields) => {
    n += 1;
    const entry = { n: `L-${String(n).padStart(6, "0")}`, at: new Date(base + n * 1000).toISOString(), actor: owner, reason: null, evidence: [], refs: [], corrects: null, prev, ...fields };
    entry.hash = entryHash(entry);
    prev = entry.hash;
    lines.push(canonicalJson(entry));
  };
  for (let task = 1; task <= 2000; task += 1) {
    const subject = `T-${task}`;
    push({ type: "task.created", subject, summary: `Task ${task}` });
    push({ type: "test.defined", subject, summary: "test", data: { command: `node --test tests/t${task}.test.mjs` } });
    push({ type: "test.approved", subject, summary: "approved" });
    push({ type: "task.claimed", subject, summary: "claimed", actor: worker });
    push({ type: "task.progress", subject, summary: "progress", actor: worker });
  }
  fs.writeFileSync(path.join(directory, "2026-10.jsonl"), `${lines.join("\n")}\n`);

  const openStart = performance.now();
  const ledger = await openLedger(repo);
  const openMs = performance.now() - openStart;
  assert.equal(ledger.verify().ok, true);
  const entries = ledger.entries();
  assert.equal(entries.length, 10_000);
  const replayStart = performance.now();
  const board = replay(entries);
  const replayMs = performance.now() - replayStart;
  assert.equal(Object.keys(board.tasks).length, 2000);
  assert.equal(board.tasks["T-2000"].state, "in-progress");
  assert.ok(replayMs < 2000, `replay took ${replayMs.toFixed(0)}ms`);
  assert.ok(openMs < 5000, `open + chain verification took ${openMs.toFixed(0)}ms`);
  await ledger.append({ actor: owner, type: "task.created", subject: "T-2001", summary: "One more" });
  assert.equal(ledger.nextId("T"), "T-2002");
  ledger.close();
});

// ------------------------------------------------------------ review fixes

async function doneReadyTask(ledger) {
  const id = await readyTask(ledger);
  await ledger.append({ actor: system, type: "commit.observed", subject: id, summary: "Commit", data: { sha: "aaa1111", files: ["src/a.mjs"] } });
  await ledger.append({ actor: system, type: "test.passed", subject: id, summary: "Passed in worktree", data: { where: "worktree" } });
  return id;
}

test("a released task can be claimed again by another worker", async () => {
  const repo = await tempRepo();
  const { ledger } = await open(repo);
  const id = await readyTask(ledger);
  await ledger.append({ actor: worker, type: "task.progress", subject: id, summary: "Working" });
  await ledger.append({ actor: worker, type: "task.progress", subject: id, summary: "Released back to the pool", data: { released: true } });
  let task = ledger.board().tasks[id];
  assert.equal(task.state, "released");
  assert.equal(task.claimedBy, null);
  await expectRule(ledger.append({ actor: worker, type: "task.progress", subject: id, summary: "still working?" }), "task-state");
  await expectRule(ledger.append({ actor: system, type: "task.done", subject: id, summary: "done?" }), "task-state");
  const other = { kind: "agent", id: "worker-2", model: "other-model" };
  await ledger.append({ actor: other, type: "task.claimed", subject: id, summary: "Claimed by worker-2" });
  task = ledger.board().tasks[id];
  assert.equal(task.state, "claimed");
  assert.equal(task.claimedBy, "worker-2");
  assert.equal(task.claimedModel, "other-model");
  ledger.close();
  const reopened = await openLedger(repo);
  assert.equal(reopened.board().tasks[id].claimedBy, "worker-2");
  reopened.close();
});

test("only creating entries advance a number series; mentioning an id never skips numbers", async () => {
  const repo = await tempRepo();
  const { ledger } = await open(repo);
  await ledger.append({ actor: owner, type: "task.created", subject: "T-1", summary: "Task" });
  await ledger.append({ actor: owner, type: "correction", subject: "T-99", summary: "Mentions T-99", reason: "probe" });
  await ledger.append({ actor: system, type: "budget.warning", subject: "Q-50", summary: "Mentions Q-50" });
  await ledger.append({ actor: owner, type: "correction", subject: "D-7", summary: "Mentions D-7", reason: "probe" });
  await ledger.append({ actor: owner, type: "correction", subject: "R-3", summary: "Mentions R-3", reason: "probe" });
  await ledger.append({ actor: owner, type: "correction", subject: "P-4", summary: "Mentions P-4", reason: "probe" });
  assert.equal(ledger.nextId("T"), "T-2");
  assert.equal(ledger.nextId("Q"), "Q-1");
  assert.equal(ledger.nextId("D"), "D-1");
  assert.equal(ledger.nextId("R"), "R-1");
  assert.equal(ledger.nextId("P"), "P-1");
  await ledger.append({ actor: owner, type: "task.created", subject: "T-2", summary: "Next task is T-2" });
  await expectRule(ledger.append({ actor: owner, type: "clause.added", subject: "P-3 §1", summary: "skips P-1" }), "number-sequence");
  await expectRule(ledger.append({ actor: owner, type: "clause.changed", subject: "P-1 §1", summary: "no such clause" }), "clause-unknown");
  ledger.close();
  const reopened = await openLedger(repo);
  assert.equal(reopened.nextId("T"), "T-3");
  assert.equal(reopened.nextId("Q"), "Q-1");
  reopened.close();
});

test("actor kinds are limited to the entry types they may write", async () => {
  const repo = await tempRepo();
  const { ledger } = await open(repo);
  await ledger.append({ actor: owner, type: "task.created", subject: "T-1", summary: "Task" });
  await ledger.append({ actor: worker, type: "test.defined", subject: "T-1", summary: "Proposed test", data: { command: "node --test tests/z.test.mjs" } });
  await expectRule(ledger.append({ actor: worker, type: "test.approved", subject: "T-1", summary: "self-approve" }), "actor-not-permitted");
  await expectRule(ledger.append({ actor: jev, type: "test.approved", subject: "T-1", summary: "jev approve" }), "jev-scope");
  await ledger.append({ actor: system, type: "test.approved", subject: "T-1", summary: "Approved after Jev review" });
  await ledger.append({ actor: worker, type: "task.claimed", subject: "T-1", summary: "Claimed" });
  for (const type of ["test.passed", "test.failed", "commit.observed", "worktree.created", "collision.detected", "budget.warning"]) {
    await expectRule(ledger.append({ actor: worker, type, subject: "T-1", summary: `agent ${type}` }), "actor-not-permitted");
    await expectRule(ledger.append({ actor: owner, type, subject: "T-1", summary: `person ${type}` }), "actor-not-permitted");
  }
  await expectRule(ledger.append({ actor: worker, type: "merge.done", subject: "T-1", summary: "self-merge" }), "actor-not-permitted");
  await expectRule(ledger.append({ actor: worker, type: "task.done", subject: "T-1", summary: "self-done" }), "actor-not-permitted");
  await expectRule(ledger.append({ actor: worker, type: "task.reopened", subject: "T-1", summary: "reopen", reason: "x" }), "actor-not-permitted");
  await expectRule(ledger.append({ actor: worker, type: "plan.approved", subject: "P-1", summary: "approve plan" }), "actor-not-permitted");
  await expectRule(ledger.append({ actor: system, type: "plan.approved", subject: "P-1", summary: "approve plan" }), "actor-not-permitted");
  await expectRule(ledger.append({ actor: worker, type: "clause.added", subject: "P-1 §1", summary: "agent clause" }), "actor-not-permitted");
  await expectRule(ledger.append({ actor: worker, type: "decision.made", subject: "D-1", summary: "agent decides", reason: "x" }), "actor-not-permitted");
  await expectRule(ledger.append({ actor: worker, type: "release.cut", subject: "R-1", summary: "agent release" }), "actor-not-permitted");
  await expectRule(ledger.append({ actor: worker, type: "correction", subject: "L-000001", summary: "agent correction", reason: "x" }), "actor-not-permitted");
  await expectRule(ledger.append({ actor: worker, type: "review.verdict", subject: "T-1", summary: "self review", reason: "x", data: { verdict: "approve" } }), "actor-not-permitted");
  assert.equal(ledger.entries().length, 4, "refusals write nothing");
  ledger.close();
});

test("task.done requires a merge and an integration pass after it", async () => {
  const repo = await tempRepo();
  const { ledger } = await open(repo);
  const id = await doneReadyTask(ledger);
  await expectRule(ledger.append({ actor: system, type: "task.done", subject: id, summary: "no merge" }), "task-done-gate");
  await ledger.append({ actor: system, type: "merge.done", subject: id, summary: "Merged", data: { commit: "bbb2222", into: "pp/integration" } });
  await expectRule(ledger.append({ actor: system, type: "task.done", subject: id, summary: "pass predates merge" }), "task-done-gate");
  await ledger.append({ actor: system, type: "test.passed", subject: id, summary: "Passed in worktree again", data: { where: "worktree" } });
  await expectRule(ledger.append({ actor: system, type: "task.done", subject: id, summary: "not on integration" }), "task-done-gate");
  await ledger.append({ actor: system, type: "test.failed", subject: id, summary: "Failed on integration", data: { where: "integration" } });
  await expectRule(ledger.append({ actor: system, type: "task.done", subject: id, summary: "failed on integration" }), "task-done-gate");
  await ledger.append({ actor: system, type: "test.passed", subject: id, summary: "Passed on integration", data: { where: "integration" } });
  const done = await ledger.append({ actor: system, type: "task.done", subject: id, summary: "Done" });
  assert.equal(done.type, "task.done");
  ledger.close();
});

test("review.verdict records model, provider, cost, confidence and reason; rejects explain why", async () => {
  const repo = await tempRepo();
  const { ledger } = await open(repo);
  const id = await readyTask(ledger);
  const full = { verdict: "approve", model: "jev-latest", provider: "TypeSafe", cost: 0.01, confidence: 0.9 };
  const verdict = (data, extra = {}) => ledger.append({ actor: jev, type: "review.verdict", subject: id, summary: "Diff review", reason: "covers the clause", data, ...extra });
  await expectRule(ledger.append({ actor: jev, type: "review.verdict", subject: id, summary: "bare verdict" }), "verdict-shape");
  await expectRule(verdict({ ...full }, { reason: undefined }), "reason-required");
  await expectRule(verdict({ ...full, verdict: "maybe" }), "verdict-shape");
  await expectRule(verdict({ ...full, model: undefined }), "verdict-model");
  await expectRule(verdict({ ...full, provider: undefined }), "verdict-provider");
  await expectRule(verdict({ ...full, cost: "cheap" }), "verdict-cost");
  await expectRule(verdict({ ...full, cost: -1 }), "verdict-cost");
  await expectRule(verdict({ ...full, confidence: 2 }), "verdict-confidence");
  await expectRule(verdict({ ...full, confidence: undefined }), "verdict-confidence");
  await expectRule(verdict({ ...full, model: "builder-model" }), "verdict-same-model");
  await expectRule(ledger.append({ actor: owner, type: "review.verdict", subject: id, summary: "Owner rejects", data: { verdict: "reject" } }), "reason-required");
  await verdict(full);
  await ledger.append({ actor: owner, type: "review.verdict", subject: id, summary: "Owner rejects", reason: "wrong approach", data: { verdict: "reject" } });
  const reviews = ledger.board().tasks[id].reviews;
  assert.deepEqual(reviews.map((review) => [review.verdict, review.model, review.provider, review.cost, review.confidence]), [["approve", "jev-latest", "TypeSafe", 0.01, 0.9], ["reject", null, null, null, null]]);
  ledger.close();
});

test("a failed write blocks the ledger until acknowledged and never glues lines together", async () => {
  const repo = await tempRepo();
  const { ledger } = await open(repo);
  await ledger.append({ actor: owner, type: "task.created", subject: "T-1", summary: "Task 1" });
  const realWriteSync = fs.writeSync;
  fs.writeSync = (fd, buffer, offset, length) => {
    realWriteSync(fd, buffer, offset, Math.min(length, 20));
    const error = new Error("no space left on device");
    error.code = "ENOSPC";
    throw error;
  };
  try {
    await assert.rejects(ledger.append({ actor: owner, type: "task.created", subject: "T-2", summary: "Task 2" }), (error) => error.code === "LEDGER_WRITE_FAILED" && error.cause.code === "ENOSPC");
  } finally {
    fs.writeSync = realWriteSync;
  }
  assert.equal(ledger.entries().length, 1, "the failed entry is not in memory");
  await assert.rejects(ledger.append({ actor: owner, type: "task.created", subject: "T-2", summary: "Task 2" }), (error) => error.code === "LEDGER_CHAIN_BROKEN" && error.reason === "write-failed");
  const correction = await ledger.acknowledgeBreak("Disk filled up during a write");
  assert.equal(correction.n, "L-000002");
  await ledger.append({ actor: owner, type: "task.created", subject: "T-2", summary: "Task 2" });
  ledger.close();

  const lines = fs.readFileSync(ledgerFiles(repo)[0], "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 4, "entry, fragment on its own line, correction, entry");
  const reopened = await openLedger(repo);
  assert.equal(reopened.verify().ok, true);
  assert.deepEqual(reopened.entries().map((entry) => entry.n), ["L-000001", "L-000002", "L-000003"]);
  assert.equal(reopened.board().tasks["T-2"].title, "Task 2");
  reopened.close();
});

test("stale lock takeover is atomic and survives pid reuse after a reboot", async () => {
  const { takeOverStaleLock } = await import("../src/core/ledger/storage.mjs");
  const repo = await tempRepo();
  const directory = ledgerDirectory(repo);
  fs.mkdirSync(directory, { recursive: true });
  const lockPath = path.join(directory, "ledger.lock");
  const sideFiles = () => fs.readdirSync(directory).filter((name) => name.endsWith(".stale"));

  // A lock that was replaced after it was judged stale is put back, not deleted.
  const fresh = JSON.stringify({ pid: process.ppid, hostname: os.hostname(), startedAt: new Date().toISOString(), token: "fresh" });
  fs.writeFileSync(lockPath, fresh);
  assert.equal(takeOverStaleLock(lockPath, "{\"token\":\"the-old-one\"}"), false);
  assert.equal(fs.readFileSync(lockPath, "utf8"), fresh);
  assert.deepEqual(sideFiles(), []);
  assert.equal(takeOverStaleLock(path.join(directory, "missing.lock"), "x"), false);

  // A live pid that holds the lock is respected...
  await assert.rejects(openLedger(repo), (error) => error.code === "LEDGER_LOCKED");
  // ...unless the owner explicitly overrides it.
  const forced = await openLedger(repo, { overrideLock: true });
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, process.pid);
  forced.close();

  // A lock written before this machine booted is stale even if its pid is alive again.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, hostname: os.hostname(), startedAt: "2000-01-01T00:00:00.000Z", token: "pre-boot" }));
  const ledger = await openLedger(repo);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, process.pid);
  assert.deepEqual(sideFiles(), []);
  ledger.close();

  // Two racers judging the same stale lock: only one removes it.
  const stale = JSON.stringify({ pid: 0, hostname: os.hostname(), startedAt: "2000-01-01T00:00:00.000Z", token: "dead" });
  fs.writeFileSync(lockPath, stale);
  assert.equal(takeOverStaleLock(lockPath, stale), true);
  assert.equal(takeOverStaleLock(lockPath, stale), false);
  assert.equal(fs.existsSync(lockPath), false);
});

test("entries that look like they carry a secret are refused", async () => {
  const repo = await tempRepo();
  const { ledger } = await open(repo);
  const { randomBytes } = await import("node:crypto");
  let token;
  do token = randomBytes(30).toString("base64url"); while (!/[A-Z]/.test(token) || !/[a-z]/.test(token) || !/[0-9]/.test(token));
  const samples = [
    ["summary", `key is ${"sk-" + "ant-" + "x".repeat(30)}`],
    ["summary", `token ${"gh" + "p_" + "A1".repeat(20)}`],
    ["reason", `aws ${"AK" + "IA" + "ABCDEFGHIJKLMNOP"}`],
    ["evidence", ["-----BEGIN " + "RSA PRIVATE KEY-----"]],
    ["data", { env: { API_KEY: token } }],
  ];
  for (const [field, value] of samples) {
    const input = { actor: owner, type: "decision.made", subject: "D-1", summary: "Use the key", reason: "needed" };
    input[field] = value;
    await expectRule(ledger.append(input), "secret-detected");
  }
  assert.equal(ledger.entries().length, 0);
  // Hashes, shas, paths and ordinary prose are fine.
  await ledger.append({ actor: owner, type: "task.created", subject: "T-1", summary: "Wire src/core/ledger/storage.mjs into the AppShellCoordinatorProvider", data: { sha: "9f3c2e1d0c9f3c2e1d0c9f3c2e1d0c9f3c2e1d0c", lineSha: "a".repeat(64) } });
  ledger.close();
});

test("an approved plan is immutable; clause changes start a new plan version", async () => {
  const repo = await tempRepo();
  const { ledger } = await open(repo);
  await ledger.append({ actor: owner, type: "clause.added", subject: "P-1 §1", summary: "Goals" });
  await ledger.append({ actor: owner, type: "clause.added", subject: "P-1 §2", summary: "Ledger" });
  await ledger.append({ actor: owner, type: "plan.approved", subject: "P-1", summary: "Plan v1" });
  await expectRule(ledger.append({ actor: owner, type: "clause.added", subject: "P-1 §3", summary: "late clause" }), "plan-approved-immutable");
  await expectRule(ledger.append({ actor: owner, type: "clause.changed", subject: "P-1 §1", summary: "edit in place" }), "plan-approved-immutable");
  await expectRule(ledger.append({ actor: owner, type: "clause.withdrawn", subject: "P-1 §2", summary: "withdraw in place" }), "plan-approved-immutable");
  await expectRule(ledger.append({ actor: owner, type: "clause.changed", subject: "P-2 §9", summary: "not inherited" }), "clause-unknown");
  await ledger.append({ actor: owner, type: "clause.changed", subject: "P-2 §1", summary: "Sharper goals" });
  const board = ledger.board();
  assert.equal(board.plans["P-1"].clauses["§1"].text, "Goals");
  assert.equal(board.plans["P-2"].state, "draft");
  assert.equal(board.plans["P-2"].clauses["§1"].text, "Sharper goals");
  assert.equal(board.plans["P-2"].clauses["§2"].text, "Ledger");
  ledger.close();
});
