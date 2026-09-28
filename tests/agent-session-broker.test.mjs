import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentSessionBroker} from '../mcp/agentSessionBroker.mjs';
const binding={projectId:'pp_test',workspaceId:'workspace-test',rootIdentity:'a'.repeat(64),registryRevision:1};
function fixture(options={}){let time=1000,current={...binding};const broker=createAgentSessionBroker({now:()=>time,resolveBinding:async()=>current,...options});return {broker,time:v=>time=v,change:v=>current=v};}
test('one-use pairing, separate session credentials, metadata-only inspector',async()=>{
  const {broker}=fixture();const pair=await broker.issuePairing(binding);
  const session=await broker.connect(pair);
  await assert.rejects(broker.connect(pair),/PAIRING_REFUSED/);
  await assert.rejects(broker.heartbeat({...session,secret:pair.secret,expectedSequence:1}),/SESSION_REFUSED/);
  const beat=await broker.heartbeat({...session,expectedSequence:1});assert.equal(beat.sequence,2);
  const view=await broker.inspect(binding);assert.equal(view[0].state,'reachable');assert.equal(view[0].executionAuthorized,false);
  const json=JSON.stringify(view);assert.ok(!json.includes(pair.secret)&&!json.includes(session.secret)&&!json.includes('digest'));
  broker.dispose();await assert.rejects(broker.inspect(binding),/CLOSED/);
});
test('concurrent pairing and heartbeat cannot consume the same revision twice',async()=>{
  const {broker}=fixture();const pair=await broker.issuePairing(binding);
  const outcomes=await Promise.allSettled([broker.connect(pair),broker.connect(pair)]);
  assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
  const session=outcomes.find(o=>o.status==='fulfilled').value;
  const beats=await Promise.allSettled([broker.heartbeat({...session,expectedSequence:1}),broker.heartbeat({...session,expectedSequence:1})]);
  assert.equal(beats.filter(o=>o.status==='fulfilled').length,1);
});
test('expiry, registry change, revocation and restart refuse old capabilities',async()=>{
  const f=fixture();const pair=await f.broker.issuePairing(binding);f.time(61000);await assert.rejects(f.broker.connect(pair),/PAIRING_REFUSED/);
  f.time(62000);const next=await f.broker.issuePairing(binding);const session=await f.broker.connect(next);
  f.change({...binding,registryRevision:2});await assert.rejects(f.broker.heartbeat({...session,expectedSequence:1}),/BINDING_CHANGED/);
  f.change(binding);f.time(92000);await assert.rejects(f.broker.heartbeat({...session,expectedSequence:1}),/SESSION_REFUSED/);
  assert.equal((await f.broker.inspect(binding))[0].state,'stale');assert.equal(f.broker.revoke(session.sessionId),true);
  await assert.rejects(f.broker.heartbeat({...session,expectedSequence:1}),/SESSION_REFUSED/);
  await assert.rejects(fixture().broker.heartbeat({...session,expectedSequence:1}),/SESSION_REFUSED/);
});
test('revocation while registration is being checked prevents heartbeat publication',async()=>{
  let block=false,release;
  const f=fixture({resolveBinding:async()=>{if(block)await new Promise(r=>release=r);return binding;}});
  const session=await f.broker.connect(await f.broker.issuePairing(binding));block=true;
  const pending=f.broker.heartbeat({...session,expectedSequence:1});f.broker.revoke(session.sessionId);release();
  await assert.rejects(pending,/SESSION_REFUSED/);
});
test('bounded capacity and malformed secret do not create sessions',async()=>{
  const {broker}=fixture({maxSessions:1});const pair=await broker.issuePairing(binding);
  await assert.rejects(broker.issuePairing(binding),/CAPACITY/);
  await assert.rejects(broker.connect({...pair,secret:'invalid'}),/PAIRING_REFUSED/);
  assert.equal((await broker.inspect(binding)).length,0);assert.equal(broker.cancelPairing(pair.pairingId),true);
  await broker.issuePairing(binding);
});
test('registration failure permanently invalidates pairing and session even if registry returns',async()=>{
  const f=fixture();const pair=await f.broker.issuePairing(binding);
  f.change({...binding,registryRevision:2});await assert.rejects(f.broker.connect(pair),/BINDING_CHANGED/);
  f.change(binding);await assert.rejects(f.broker.connect(pair),/PAIRING_REFUSED/);
  const session=await f.broker.connect(await f.broker.issuePairing(binding));
  f.change({...binding,rootIdentity:'d'.repeat(64)});await assert.rejects(f.broker.heartbeat({...session,expectedSequence:1}),/BINDING_CHANGED/);
  f.change(binding);await assert.rejects(f.broker.heartbeat({...session,expectedSequence:1}),/SESSION_REFUSED/);
});
test('expired or backwards-clock sessions cannot revive when the clock returns',async()=>{
  for(const jump of [999,31000]){
    const f=fixture();const session=await f.broker.connect(await f.broker.issuePairing(binding));
    f.time(jump);await assert.rejects(f.broker.heartbeat({...session,expectedSequence:1}),/SESSION_REFUSED/);
    f.time(1001);await assert.rejects(f.broker.heartbeat({...session,expectedSequence:1}),/SESSION_REFUSED/);
  }
});
