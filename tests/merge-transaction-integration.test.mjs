// Real Git below: run hermetically regardless of the caller's Git config or GIT_* env.
import "./helpers/hermetic-git.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { rehearseMergedState } from "../src/node/mergedStateRunner.mjs";
import { appendMergeTransactionTransition, inspectMergeTransaction, listPendingMergeTransactions, inspectMergeRecoveryPage } from "../src/node/mergeTransactionStore.mjs";

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", shell: false, timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  return { exit: result.status, stdout: result.stdout, stderr: result.stderr, signal: null };
}
async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), "pp-merge-journal-caller-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = path.join(base, "repo");
  await mkdir(repo);
  git(repo, ["init", "-b", "main"]); git(repo, ["config", "user.name", "Fixture"]); git(repo, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(path.join(repo, "base.txt"), "base");
  await writeFile(path.join(repo, "verify.mjs"), "process.exit(0);\n");
  git(repo, ["add", "."]); git(repo, ["commit", "-m", "base"]);
  git(repo, ["switch", "-c", "feature"]); await writeFile(path.join(repo, "feature.txt"), "feature"); git(repo, ["add", "."]); git(repo, ["commit", "-m", "feature"]); git(repo, ["switch", "main"]);
  return { repositoryRoot: repo, allowedBase: base, worktreeParent: path.join(base, "worktrees"), transactionStoreRoot: path.join(base, "transactions"), targetRef: "main", sourceRef: "feature", actor: "Developer One",
    allowedExecutables: [process.execPath], ciPlan: { state: "derived", gates: [{ job: "check", supported: true, commands: [{ executable: process.execPath, args: ["verify.mjs"] }] }] } };
}

test("actual rehearsal records pre-mutation intent and binds retained local-only proof", async (t) => {
  const options = await fixture(t);
  let sawIntent = false;
  const gitRunner = async (cwd, args) => {
    if (args[0] === "worktree" && args[1] === "add") {
      const pending = await listPendingMergeTransactions({ storeRoot: options.transactionStoreRoot });
      assert.equal(pending.length, 1);
      assert.equal(pending[0].state, "INTENT_RECORDED");
      assert.equal(pending[0].intent.worktreePath, args[3]);
      assert.equal(pending[0].intent.baseSha, args[4]);
      sawIntent = true;
    }
    return git(cwd, args);
  };
  const result = await rehearseMergedState({ ...options, gitRunner });
  assert.equal(sawIntent, true);
  assert.equal(result.state, "green", JSON.stringify(result));
  const transaction = await inspectMergeTransaction({ storeRoot: options.transactionStoreRoot, transactionId: result.transaction.transactionId });
  assert.equal(transaction.state, "RETAINED");
  assert.equal(transaction.pending, true);
  assert.equal(transaction.intent.sourceSha, result.sourceSha);
  assert.equal(transaction.intent.baseSha, result.targetSha);
  assert.ok(transaction.entries.some((entry) => entry.state === "CHECKS_FINISHED"));
  assert.equal(transaction.entries.some((entry) => ["CLEANUP_STARTED", "REMOVAL_STARTED", "COMPLETED"].includes(entry.state)), false);
  const receipt = JSON.parse(await readFile(result.cleanup.receiptPath, "utf8"));
  assert.equal(receipt.transactionId, transaction.transactionId);
  assert.equal(result.cleanup.transactionId, transaction.transactionId);
  assert.equal(result.cleanup.state, "retained-for-review");
  assert.equal(result.proofScope, "local-rehearsal"); assert.equal(result.promotionAuthority, false);
  assert.match(result.candidateSnapshotDigest, /^[a-f0-9]{64}$/);
  assert.equal(result.candidateSnapshotDigest, result.testedCandidateSnapshotDigest);
  assert.match(result.ciCommandContractDigest, /^[a-f0-9]{64}$/);
  assert.equal(receipt.candidateSnapshotDigest, result.candidateSnapshotDigest);
  assert.equal(receipt.ciCommandContractDigest, result.ciCommandContractDigest);
  const recovery = await inspectMergeRecoveryPage({ storeRoot: options.transactionStoreRoot, repositoryRoot: options.repositoryRoot });
  assert.equal(recovery.pageComplete, true); assert.equal(recovery.inventoryExhausted, true);
  assert.equal(recovery.transactions[0].transactionId, result.transaction.transactionId);
  assert.equal(recovery.transactions[0].state, "RETAINED");
  assert.equal(recovery.transactions[0].promotionAuthority, false);
  assert.equal(recovery.transactions[0].evidenceVerified, false);
});

