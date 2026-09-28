import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,access} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createTaskLedgerAuthorityStore} from '../src/node/taskLedgerAuthorityStore.mjs';
import {createTaskCheckContractStore} from '../src/node/taskCheckContractStore.mjs';
import {createTaskCheckContract} from '../src/node/taskCheckContract.mjs';
import {createTaskProposalReview} from '../src/node/taskProposalReview.mjs';
import {createNativeTaskReviewFlow} from '../src/node/nativeTaskReviewFlow.mjs';
import {createTrustedUserGestureBoundary,inspectConfirmations} from '../src/node/confirmationStore.mjs';
import {emptyTaskDraftLedger,updateTaskDraft} from '../src/project/taskDraftLedger.js';

async function fixture(){
 const root=await mkdtemp(path.join(os.tmpdir(),'pp-custody-review-'));
 const binding={projectId:'pp_custody_review',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)};
 const proposalConfig={journalPath:path.join(root,'proposals.jsonl'),projectId:binding.projectId,rootIdentity:binding.rootIdentity};
 const ledger=updateTaskDraft(emptyTaskDraftLedger(binding),{title:'Exact task',description:'Scope',owner:'Worker',acceptance:'Check',recovery:'Retain',claims:[],dependsOn:[],archived:false});
 const proposed=await createTaskLedgerAuthorityStore(proposalConfig).propose(ledger,{requestId:'proposal',expectedRevision:0,expectedHeadDigest:'GENESIS'});
 const expected={hostRevision:1,headDigest:proposed.proposal.recordHash};
 const raw={schemaVersion:1,kind:'TASK_CHECK_CONTRACT',projectId:binding.projectId,rootIdentity:binding.rootIdentity,policyVersion:1,policyDigest:'c'.repeat(64),tasks:[{taskId:'T0001',checks:[{checkId:'unit',executablePath:process.execPath,executableDigest:'d'.repeat(64),args:['--version'],cwd:'.',timeoutMs:1000,outputLimits:{stdoutBytes:1000,stderrBytes:1000,combinedBytes:2000}}]}]};
 const checkContract=createTaskCheckContract(raw),storeConfig={journalPath:path.join(root,'checks.jsonl'),proposalConfig,registeredBinding:async()=>binding,actor:'owner',source:'host'};
 const custody=createTaskCheckContractStore(storeConfig),saved=await custody.retain(expected,checkContract,{requestId:'checks',expectedRevision:0,expectedHeadDigest:'GENESIS'});
 const contractCustody={storeConfig,expectedHead:{revision:1,headDigest:saved.record.recordHash}};
 const config={proposalConfig,confirmationPath:path.join(root,'confirmations.json'),checkContract,contractCustody};
 const replace=()=>custody.retain(expected,createTaskCheckContract({...raw,policyVersion:2}),{requestId:'replacement',expectedRevision:1,expectedHeadDigest:saved.record.recordHash});
 return {root,expected,config,custody,replace};
}
test('custody head/digest mismatch refuses request without a confirmation',async()=>{
 for(const mode of ['stale','digest']){
  const f=await fixture();if(mode==='stale')await f.replace();
  const config=mode==='digest'?{...f.config,checkContract:createTaskCheckContract((({contractDigest,executionAuthorized,authorityVerified,...v})=>({...v,policyVersion:3}))(f.config.checkContract))}:f.config;
  await assert.rejects(createTaskProposalReview(config).request(f.expected,{requestedBy:'owner',question:'Review'}),mode==='stale'?/STALE_HEAD/:/CUSTODY_MISMATCH/);
  await assert.rejects(access(f.config.confirmationPath),{code:'ENOENT'});
 }
});
test('custody rejects mismatched proposal storage and snapshots caller config',async()=>{
 const f=await fixture();assert.throws(()=>createTaskProposalReview({...f.config,contractCustody:{...f.config.contractCustody,storeConfig:{...f.config.contractCustody.storeConfig,proposalConfig:{...f.config.proposalConfig,journalPath:path.join(f.root,'other.jsonl')}}}}),/CUSTODY_INVALID/);
 const review=createTaskProposalReview(f.config);f.config.contractCustody.expectedHead.headDigest='f'.repeat(64);f.config.contractCustody.storeConfig.registeredBinding=async()=>{throw Error('mutated');};
 const result=await review.request(f.expected,{requestedBy:'owner',question:'Review'});assert.equal(result.confirmation.status,'pending');
});
test('contract replacement during dialog rejects decision and cancels pending request',async()=>{
 const f=await fixture();let displayed=false;
 const flow=createNativeTaskReviewFlow({...f.config,actor:'owner',source:'test',presentNativeReview:async()=>{displayed=true;await f.replace();return {decision:'approved',rationale:'Test only',nativeEvent:{isTrusted:true}};}});
 await assert.rejects(flow.reviewProposal(f.expected),/STALE_HEAD/);
 assert.equal(displayed,true);const records=await inspectConfirmations(f.config.confirmationPath);assert.equal(records.length,1);assert.equal(records[0].status,'cancelled');assert.equal(records[0].decision,null);
});
test('replacement waits while exact decision holds proposal and contract locks, without recursive locking',async()=>{
 const f=await fixture(),review=createTaskProposalReview(f.config),pending=await review.request(f.expected,{requestedBy:'owner',question:'Review'});
 let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const boundary=createTrustedUserGestureBoundary(async(_evidence,binding)=>{entered();await gate;return {trusted:true,binding,actor:'owner',source:'controlled-test',eventId:'test-gesture',occurredAt:new Date().toISOString()};});
 const decision=review.decide(f.expected,{id:pending.confirmation.id,decision:'approved',decidedBy:'owner',userGestureEvidence:'controlled-only'},{gestureBoundary:boundary});
 let replacement;
 try{
  await ready;await access(f.config.proposalConfig.journalPath+'.pp-lock');await access(f.config.contractCustody.storeConfig.journalPath+'.pp-lock');
  replacement=f.replace();let replaced=false;replacement.then(()=>{replaced=true;},()=>{});
  await new Promise(r=>setImmediate(r));assert.equal(replaced,false);
 }finally{release();}
 assert.equal((await decision).confirmation.status,'approved');await replacement;
 assert.equal((await inspectConfirmations(f.config.confirmationPath))[0].status,'approved');
 await assert.rejects(review.withApprovedProposal(f.expected,pending.confirmation.id,()=>true),/STALE_HEAD/);
});
