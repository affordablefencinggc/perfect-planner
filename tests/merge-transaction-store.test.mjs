import "./helpers/hermetic-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createMergeTransactionIntent, appendMergeTransactionTransition, inspectMergeTransaction, listPendingMergeTransactions, inspectMergeRecoveryPage, inspectMergeRecoveryCatalog, registerMergeRecoveryStore, validateRecoveryCatalogPublicationBudget } from "../src/node/mergeTransactionStore.mjs";

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), "pp-merge-transaction-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repositoryRoot = path.join(base, "repository");
  const storeRoot = path.join(base, "transactions");
  const allowedWorktreeRoot = path.join(base, "worktrees");
  await Promise.all([repositoryRoot, storeRoot, allowedWorktreeRoot].map((directory) => mkdir(directory)));
  const intent = { storeRoot, transactionId: "merge-001", repositoryRoot, repositoryIdentity: createHash("sha256").update(repositoryRoot).digest("hex"), baseSha: "a".repeat(40), sourceSha: "b".repeat(40), targetRef: "main", sourceRef: "feature", allowedWorktreeRoot, worktreePath: path.join(allowedWorktreeRoot, "merge-001"), owner: "worker-one" };
  return { base, intent };
}
const transition = (intent, snapshot, state, extras = {}) => appendMergeTransactionTransition({ storeRoot: intent.storeRoot, transactionId: intent.transactionId, expectedRevision: snapshot.revision, expectedHead: snapshot.head, owner: intent.owner, state, ...extras });

