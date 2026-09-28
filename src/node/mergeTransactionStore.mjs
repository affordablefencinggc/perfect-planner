import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, opendir, realpath, link, unlink } from "node:fs/promises";
import path from "node:path";
import { withPlanLock } from "./planLock.mjs";

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,95}$/;
const HASH = /^[a-f0-9]{64}$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const REF = /^(?!-)(?!.*\.\.)(?!.*@\{)[A-Za-z0-9._/-]{1,200}$/;
const TERMINAL = new Set(["COMPLETED", "RECONCILED"]);
const STATES = Object.freeze({
  INTENT_RECORDED: ["WORKTREE_CREATED", "RETAINED"],
  WORKTREE_CREATED: ["MERGE_STARTED", "CHECKS_STARTED", "RETAINED"],
  MERGE_STARTED: ["MERGE_OBSERVED", "RETAINED"],
  MERGE_OBSERVED: ["CHECKS_STARTED", "RETAINED"],
  CHECKS_STARTED: ["CHECKS_FINISHED", "RETAINED"],
  CHECKS_FINISHED: ["CLEANUP_STARTED", "RETAINED"],
  CLEANUP_STARTED: ["REMOVAL_STARTED", "RETAINED"],
  REMOVAL_STARTED: ["COMPLETED", "RETAINED"],
  RETAINED: ["RECONCILED"],
  COMPLETED: [], RECONCILED: [],
});
const INTENT_KEYS = ["allowedWorktreeRoot", "baseSha", "operation", "owner", "repositoryIdentity", "repositoryRoot", "sourceRef", "sourceSha", "targetRef", "transactionId", "worktreePath"];
const ENTRY_KEYS = ["evidenceDigest", "hash", "intent", "owner", "previousHash", "revision", "schemaVersion", "state", "timestamp", "transactionId"];
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(canonical(value))).digest("hex");
const within = (root, target) => { const relative = path.relative(root, target); return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)); };
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
const exact = (value, keys) => { if (!value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) fail("transaction-schema-invalid"); };
const deepFreeze = (value) => { if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };

async function safePath(input, { missingLeaf = false } = {}) {
  if (typeof input !== "string" || !path.isAbsolute(input) || /(?:^|[\\/])\.{1,2}(?:[\\/]|$)/.test(input)) fail("transaction-path-alias-refused");
  const target = path.resolve(input);
  let current = path.parse(target).root;
  const parts = target.slice(current.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let info;
    try { info = await lstat(current); }
    catch (error) { if (error.code === "ENOENT" && missingLeaf && i === parts.length - 1) return target; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) fail("transaction-directory-redirected");
  }
  if (path.relative(target, await realpath(target)) !== "") fail("transaction-path-alias-refused");
  return target;
}

async function syncDirectory(directory) {
  // Windows does not provide a portable directory fsync; each record is still fsynced before publication.
  if (process.platform === "win32") return;
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function readRecord(filename, budget) {
  budget?.check();
  await safePath(path.dirname(filename));
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 128_000) fail("transaction-record-refused");
  budget?.consume(info.size);
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (before.ino !== info.ino || before.dev !== info.dev || before.size !== info.size || before.nlink !== 1) fail("transaction-record-changed");
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      budget?.check();
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    await safePath(path.dirname(filename));
    const current = await lstat(filename);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || current.isSymbolicLink() || !current.isFile() || current.ino !== before.ino || current.dev !== before.dev
      || current.size !== before.size || current.mtimeMs !== before.mtimeMs || current.nlink !== 1) fail("transaction-record-changed");
    return JSON.parse(bytes.subarray(0, length).toString("utf8"));
  } finally { await handle.close(); }
}