test("journal failure after worktree creation prevents merge and every cleanup mutation", async (t) => {
  const options = await fixture(t);
  const commands = [];
  const result = await rehearseMergedState({ ...options,
    gitRunner: async (cwd, args) => { commands.push(args); return git(cwd, args); },
    transactionStore: { appendTransition: async (input) => { if (input.state === "WORKTREE_CREATED") throw new Error("simulated-journal-disk-failure"); return appendMergeTransactionTransition(input); } },
  });
  assert.equal(result.state, "grey");
  assert.equal(result.cleanup.state, "manual-recovery-required");
  assert.equal(result.transaction.journalHealthy, false);
  assert.equal(result.candidateSnapshotDigest, null); assert.equal(result.testedCandidateSnapshotDigest, null); assert.equal(result.ciCommandContractDigest, null);
  assert.equal(commands.some((args) => args[0] === "merge" || (args[0] === "worktree" && args[1] === "remove")), false);
  assert.equal((await lstat(result.cleanup.worktreePath)).isDirectory(), true);
  const pending = await listPendingMergeTransactions({ storeRoot: options.transactionStoreRoot });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].state, "INTENT_RECORDED");
  const recovery = await inspectMergeRecoveryPage({ storeRoot: options.transactionStoreRoot, repositoryRoot: options.repositoryRoot });
  assert.equal(recovery.transactions[0].state, "INTENT_RECORDED");
  assert.equal(recovery.canAutomaticallyDelete, false);
});

test("failed initial intent forbids the first Git mutation", async (t) => {
  const options = await fixture(t);
  const commands = [];
  await assert.rejects(rehearseMergedState({ ...options,
    gitRunner: async (cwd, args) => { commands.push(args); return git(cwd, args); },
    transactionStore: { createIntent: async () => { throw new Error("simulated-intent-write-failure"); } },
  }), /simulated-intent-write-failure/);
  assert.equal(commands.some((args) => args[0] === "worktree" || args[0] === "merge"), false);
});

test("final retention journal failure retains the candidate without aborting or removing it", async (t) => {
  const options = await fixture(t);
  const commands = [];
  const result = await rehearseMergedState({ ...options,
    gitRunner: async (cwd, args) => { commands.push(args); return git(cwd, args); },
    transactionStore: { appendTransition: async (input) => { if (input.state === "RETAINED") throw new Error("simulated-journal-disk-failure"); return appendMergeTransactionTransition(input); } },
  });
  assert.equal(result.state, "grey");
  assert.equal(result.cleanup.state, "manual-recovery-required");
  assert.equal(commands.some((args) => args.includes("--abort") || (args[0] === "worktree" && args[1] === "remove")), false);
  const receipt = JSON.parse(await readFile(result.cleanup.receiptPath, "utf8"));
  assert.equal(receipt.state, "manual-recovery-required"); assert.equal(receipt.journalHealthy, false);
  assert.ok(receipt.supersededReceipt.path); assert.notEqual(receipt.supersededReceipt.path, result.cleanup.receiptPath);
  assert.equal(JSON.parse(await readFile(receipt.supersededReceipt.path, "utf8")).state, "retained-for-review");
  assert.equal(await readFile(path.join(result.cleanup.worktreePath, "feature.txt"), "utf8"), "feature");
  assert.equal((await listPendingMergeTransactions({ storeRoot: options.transactionStoreRoot })).length, 1);
});

test("process interruption after worktree add leaves discoverable pre-mutation intent and surviving worktree", async (t) => {
  const options = await fixture(t);
  const entry = path.join(options.allowedBase, "interrupt.mjs");
  const moduleUrl = new URL("../src/node/mergedStateRunner.mjs", import.meta.url).href;
  await writeFile(entry, `import { spawnSync } from 'node:child_process';
import { rehearseMergedState } from ${JSON.stringify(moduleUrl)};
const options = ${JSON.stringify(options)};
await rehearseMergedState({ ...options, gitRunner: async (cwd,args) => {
 const r=spawnSync('git',args,{cwd,encoding:'utf8',shell:false});
 if(args[0]==='worktree' && args[1]==='add' && r.status===0) process.exit(91);
 return {exit:r.status,stdout:r.stdout,stderr:r.stderr,signal:null};
}});
`);
  const result = spawnSync(process.execPath, [entry], { encoding: "utf8", shell: false, timeout: 20_000 });
  assert.equal(result.status, 91, result.stderr);
  const pending = await listPendingMergeTransactions({ storeRoot: options.transactionStoreRoot });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].state, "INTENT_RECORDED");
  assert.equal(pending[0].recoveryAction, "inspect-and-reconcile");
  assert.equal((await lstat(pending[0].intent.worktreePath)).isDirectory(), true);
});

