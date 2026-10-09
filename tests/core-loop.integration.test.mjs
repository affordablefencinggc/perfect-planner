// End-to-end core loop on a real temp git repository with the real strict ledger
// (Core Specs §2-§6). Only the Jev provider (TypeSafe HTTP) and the keychain are
// fakes; git, worktrees, hooks, the watcher, the test gate and the relay are real.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openLedger, replay } from "../src/core/ledger/index.mjs";
import { approvePlan, lookup } from "../src/core/clauses/index.mjs";
import { createWorktreeManager } from "../src/core/worktrees/index.mjs";
import { createGitWatcher } from "../src/core/watcher/gitWatcher.mjs";
import { createTestGate, displayCommand } from "../src/core/testgate/index.mjs";
import { createRelay, RELAY_ERROR_CODES } from "../src/core/relay/index.mjs";
import { createJev, createKeychainJevProvider, createMemoryKeychain, setJevKey, hasJevKey } from "../src/core/jev/index.mjs";

const owner = { kind: "person", id: "owner" };
const system = { kind: "system", id: "perfect-planner" };
// Built at runtime so no credential-shaped literal sits in the source.
const PLANTED_KEY = "AKIA" + "0".repeat(16);
const FAKE_JEV_KEY = ["ts", "loop", "test", "0123456789abcdef"].join("_");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
const gitTry = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });

const PLAN = `# Save

Plans save to the local store.

# Load

Plans load on start and report a missing plan.

# Export

Plans export as markdown.
`;

const REGISTRY = `export const features = {
  save: false,
  // -
  // -
  // -
  // -
  load: false,
  // -
  // -
  // -
  // -
  exportPlan: false,
};
`;

function checkScript(file, fn, expected) {
  return `import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const file = path.resolve(${JSON.stringify(file)});
if (!fs.existsSync(file)) { console.error(${JSON.stringify(file + " is missing")}); process.exit(1); }
const mod = await import(pathToFileURL(file).href);
const got = mod.${fn}("plan");
if (got !== ${JSON.stringify(expected)}) { console.error("unexpected " + got); process.exit(1); }
console.log("ok");
`;
}

async function makeRepo() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pp-core-loop-")));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "loop@example.invalid");
  git(root, "config", "user.name", "PP Loop");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.autocrlf", "false");
  await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\n.perfect-planner/\n");
  await fs.mkdir(path.join(root, "src"));
  await fs.mkdir(path.join(root, "checks"));
  await fs.writeFile(path.join(root, "src", "registry.js"), REGISTRY);
  await fs.writeFile(path.join(root, "checks", "t1.mjs"), checkScript("src/save.js", "save", "saved:plan"));
  await fs.writeFile(path.join(root, "checks", "t2.mjs"), checkScript("src/load.js", "load", "loaded:plan"));
  await fs.writeFile(path.join(root, "checks", "t3.mjs"), checkScript("src/export.js", "exportPlan", "# plan"));
  await fs.writeFile(path.join(root, "checks", "t4.mjs"), checkScript("src/never.js", "never", "never"));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "Initial app with acceptance checks");
  return root;
}

/** Fake TypeSafe System One endpoint: answers every question; rejects the first diff review of chosen tasks. */
function fakeTypeSafe({ rejectDiffOnce = [] } = {}) {
  const rejectOnce = new Set(rejectDiffOnce);
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const task = body.state.task.id;
    const phase = "diff" in body.state ? "diff" : "test";
    const reject = phase === "diff" && rejectOnce.delete(task);
    calls.push({ url, authorization: init.headers.Authorization, task, phase, reject });
    const answers = {};
    for (const [id, question] of Object.entries(body.questions)) {
      if (question.type === "noul") answers[id] = { type: "noul", noul: id === "trivial" || id === "weakens" ? 0.05 : reject ? 0.1 : 0.95 };
      else answers[id] = { type: "choice", choice: reject ? "reject" : "approve", confidence: 0.9 };
    }
    return { status: 200, ok: true, json: async () => ({ model: "jev-1.13.0", answers, usage: { input_tokens: 1200, output_tokens: 3 } }) };
  };
  return { fetchImpl, calls };
}

async function commitAll(cwd, message) {
  git(cwd, "add", "-A");
  return gitTry(cwd, "commit", "-q", "-m", message);
}

