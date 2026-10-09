import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, link, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createTaskLedgerAuthorityStore } from '../src/node/taskLedgerAuthorityStore.mjs';
import { emptyTaskDraftLedger, updateTaskDraft } from '../src/project/taskDraftLedger.js';

const binding = { projectId: 'pp_authority_fixture', rootIdentity: 'a'.repeat(64), censusDigest: 'b'.repeat(64) };
const draft = () => updateTaskDraft(emptyTaskDraftLedger(binding), {
  title: 'Proposed task', description: ' Draft description ', owner: '', acceptance: '', recovery: '', claims: [], dependsOn: [], archived: false,
}, '2026-09-09T00:00:00.000Z');
const request = requestId => ({ requestId, expectedRevision: 0, expectedHeadDigest: 'GENESIS' });
async function fixture(t, limits = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-task-ledger-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { journalPath: path.join(root, 'proposals.jsonl'), projectId: binding.projectId, rootIdentity: binding.rootIdentity, ...limits };
  return { root, config, store: createTaskLedgerAuthorityStore(config) };
}

test('normalized proposals reopen with distinct host revisions and never confer approval', async t => {
  const f = await fixture(t), input = structuredClone(draft());
  input.tasks[0].description = '  Normalized text  ';
  const first = await f.store.propose(input, request('request-1'));
  assert.equal(first.proposal.ledger.tasks[0].description, 'Normalized text');
  const next = structuredClone(first.proposal.ledger); next.tasks[0].title = 'Another proposal';
  const second = await f.store.propose(next, { requestId: 'request-2', expectedRevision: 1, expectedHeadDigest: first.proposal.recordHash });
  assert.equal(second.proposal.hostRevision, 2); assert.equal(second.proposal.ledger.revision, 1);
  const state = await createTaskLedgerAuthorityStore(f.config).inspect();
  assert.equal(state.hostRevision, 2); assert.equal(state.headDigest, second.proposal.recordHash);
  assert.equal(state.approvalState, 'unapproved-proposal'); assert.equal(state.executionAuthorized, false);
  assert.ok(state.proposals.every(record => record.executionAuthorized === false));
  assert.ok(Object.isFrozen(state.proposals[0].ledger.tasks[0]));
});

test('snapshots input before awaits and retries exact requests without duplicating history', async t => {
  const f = await fixture(t), input = structuredClone(draft()), req = request('retry');
  const pending = f.store.propose(input, req);
  input.tasks[0].title = 'Late mutation'; req.requestId = 'changed';
  const first = await pending;
  assert.equal(first.proposal.requestId, 'retry'); assert.equal(first.proposal.ledger.tasks[0].title, 'Proposed task');
  const second = await f.store.propose(draft(), request('retry'));
  assert.equal(second.idempotent, true); assert.equal(second.proposal.recordHash, first.proposal.recordHash);
  const altered = structuredClone(draft()); altered.tasks[0].title = 'Changed request payload';
  await assert.rejects(f.store.propose(altered, request('retry')), /REQUEST_CONFLICT/);
  assert.equal((await f.store.inspect()).hostRevision, 1);
});

test('concurrent CAS has one winner, concurrent retries have one durable proposal', async t => {
  const f = await fixture(t);
  const outcomes = await Promise.allSettled(['one', 'two', 'three'].map(id => f.store.propose(draft(), request(id))));
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  for (const outcome of outcomes.filter(item => item.status === 'rejected')) assert.match(outcome.reason.message, /STALE_HEAD/);
  const state = await f.store.inspect();
  const req = { requestId: 'same-successor', expectedRevision: state.hostRevision, expectedHeadDigest: state.headDigest };
  const retries = await Promise.all([f.store.propose(draft(), req), f.store.propose(draft(), req)]);
  assert.deepEqual(retries.map(item => item.idempotent).sort(), [false, true]);
  assert.equal((await f.store.inspect()).hostRevision, 2);
  const original = state.proposals[0];
  assert.equal((await f.store.propose(draft(), request(original.requestId))).idempotent, true);
});

