import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { link, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { createTaskEnrollmentStore } from '../src/node/taskEnrollmentStore.mjs';

const snapshot = () => ({ hostRevision: 3, proposalDigest: 'a'.repeat(64), checkContractDigest: 'b'.repeat(64), policyVersion: 2, policyDigest: 'c'.repeat(64),
  assignments: [{ taskId: 'T0001', workerId: 'worker-1', sessionId: 'session-1', actor: 'Assigned actor' }] });
const request = (requestId = 'first', expectedRevision = 0) => ({ requestId, expectedRevision });
async function fixture(t, limits = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-task-enrollment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { journalPath: path.join(root, 'enrollment.jsonl'), projectId: 'pp_enrollment_fixture', rootIdentity: 'd'.repeat(64), ...limits };
  return { root, config, store: createTaskEnrollmentStore(config) };
}
const expected = enrollment => ({ revision: enrollment.revision, epoch: enrollment.epoch, headDigest: enrollment.recordHash });

test('reopens immutable host enrollment with separate proposal revision and issued epoch', async t => {
  const f = await fixture(t), input = snapshot(), req = request();
  const pending = f.store.publish(input, req);
  input.assignments[0].actor = 'Late mutation'; req.requestId = 'late';
  const result = await pending;
  assert.equal(result.enrollment.snapshot.hostRevision, 3);
  assert.equal(result.enrollment.revision, 1); assert.equal(result.enrollment.epoch, 1);
  assert.equal(result.enrollment.snapshot.assignments[0].actor, 'Assigned actor');
  assert.equal(result.enrollment.requestId, 'first');
  const state = await createTaskEnrollmentStore(f.config).inspect();
  assert.deepEqual(state.head, result.enrollment); assert.equal(state.executionAuthorized, false);
  assert.equal(state.head.executionAuthorized, false); assert.equal(Object.isFrozen(state.head.snapshot.assignments[0]), true);
  assert.equal(await f.store.withCurrentEnrollment(expected(state.head), record => record.projectId), f.config.projectId);
});

test('CAS and stable request retries serialize without duplicated assignment history', async t => {
  const f = await fixture(t);
  const competing = await Promise.allSettled(['a', 'b', 'c'].map(id => f.store.publish(snapshot(), request(id))));
  assert.equal(competing.filter(item => item.status === 'fulfilled').length, 1);
  for (const item of competing.filter(item => item.status === 'rejected')) assert.match(item.reason.message, /STALE_HEAD/);
  const state = await f.store.inspect(), next = request('retry', 1);
  const retries = await Promise.all([f.store.publish(snapshot(), next), f.store.publish(snapshot(), next)]);
  assert.deepEqual(retries.map(item => item.idempotent).sort(), [false, true]);
  assert.equal((await f.store.inspect()).revision, 2);
  const old = state.head;
  assert.equal((await f.store.publish(snapshot(), request(old.requestId))).idempotent, true);
  const changed = snapshot(); changed.policyVersion++;
  await assert.rejects(f.store.publish(changed, next), /REQUEST_CONFLICT/);
});

test('current enrollment remains locked through callback; newer empty snapshot revokes assignments', async t => {
  const f = await fixture(t), first = (await f.store.publish(snapshot(), request())).enrollment;
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const callback = f.store.withCurrentEnrollment(expected(first), async record => { entered(); await gate; return record.snapshot.assignments.length; });
  await started;
  const revoked = snapshot(); revoked.assignments = [];
  const publication = f.store.publish(revoked, request('revoke', 1));
  release(); assert.equal(await callback, 1);
  const second = (await publication).enrollment;
  assert.equal(second.epoch, 2); assert.deepEqual(second.snapshot.assignments, []);
  let called = false;
  await assert.rejects(f.store.withCurrentEnrollment(expected(first), () => { called = true; }), /STALE_HEAD/);
  assert.equal(called, false);
  assert.equal(await f.store.withCurrentEnrollment(expected(second), record => record.snapshot.assignments.length), 0);
  await assert.rejects(f.store.withCurrentEnrollment({ ...expected(second), epoch: 1 }, () => {}), /STALE_HEAD/);
});

test('strict bounded snapshot schemas refuse ambiguous assignments and caller-issued authority', async t => {
  const f = await fixture(t);
  for (const change of [
    value => { value.epoch = 1; }, value => { value.executionAuthorized = true; }, value => { value.hostRevision = 0; },
    value => { value.proposalDigest = 'bad'; }, value => { value.policyVersion = '2'; },
    value => { value.assignments.push({ ...value.assignments[0] }); }, value => { delete value.assignments[0]; },
    value => { value.assignments[0].token = 'secret'; }, value => { value.assignments[0].actor = ' actor '; },
    value => { value.assignments[0].taskId = 'T00001'; }, value => { value.assignments[0].sessionId = ''; },
    value => { value.assignments.push({ ...value.assignments[0], taskId: 'T0002', actor: 'Different actor' }); },
    value => { value.assignments.push({ ...value.assignments[0], taskId: 'T0002', workerId: 'other-worker' }); },
    value => { value.assignments = Array.from({ length: 501 }, (_, i) => ({ ...value.assignments[0], taskId: `T${String(i + 1).padStart(4, '0')}` })); },
  ]) { const input = snapshot(); change(input); await assert.rejects(f.store.publish(input, request())); }
  assert.equal((await f.store.inspect()).revision, 0);
  const valid = snapshot(); valid.assignments.unshift({ ...valid.assignments[0], taskId: 'T0002' });
  const result = await f.store.publish(valid, request());
  assert.deepEqual(result.enrollment.snapshot.assignments.map(item => item.taskId), ['T0001', 'T0002']);
});

test('partial, altered, replayed and wrong-project history is preserved and refused', async t => {
  const f = await fixture(t);
  await f.store.publish(snapshot(), request());
  const original = await readFile(f.config.journalPath, 'utf8');
  const changed = JSON.parse(original); changed.snapshot.assignments[0].actor = 'Attacker';
  for (const bytes of ['', original.slice(0, -1), `${original}{partial`, `${original}${original}`, `${JSON.stringify(changed)}\n`, '{bad}\n']) {
    await writeFile(f.config.journalPath, bytes);
    await assert.rejects(f.store.inspect()); await assert.rejects(f.store.publish(snapshot(), request('next', 1)));
    assert.equal(await readFile(f.config.journalPath, 'utf8'), bytes);
  }
  await writeFile(f.config.journalPath, original);
  await assert.rejects(createTaskEnrollmentStore({ ...f.config, projectId: 'pp_other_project' }).inspect(), /CORRUPT/);
});

test('record and byte quotas retain the previous head', async t => {
  const f = await fixture(t, { maxRecords: 1 });
  await f.store.publish(snapshot(), request());
  const before = await readFile(f.config.journalPath);
  await assert.rejects(f.store.publish(snapshot(), request('next', 1)), /QUOTA/);
  assert.deepEqual(await readFile(f.config.journalPath), before);
  await assert.rejects(createTaskEnrollmentStore({ ...f.config, maxBytes: 1 }).inspect(), /QUOTA/);
  assert.equal((await f.store.publish(snapshot(), request())).idempotent, true);
});

test('current admission refuses exhausted revocation headroom without hiding history', async t => {
  const f = await fixture(t);
  const { enrollment } = await f.store.publish(snapshot(), request());
  const before = await readFile(f.config.journalPath);
  for (const limits of [{ maxRecords: 1 }, { maxBytes: before.length + 1 }]) {
    const constrained = createTaskEnrollmentStore({ ...f.config, ...limits }); let called = false;
    await assert.rejects(constrained.withCurrentEnrollment(expected(enrollment), () => { called = true; }), /REVOCATION_CAPACITY/);
    assert.equal(called, false);
    assert.deepEqual((await constrained.inspect()).head, enrollment);
    assert.deepEqual(await readFile(f.config.journalPath), before);
  }
  assert.equal(await f.store.withCurrentEnrollment(expected(enrollment), () => 'headroom available'), 'headroom available');
});

test('hardlinks, redirected ancestors and lock aliases are refused', async t => {
  const f = await fixture(t);
  await f.store.publish(snapshot(), request());
  const hardlink = path.join(f.root, 'alias.jsonl'); await link(f.config.journalPath, hardlink);
  await assert.rejects(f.store.inspect(), /UNSAFE_FILE/); await rm(hardlink);
  const alias = `${f.root}-alias`;
  try { await symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Directory links unavailable'); return; } throw error; }
  t.after(() => rm(alias, { recursive: true, force: true }));
  await assert.rejects(createTaskEnrollmentStore({ ...f.config, journalPath: path.join(alias, 'enrollment.jsonl') }).inspect(), /UNSAFE_PATH/);
  await symlink(f.root, `${f.config.journalPath}.pp-lock`, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.store.inspect(), /UNSAFE_LOCK/);
});

test('flush failures preserve the first error and exact retry flushes retained bytes', async t => {
  const f = await fixture(t), actualOpen = fs.open;
  let broken = true, flushes = 0;
  const mock = t.mock.method(fs, 'open', async (...args) => {
    const handle = await actualOpen(...args);
    if (args[0] === f.config.journalPath && (args[1] & 1)) {
      const sync = handle.sync.bind(handle), close = handle.close.bind(handle);
      handle.sync = async () => { flushes++; if (broken) throw new Error('First flush failure'); return sync(); };
      handle.close = async () => { await close(); if (broken) throw new Error('Secondary close failure'); };
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.store.publish(snapshot(), request()), /First flush failure/);
    assert.equal((await f.store.inspect()).revision, 1);
    await assert.rejects(f.store.publish(snapshot(), request()), /First flush failure/);
    broken = false;
    assert.equal((await f.store.publish(snapshot(), request())).idempotent, true); assert.equal(flushes, 3);
    assert.equal((await f.store.inspect()).revision, 1);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test('sequential 155-task enrollment retains history and explicit revocation beyond the old 128-record ceiling', async t => {
  const f = await fixture(t); let first, head;
  for (let index = 1; index <= 155; index++) {
    const input = snapshot(); input.assignments[0].taskId = `T${String(index).padStart(4, '0')}`;
    head = (await f.store.publish(input, request(`task-${index}`, index - 1))).enrollment;
    first ??= head;
    if ([127, 128, 129, 155].includes(index)) {
      assert.equal(await f.store.withCurrentEnrollment(expected(head), record => record.revision), index);
    }
  }
  const before = await readFile(f.config.journalPath), reopened = createTaskEnrollmentStore(f.config);
  const state = await reopened.inspect(); assert.equal(state.history.length, 155); assert.deepEqual(state.history[0], first);
  assert.deepEqual(state.head, head);
  await assert.rejects(reopened.withCurrentEnrollment(expected(first), () => assert.fail('stale admission')), /STALE_HEAD/);
  const revoked = snapshot(); revoked.assignments = [];
  const revocation = (await reopened.publish(revoked, request('explicit-revocation', 155))).enrollment;
  assert.equal(revocation.revision, 156);
  assert.deepEqual((await reopened.inspect()).head.snapshot.assignments, []);
  assert.deepEqual((await readFile(f.config.journalPath)).subarray(0, before.length), before);
  await assert.rejects(reopened.withCurrentEnrollment(expected(head), () => assert.fail('revoked admission')), /STALE_HEAD/);
});
