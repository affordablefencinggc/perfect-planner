import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createInstalledTaskExecutionCustody} from '../src/node/installedTaskExecutionCustody.mjs';
import {createTaskLedgerAuthorityStore} from '../src/node/taskLedgerAuthorityStore.mjs';
import {createTaskCheckContract} from '../src/node/taskCheckContract.mjs';
import {createTaskProposalReview} from '../src/node/taskProposalReview.mjs';
import {createTrustedUserGestureProducer} from '../src/node/confirmationStore.mjs';
import {emptyTaskDraftLedger,updateTaskDraft} from '../src/project/taskDraftLedger.js';

// Real disk-backed stores; synthetic retained observations, not native execution.
async function fixture(){
 assert.equal(os.hostname().toLowerCase(),'dans1');
 const root=await mkdtemp(path.join(os.tmpdir(),'pp-coverage-'));
 const binding={projectId:'pp_coverage',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)};
 let hook=async()=>{},calls=0;
 const c=createInstalledTaskExecutionCustody({stateDirectory:root,binding,observeBinding:async()=>{await hook(++calls);return binding;}});
 await mkdir(path.join(root,`${binding.projectId}.native-observations`));
 const proposalConfig={journalPath:path.join(root,'proposal.jsonl'),projectId:binding.projectId,rootIdentity:binding.rootIdentity},confirmationPath=path.join(root,'confirmation.json');
 const ledger=updateTaskDraft(emptyTaskDraftLedger(binding),{title:'Coverage',description:'Controlled stores',owner:'Owner',acceptance:'All checks',recovery:'Preserve evidence',claims:[],dependsOn:[],archived:false});
 const proposed=await createTaskLedgerAuthorityStore(proposalConfig).propose(ledger,{requestId:'proposal',expectedRevision:0,expectedHeadDigest:'GENESIS'});
 const expected={hostRevision:1,headDigest:proposed.proposal.recordHash};
 const contract=createTaskCheckContract({schemaVersion:1,kind:'TASK_CHECK_CONTRACT',projectId:binding.projectId,rootIdentity:binding.rootIdentity,policyVersion:1,policyDigest:'c'.repeat(64),tasks:[{taskId:'T0001',checks:['a','b','c'].map(checkId=>({checkId,executablePath:process.execPath,executableDigest:'d'.repeat(64),args:[],cwd:'.',timeoutMs:1000,outputLimits:{stdoutBytes:100,stderrBytes:100,combinedBytes:200}}))}]});
 const review=createTaskProposalReview({proposalConfig,confirmationPath,checkContract:contract});
 const {confirmation}=await review.request(expected,{requestedBy:'fixture',question:'Approve controlled store test'});
 const producer=createTrustedUserGestureProducer({source:'controlled-coverage-test'});
 await review.decide(expected,{id:confirmation.id,decision:'approved',decidedBy:'Fixture',userGestureEvidence:producer.capture({isTrusted:true},'Fixture',{request:confirmation,decision:'approved'})},{gestureBoundary:producer.boundary});
 const owner=c.createExecution({proposalConfig,confirmationPath,checkContract:contract,registeredRoot:root,actor:'fixture',nativeConfig:{executable:process.execPath,executableDigest:'d'.repeat(64),cwd:root,compilationTempRoot:path.join(root,'compile')}});
 const credentials=await owner.createWorker('coverage fixture');
 const {enrollment}=await owner.enroll(expected,confirmation.id,[{taskId:'T0001',workerId:'worker',credentials}],{expectedRevision:0,requestId:'enroll'});
 let sequence=0;
 async function retain(checkId,{exitCode=0,provisional=false,override={}}={}){
  const manifest={schemaVersion:2,index:override.candidateDigest??'e'.repeat(64),entries:[]};
  const candidateDigest=createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  const bound={proposalRevision:1,proposalDigest:expected.headDigest,checkContractDigest:contract.contractDigest,enrollmentEpoch:enrollment.epoch,taskId:'T0001',checkId,attemptId:'attempt',attemptNumber:1,workerId:'worker',sessionId:credentials.id,candidateSchemaVersion:2,candidateDigest:'e'.repeat(64),policyVersion:1,policyDigest:contract.policyDigest,...override};
  bound.candidateDigest=candidateDigest;
  const revision=(await c.grants.inspect()).revision,request=++sequence;
  const {grant}=await c.grants.issue(bound,{requestId:`issue${request}`,expectedRevision:revision,ttlMs:300000});
  const consumed=await c.grants.consume(bound,{grantId:grant.grantId,requestId:`consume${request}`,expectedRevision:revision+1});
  const {intentReceipt}=await c.grants.recordExecutionIntent(consumed.consumptionReceipt,{grantId:grant.grantId,requestId:`intent${request}`,expectedRevision:revision+2});
  const executionSpec={runId:intentReceipt.runId,intentDigest:intentReceipt.recordDigest,candidateDigest:bound.candidateDigest,checkContractDigest:bound.checkContractDigest,outputLimits:{stdoutBytes:100,stderrBytes:100,combinedBytes:200}};
  const observation={schemaVersion:2,kind:'NATIVE_TASK_OBSERVATION',runId:intentReceipt.runId,exitCode,timedOut:false,cancelObserved:false,outputTruncated:false,cpuTimeExceeded:false,cpuObservationFailed:false,processExited:true,jobEmptyObserved:true,descendantsSettled:true,ioSettled:true,ioFailed:false,stdout:'fixture',stderr:''};
  const candidate=await c.custody.retainCandidate({intentReceipt,executionSpec,manifest});
  const receipt=await c.custody.retainProvisional({intentReceipt,executionSpec,observation,candidateManifestDigest:candidate.artifactDigest});
  if(!provisional)await c.custody.finalize({intentReceipt,finalization:{schemaVersion:2,kind:'NATIVE_TASK_GUARD_FINALIZED',runId:intentReceipt.runId,intentDigest:intentReceipt.recordDigest,candidateDigest:bound.candidateDigest,checkContractDigest:bound.checkContractDigest,artifactDigest:receipt.artifactDigest,executionAuthorized:false}});
  return {grantId:grant.grantId,intentReceipt};
 }
 return {root,c,owner,retain,confirmationPath,query:grantId=>({expected,confirmationId:confirmation.id,grantId}),arm:value=>{calls=0;hook=value;}};
}
test('coverage preserves failed, missing and provisional checks independently',async()=>{
 const f=await fixture(),a=await f.retain('a',{exitCode:7});await f.retain('b',{provisional:true});
 const result=await f.owner.inspectAttempt(f.query(a.grantId));assert.deepEqual(result.failed,['a']);assert.deepEqual(result.unresolved,['b']);assert.deepEqual(result.missing,['c']);assert.equal(result.allRequiredChecksPassed,false);assert.equal(result.authorityVerified,false);
});
test('all observed checks may pass without acquiring verification or promotion authority',async()=>{
 const f=await fixture(),a=await f.retain('a');await f.retain('b');await f.retain('c');
 const result=await f.owner.inspectAttempt(f.query(a.grantId));assert.equal(result.allRequiredChecksPassed,true);assert.equal(result.authorityVerified,false);assert.equal(result.promotionAuthority,false);assert.equal(result.executionAuthorized,false);
});
test('unknown exit code remains unresolved even when process settlement is observed',async()=>{
 const f=await fixture(),a=await f.retain('a',{exitCode:null});await f.retain('b');await f.retain('c');
 const result=await f.owner.inspectAttempt(f.query(a.grantId));assert.deepEqual(result.unresolved,['a']);assert.equal(result.checks[0].state,'unresolved');assert.equal(result.allRequiredChecksPassed,false);
});
test('another retry cannot supply the missing checks of the selected attempt',async()=>{
 const f=await fixture(),a=await f.retain('a');
 for(const check of ['b','c'])await f.retain(check,{override:{attemptId:'retry',attemptNumber:2,candidateDigest:'f'.repeat(64)}});
 const result=await f.owner.inspectAttempt(f.query(a.grantId));assert.deepEqual(result.missing,['b','c']);assert.equal(result.allRequiredChecksPassed,false);
});
test('duplicate grants and changed candidate, attempt number or proposal cannot be combined',async()=>{
 for(const override of [{checkId:'a'},{candidateDigest:'f'.repeat(64)},{attemptNumber:2},{proposalDigest:'f'.repeat(64)}]){
  const f=await fixture(),a=await f.retain('a');await assert.rejects(f.retain('b',{override}),/CHECK_ALREADY_ISSUED|ATTEMPT_BINDING_CONFLICT/);
  const result=await f.owner.inspectAttempt(f.query(a.grantId));assert.deepEqual(result.missing,['b','c']);assert.equal(result.allRequiredChecksPassed,false);
 }
});
test('a foreign enrollment is refused and damaged output stays unresolved',async()=>{
 const f=await fixture(),a=await f.retain('a',{override:{workerId:'foreign'}});await assert.rejects(f.owner.inspectAttempt(f.query(a.grantId)),/ENROLLMENT_MISMATCH/);
 const g=await fixture(),b=await g.retain('a');await writeFile(path.join(g.root,'pp_coverage.native-observations',b.intentReceipt.runId+'.json'),'partial');
 assert.deepEqual((await g.owner.inspectAttempt(g.query(b.grantId))).unresolved,['a']);
});
test('journal movement or approval withdrawal during artifact reads refuses stale coverage',async()=>{
 for(const change of ['journal','approval','approval-identity']){
  const f=await fixture(),a=await f.retain('a');
  f.arm(async count=>{if(count!==2)return;if(change==='journal')await f.retain('b');else{const saved=JSON.parse(await readFile(f.confirmationPath,'utf8'));if(change==='approval-identity')saved.requests[0].decidedAt='2020-01-01T00:00:00.000Z';else{saved.requests[0].status='rejected';saved.requests[0].decision='rejected';}await writeFile(f.confirmationPath,JSON.stringify(saved));}});
  await assert.rejects(f.owner.inspectAttempt(f.query(a.grantId)),change==='approval'?/APPROVAL_UNAVAILABLE/:/COVERAGE_STALE/);
 }
});