async function catalogFixture(t) {
  const f = await fixture(t); const catalogRoot = path.join(f.base, 'recovery-catalog'); await mkdir(catalogRoot);
  return { ...f, binding: { catalogRoot, repositoryRoot: f.intent.repositoryRoot, storeRoot: f.intent.storeRoot, actor: 'local-authority', expectedHead: 'GENESIS' } };
}
test('catalog publication budget counts UTF-8 bytes and refuses unreadable successors before publication', () => {
  assert.throws(() => validateRecoveryCatalogPublicationBudget({ path: '界'.repeat(43000) }, 0), /publication-budget/);
  const entry = { path: 'small' }; const bytes = Buffer.byteLength(JSON.stringify(entry) + '\n');
  assert.equal(validateRecoveryCatalogPublicationBudget(entry, 4 * 1024 * 1024 - bytes), bytes);
  assert.throws(() => validateRecoveryCatalogPublicationBudget(entry, 4 * 1024 * 1024 - bytes + 1), /publication-budget/);
});
test('missing recovery catalog is unknown, read-only, and never an empty pending-work claim', async t => {
  const { binding } = await catalogFixture(t);
  const result = await inspectMergeRecoveryCatalog(binding);
  assert.equal(result.status, 'unconfigured'); assert.equal(result.coverage, 'unknown');
  assert.deepEqual(await readdir(binding.catalogRoot), []);
});
test('catalog preserves explicit custom store bindings across reload without granting execution', async t => {
  const { binding, base } = await catalogFixture(t);
  const first = await registerMergeRecoveryStore(binding);
  const custom = path.join(base, 'custom-transactions'); await mkdir(custom);
  const second = await registerMergeRecoveryStore({ ...binding, storeRoot: custom, expectedHead: first.head });
  assert.equal(second.revision, 2); assert.equal(second.coverage, 'registered-stores-only');
  assert.deepEqual(second.stores.map(s => s.storeRoot), [binding.storeRoot, custom]);
  assert.deepEqual(await inspectMergeRecoveryCatalog(binding), second);
  assert.equal(Object.hasOwn(second, 'promotionAuthority'), false);
  await assert.rejects(registerMergeRecoveryStore({ ...binding, expectedHead: second.head }), /already-registered/);
});
test('concurrent catalog registration refuses stale heads without replacing earlier bindings', async t => {
  const { binding, base } = await catalogFixture(t);
  const other = path.join(base, 'other-transactions'); await mkdir(other);
  const results = await Promise.allSettled([registerMergeRecoveryStore(binding), registerMergeRecoveryStore({ ...binding, storeRoot: other })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /compare-and-swap/);
  assert.equal((await inspectMergeRecoveryCatalog(binding)).stores.length, 1);
});
test('partial catalog records block discovery and later registration without erasing evidence', async t => {
  const { binding } = await catalogFixture(t); const first = await registerMergeRecoveryStore(binding);
  const partial = path.join(binding.catalogRoot, first.repositoryIdentity, '.pending-interrupted.json');
  await writeFile(partial, '{');
  await assert.rejects(inspectMergeRecoveryCatalog(binding), /catalog-incomplete/);
  await assert.rejects(registerMergeRecoveryStore({ ...binding, expectedHead: first.head }), /catalog-incomplete/);
  assert.equal(await readFile(partial, 'utf8'), '{');
});
test('catalog refuses store locations overlapping source or catalog directories', async t => {
  const { binding } = await catalogFixture(t);
  for (const storeRoot of [binding.repositoryRoot, binding.catalogRoot]) await assert.rejects(registerMergeRecoveryStore({ ...binding, storeRoot }), /boundary-invalid/);
  assert.deepEqual(await readdir(binding.catalogRoot), []);
});
test('catalog-selected custom journal exposes retained work without changing journal bytes', async t => {
  const { binding, intent } = await catalogFixture(t);
  const created = await createMergeTransactionIntent(intent);
  await transition(intent, created, 'RETAINED');
  const catalog = await registerMergeRecoveryStore(binding);
  const directory = path.join(intent.storeRoot, intent.transactionId);
  const names = await readdir(directory); const before = await Promise.all(names.map(n => readFile(path.join(directory, n), 'utf8')));
  const page = await inspectMergeRecoveryPage({ repositoryRoot: binding.repositoryRoot, storeRoot: catalog.stores[0].storeRoot });
  assert.equal(page.transactions[0].state, 'RETAINED'); assert.equal(page.transactions[0].promotionAuthority, false);
  assert.deepEqual(await Promise.all(names.map(n => readFile(path.join(directory, n), 'utf8'))), before);
});

test("pre-mutation intent is durable externally, hash-bound, reloadable and pending without touching the worktree", async (t) => {
  const { intent } = await fixture(t);
  const created = await createMergeTransactionIntent(intent);
  assert.equal(created.integrity, "verified");
  assert.equal(created.state, "INTENT_RECORDED");
  assert.equal(created.intent.baseSha, intent.baseSha);
  assert.equal(created.intent.worktreePath, intent.worktreePath);
  assert.equal(created.entries[0].previousHash, "GENESIS");
  assert.equal(created.reconcileRequired, true);
  assert.equal(created.canAutomaticallyDelete, false);
  assert.deepEqual(await readdir(intent.allowedWorktreeRoot), []);
  const reloaded = await inspectMergeTransaction(intent);
  assert.deepEqual(reloaded, created);
  assert.equal((await listPendingMergeTransactions(intent)).length, 1);
});

test("concurrent append uses revision and head compare-and-swap; replay cannot overwrite history", async (t) => {
  const { intent } = await fixture(t);
  const first = await createMergeTransactionIntent(intent);
  const firstBytes = await readFile(path.join(first.directory, "000001.json"), "utf8");
  const outcomes = await Promise.allSettled([transition(intent, first, "WORKTREE_CREATED"), transition(intent, first, "WORKTREE_CREATED")]);
  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  assert.match(outcomes.find((item) => item.status === "rejected").reason.message, /compare-and-swap/);
  await assert.rejects(transition(intent, first, "WORKTREE_CREATED"), /compare-and-swap/);
  await assert.rejects(createMergeTransactionIntent(intent));
  assert.equal(await readFile(path.join(first.directory, "000001.json"), "utf8"), firstBytes);
  const current = await inspectMergeTransaction(intent);
  assert.equal(current.revision, 2);
  assert.equal(current.entries[1].previousHash, first.head);
});

test("crash-like partial records require inspection and are preserved, never discarded or treated as terminal", async (t) => {
  const { intent } = await fixture(t);
  const first = await createMergeTransactionIntent(intent);
  const partial = path.join(first.directory, ".pending-interrupted.json");
  await writeFile(partial, '{"unfinished":');
  const inspected = await inspectMergeTransaction(intent);
  assert.equal(inspected.state, "RECONCILE_REQUIRED");
  assert.equal(inspected.pending, true);
  assert.equal(inspected.intent.worktreePath, intent.worktreePath);
  assert.equal(inspected.entries.length, 1);
  await assert.rejects(transition(intent, first, "WORKTREE_CREATED"), /reconciliation-required/);
  assert.equal(await readFile(partial, "utf8"), '{"unfinished":');
  assert.equal((await listPendingMergeTransactions(intent))[0].state, "RECONCILE_REQUIRED");
});

test("tampered and truncated immutable records block later transitions and survive inspection", async (t) => {
  const { intent } = await fixture(t);
  const first = await createMergeTransactionIntent(intent);
  const filename = path.join(first.directory, "000001.json");
  const value = JSON.parse(await readFile(filename, "utf8"));
  value.intent.sourceSha = "c".repeat(40);
  await writeFile(filename, JSON.stringify(value));
  assert.equal((await inspectMergeTransaction(intent)).integrity, "invalid");
  await assert.rejects(transition(intent, first, "WORKTREE_CREATED"), /reconciliation-required/);
  await writeFile(filename, "{");
  assert.equal((await inspectMergeTransaction(intent)).state, "RECONCILE_REQUIRED");
  assert.equal(await readFile(filename, "utf8"), "{");
});

test("unknown states, owner changes, backward timestamps and unsupported terminal jumps fail closed", async (t) => {
  const { intent } = await fixture(t);
  const first = await createMergeTransactionIntent({ ...intent, timestamp: "2026-01-01T00:00:00.000Z" });
  await assert.rejects(transition(intent, first, "TIMEOUT_MEANS_SUCCESS"), /entry-invalid/);
  await assert.rejects(transition(intent, first, "WORKTREE_CREATED", { owner: "worker-two" }), /owner-mismatch/);
  await assert.rejects(transition(intent, first, "WORKTREE_CREATED", { timestamp: "2025-01-01T00:00:00.000Z" }), /time-invalid/);
  await assert.rejects(transition(intent, first, "COMPLETED", { evidenceDigest: "d".repeat(64) }), /transition-refused/);
  assert.equal((await inspectMergeTransaction(intent)).revision, 1);
});

test("retained transactions remain pending until explicit evidence-bound reconciliation and all records remain", async (t) => {
  const { intent } = await fixture(t);
  const first = await createMergeTransactionIntent(intent);
  const retained = await transition(intent, first, "RETAINED");
  assert.equal(retained.pending, true);
  await assert.rejects(transition(intent, retained, "RECONCILED"), /terminal-evidence-required/);
  const reconciled = await transition(intent, retained, "RECONCILED", { evidenceDigest: "e".repeat(64) });
  assert.equal(reconciled.pending, false);
  assert.deepEqual(await listPendingMergeTransactions(intent), []);
  assert.deepEqual(await readdir(first.directory), ["000001.json", "000002.json", "000003.json"]);
  await assert.rejects(transition(intent, reconciled, "WORKTREE_CREATED"), /transition-refused/);
});

test("directory links, path aliases, internal stores and identity mismatches are refused", async (t) => {
  const { base, intent } = await fixture(t);
  const redirected = path.join(base, "redirected");
  await symlink(intent.storeRoot, redirected, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(createMergeTransactionIntent({ ...intent, storeRoot: redirected }), /redirected|alias/);
  await assert.rejects(createMergeTransactionIntent({ ...intent, repositoryIdentity: "f".repeat(64) }), /identity-mismatch/);
  const internal = path.join(intent.repositoryRoot, "transactions");
  await mkdir(internal);
  await assert.rejects(createMergeTransactionIntent({ ...intent, storeRoot: internal }), /external-boundary/);
  await assert.rejects(createMergeTransactionIntent({ ...intent, worktreePath: intent.allowedWorktreeRoot + path.sep + ".." + path.sep + "escape" }), /alias/);
});

test("a record replaced with a symlink is neither read nor adopted", async (t) => {
  const { base, intent } = await fixture(t);
  const first = await createMergeTransactionIntent(intent);
  const filename = path.join(first.directory, "000001.json");
  const external = path.join(base, "external.json");
  await writeFile(external, await readFile(filename));
  await rm(filename);
  try { await symlink(external, filename, "file"); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) { t.skip("File symlink creation is unavailable for this account."); return; } throw error; }
  assert.equal((await inspectMergeTransaction(intent)).integrity, "invalid");
  await assert.rejects(transition(intent, first, "WORKTREE_CREATED"), /reconciliation-required/);
});

test("a hardlinked record is rejected even without symlink privileges", async (t) => {
  const { base, intent } = await fixture(t);
  const first = await createMergeTransactionIntent(intent);
  await link(path.join(first.directory, "000001.json"), path.join(base, "aliased-record.json"));
  assert.equal((await inspectMergeTransaction(intent)).integrity, "invalid");
  await assert.rejects(transition(intent, first, "WORKTREE_CREATED"), /reconciliation-required/);
});

test("completed operation keeps every immutable revision and requires explicit cleanup intent", async (t) => {
  const { intent } = await fixture(t);
  let current = await createMergeTransactionIntent(intent);
  for (const state of ["WORKTREE_CREATED", "MERGE_STARTED", "MERGE_OBSERVED", "CHECKS_STARTED", "CHECKS_FINISHED", "CLEANUP_STARTED", "REMOVAL_STARTED", "COMPLETED"]) {
    current = await transition(intent, current, state, { evidenceDigest: "d".repeat(64) });
  }
  assert.equal(current.pending, false);
  assert.equal(current.entries.length, 9);
  assert.equal((await readdir(current.directory)).length, 9);
  assert.equal(current.canAutomaticallyDelete, false);
  assert.deepEqual(await readdir(intent.allowedWorktreeRoot), []);
});

test("recovery pages summarize only the selected repository without returning worktree paths or entire histories", async (t) => {
  const { base, intent } = await fixture(t);
  await createMergeTransactionIntent(intent);
  const foreignRoot = path.join(base, "foreign-repository"); await mkdir(foreignRoot);
  await createMergeTransactionIntent({ ...intent, transactionId: "merge-002", repositoryRoot: foreignRoot, repositoryIdentity: createHash("sha256").update(foreignRoot).digest("hex"), worktreePath: path.join(intent.allowedWorktreeRoot, "merge-002") });
  const page = await inspectMergeRecoveryPage({ storeRoot: intent.storeRoot, repositoryRoot: intent.repositoryRoot });
  assert.equal(page.transactions.length, 1);
  assert.equal(page.transactions[0].transactionId, "merge-001");
  assert.equal(page.transactions[0].evidenceVerified, false);
  assert.equal(page.pageComplete, true); assert.equal(page.inventoryExhausted, true);
  assert.equal(page.promotionAuthority, false); assert.equal(page.canAutomaticallyDelete, false);
  const serialized = JSON.stringify(page);
  for (const privateValue of [intent.worktreePath, foreignRoot, "merge-002", "entries", "sourceSha"]) assert.equal(serialized.includes(privateValue), false);
});

test("bounded recovery pages resume without skips and refuse a cursor after store entries change", async (t) => {
  const { intent } = await fixture(t); await createMergeTransactionIntent(intent);
  await createMergeTransactionIntent({ ...intent, transactionId: "merge-002", worktreePath: path.join(intent.allowedWorktreeRoot, "merge-002") });
  const request = { storeRoot: intent.storeRoot, repositoryRoot: intent.repositoryRoot, limit: 1 };
  const first = await inspectMergeRecoveryPage(request);
  assert.equal(first.inventoryExhausted, false); assert.equal(first.nextCursor.offset, 1);
  const next = await inspectMergeRecoveryPage({ ...request, cursor: first.nextCursor });
  assert.equal(next.transactions[0].transactionId, "merge-002"); assert.equal(next.nextCursor, null);
  await createMergeTransactionIntent({ ...intent, transactionId: "merge-003", worktreePath: path.join(intent.allowedWorktreeRoot, "merge-003") });
  await assert.rejects(inspectMergeRecoveryPage({ ...request, cursor: first.nextCursor }), /cursor-stale/);
});

test("recovery inspection budget exhaustion preserves the uninspected cursor and cannot mean no pending work", async (t) => {
  const { intent } = await fixture(t); const first = await createMergeTransactionIntent(intent);
  await transition(intent, first, "RETAINED");
  const request = { storeRoot: intent.storeRoot, repositoryRoot: intent.repositoryRoot };
  for (const limits of [{ maxRecords: 1 }, { maxBytes: 1 }]) {
    const page = await inspectMergeRecoveryPage({ ...request, ...limits });
    assert.equal(page.stopReason, "transaction-inspection-budget-exhausted");
    assert.equal(page.pageComplete, false); assert.equal(page.inventoryExhausted, false);
    assert.equal(page.nextCursor.offset, 0); assert.deepEqual(page.transactions, []);
  }
  assert.equal((await inspectMergeRecoveryPage(request)).transactions[0].state, "RETAINED");
  assert.equal((await readdir(first.directory)).length, 2);
});

test("corrupt recovery records remain visible as unattributed uncertainty and cannot borrow a valid project identity", async (t) => {
  const { intent } = await fixture(t); const first = await createMergeTransactionIntent(intent);
  const filename = path.join(first.directory, "000001.json"); await writeFile(filename, '{"private":"unfinished"');
  const page = await inspectMergeRecoveryPage({ storeRoot: intent.storeRoot, repositoryRoot: intent.repositoryRoot });
  assert.equal(page.unattributedCount, 1); assert.equal(page.pageComplete, false);
  assert.equal(page.inventoryExhausted, true); assert.deepEqual(page.transactions, []);
  assert.equal(JSON.stringify(page).includes("unfinished"), false);
  assert.equal(await readFile(filename, "utf8"), '{"private":"unfinished"');
});

test("recovery inspection refuses cancellation, invalid bounds and cross-repository cursor reuse", async (t) => {
  const { base, intent } = await fixture(t); await createMergeTransactionIntent(intent);
  const request = { storeRoot: intent.storeRoot, repositoryRoot: intent.repositoryRoot };
  await assert.rejects(inspectMergeRecoveryPage({ ...request, signal: AbortSignal.abort() }), /cancelled/);
  for (const invalid of [{ limit: 0 }, { limit: 51 }, { maxBytes: 4 * 1024 * 1024 + 1 }, { maxRecords: 257 }]) {
    await assert.rejects(inspectMergeRecoveryPage({ ...request, ...invalid }), /options-invalid/);
  }
  await createMergeTransactionIntent({ ...intent, transactionId: "merge-002", worktreePath: path.join(intent.allowedWorktreeRoot, "merge-002") });
  const page = await inspectMergeRecoveryPage({ ...request, limit: 1 });
  const otherRoot = path.join(base, "another-repository"); await mkdir(otherRoot);
  await assert.rejects(inspectMergeRecoveryPage({ ...request, repositoryRoot: otherRoot, cursor: page.nextCursor }), /cursor-stale/);
});