async function validateIntent(intent, storeRoot, { inspect = false } = {}) {
  exact(intent, INTENT_KEYS);
  if (!ID.test(intent.transactionId) || !ID.test(intent.owner) || !["merge-rehearsal", "worktree-allocation"].includes(intent.operation)) fail("transaction-identity-invalid");
  if (!SHA.test(intent.baseSha) || !SHA.test(intent.sourceSha) || !REF.test(intent.targetRef) || !REF.test(intent.sourceRef)) fail("transaction-git-binding-invalid");
  const repositoryRoot = await safePath(intent.repositoryRoot);
  if (!HASH.test(intent.repositoryIdentity) || intent.repositoryIdentity !== digest(repositoryRoot)) fail("transaction-repository-identity-mismatch");
  const allowedRoot = await safePath(intent.allowedWorktreeRoot);
  const worktreePath = await safePath(intent.worktreePath, { missingLeaf: true });
  if (!within(allowedRoot, worktreePath) || worktreePath === allowedRoot || within(repositoryRoot, worktreePath)
    || within(repositoryRoot, storeRoot) || within(worktreePath, storeRoot) || within(storeRoot, worktreePath)) fail("transaction-external-boundary-invalid");
  if (!inspect) {
    try { await lstat(worktreePath); fail("transaction-worktree-already-exists"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function validateEntry(entry, previous, id) {
  exact(entry, ENTRY_KEYS);
  if (entry.schemaVersion !== 1 || entry.transactionId !== id || entry.intent.transactionId !== id || !Object.hasOwn(STATES, entry.state)) fail("transaction-entry-invalid");
  if (entry.revision !== (previous?.revision ?? 0) + 1 || entry.previousHash !== (previous?.hash ?? "GENESIS")) fail("transaction-chain-broken");
  if (entry.owner !== entry.intent.owner || !ID.test(entry.owner)) fail("transaction-owner-mismatch");
  if (typeof entry.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp)) || new Date(entry.timestamp).toISOString() !== entry.timestamp
    || (previous && entry.timestamp < previous.timestamp)) fail("transaction-time-invalid");
  if (entry.evidenceDigest !== null && !HASH.test(entry.evidenceDigest)) fail("transaction-evidence-invalid");
  if (TERMINAL.has(entry.state) && !entry.evidenceDigest) fail("transaction-terminal-evidence-required");
  if (previous ? !STATES[previous.state].includes(entry.state) || digest(previous.intent) !== digest(entry.intent) : entry.state !== "INTENT_RECORDED") fail("transaction-transition-refused");
  const { hash, ...body } = entry;
  if (!HASH.test(hash) || digest(body) !== hash) fail("transaction-hash-mismatch");
}

async function inspectAt(storeRoot, transactionId, budget) {
  const directory = path.join(storeRoot, transactionId);
  const entries = [];
  let issue = null;
  try {
    await safePath(directory);
    const names = (await boundedDirectoryNames(directory, 128, budget)).sort();
    if (!names.length || names.length > 128 || names.some((name) => !/^\d{6}\.json$/.test(name))) issue = "transaction-partial-or-unknown-record";
    for (const name of names.filter((name) => /^\d{6}\.json$/.test(name)).slice(0, 128)) {
      if (name !== `${String(entries.length + 1).padStart(6, "0")}.json`) fail("transaction-record-sequence-invalid");
      const entry = await readRecord(path.join(directory, name), budget);
      validateEntry(entry, entries.at(-1), transactionId);
      entries.push(entry);
      await validateIntent(entry.intent, storeRoot, { inspect: true });
    }
  } catch (error) {
    if (error.code?.startsWith("transaction-inspection-")) throw error;
    issue = /^transaction-[a-z-]+$/.test(error.code ?? "") ? error.code : "transaction-record-unreadable";
  }
  const last = entries.at(-1);
  const pending = Boolean(issue) || !last || !TERMINAL.has(last.state);
  return deepFreeze({ schemaVersion: 1, transactionId, directory, revision: last?.revision ?? 0, head: last?.hash ?? "GENESIS", state: issue ? "RECONCILE_REQUIRED" : last.state,
    intent: entries[0]?.intent ?? null, entries, integrity: issue ? "invalid" : "verified", issue, pending, reconcileRequired: pending,
    recoveryAction: pending ? "inspect-and-reconcile" : "none", canAutomaticallyDelete: false });
}

async function publishRecord(directory, entry) {
  await safePath(directory);
  const temporary = path.join(directory, `.pending-${randomUUID()}.json`);
  const target = path.join(directory, `${String(entry.revision).padStart(6, "0")}.json`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { await handle.writeFile(JSON.stringify(entry) + "\n", "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  // Hard-link publication is atomic and refuses an existing revision. A crash leaves evidence, never an overwritten record.
  await link(temporary, target);
  await syncDirectory(directory);
  await unlink(temporary);
  await syncDirectory(directory);
}

function entryFor(intent, previous, state, owner, evidenceDigest, timestamp) {
  const body = { schemaVersion: 1, transactionId: intent.transactionId, revision: (previous?.revision ?? 0) + 1, previousHash: previous?.hash ?? "GENESIS", intent, state, owner, evidenceDigest: evidenceDigest ?? null, timestamp: timestamp ?? new Date().toISOString() };
  const entry = { ...body, hash: digest(body) };
  validateEntry(entry, previous, intent.transactionId);
  return entry;
}

export async function createMergeTransactionIntent(input) {
  const storeRoot = await safePath(input.storeRoot);
  const intent = Object.fromEntries(INTENT_KEYS.map((key) => [key, key === "operation" ? input[key] ?? "merge-rehearsal" : input[key]]));
  await validateIntent(intent, storeRoot);
  const directory = path.join(storeRoot, intent.transactionId);
  return withPlanLock(directory, { actor: intent.owner, timeoutMs: 5_000 }, async () => {
    await safePath(storeRoot);
    await mkdir(directory); // Exclusive: duplicate IDs are never reset or resumed implicitly.
    await syncDirectory(storeRoot);
    const entry = entryFor(intent, null, "INTENT_RECORDED", intent.owner, null, input.timestamp);
    await publishRecord(directory, entry);
    const snapshot = await inspectAt(storeRoot, intent.transactionId);
    if (snapshot.integrity !== "verified" || snapshot.head !== entry.hash) fail("transaction-published-record-unverified");
    return snapshot;
  });
}

export async function appendMergeTransactionTransition(input) {
  const storeRoot = await safePath(input.storeRoot);
  if (!ID.test(input.transactionId) || !ID.test(input.owner)) fail("transaction-identity-invalid");
  return withPlanLock(path.join(storeRoot, input.transactionId), { actor: input.owner, timeoutMs: 5_000 }, async () => {
    const snapshot = await inspectAt(storeRoot, input.transactionId);
    if (snapshot.integrity !== "verified") fail("transaction-reconciliation-required");
    if (snapshot.revision !== input.expectedRevision || snapshot.head !== input.expectedHead) fail("transaction-compare-and-swap-conflict");
    if (snapshot.revision >= 128) fail("transaction-record-limit");
    const entry = entryFor(snapshot.intent, snapshot.entries.at(-1), input.state, input.owner, input.evidenceDigest, input.timestamp);
    await publishRecord(snapshot.directory, entry);
    const next = await inspectAt(storeRoot, input.transactionId);
    if (next.integrity !== "verified" || next.head !== entry.hash) fail("transaction-published-record-unverified");
    return next;
  });
}

export async function inspectMergeTransaction({ storeRoot, transactionId }) {
  storeRoot = await safePath(storeRoot);
  if (!ID.test(transactionId)) fail("transaction-identity-invalid");
  return inspectAt(storeRoot, transactionId);
}

export async function listPendingMergeTransactions({ storeRoot }) {
  const budget = recoveryInspectionBudget();
  storeRoot = await safePath(storeRoot);
  const names = await boundedDirectoryNames(storeRoot, 2000, budget);
  const ids = new Set();
  for (const name of names) {
    const id = name.endsWith(".pp-lock") ? name.slice(0, -8) : name;
    if (!ID.test(id)) fail("transaction-store-entry-invalid");
    ids.add(id);
  }
  const snapshots = [];
  for (const id of [...ids].sort()) {
    const snapshot = await inspectAt(storeRoot, id, budget);
    if (snapshot.pending) snapshots.push(snapshot);
  }
  budget.check();
  return Object.freeze(snapshots);
}

function recoveryInspectionBudget({ signal, maxBytes = 4 * 1024 * 1024, maxRecords = 256 } = {}) {
  const started = performance.now();
  return {
    bytes: 0, records: 0,
    check() {
      if (signal?.aborted) fail("transaction-inspection-cancelled");
      if (performance.now() - started >= 2000) fail("transaction-inspection-timeout");
    },
    consume(size) {
      this.check();
      if (this.records >= maxRecords || this.bytes + size > maxBytes) fail("transaction-inspection-budget-exhausted");
      this.records += 1; this.bytes += size;
    },
  };
}

async function boundedDirectoryNames(directory, maximum, budget) {
  const names = [];
  const handle = await opendir(directory);
  for await (const entry of handle) {
    budget?.check();
    if (names.length >= maximum) fail("transaction-directory-entry-limit");
    names.push(entry.name);
  }
  return names;
}

// Authority-owned adapter entry point, not an arbitrary-path browser/MCP tool.
// Each page is a fresh observation, not an atomic whole-store or live Git census.
export async function inspectMergeRecoveryPage({ storeRoot, repositoryRoot, cursor = null, limit = 25, signal, maxBytes = 4 * 1024 * 1024, maxRecords = 256 }) {
  cursor = cursor === null ? null : structuredClone(cursor);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 * 1024
    || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 256) fail("transaction-inspection-options-invalid");
  const budget = recoveryInspectionBudget({ signal, maxBytes, maxRecords });
  budget.check();
  storeRoot = await safePath(storeRoot); repositoryRoot = await safePath(repositoryRoot);
  if (within(repositoryRoot, storeRoot)) fail("transaction-external-boundary-invalid");
  const repositoryIdentity = digest(repositoryRoot);
  const names = await boundedDirectoryNames(storeRoot, 2000, budget);
  const ids = [...new Set(names.map(name => name.endsWith(".pp-lock") ? name.slice(0, -8) : name))].sort();
  if (ids.some(id => !ID.test(id))) fail("transaction-store-entry-invalid");
  const listingDigest = digest({ storeRoot, repositoryIdentity, ids });
  let offset = 0;
  if (cursor !== null) {
    exact(cursor, ["listingDigest", "offset"]);
    if (cursor.listingDigest !== listingDigest || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > ids.length) fail("transaction-inspection-cursor-stale");
    offset = cursor.offset;
  }
  const transactions = []; let unattributedCount = 0; let inspected = 0; let stopReason = null;
  for (; offset < ids.length && inspected < limit; offset += 1, inspected += 1) {
    let snapshot;
    try { budget.check(); snapshot = await inspectAt(storeRoot, ids[offset], budget); }
    catch (error) {
      if (error.code === "transaction-inspection-cancelled") throw error;
      if (!error.code?.startsWith("transaction-inspection-")) throw error;
      stopReason = error.code; break;
    }
    // Invalid intent is never a trustworthy project attribution or path to display.
    if (snapshot.integrity !== "verified") { unattributedCount += 1; continue; }
    if (snapshot.intent.repositoryIdentity !== repositoryIdentity || snapshot.intent.repositoryRoot !== repositoryRoot || !snapshot.pending) continue;
    transactions.push({ transactionId: snapshot.transactionId, revision: snapshot.revision, head: snapshot.head, state: snapshot.state,
      owner: snapshot.intent.owner, operation: snapshot.intent.operation, pending: true, recoveryAction: "inspect-and-reconcile",
      evidenceVerified: false, canAutomaticallyDelete: false, promotionAuthority: false });
  }
  // Entry additions/removals invalidate the page rather than silently shifting its cursor.
  const finalNames = await boundedDirectoryNames(storeRoot, 2000, budget);
  const finalIds = [...new Set(finalNames.map(name => name.endsWith(".pp-lock") ? name.slice(0, -8) : name))].sort();
  if (digest({ storeRoot, repositoryIdentity, ids: finalIds }) !== listingDigest) fail("transaction-inspection-list-changed");
  await safePath(storeRoot); await safePath(repositoryRoot);
  budget.check();
  return deepFreeze({ schemaVersion: 1, scope: "local-recovery-inspection", repositoryIdentity, observedAt: new Date().toISOString(),
    transactions, unattributedCount, inspected, budgetedBytes: budget.bytes, budgetedRecords: budget.records, stopReason,
    pageComplete: !stopReason && unattributedCount === 0, inventoryExhausted: offset === ids.length,
    nextCursor: offset < ids.length ? { offset, listingDigest } : null,
    canAutomaticallyDelete: false, promotionAuthority: false });
}

export const mergeTransactionStates = Object.freeze(Object.keys(STATES));

// Internal authority-side catalog. Never expose these path-taking entry points
// directly as browser/MCP tools. Registration authorizes discovery only, not
// execution, reconciliation, deletion or promotion. The native adapter must
// supply its own catalog root and revalidate the selected workspace binding.
const CATALOG_KEYS = ['schemaVersion', 'revision', 'previousHash', 'repositoryRoot', 'repositoryIdentity', 'storeRoot', 'storeId', 'actor', 'timestamp', 'hash'];
export function validateRecoveryCatalogPublicationBudget(entry, existingBytes) {
  const bytes = Buffer.byteLength(JSON.stringify(entry) + '\n', 'utf8');
  if (!Number.isSafeInteger(existingBytes) || existingBytes < 0 || bytes > 128000
    || existingBytes + bytes > 4 * 1024 * 1024) fail('recovery-catalog-publication-budget');
  return bytes;
}
async function catalogContext(catalogRoot, repositoryRoot) {
  catalogRoot = await safePath(catalogRoot); repositoryRoot = await safePath(repositoryRoot);
  if (within(repositoryRoot, catalogRoot) || within(catalogRoot, repositoryRoot)) fail('recovery-catalog-boundary-invalid');
  const repositoryIdentity = digest(repositoryRoot);
  return { catalogRoot, repositoryRoot, repositoryIdentity, directory: path.join(catalogRoot, repositoryIdentity) };
}
async function readRecoveryCatalog(context) {
  const { directory, catalogRoot, repositoryRoot, repositoryIdentity } = context;
  const budget = recoveryInspectionBudget();
  try { await safePath(directory); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await safePath(catalogRoot); await safePath(repositoryRoot);
    return deepFreeze({ schemaVersion: 1, status: 'unconfigured', repositoryIdentity, revision: 0, head: 'GENESIS', lastRegisteredAt: null, budgetedBytes: 0, stores: [], coverage: 'unknown' });
  }
  const names = (await boundedDirectoryNames(directory, 64, budget)).sort();
  if (!names.length || names.some((name, index) => name !== `${String(index + 1).padStart(6, '0')}.json`)) fail('recovery-catalog-incomplete');
  let previous = null; const stores = [], seen = new Set();
  for (const name of names) {
    const entry = await readRecord(path.join(directory, name), budget);
    exact(entry, CATALOG_KEYS);
    const { hash, ...body } = entry;
    if (entry.schemaVersion !== 1 || entry.revision !== (previous?.revision ?? 0) + 1
      || entry.previousHash !== (previous?.hash ?? 'GENESIS') || entry.repositoryRoot !== repositoryRoot
      || entry.repositoryIdentity !== repositoryIdentity || typeof entry.actor !== 'string' || !ID.test(entry.actor)
      || !HASH.test(hash) || digest(body) !== hash) fail('recovery-catalog-invalid');
    if (typeof entry.timestamp !== 'string' || !Number.isFinite(Date.parse(entry.timestamp))
      || new Date(entry.timestamp).toISOString() !== entry.timestamp || (previous && entry.timestamp < previous.timestamp)) fail('recovery-catalog-time-invalid');
    const storeRoot = await safePath(entry.storeRoot);
    if (within(repositoryRoot, storeRoot) || within(storeRoot, repositoryRoot)
      || within(catalogRoot, storeRoot) || within(storeRoot, catalogRoot)) fail('recovery-catalog-boundary-invalid');
    const storeId = digest({ repositoryIdentity, storeRoot });
    if (entry.storeId !== storeId || seen.has(storeId)) fail('recovery-catalog-store-invalid');
    seen.add(storeId); stores.push({ storeId, storeRoot }); previous = entry;
  }
  if ((await boundedDirectoryNames(directory, 64, budget)).sort().join('|') !== names.join('|')) fail('recovery-catalog-changed');
  await safePath(catalogRoot); await safePath(repositoryRoot); await safePath(directory); budget.check();
  // A valid catalog lists registered stores, not all possible historical stores.
  return deepFreeze({ schemaVersion: 1, status: 'registered', repositoryIdentity, revision: previous.revision, head: previous.hash, lastRegisteredAt: previous.timestamp, budgetedBytes: budget.bytes, stores, coverage: 'registered-stores-only' });
}
export async function inspectMergeRecoveryCatalog({ catalogRoot, repositoryRoot }) {
  return readRecoveryCatalog(await catalogContext(catalogRoot, repositoryRoot));
}
export async function registerMergeRecoveryStore({ catalogRoot, repositoryRoot, storeRoot, actor, expectedHead }) {
  if (typeof actor !== 'string' || !ID.test(actor) || typeof expectedHead !== 'string'
    || (expectedHead !== 'GENESIS' && !HASH.test(expectedHead))) fail('recovery-catalog-request-invalid');
  const context = await catalogContext(catalogRoot, repositoryRoot);
  storeRoot = await safePath(storeRoot);
  if (within(context.repositoryRoot, storeRoot) || within(storeRoot, context.repositoryRoot)
    || within(context.catalogRoot, storeRoot) || within(storeRoot, context.catalogRoot)) fail('recovery-catalog-boundary-invalid');
  return withPlanLock(context.directory, { actor, timeoutMs: 5000 }, async () => {
    const current = await readRecoveryCatalog(context);
    if (current.head !== expectedHead) fail('recovery-catalog-compare-and-swap-conflict');
    const storeId = digest({ repositoryIdentity: context.repositoryIdentity, storeRoot });
    if (current.stores.some(store => store.storeId === storeId)) fail('recovery-catalog-store-already-registered');
    if (current.revision >= 64) fail('recovery-catalog-store-limit');
    const timestamp = new Date().toISOString();
    if (current.lastRegisteredAt && timestamp < current.lastRegisteredAt) fail('recovery-catalog-clock-moved-backward');
    const body = { schemaVersion: 1, revision: current.revision + 1, previousHash: current.head,
      repositoryRoot: context.repositoryRoot, repositoryIdentity: context.repositoryIdentity,
      storeRoot, storeId, actor, timestamp };
    const entry = { ...body, hash: digest(body) };
    validateRecoveryCatalogPublicationBudget(entry, current.budgetedBytes);
    if (current.status === 'unconfigured') { await mkdir(context.directory); await syncDirectory(context.catalogRoot); }
    await safePath(storeRoot);
    await publishRecord(context.directory, entry);
    const result = await readRecoveryCatalog(context);
    if (result.head !== digest(body)) fail('recovery-catalog-published-record-unverified');
    return result;
  });
}
