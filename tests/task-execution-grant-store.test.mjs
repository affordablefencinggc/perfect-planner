import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { link, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { createTaskExecutionGrantStore } from '../src/node/taskExecutionGrantStore.mjs';

const binding = () => ({ proposalRevision: 1, proposalDigest: 'a'.repeat(64), checkContractDigest: 'b'.repeat(64), enrollmentEpoch: 2,
  taskId: 'T0001', checkId: 'unit', attemptId: 'attempt-1', attemptNumber: 1, workerId: 'worker-1', sessionId: 'session-1',
  candidateSchemaVersion: 2, candidateDigest: 'c'.repeat(64), policyVersion: 1, policyDigest: 'd'.repeat(64) });
const issueRequest = (requestId = 'issue-1', expectedRevision = 0) => ({ requestId, expectedRevision, ttlMs: 300000 });
const observationReceipt=intent=>({schemaVersion:1,kind:'NATIVE_TASK_OBSERVATION_RECEIPT',projectId:intent.projectId,rootIdentity:intent.rootIdentity,runId:intent.runId,intentDigest:intent.recordDigest,artifactDigest:'f'.repeat(64),state:'result-unverified',executionAuthorized:false});
const terminalRequest = (grantId, requestId = 'consume-1', expectedRevision = 1) => ({ grantId, requestId, expectedRevision });
async function fixture(t, limits = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-task-grant-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let time = Date.parse('2026-09-09T00:00:00.000Z');
  const config = { journalPath: path.join(root, 'grants.jsonl'), projectId: 'pp_grant_fixture', rootIdentity: 'e'.repeat(64), now: () => time, ...limits };
  return { root, config, store: createTaskExecutionGrantStore(config), advance: ms => { time += ms; } };
}

test('result link retains original intent and consumed receipt after expiry and concurrent recovery',async t=>{
 const f=await fixture(t),issued=await f.store.issue(binding(),issueRequest()),grantId=issued.grant.grantId;
 const consumed=await f.store.consume(binding(),terminalRequest(grantId));
 const intentRequest=terminalRequest(grantId,'intent',2),intent=(await f.store.recordExecutionIntent(consumed.consumptionReceipt,intentRequest)).intentReceipt;
 f.advance(300001);const request=terminalRequest(grantId,'result',3),receipt=observationReceipt(intent);
 const replies=await Promise.all([f.store.recordObservationReceipt(intent,receipt,request),f.store.recordObservationReceipt(intent,receipt,request)]);
 assert.equal(replies.filter(r=>!r.idempotent).length,1);assert.deepEqual(replies[0].observationLink,replies[1].observationLink);
 const reopened=createTaskExecutionGrantStore(f.config),state=await reopened.inspect();assert.equal(state.revision,4);assert.equal(state.grants[0].state,'result-recorded');assert.deepEqual(state.grants[0].intentReceipt,intent);assert.deepEqual(state.grants[0].consumptionReceipt,consumed.consumptionReceipt);
 assert.equal(state.grants[0].observationLink.artifactDigest,receipt.artifactDigest);assert.equal((await reopened.recordExecutionIntent(consumed.consumptionReceipt,intentRequest)).firstIntent,false);
 const issue=await reopened.issue(binding(),issueRequest());assert.equal(issue.state,'result-recorded');assert.equal(issue.launchAllowed,false);assert.equal(issue.alreadyConsumed,true);assert.deepEqual(issue.intentReceipt,intent);
 await assert.rejects(reopened.recordObservationReceipt(intent,{...receipt,artifactDigest:'a'.repeat(64)},request),/REQUEST_CONFLICT/);
 await assert.rejects(reopened.recordObservationReceipt(intent,receipt,{...request,requestId:'another',expectedRevision:4}),/TERMINAL/);
});

test('result link rejects mismatched receipt and lost flush reply recovers without granting execution',async t=>{
 const f=await fixture(t),issued=await f.store.issue(binding(),issueRequest()),grantId=issued.grant.grantId;
 const consumed=await f.store.consume(binding(),terminalRequest(grantId)),intent=(await f.store.recordExecutionIntent(consumed.consumptionReceipt,terminalRequest(grantId,'intent',2))).intentReceipt;
 const request=terminalRequest(grantId,'result',3),receipt=observationReceipt(intent);
 for(const change of [{projectId:'pp_foreign'},{runId:'wrong'},{intentDigest:'a'.repeat(64)},{executionAuthorized:true}])await assert.rejects(f.store.recordObservationReceipt(intent,{...receipt,...change},request),/OBSERVATION_MISMATCH/);
 await assert.rejects(f.store.recordObservationReceipt({...intent,revision:2},receipt,request),/OBSERVATION_MISMATCH/);
 await assert.rejects(f.store.recordObservationReceipt(intent,receipt,{...request,expectedRevision:2}),/STALE_HEAD/);
 const actualOpen=fs.open;let broken=true;
 const mock=t.mock.method(fs,'open',async(...args)=>{const handle=await actualOpen(...args);if(args[0]===f.config.journalPath&&(args[1]&1)){const sync=handle.sync.bind(handle);handle.sync=async()=>{if(broken)throw Error('Result flush failed');return sync();};}return handle;});syncBuiltinESMExports();
 try{await assert.rejects(f.store.recordObservationReceipt(intent,receipt,request),/Result flush failed/);broken=false;
 const recovered=await createTaskExecutionGrantStore(f.config).recordObservationReceipt(intent,receipt,request);assert.equal(recovered.idempotent,true);assert.equal(recovered.launchAllowed,false);assert.equal(recovered.executionAuthorized,false);assert.equal((await f.store.inspect()).revision,4);
 }finally{mock.mock.restore();syncBuiltinESMExports();}
});

test('issues immutable exact bindings and consumes once across reopening and retries', async t => {
  const f = await fixture(t), input = binding(), req = issueRequest();
  const pending = f.store.issue(input, req); input.workerId = 'late'; req.requestId = 'late';
  const issued = await pending;
  assert.equal(issued.grant.binding.workerId, 'worker-1'); assert.equal(issued.state, 'issued'); assert.equal(issued.launchAllowed, false);
  assert.equal(issued.executionAuthorized, false); assert.equal(Object.isFrozen(issued.grant.binding), true);
  assert.equal(issued.consumptionReceipt, null);
  const consumeRequest = terminalRequest(issued.grant.grantId);
  const consumed = await f.store.consume(binding(), consumeRequest);
  assert.equal(consumed.launchAllowed, true); assert.equal(consumed.executionAuthorized, false);
  const reopened = createTaskExecutionGrantStore(f.config);
  const retried = await reopened.consume(binding(), consumeRequest);
  assert.equal(retried.launchAllowed, false); assert.equal(retried.alreadyConsumed, true); assert.equal(retried.idempotent, true);
  assert.deepEqual(retried.consumptionReceipt, consumed.consumptionReceipt);
  const saved = await reopened.inspect();
  assert.deepEqual(saved.grants[0].consumptionReceipt, consumed.consumptionReceipt);
  assert.equal(consumed.consumptionReceipt.recordDigest, saved.history[1].recordHash);
  assert.equal(consumed.consumptionReceipt.consumedAt, saved.history[1].recordedAt);
  assert.equal(consumed.consumptionReceipt.requestId, consumeRequest.requestId);
  assert.equal(consumed.consumptionReceipt.revision, 2);
  assert.equal(Object.isFrozen(consumed.consumptionReceipt.binding), true);
  assert.equal((await reopened.inspect()).revision, 2);
  const retriedIssue = await reopened.issue(binding(), issueRequest());
  assert.equal(retriedIssue.state, 'consumed'); assert.equal(retriedIssue.launchAllowed, false);
  assert.deepEqual(retriedIssue.consumptionReceipt, consumed.consumptionReceipt);
  await assert.rejects(reopened.consume(binding(), terminalRequest(issued.grant.grantId, 'another-consume', 2)), /TERMINAL/);
});

test('concurrent consume requests produce only one launch allowance', async t => {
  const f = await fixture(t), { grant } = await f.store.issue(binding(), issueRequest());
  const request = terminalRequest(grant.grantId);
  const retries = await Promise.all([f.store.consume(binding(), request), f.store.consume(binding(), request)]);
  assert.equal(retries.filter(item => item.launchAllowed).length, 1); assert.equal(retries.filter(item => item.alreadyConsumed).length, 1);
  assert.deepEqual(retries[0].consumptionReceipt, retries[1].consumptionReceipt);
  assert.equal((await f.store.inspect()).revision, 2);
});

test('revocation, expiry and stale revisions refuse consumption', async t => {
  const f = await fixture(t), { grant } = await f.store.issue(binding(), issueRequest());
  await assert.rejects(f.store.consume(binding(), terminalRequest(grant.grantId, 'stale', 0)), /STALE_HEAD/);
  f.advance(300000);
  await assert.rejects(f.store.consume(binding(), terminalRequest(grant.grantId)), /EXPIRED/);
  assert.equal((await f.store.inspect()).revision, 1);
  const revoked = await f.store.revoke(terminalRequest(grant.grantId, 'revoke'));
  assert.equal(revoked.state, 'revoked'); assert.equal(revoked.launchAllowed, false);
  assert.equal(revoked.consumptionReceipt, null);
  assert.equal((await f.store.revoke(terminalRequest(grant.grantId, 'revoke'))).idempotent, true);
  await assert.rejects(f.store.consume(binding(), terminalRequest(grant.grantId, 'after-revoke', 2)), /TERMINAL/);
});

test('same attempt cannot change its binding or reuse a check after a terminal outcome', async t => {
  const f = await fixture(t), { grant } = await f.store.issue(binding(), issueRequest());
  await assert.rejects(f.store.issue(binding(), issueRequest('second-issue', 1)), /CHECK_ALREADY_ISSUED/);
  for (const field of ['attemptNumber', 'workerId', 'sessionId', 'candidateDigest', 'proposalDigest', 'checkContractDigest', 'enrollmentEpoch', 'policyVersion', 'policyDigest']) {
    const value = binding(); value.checkId = 'integration';
    value[field] = typeof value[field] === 'number' ? value[field] + 1 : field.endsWith('Digest') ? 'f'.repeat(64) : 'changed';
    await assert.rejects(f.store.issue(value, issueRequest(`changed-${field}`, 1)), /ATTEMPT_BINDING_CONFLICT/);
  }
  const otherCheck = { ...binding(), checkId: 'integration' };
  await f.store.issue(otherCheck, issueRequest('integration', 1));
  await f.store.revoke(terminalRequest(grant.grantId, 'revoke', 2));
  await assert.rejects(f.store.issue(binding(), issueRequest('reissue', 3)), /CHECK_ALREADY_ISSUED/);
  const fresh = { ...binding(), attemptId: 'attempt-2', attemptNumber: 2 };
  assert.equal((await f.store.issue(fresh, issueRequest('fresh', 3))).state, 'issued');
});

test('every consume binding dimension and idempotency request body remains exact', async t => {
  const f = await fixture(t), { grant } = await f.store.issue(binding(), issueRequest());
  for (const field of Object.keys(binding())) {
    if (field === 'candidateSchemaVersion') continue;
    const changed = binding();
    changed[field] = typeof changed[field] === 'number' ? changed[field] + 1 : field.endsWith('Digest') ? 'f'.repeat(64) : field === 'taskId' ? 'T0002' : 'other';
    await assert.rejects(f.store.consume(changed, terminalRequest(grant.grantId)), /BINDING_MISMATCH/);
  }
  await assert.rejects(f.store.issue({ ...binding(), workerId: 'other' }, issueRequest()), /REQUEST_CONFLICT/);
  for (const patch of [{ candidateSchemaVersion: 1 }, { executionAuthorized: true }, { attemptNumber: 0 }, { taskId: 'T00001' }]) {
    await assert.rejects(f.store.issue({ ...binding(), ...patch }, issueRequest()));
  }
  for (const ttlMs of [0, -1, 300001, Infinity, '3000']) await assert.rejects(f.store.issue(binding(), { ...issueRequest(), ttlMs }), /REQUEST_INVALID/);
  assert.equal((await f.store.inspect()).revision, 1);
});

test('new task attempts require increasing numbers while task-scoped IDs may add checks', async t => {
  const f = await fixture(t); await f.store.issue(binding(), issueRequest());
  await assert.rejects(f.store.issue({ ...binding(), attemptId: 'another-id' }, issueRequest('duplicate-number', 1)), /ATTEMPT_NUMBER_REUSED/);
  const newer = { ...binding(), attemptId: 'newer', attemptNumber: 3 };
  await f.store.issue(newer, issueRequest('newer', 1));
  await assert.rejects(f.store.issue({ ...binding(), attemptId: 'between', attemptNumber: 2 }, issueRequest('backwards-number', 2)), /ATTEMPT_NUMBER_REUSED/);
  assert.equal((await f.store.issue({ ...newer, checkId: 'integration' }, issueRequest('additional-check', 2))).state, 'issued');
  assert.equal((await f.store.issue({ ...binding(), taskId: 'T0002' }, issueRequest('different-task', 3))).state, 'issued');
});

test('expiry or clock reversal after flushed consumption leaves consumed state without launch permission', async t => {
  for (const finalOffset of [300000, 5]) {
    const f = await fixture(t), base = Date.parse('2026-09-09T00:00:00.000Z');
    const times = [base, base + 10, base + finalOffset];
    const store = createTaskExecutionGrantStore({ ...f.config, now: () => times.shift() });
    const { grant } = await store.issue(binding(), issueRequest());
    await assert.rejects(store.consume(binding(), terminalRequest(grant.grantId)), finalOffset === 300000 ? /EXPIRED_AFTER_CONSUMPTION/ : /CLOCK_REVERSED/);
    assert.equal((await store.inspect()).grants[0].state, 'consumed');
    const retry = await store.consume(binding(), terminalRequest(grant.grantId));
    assert.equal(retry.alreadyConsumed, true); assert.equal(retry.launchAllowed, false);
  }
});

test('observed expiry cannot become eligible after clock rollback within the same store instance', async t => {
  const f = await fixture(t), { grant } = await f.store.issue(binding(), issueRequest());
  f.advance(300000);
  await assert.rejects(f.store.consume(binding(), terminalRequest(grant.grantId)), /EXPIRED/);
  f.advance(-1);
  await assert.rejects(f.store.consume(binding(), terminalRequest(grant.grantId)), /CLOCK_REVERSED/);
  assert.equal((await f.store.inspect()).revision, 1);
});

test('issue reserves record and byte capacity for terminal transitions', async t => {
  const f = await fixture(t, { maxRecords: 4 });
  const { grant } = await f.store.issue(binding(), issueRequest());
  await assert.rejects(f.store.issue({ ...binding(), checkId: 'integration' }, issueRequest('next', 1)), /QUOTA/);
  const consumed=await f.store.consume(binding(), terminalRequest(grant.grantId));assert.equal(consumed.launchAllowed,true);
  const intent=(await f.store.recordExecutionIntent(consumed.consumptionReceipt,terminalRequest(grant.grantId,'intent',2))).intentReceipt;
  await f.store.recordObservationReceipt(intent,observationReceipt(intent),terminalRequest(grant.grantId,'result',3));assert.equal((await f.store.inspect()).revision,4);
  const g = await fixture(t, { maxRecords: 1 });
  await assert.rejects(g.store.issue(binding(), issueRequest()), /QUOTA/); assert.equal((await g.store.inspect()).revision, 0);
  const h = await fixture(t, { maxBytes: 100 });
  await assert.rejects(h.store.issue(binding(), issueRequest()), /QUOTA/); assert.equal((await h.store.inspect()).revision, 0);
});

test('default journal accommodates 155 two-check grant lifecycles without claiming task acceptance',async t=>{
 const f=await fixture(t);let revision=0;
 for(let i=1;i<=155;i++){
  for(const checkId of ['unit','integration']){
   const b={...binding(),taskId:`T${String(i).padStart(4,'0')}`,checkId},id=`${i}-${checkId}`;
   const issued=await f.store.issue(b,issueRequest(`issue-${id}`,revision)),grantId=issued.grant.grantId;
   const consumed=await f.store.consume(b,terminalRequest(grantId,`consume-${id}`,revision+1));
   const intent=(await f.store.recordExecutionIntent(consumed.consumptionReceipt,terminalRequest(grantId,`intent-${id}`,revision+2))).intentReceipt;
   await f.store.recordObservationReceipt(intent,observationReceipt(intent),terminalRequest(grantId,`result-${id}`,revision+3));revision+=4;
  }
 }
 const state=await createTaskExecutionGrantStore(f.config).inspect();assert.equal(state.revision,1240);assert.equal(state.grants.length,310);
 assert.equal(state.grants.every(g=>g.state==='result-recorded'&&g.observationLink.state==='result-unverified'),true);assert.equal(state.executionAuthorized,false);
});

test('partial and corrupt grant history is retained and cannot be consumed', async t => {
  const f = await fixture(t), { grant } = await f.store.issue(binding(), issueRequest());
  const original = await readFile(f.config.journalPath, 'utf8');
  const changed = JSON.parse(original); changed.grant.binding.workerId = 'attacker';
  for (const bytes of ['', original.slice(0, -1), `${original}{partial`, `${original}${original}`, `${JSON.stringify(changed)}\n`]) {
    await writeFile(f.config.journalPath, bytes);
    await assert.rejects(f.store.inspect()); await assert.rejects(f.store.consume(binding(), terminalRequest(grant.grantId)));
    assert.equal(await readFile(f.config.journalPath, 'utf8'), bytes);
  }
});

test('unsafe aliases and substituted host project identities fail closed', async t => {
  const f = await fixture(t); await f.store.issue(binding(), issueRequest());
  await assert.rejects(createTaskExecutionGrantStore({ ...f.config, projectId: 'pp_foreign_fixture' }).inspect(), /CORRUPT/);
  const aliasFile = path.join(f.root, 'alias.jsonl'); await link(f.config.journalPath, aliasFile);
  await assert.rejects(f.store.inspect(), /UNSAFE_FILE/); await rm(aliasFile);
  const alias = `${f.root}-alias`;
  try { await symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Directory links unavailable'); return; } throw error; }
  t.after(() => rm(alias, { recursive: true, force: true }));
  await assert.rejects(createTaskExecutionGrantStore({ ...f.config, journalPath: path.join(alias, 'grants.jsonl') }).inspect(), /UNSAFE_PATH/);
  await symlink(f.root, `${f.config.journalPath}.pp-lock`, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.store.inspect(), /UNSAFE_LOCK/);
});

test('failed consume flush cannot enable a launch on retry', async t => {
  const f = await fixture(t), { grant } = await f.store.issue(binding(), issueRequest());
  const actualOpen = fs.open; let broken = true;
  const mock = t.mock.method(fs, 'open', async (...args) => {
    const handle = await actualOpen(...args);
    if (args[0] === f.config.journalPath && (args[1] & 1)) {
      const sync = handle.sync.bind(handle), close = handle.close.bind(handle);
      handle.sync = async () => { if (broken) throw new Error('First flush failure'); return sync(); };
      handle.close = async () => { await close(); if (broken) throw new Error('Secondary close failure'); };
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.store.consume(binding(), terminalRequest(grant.grantId)), /First flush failure/);
    assert.equal((await f.store.inspect()).grants[0].state, 'consumed');
    broken = false;
    const retry = await f.store.consume(binding(), terminalRequest(grant.grantId));
    assert.equal(retry.alreadyConsumed, true); assert.equal(retry.launchAllowed, false);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test('one durable unresolved execution intent per consumption survives concurrency and reopening', async t => {
  const f=await fixture(t), issued=await f.store.issue(binding(),issueRequest());
  const consumed=await f.store.consume(binding(),terminalRequest(issued.grant.grantId));
  const request=terminalRequest(issued.grant.grantId,'intent-1',2);
  const replies=await Promise.all([f.store.recordExecutionIntent(consumed.consumptionReceipt,request),f.store.recordExecutionIntent(consumed.consumptionReceipt,request)]);
  assert.equal(replies.filter(reply=>reply.firstIntent).length,1);
  assert.deepEqual(replies[0].intentReceipt,replies[1].intentReceipt);
  for(const reply of replies){assert.equal(reply.launchAllowed,false);assert.equal(reply.executionAuthorized,false);assert.equal(reply.intentReceipt.state,'launch-unresolved');}
  const intent=replies[0].intentReceipt;
  assert.match(intent.runId,/^[a-f0-9-]{36}$/);assert.equal(intent.consumptionDigest,consumed.consumptionReceipt.recordDigest);
  assert.equal(intent.consumptionRevision,2);assert.equal(intent.revision,3);
  const reopened=createTaskExecutionGrantStore(f.config),before=await readFile(f.config.journalPath,'utf8');
  const replay=await reopened.recordExecutionIntent(consumed.consumptionReceipt,request);
  assert.equal(replay.firstIntent,false);assert.deepEqual(replay.intentReceipt,intent);
  const inspected=await reopened.inspect();assert.equal(inspected.revision,3);
  assert.equal(inspected.history[2].recordHash,intent.recordDigest);
  assert.deepEqual(inspected.grants[0].intentReceipt,intent);
  assert.deepEqual(inspected.grants[0].consumptionReceipt,consumed.consumptionReceipt);
  const issueReplay=await reopened.issue(binding(),issueRequest());assert.equal(issueReplay.alreadyConsumed,true);assert.equal(issueReplay.launchAllowed,false);assert.deepEqual(issueReplay.intentReceipt,intent);
  await assert.rejects(reopened.recordExecutionIntent(consumed.consumptionReceipt,{...request,requestId:'different',expectedRevision:3}),/TERMINAL/);
  assert.equal(await readFile(f.config.journalPath,'utf8'),before);
});

test('intent rejects substituted consumption, stale head, expiry and caller-selected run id', async t => {
  const f=await fixture(t),issued=await f.store.issue(binding(),issueRequest());
  const consumed=await f.store.consume(binding(),terminalRequest(issued.grant.grantId));
  const request=terminalRequest(issued.grant.grantId,'intent-1',2), receipt=consumed.consumptionReceipt;
  for(const change of [{recordDigest:'f'.repeat(64)},{revision:1},{projectId:'pp_foreign'},{consumedAt:issued.grant.issuedAt+'bad'},{executionAuthorized:true}]){
    await assert.rejects(f.store.recordExecutionIntent({...receipt,...change},request),/RECEIPT_MISMATCH/);
  }
  await assert.rejects(f.store.recordExecutionIntent(receipt,{...request,expectedRevision:1}),/STALE_HEAD/);
  await assert.rejects(f.store.recordExecutionIntent(receipt,{...request,runId:'caller-id'}),/INVALID/);
  f.advance(300000);await assert.rejects(f.store.recordExecutionIntent(receipt,request),/EXPIRED/);
  assert.equal((await f.store.inspect()).revision,2);assert.equal((await f.store.inspect()).grants[0].intentReceipt,null);
});

test('failed intent flush stays unresolved and cannot produce a fresh intent on recovery',async t=>{
  const f=await fixture(t),issued=await f.store.issue(binding(),issueRequest());
  const consumed=await f.store.consume(binding(),terminalRequest(issued.grant.grantId));
  const request=terminalRequest(issued.grant.grantId,'intent-1',2),actualOpen=fs.open;let broken=true;
  const mock=t.mock.method(fs,'open',async(...args)=>{
    const handle=await actualOpen(...args);
    if(args[0]===f.config.journalPath&&(args[1]&1)){
      const sync=handle.sync.bind(handle);handle.sync=async()=>{if(broken)throw Error('Intent flush failed');return sync();};
    }return handle;
  });syncBuiltinESMExports();
  try{
    await assert.rejects(f.store.recordExecutionIntent(consumed.consumptionReceipt,request),/Intent flush failed/);
    const saved=(await f.store.inspect()).grants[0].intentReceipt;assert.equal(saved.state,'launch-unresolved');
    broken=false;const recovered=await createTaskExecutionGrantStore(f.config).recordExecutionIntent(consumed.consumptionReceipt,request);
    assert.equal(recovered.firstIntent,false);assert.equal(recovered.launchAllowed,false);assert.deepEqual(recovered.intentReceipt,saved);
  }finally{mock.mock.restore();syncBuiltinESMExports();}
});