test('partial, malformed, duplicate and changed records remain untouched and block successors', async t => {
  const f = await fixture(t);
  await f.store.propose(draft(), request('initial'));
  const valid = await readFile(f.config.journalPath, 'utf8');
  const changed = JSON.parse(valid); changed.ledger.tasks[0].title = 'Tampered';
  for (const bytes of ['', valid.slice(0, -1), `${valid}{partial`, `${valid}${valid}`, `${JSON.stringify(changed)}\n`, '\n', '{bad}\n']) {
    await writeFile(f.config.journalPath, bytes);
    await assert.rejects(f.store.inspect());
    await assert.rejects(f.store.propose(draft(), request('next')));
    assert.equal(await readFile(f.config.journalPath, 'utf8'), bytes);
  }
});

test('byte and record quotas refuse writes while preserving previous bytes', async t => {
  const f = await fixture(t, { maxRecords: 1 });
  const first = await f.store.propose(draft(), request('first'));
  const before = await readFile(f.config.journalPath);
  await assert.rejects(f.store.propose(draft(), { requestId: 'second', expectedRevision: 1, expectedHeadDigest: first.proposal.recordHash }), /QUOTA/);
  assert.deepEqual(await readFile(f.config.journalPath), before);
  const small = createTaskLedgerAuthorityStore({ ...f.config, maxBytes: 1 });
  await assert.rejects(small.inspect(), /QUOTA/);
  await appendFile(f.config.journalPath, ' '.repeat(8 * 1024 * 1024));
  await assert.rejects(f.store.inspect(), /QUOTA/);
});

test('foreign roots, path aliases and hardlinked storage are refused', async t => {
  const f = await fixture(t);
  const foreign = structuredClone(draft()); foreign.binding.rootIdentity = 'f'.repeat(64);
  await assert.rejects(f.store.propose(foreign, request('foreign')), /BINDING_MISMATCH/);
  for (const journalPath of ['relative.jsonl', `${f.root}${path.sep}..${path.sep}${path.basename(f.root)}${path.sep}proposals.jsonl`, path.join(f.root, 'file:stream')]) {
    assert.throws(() => createTaskLedgerAuthorityStore({ ...f.config, journalPath }), /CONFIG_INVALID/);
  }
  await f.store.propose(draft(), request('valid'));
  await link(f.config.journalPath, path.join(f.root, 'alias.jsonl'));
  await assert.rejects(f.store.inspect(), /UNSAFE_FILE/);
  await assert.rejects(f.store.propose(draft(), request('next')), /UNSAFE_FILE/);
});

test('redirected ancestor directories and lock aliases are refused', async t => {
  const f = await fixture(t);
  const alias = `${f.root}-alias`;
  try { await symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Directory links unavailable'); return; } throw error; }
  t.after(() => rm(alias, { recursive: true, force: true }));
  const redirected = createTaskLedgerAuthorityStore({ ...f.config, journalPath: path.join(alias, 'proposals.jsonl') });
  await assert.rejects(redirected.inspect(), /UNSAFE_PATH/);
  await symlink(f.root, `${f.config.journalPath}.pp-lock`, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.store.inspect(), /UNSAFE_LOCK/);
});

test('failed flush remains uncertain and an idempotent retry flushes before success', async t => {
  const f = await fixture(t), actualOpen = fs.open;
  let failSync = true, syncCalls = 0;
  const mocked = t.mock.method(fs, 'open', async (...args) => {
    const handle = await actualOpen(...args);
    if (args[0] === f.config.journalPath) {
      const actualSync = handle.sync.bind(handle);
      handle.sync = async () => { syncCalls++; if (failSync) throw new Error('Controlled sync failure'); return actualSync(); };
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.store.propose(draft(), request('flush')), /Controlled sync failure/);
    assert.equal((await f.store.inspect()).hostRevision, 1);
    await assert.rejects(f.store.propose(draft(), request('flush')), /Controlled sync failure/);
    failSync = false;
    const result = await f.store.propose(draft(), request('flush'));
    assert.equal(result.idempotent, true); assert.equal(syncCalls, 3);
    assert.equal((await f.store.inspect()).hostRevision, 1);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});
