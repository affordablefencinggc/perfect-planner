import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptAgentSessionObservation as accept,agentSessionPresentation as present} from '../src/runtime/agentSessionProtocol.js';
const binding={projectId:'pp_test',rootIdentity:'a'.repeat(64),workspaceId:'workspace-test',registryRevision:1};
const open={schemaVersion:1,binding,sessionId:'b'.repeat(32),sequence:1,kind:'open',observedAt:1000,expiresAt:31000};
test('real observation states never grant authority or claim work proof',()=>{
  const first=accept(null,open,binding,1000);
  assert.equal(present(first,1001).state,'reachable');
  assert.equal(present(first,31000).state,'stale');
  assert.equal(present(first,999).state,'stale');
  assert.equal(present(null,1000).state,'unverified');
  assert.equal(present(first,1001).workVerified,false);
  assert.equal(present(first,1001).executionAuthorized,false);
  assert.ok(Object.isFrozen(first.binding));
});
test('heartbeat advances one sequence; close is terminal',()=>{
  const a=accept(null,open,binding,1000);
  const b=accept(a,{...open,sequence:2,kind:'heartbeat',observedAt:2000,expiresAt:32000},binding,2000);
  assert.equal(present(b,31001).state,'reachable');
  const c=accept(b,{...b,sequence:3,kind:'close',observedAt:3000,expiresAt:3000},binding,3000);
  assert.equal(present(c,3001).state,'closed');
  assert.throws(()=>accept(c,{...b,sequence:4},binding,3001),/CLOSED/);
});
test('reject foreign binding, replay, missing sequence and invented success fields',()=>{
  const a=accept(null,open,binding,1000);
  for(const patch of [{projectId:'pp_other'},{rootIdentity:'c'.repeat(64)},{registryRevision:2},{workspaceId:'other-root'}])assert.throws(()=>accept(null,{...open,binding:{...binding,...patch}},binding,1000),/FOREIGN/);
  for(const patch of [{sequence:1},{sequence:3},{kind:'open',sequence:2}])assert.throws(()=>accept(a,{...open,kind:'heartbeat',...patch},binding,1000),/SEQUENCE/);
  assert.throws(()=>accept(null,{...open,executionAuthorized:true},binding,1000),/SCHEMA/);
  assert.throws(()=>accept(null,{...open,kind:'heartbeat'},binding,1000),/OPEN_REQUIRED/);
  assert.throws(()=>accept(a,{...open,kind:'heartbeat',sequence:2,sessionId:'c'.repeat(32)},binding,1000),/IDENTITY/);
});
test('reject future, expired, overlong leases and decreasing observation times',()=>{
  assert.throws(()=>accept(null,open,binding,999),/TIME/);
  assert.throws(()=>accept(null,open,binding,31000),/TIME/);
  assert.throws(()=>accept(null,{...open,expiresAt:31001},binding,1000),/EXPIRY/);
  assert.throws(()=>accept(open,{...open,kind:'heartbeat',sequence:2,observedAt:999,expiresAt:2000},binding,1000),/SEQUENCE/);
});