test("the whole core loop runs on a real repo with the real ledger", { timeout: 600_000 }, async (t) => {
  const repo = await makeRepo();
  const ledger = await openLedger(repo);
  t.after(async () => {
    try { ledger.close(); } catch { /* already closed */ }
    await fs.rm(repo, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  });

  // ---- 1. Owner approves plan P-1; its clauses are numbered by the clauses module.
  const approved = await approvePlan(ledger, { plan: "P-1", markdown: PLAN, actor: owner, title: "Save, load and export plans" });
  assert.equal(approved.entries.at(-1).type, "plan.approved");
  let board = ledger.board();
  assert.equal(board.plans["P-1"].state, "approved");
  assert.equal(board.plans["P-1"].clauses["§1"].text, "Save");
  assert.equal(board.plans["P-1"].clauses["§2.1"].text, "Plans load on start and report a missing plan.");

  // ---- 2. Three tasks, each citing a clause.
  const specs = {
    "T-1": { title: "Save plans", clause: "P-1 §1", check: "checks/t1.mjs" },
    "T-2": { title: "Load plans", clause: "P-1 §2", check: "checks/t2.mjs" },
    "T-3": { title: "Export plans", clause: "P-1 §3", check: "checks/t3.mjs" },
  };
  for (const [id, spec] of Object.entries(specs)) {
    assert.equal(ledger.nextId("T"), id);
    await ledger.append({ actor: owner, type: "task.created", subject: id, summary: spec.title, refs: [spec.clause], data: { title: spec.title } });
  }

  // ---- 3. Tests defined and shown to fail on current code; Jev reviews them; owner approves.
  const keychain = createMemoryKeychain();
  await setJevKey(FAKE_JEV_KEY, { keychain });
  assert.equal(await hasJevKey({ keychain }), true);
  const typesafe = fakeTypeSafe({ rejectDiffOnce: ["T-2"] });
  const provider = createKeychainJevProvider({ keychain, fetchImpl: typesafe.fetchImpl });
  const jev = createJev({ ledger, provider, budget: { monthlyCap: 10 } });
  const gate = createTestGate({ ledger, repoRoot: repo });
  const clausesOf = (id) => {
    const current = ledger.board();
    return current.tasks[id].refs
      .filter((ref) => /^P-\d+ §/.test(ref))
      .map((ref) => ({ ref, text: lookup(ref, { entries: ledger.entries(), plans: current.plans }).text }));
  };

  for (const [id, spec] of Object.entries(specs)) {
    const argv = [process.execPath, spec.check];
    await gate.defineTest(id, argv, owner, { refs: [spec.clause] });
    const first = await gate.confirmFailsFirst(id, repo);
    assert.equal(first.passed, false, `${id} must fail on current code`);
    assert.equal(first.failedFirst, true);
    const review = await jev.reviewTest({
      task: { id, title: spec.title },
      clauses: clausesOf(id),
      testSource: await fs.readFile(path.join(repo, spec.check), "utf8"),
      preRun: { command: displayCommand(argv), exitCode: first.result.exitCode },
      buildModel: "builder-model",
    });
    assert.equal(review.verdict, "approve", `${id} test review`);
    await gate.approveTest(id, owner, { jevVerdict: { entry: review.ledger } });
  }
  board = ledger.board();
  for (const id of Object.keys(specs)) {
    assert.equal(board.tasks[id].test.approved, true);
    assert.equal(board.tasks[id].test.lastResult, "failed");
  }

  // ---- 4. One worktree per task.
  const worktrees = createWorktreeManager({ repoRoot: repo, ledger });
  const launched = {};
  for (const id of Object.keys(specs)) launched[id] = await worktrees.launch(id);
  board = ledger.board();
  for (const id of Object.keys(specs)) {
    assert.equal(board.tasks[id].worktree.branch, `pp/${id}`);
    assert.equal(board.tasks[id].worktree.path, `.perfect-planner/worktrees/${id}`);
  }
  git(repo, "branch", "integration", "main");
  const integrationPath = path.join(repo, ".perfect-planner", "integration");
  git(repo, "worktree", "add", "-q", integrationPath, "integration");

  // ---- 5. Workers check in through the relay and claim with their tokens.
  const relay = createRelay({
    ledger,
    mainAgent: "main-chat",
    resolver: (ref, { entries, plans }) => lookup(ref, { entries, plans }),
  });
  const main = relay.hello({ agent: "main-chat", model: "planner-model" });
  assert.equal(main.role, "main");
  const workerA = relay.hello({ agent: "worker-a", model: "builder-a", role: "worker" });
  const workerB = relay.hello({ agent: "worker-b", model: "builder-b", role: "worker" });
  const workerC = relay.hello({ agent: "worker-c", model: "builder-c", role: "worker" });
  assert.notEqual(workerA.token, workerB.token);
  await relay.claimTask(workerA.token, "T-1");
  await relay.claimTask(workerB.token, "T-2");
  await assert.rejects(relay.claimTask(workerA.token, "T-2"), { code: RELAY_ERROR_CODES.FORBIDDEN });
  await assert.rejects(relay.reportProgress(workerC.token, "T-1", "not mine"), { code: RELAY_ERROR_CODES.FORBIDDEN });
  await relay.claimTask(workerC.token, "T-3");
  assert.equal(ledger.board().tasks["T-1"].claimedModel, "builder-a");

  // ---- 6. Worker B asks the main chat a blocking question; main answers; it is routed back.
  const asked = await relay.askMain(workerB.token, "T-2", "Should load() throw or return null for a missing plan?", ["throw", "return null"], true);
  assert.equal(asked.state, "open");
  await assert.rejects(relay.reportProgress(workerB.token, "T-2", "keeps going"), { code: RELAY_ERROR_CODES.PAUSED });
  const inbox = relay.checkInbox(main.token);
  assert.equal(inbox.blockingCount, 1);
  assert.equal(inbox.open[0].question, asked.question);
  const answered = await relay.answer(main.token, asked.question, "return null", "Callers already handle null and it keeps start-up quiet");
  assert.equal(answered.routedTo, "worker-b");
  const routed = relay.checkAnswer(workerB.token, asked.question);
  assert.deepEqual([routed.state, routed.answer, routed.decision], ["answered", "return null", answered.decision]);
  assert.equal(ledger.board().questions[asked.question].decision, answered.decision);

  // ---- 7. Workers commit in their worktrees; T-1 and T-2 both touch src/registry.js.
  const wt = (id) => launched[id].path;
  await fs.writeFile(path.join(wt("T-1"), "src", "save.js"), 'export function save(plan) { return "saved:" + plan; }\n');
  await fs.writeFile(path.join(wt("T-1"), "src", "registry.js"), REGISTRY.replace("save: false", "save: true"));
  assert.equal((await commitAll(wt("T-1"), "Save plans\n\nImplements: P-1 §1 (T-1)")).status, 0);
  await relay.reportProgress(workerA.token, "T-1", "save() written and registered");

  await fs.writeFile(path.join(wt("T-2"), "src", "load.js"), 'export function load(plan) { return "loaded:" + plan; }\n');
  await fs.writeFile(path.join(wt("T-2"), "src", "registry.js"), REGISTRY.replace("load: false", "load: true"));
  assert.equal((await commitAll(wt("T-2"), "Load plans\n\nImplements: P-1 §2 (T-2)")).status, 0);
  await relay.reportProgress(workerB.token, "T-2", "load() written and registered");

  // ---- 8. A planted fake key is blocked at commit by the worktree's hook.
  await fs.writeFile(path.join(wt("T-3"), "src", "config.js"), `export const awsKey = "${PLANTED_KEY}";\n`);
  const blocked = await commitAll(wt("T-3"), "Add config");
  assert.notEqual(blocked.status, 0, "the secret scan must block the commit");
  assert.match(blocked.stderr, /aws-access-key/);
  assert.ok(!blocked.stderr.includes(PLANTED_KEY), "the scan never echoes the secret");
  git(wt("T-3"), "rm", "-q", "--cached", "src/config.js");
  await fs.rm(path.join(wt("T-3"), "src", "config.js"));
  await fs.writeFile(path.join(wt("T-3"), "src", "export.js"), 'export function exportPlan(plan) { return "# " + plan; }\n');
  assert.equal((await commitAll(wt("T-3"), "Export plans\n\nImplements: P-1 §3 (T-3)")).status, 0);

  // ---- 9. The watcher observes the commits and the shared file without any declared file list.
  const watcher = createGitWatcher({ repoRoot: repo, ledger, integrationBranch: "main" });
  const tick = await watcher.tick();
  assert.deepEqual(tick.errors, []);
  board = ledger.board();
  assert.equal(board.collisions.length, 1);
  assert.deepEqual(board.collisions[0].tasks, ["T-1", "T-2"]);
  assert.deepEqual(board.collisions[0].files, ["src/registry.js"]);
  assert.deepEqual(board.tasks["T-1"].commits.map((commit) => commit.files), [["src/registry.js", "src/save.js"]]);
  assert.equal(board.tasks["T-3"].commits.length, 1, "the blocked commit never happened");
  assert.ok(!JSON.stringify(ledger.entries()).includes(PLANTED_KEY));
  assert.deepEqual((await watcher.tick()).written, [], "a second tick writes nothing new");
  // The owner sequences the two tasks: T-1 merges first, T-2 rebases onto it if needed.
  await ledger.append({ actor: owner, type: "collision.resolved", subject: board.collisions[0].subject, summary: "Merge T-1 before T-2; the edits are on separate lines", data: { collision: board.collisions[0].id } });

  // ---- 10. Workers report done; Perfect Planner runs the approved test in each worktree.
  for (const [id, token] of [["T-1", workerA.token], ["T-2", workerB.token], ["T-3", workerC.token]]) {
    await relay.attachProof(token, id, "commit", git(wt(id), "rev-parse", "HEAD"));
    const run = await gate.runInWorktree(id, wt(id));
    assert.equal(run.passed, true, `${id} passes in its worktree`);
  }

  // ---- 11. Jev reviews each diff; T-2 is rejected and reopened as attempt .a2.
  const reviewDiff = async (id) => {
    const current = ledger.board();
    const files = [...new Set(current.tasks[id].commits.flatMap((commit) => commit.files))];
    return jev.reviewDiff({
      task: { id, title: specs[id].title },
      clauses: clausesOf(id),
      diff: git(repo, "diff", "--no-color", "main...pp/" + id),
      files,
      taskTests: [specs[id].check],
      testOutput: "exit 0",
      buildModel: current.tasks[id].claimedModel,
    });
  };
  const verdicts = {};
  for (const id of Object.keys(specs)) verdicts[id] = await reviewDiff(id);
  assert.equal(verdicts["T-1"].verdict, "approve");
  assert.equal(verdicts["T-3"].verdict, "approve");
  assert.equal(verdicts["T-2"].verdict, "reject");
  const reopened = await ledger.append({ actor: system, type: "task.reopened", subject: "T-2", summary: "Jev rejected the T-2 diff", reason: `Jev diff review ${verdicts["T-2"].ledger} rejected the change`, evidence: [verdicts["T-2"].ledger] });
  board = ledger.board();
  assert.equal(board.tasks["T-2"].attemptId, "T-2.a2");
  assert.equal(board.tasks["T-2"].state, "reopened");
  assert.equal(reopened.type, "task.reopened");
  await assert.rejects(gate.afterMerge("T-2", integrationPath), { code: "TEST_WORKTREE_NOT_PASSED" });

  // ---- 12. Approved tasks merge into the integration branch, the test reruns there, task.done, worktree removed.
  const finish = async (id) => {
    const merged = await worktrees.merge(id, { into: "integration", integrationPath });
    assert.equal(merged.entry.type, "merge.done");
    const after = await gate.afterMerge(id, integrationPath);
    assert.equal(after.passed, true, `${id} passes on the integration branch`);
    assert.equal(after.done?.type, "task.done");
    const removed = await worktrees.remove(id, { into: "integration" });
    assert.equal(removed.entry.type, "worktree.removed");
  };
  await finish("T-1");
  await finish("T-3");

  // ---- 13. Attempt .a2 of T-2: reclaimed, reworked, re-tested, approved and finished.
  const reclaimed = await relay.claimTask(workerB.token, "T-2");
  assert.equal(reclaimed.attempt, 2);
  assert.equal(ledger.entries().at(-1).subject, "T-2.a2");
  await fs.writeFile(path.join(wt("T-2"), "src", "load.js"), 'export function load(plan) { if (!plan) return null; return "loaded:" + plan; }\n');
  assert.equal((await commitAll(wt("T-2"), "Return null for a missing plan\n\nImplements: P-1 §2.1 (T-2)")).status, 0);
  assert.deepEqual((await watcher.tick()).errors, []);
  await relay.attachProof(workerB.token, "T-2", "commit", git(wt("T-2"), "rev-parse", "HEAD"));
  assert.equal((await gate.runInWorktree("T-2", wt("T-2"))).passed, true);
  assert.equal((await reviewDiff("T-2")).verdict, "approve");
  await finish("T-2");

  board = ledger.board();
  for (const id of Object.keys(specs)) {
    assert.equal(board.tasks[id].state, "done", `${id} done`);
    assert.equal(board.tasks[id].worktree, null);
    assert.equal(board.tasks[id].test.lastRunWhere, "integration");
  }
  assert.equal(board.tasks["T-2"].attempt, 2);
  assert.equal(git(integrationPath, "show", "HEAD:src/registry.js"), REGISTRY.replace("save: false", "save: true").replace("load: false", "load: true").trim());
  assert.equal(typesafe.calls.length, 7, "3 test reviews and 4 diff reviews");
  assert.ok(typesafe.calls.every((call) => call.authorization === `Bearer ${FAKE_JEV_KEY}`));
  assert.ok(!JSON.stringify(ledger.entries()).includes(FAKE_JEV_KEY), "the Jev key never reaches the ledger");

  // ---- 14. task.done is refused for a task whose test never passed.
  await ledger.append({ actor: owner, type: "task.created", subject: "T-4", summary: "Never finished", refs: ["P-1 §3"] });
  await gate.defineTest("T-4", [process.execPath, "checks/t4.mjs"], owner, { refs: ["P-1 §3"] });
  assert.equal((await gate.confirmFailsFirst("T-4", repo)).failedFirst, true);
  await gate.approveTest("T-4", owner, { override: { reason: "Owner checked this test by hand" } });
  await relay.claimTask(workerA.token, "T-4"); // worker A's token moves on once T-1 is done
  await assert.rejects(
    ledger.append({ actor: system, type: "task.done", subject: "T-4", summary: "Trying to finish without a pass" }),
    (error) => error.code === "LEDGER_RULE" && error.rule === "task-done-gate" && /no passing run/.test(error.message),
  );
  await assert.rejects(gate.afterMerge("T-4", integrationPath), { code: "TEST_WORKTREE_NOT_PASSED" });
  assert.equal(ledger.board().tasks["T-4"].state, "claimed");

  // ---- 15. lookup("P-1 §1") returns the clause with its tasks and commits.
  const found = relay.lookup(main.token, "P-1 §1");
  assert.equal(found.text, "Save");
  assert.deepEqual(found.tasks, ["T-1"]);
  const t1Commits = ledger.board().tasks["T-1"].commits.map((commit) => commit.sha);
  assert.equal(t1Commits.length, 1);
  assert.match(t1Commits[0], /^[0-9a-f]{40}$/);
  assert.deepEqual(found.commits.map((commit) => commit.sha), t1Commits);
  assert.deepEqual(found.history.map((entry) => entry.type), ["clause.added"]);
  const loadClause = relay.lookup(main.token, "P-1 §2.1");
  assert.equal(loadClause.text, "Plans load on start and report a missing plan.");
  assert.deepEqual(loadClause.tasks, ["T-2"]);

  // ---- 16. Replay rebuilds the identical board, also from disk; verify() is clean.
  await watcher.stop();
  const live = ledger.board();
  assert.deepEqual(replay(ledger.entries()), live);
  const verified = ledger.verify();
  assert.equal(verified.ok, true);
  assert.deepEqual(verified.breaks, []);
  const entryCount = ledger.entries().length;
  ledger.close();
  const reopenedLedger = await openLedger(repo);
  try {
    assert.equal(reopenedLedger.entries().length, entryCount);
    assert.deepEqual(reopenedLedger.board(), live);
    assert.equal(reopenedLedger.verify().ok, true);
  } finally {
    reopenedLedger.close();
  }
  gitTry(repo, "worktree", "remove", "--force", integrationPath);
});