test("tracked writes after the tested snapshot survive and invalidate green without destructive commands", async (t) => {
  const options = await fixture(t);
  const commands = [];
  const result = await rehearseMergedState({ ...options,
    gitRunner: async (cwd, args) => { commands.push(args); return git(cwd, args); },
    transactionStore: { appendTransition: async (input) => {
      const snapshot = await appendMergeTransactionTransition(input);
      if (input.state === "CHECKS_FINISHED") await writeFile(path.join(snapshot.intent.worktreePath, "base.txt"), "valuable late tracked edit");
      return snapshot;
    } },
  });
  assert.equal(result.state, "grey");
  assert.equal(result.transaction.journalHealthy, true);
  assert.equal(commands.some((args) => args.includes("--abort")), false);
  assert.equal(commands.some((args) => args[0] === "worktree" && args[1] === "remove"), false);
  assert.equal((await lstat(result.cleanup.worktreePath)).isDirectory(), true);
  assert.equal(await readFile(path.join(result.cleanup.worktreePath, "base.txt"), "utf8"), "valuable late tracked edit");
  assert.notEqual(result.cleanup.preservation.candidateDigest, result.candidateSnapshotDigest);
  assert.equal((await listPendingMergeTransactions({ storeRoot: options.transactionStoreRoot }))[0].state, "RETAINED");
});

test("throwing final Git inspection yields a structured pending recovery receipt without mutation", async (t) => {
  const options = await fixture(t); const commands = []; let candidateHeadReads = 0;
  const result = await rehearseMergedState({ ...options, gitRunner: async (cwd, args) => {
    commands.push(args);
    if (cwd !== options.repositoryRoot && args[0] === "rev-parse" && args[2] === "HEAD^{commit}" && ++candidateHeadReads === 3) throw new Error("unexpected inspection failure");
    return git(cwd, args);
  } });
  assert.equal(result.state, "grey"); assert.equal(result.cleanup.state, "manual-recovery-required");
  assert.match(result.cleanup.preservation.reason, /inspection failed unexpectedly/);
  assert.equal(commands.some((args) => args.includes("--abort") || (args[0] === "worktree" && args[1] === "remove")), false);
  assert.equal((await lstat(result.cleanup.worktreePath)).isDirectory(), true);
  const receipt = JSON.parse(await readFile(result.cleanup.receiptPath, "utf8"));
  assert.equal(receipt.state, "manual-recovery-required");
  assert.equal(result.transaction.state, "RETAINED"); assert.equal(result.transaction.pending, true);
});

test("empty or malformed CI contracts never start checks or produce green proof", async (t) => {
  const options = await fixture(t);
  const command = { executable: process.execPath, args: ["verify.mjs"] };
  const gate = { job: "check", supported: true, commands: [command] };
  const invalidGates = [[], new Array(1), [gate, gate], [{ ...gate, commands: new Array(1) }], [{ ...gate, commands: [] }], [{ ...gate, supported: "true" }], [{ ...gate, job: " " }], [{ ...gate, commands: [{ ...command, args: "verify.mjs" }] }], [{ ...gate, commands: [{ ...command, args: new Array(1) }] }], [{ ...gate, commands: [{ ...command, executable: "" }] }], Array.from({ length: 65 }, () => gate), [{ ...gate, commands: Array.from({ length: 65 }, () => command) }]];
  for (const gates of invalidGates) {
    const result = await rehearseMergedState({ ...options, ciPlan: { state: "derived", gates }, gitRunner: async (cwd, args) => git(cwd, args) });
    assert.equal(result.state, "grey"); assert.match(result.reason, /CI gate contract/);
    assert.equal(result.evidence.length, 0); assert.equal(result.ciCommandContractDigest, null);
    const transaction = await inspectMergeTransaction({ storeRoot: result.transaction.storeRoot, transactionId: result.transaction.transactionId });
    assert.equal(transaction.entries.some((entry) => entry.state === "CHECKS_STARTED" || entry.state === "CHECKS_FINISHED"), false);
    assert.equal(transaction.pending, true);
  }
});
