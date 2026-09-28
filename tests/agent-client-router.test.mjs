import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentSessionBroker} from '../mcp/agentSessionBroker.mjs';
import {createAgentClientRouter} from '../mcp/agentClientRouter.mjs';
const binding={projectId:'pp_client',workspaceId:'client-test',rootIdentity:'a'.repeat(64),registryRevision:1};
const other={...binding,projectId:'pp_other',workspaceId:'other-test',rootIdentity:'b'.repeat(64)};
const frame=(id,method,params)=>({version:1,id,method,params});
const pairParams=p=>({pairingId:p.pairingId,secret:p.secret});
function fixture(){const broker=createAgentSessionBroker({now:()=>1000,resolveBinding:async id=>id===binding.workspaceId?binding:other});return {broker,router:createAgentClientRouter({broker,binding})};}
test('client router admits scoped pairing and heartbeat but no owner methods',async()=>{
  const {broker,router}=fixture();
  for(const method of ['owner.pair','owner.inspect','owner.revoke','owner.cancel','constructor','__proto__','client.execute'])await assert.rejects(router.request(frame(1,method,{})),/METHOD_REFUSED/);
  const pair=await broker.issuePairing(binding);
  const connected=await router.request(frame(1,'client.connect',pairParams(pair)));assert.equal(connected.ok,true);
  const session=connected.result;
  const beat=await router.request(frame(2,'client.heartbeat',{sessionId:session.sessionId,secret:session.secret,expectedSequence:1}));
  assert.equal(beat.ok,true);assert.equal(beat.result.sequence,2);
  await assert.rejects(router.request(frame(2,'client.heartbeat',{})),/FRAME_REFUSED/);
  broker.dispose();
});
test('foreign pairing is refused without consuming it or returning credentials',async()=>{
  const {broker,router}=fixture();const pair=await broker.issuePairing(other);
  const denied=await router.request(frame(1,'client.connect',pairParams(pair)));
  assert.deepEqual(denied,{version:1,id:1,ok:false,error:'AGENT_CLIENT_REQUEST_REFUSED'});
  assert.ok(!JSON.stringify(denied).includes(pair.secret));
  const foreign=await broker.connect(pair,other);
  assert.equal((await router.request(frame(2,'client.heartbeat',{sessionId:foreign.sessionId,secret:foreign.secret,expectedSequence:1}))).ok,false);
  assert.equal((await broker.heartbeat({...foreign,expectedSequence:1},other)).sequence,2);
  broker.dispose();
});
test('exact envelope and argument fields prevent authority smuggling',async()=>{
  const {broker,router}=fixture();const p=pairParams(await broker.issuePairing(binding));
  await assert.rejects(router.request({...frame(1,'client.connect',p),owner:true}),/FRAME_REFUSED/);
  await assert.rejects(router.request(frame(1,'client.connect',{...p,binding:other})),/METHOD_REFUSED/);
  await assert.rejects(router.request(frame(1,'client.connect',{...p,secret:'x'.repeat(100000)})),/METHOD_REFUSED/);
  assert.equal((await router.request(frame(1,'client.connect',p))).ok,true);broker.dispose();
});
test('busy refusal, input snapshot and shutdown suppress late responses',async()=>{
  let finish,received;const revoked=[];const broker={connect:async p=>{received=p;return new Promise(r=>finish=r);},heartbeat:async()=>{},revoke:id=>{revoked.push(id);return true;}};
  const router=createAgentClientRouter({broker,binding});
  const params={pairingId:'1'.repeat(32),secret:'2'.repeat(64)};
  const pending=router.request(frame(1,'client.connect',params));params.secret='3'.repeat(64);
  assert.equal(received.secret,'2'.repeat(64));
  await assert.rejects(router.request(frame(2,'client.connect',params)),/UNAVAILABLE/);
  const closing=router.close();finish({sessionId:'4'.repeat(32),secret:'must-not-be-delivered'});
  assert.deepEqual(await pending,{version:1,id:1,ok:false,error:'AGENT_CLIENT_REQUEST_REFUSED'});
  await assert.rejects(router.request(frame(2,'client.connect',params)),/UNAVAILABLE/);
  assert.deepEqual(await closing,{closed:true,revocationComplete:true});
  assert.deepEqual(revoked,['4'.repeat(32)]);
});
test('closing revokes only sessions minted by that router',async()=>{
  const {broker,router}=fixture();const independent=await broker.connect(await broker.issuePairing(binding));
  const connected=await router.request(frame(1,'client.connect',pairParams(await broker.issuePairing(binding))));
  assert.deepEqual(await router.close(),{closed:true,revocationComplete:true});
  await assert.rejects(broker.heartbeat({...connected.result,expectedSequence:1}),/SESSION_REFUSED/);
  assert.equal((await broker.heartbeat({...independent,expectedSequence:1})).sequence,2);
  broker.dispose();
});
test('failed revocation stays unconfirmed and can be retried without reopening',async()=>{
  let fail=true;const broker={connect:async()=>({sessionId:'5'.repeat(32)}),heartbeat:async()=>{},revoke:()=>{if(fail)throw Error('private diagnostic');return true;}};
  const router=createAgentClientRouter({broker,binding});
  await router.request(frame(1,'client.connect',{pairingId:'1'.repeat(32),secret:'2'.repeat(64)}));
  await assert.rejects(router.close(),/REVOCATION_UNCONFIRMED/);
  await assert.rejects(router.request(frame(2,'client.connect',{})),/UNAVAILABLE/);
  fail=false;assert.equal((await router.close()).revocationComplete,true);
});
