import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlanningApprovalRecovery} from '../src/project/planningApprovalRecovery.js';
import {planningApprovalFixture} from './fixtures/planningApproval.mjs';

test('invalid original IDs are refused before recovery storage is opened',async t=>{
 const f=await planningApprovalFixture(t);let opens=0;
 const recovery=createPlanningApprovalRecovery({indexedDB:{open(){opens++;throw Error('Storage must not open');}}});
 for(const requestId of [1,null,{},'','bad id']){
  const input=structuredClone({ledger:f.ledger,request:{requestId,expectedRevision:0,expectedHeadDigest:'GENESIS'},expectedCensusDigest:null});
  await assert.rejects(recovery.prepare(f.proposal.binding,{kind:'ledger',input}));
 }
 assert.equal(opens,0);
});
test('recovery requires real storage and never silently substitutes memory',async t=>{
 const f=await planningApprovalFixture(t),recovery=createPlanningApprovalRecovery({indexedDB:null});
 await assert.rejects(recovery.inspect(f.proposal.binding));
 await assert.rejects(recovery.prepare(f.proposal.binding,{kind:'approval',input:{binding:f.proposal.binding,...f.publishInput}}));
});
test('mismatched approval binding and undeclared decision refuse before storage',async t=>{
 const f=await planningApprovalFixture(t);let opens=0;
 const recovery=createPlanningApprovalRecovery({indexedDB:{open(){opens++;throw Error('Must not open');}}});
 for(const patch of [{binding:{...f.proposal.binding,censusDigest:'f'.repeat(64)}},{confirmation:{proposalDigest:f.proposal.digest,decision:'reject'}}]){
  await assert.rejects(recovery.prepare(f.proposal.binding,{kind:'approval',input:{binding:f.proposal.binding,...f.publishInput,...patch}}));
 }
 assert.equal(opens,0);
});
