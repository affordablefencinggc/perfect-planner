import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyTaskDraftLedger, updateTaskDraft } from '../src/project/taskDraftLedger.js';
import { readTaskRunObservationsForDraft } from '../src/project/taskRunObservationClient.js';

const ledger = updateTaskDraft(emptyTaskDraftLedger({ projectId: 'pp_client_fixture', rootIdentity: 'a'.repeat(64), censusDigest: 'b'.repeat(64) }), {
  title: 'Check task', description: '', owner: '', acceptance: '', recovery: '', claims: [], dependsOn: [], archived: false,
}, '2026-09-09T00:00:00.000Z');
const session = { schemaVersion: 1, token: 'c'.repeat(64), executionAuthorized: false };
const run = () => ({ runId: '12345678-1234-1234-1234-123456789abc', taskId: 'T0001', attemptId: 'attempt-1', attemptNumber: 1, checkId: 'unit',
  ledgerMatch: 'current-draft', admittedAt: '2026-09-09T00:00:00.000Z', terminalAt: null, state: 'unresolved', exitCode: null, timedOut: null,
  outputTruncated: null, failureStage: null, cleanup: 'unknown', artifactDigest: null, artifactVerified: false, authorityVerified: false,
  cause: 'unknown', nextAction: 'Inspect retained evidence.' });
const observations = () => ({ schemaVersion: 1, binding: { ...ledger.binding }, ledgerRevision: ledger.revision, authorityVerified: false,
  runs: [run()], ledgerSource: 'renderer-supplied-draft', currentHostLedgerVerified: false });
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const fetchFor = (value, handshake = session) => async url => json(url.endsWith('/session') ? handshake : value);
const refused = promise => assert.rejects(promise, /^Error: TASK_RUN_OBSERVATIONS_UNAVAILABLE$/);

test('uses fixed browser POST transport, snapshots input and exposes immutable unverified observations', async () => {
  const calls = [], input = structuredClone(ledger);
  const value = observations();
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/session')) { input.revision += 1; input.binding.rootIdentity = 'f'.repeat(64); return json(session); }
    return json(value);
  };
  const result = await readTaskRunObservationsForDraft(input, { fetchImpl });
  assert.deepEqual(result, value);
  assert.equal(Object.isFrozen(result.runs[0]), true);
  assert.deepEqual(calls.map(call => call.url), ['/api/task-run-observations/session', '/api/task-run-observations/read']);
  assert.deepEqual(JSON.parse(calls[1].options.body), { ledger });
  for (const { options } of calls) {
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error'); assert.equal(options.mode, 'same-origin');
    assert.equal(options.headers.Origin, undefined); assert.equal(options.headers.origin, undefined);
  }
  assert.equal(calls[1].options.headers['x-pp-observation-token'], session.token);
});

test('rejects stale bindings, authority expansion, unknown fields and malformed run states', async () => {
  const changes = [
    value => { value.binding.projectId = 'pp_other_fixture'; }, value => { value.binding.rootIdentity = 'f'.repeat(64); },
    value => { value.binding.censusDigest = 'f'.repeat(64); }, value => { value.ledgerRevision++; },
    value => { value.authorityVerified = true; }, value => { value.currentHostLedgerVerified = true; },
    value => { value.ledgerSource = 'host-approved'; }, value => { value.extra = true; },
    value => { value.runs[0].authorityVerified = true; }, value => { value.runs[0].artifactVerified = true; },
    value => { value.runs[0].taskId = 'T0002'; }, value => { value.runs[0].state = 'verified'; },
    value => { value.runs[0].exitCode = 0; }, value => { value.runs[0].nextAction = 'bad\ntext'; },
    value => { value.runs.push(run()); }, value => { value.runs = Array(1001).fill(run()); },
  ];
  for (const change of changes) { const value = observations(); change(value); await refused(readTaskRunObservationsForDraft(ledger, { fetchImpl: fetchFor(value) })); }
  await refused(readTaskRunObservationsForDraft(ledger, { fetchImpl: fetchFor(observations(), { ...session, executionAuthorized: true }) }));
});

test('accepts historical observations and terminal failures but never upgrades zero exits', async () => {
  for (const exitCode of [0, 3, null]) {
    const value = observations();
    Object.assign(value.runs[0], { terminalAt: '2026-09-09T00:00:01.000Z', state: exitCode === 3 ? 'failure-observed' : 'result-unverified',
      exitCode, timedOut: false, outputTruncated: false, artifactDigest: 'd'.repeat(64) });
    const result = await readTaskRunObservationsForDraft(ledger, { fetchImpl: fetchFor(value) });
    assert.equal(result.runs[0].state, value.runs[0].state); assert.equal(result.authorityVerified, false);
    value.runs[0].state = exitCode === 3 ? 'result-unverified' : 'failure-observed';
    await refused(readTaskRunObservationsForDraft(ledger, { fetchImpl: fetchFor(value) }));
  }
  const historical = observations(); historical.runs[0].taskId = 'T0002'; historical.runs[0].ledgerMatch = 'historical-or-changed';
  assert.equal((await readTaskRunObservationsForDraft(ledger, { fetchImpl: fetchFor(historical) })).runs[0].taskId, 'T0002');
});

test('refuses failed, malformed and oversized responses without exposing server details', async () => {
  for (const response of [
    new Response('private path', { status: 503 }),
    new Response('{bad', { headers: { 'Content-Type': 'application/json' } }),
    new Response('{}', { headers: { 'Content-Type': 'text/html' } }),
    new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '2097153' } }),
    new Response(' '.repeat(2097153), { headers: { 'Content-Type': 'application/json' } }),
  ]) {
    await refused(readTaskRunObservationsForDraft(ledger, { fetchImpl: async url => url.endsWith('/session') ? json(session) : response }));
  }
  await refused(readTaskRunObservationsForDraft(ledger, { fetchImpl: async () => { throw new Error('private path'); } }));
});

test('abort refuses pending fetches even when a transport ignores cancellation', async () => {
  const controller = new AbortController(); let transportSignal;
  const pending = readTaskRunObservationsForDraft(ledger, { signal: controller.signal, fetchImpl: async (_, options) => {
    transportSignal = options.signal; return new Promise(() => {});
  } });
  controller.abort(); await refused(pending); assert.equal(transportSignal.aborted, true);
  let called = false;
  await refused(readTaskRunObservationsForDraft(ledger, { signal: controller.signal, fetchImpl: async () => { called = true; } }));
  assert.equal(called, false);
});

test('deadline refuses a stalled transport without waiting for it to cooperate', async t => {
  let deadline;
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds) => { assert.equal(milliseconds, 6000); deadline = callback; return undefined; });
  const pending = readTaskRunObservationsForDraft(ledger, { fetchImpl: async () => new Promise(() => {}) });
  deadline(); await refused(pending);
});
