import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeReviewHostProtocol} from '../src/node/nativeReviewHostProtocol.mjs';
import {createNativeReviewHostComposition} from '../src/node/nativeReviewHostComposition.mjs';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const flow={inspectRecoveryState:async()=>({unresolvedPresentation:null}),reviewProposal:async()=>{throw Error('CHECKS_NOT_CONFIGURED');},recoverFailedPresentation:async()=>({recovered:false}),recoverInterruptedRequest:async()=>{},cancelActiveReview:async()=>({cancelRequested:false,presenterSettled:true})};
const payload={expected:{hostRevision:1,headDigest:'a'.repeat(64)},request:{requestId:'original-1',expectedRevision:0,expectedHeadDigest:'GENESIS'}};
const encode=(p=payload,id='transport-1')=>JSON.stringify({version:1,requestId:id,command:'prepare-checks',payload:p});
const receipt=()=>({schemaVersion:1,profileId:'perfect-planner-checks-v1',originalRequestId:'original-1',contractDigest:'b'.repeat(64),policyDigest:'c'.repeat(64),contractHead:{revision:1,headDigest:'d'.repeat(64)},idempotent:false,matchesObservedContractHead:true,preparationPersisted:true,observationEvidencePersisted:true,reviewEnabled:false,toolchainVerified:false,candidateVerified:false,executionAuthorized:false,registrationLeaseHeld:false});
async function composed(prepareChecks){const root=await mkdtemp(path.join(os.tmpdir(),'pp-preparation-shutdown-'));return createNativeReviewHostComposition({proposalConfig:{journalPath:path.join(root,'proposal.jsonl'),projectId:'pp_preparation',rootIdentity:'a'.repeat(64)},confirmationPath:path.join(root,'confirmations.json'),registeredBinding:async()=>({projectId:'pp_preparation',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)}),presenterConfig:{executable:path.join(root,'unused.exe'),executableDigest:'c'.repeat(64),cwd:root},actor:'fixture',source:'fixture',checkPreparation:{prepareChecks}});}
test('composition shutdown waits both successful and failed active preparation',async()=>{
 for(const failure of [false,true]){let enter,release,settled=false;const started=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
  const host=await composed(async()=>{enter();await gate;if(failure)throw Error('write failed');return receipt();});
  const pending=host.dispatchLine(encode());await started;const shutdown=host.shutdown().then(result=>{settled=true;return result;});await Promise.resolve();await Promise.resolve();assert.equal(settled,false);
  release();assert.equal(JSON.parse(await pending).ok,!failure);assert.equal((await shutdown).cleanupComplete,true);assert.equal(JSON.parse(await host.dispatchLine(encode(payload,'late'))).ok,false);
 }
});
test('shutdown before preparation microtask prevents writes',async()=>{
 let calls=0;const host=await composed(async()=>{calls++;return receipt();});const pending=host.dispatchLine(encode());const shutdown=host.shutdown();assert.equal(JSON.parse(await pending).ok,false);await shutdown;assert.equal(calls,0);
});
test('preparation is explicit, captured, original-bound and never authorizes review',async()=>{
 let calls=0;const adapter={prepareChecks:async input=>{calls++;assert.ok(Object.isFrozen(input.request));return receipt();}};
 const host=createNativeReviewHostProtocol({flow,checkPreparation:adapter});assert.equal(calls,0);
 adapter.prepareChecks=()=>{throw Error('replaced');};
 const result=JSON.parse(await host.dispatchLine(encode()));assert.equal(result.ok,true);assert.equal(result.result.originalRequestId,'original-1');assert.equal(result.executionAuthorized,false);assert.equal(calls,1);
 assert.equal(JSON.parse(await host.dispatchLine(encode())).error.code,'PROTOCOL_DUPLICATE_REQUEST');
 const absent=createNativeReviewHostProtocol({flow});assert.equal(JSON.parse(await absent.dispatchLine(encode())).ok,false);
});
test('preparation refuses authority fields, invalid CAS and unsupported result data',async()=>{
 let calls=0;const host=createNativeReviewHostProtocol({flow,checkPreparation:{prepareChecks:async()=>{calls++;return receipt();}}});
 for(const p of [{...payload,commands:['npm']},{...payload,registeredRoot:'C:\\private'},{...payload,assignments:[]},{...payload,request:{...payload.request,expectedRevision:1}},{...payload,request:{...payload.request,expectedHeadDigest:'a'.repeat(64)}}])assert.equal(JSON.parse(await host.dispatchLine(encode(p))).ok,false);
 assert.equal(calls,0);
 for(const change of [{secret:'PRIVATE'},{executionAuthorized:true},{originalRequestId:'other'},{observationEvidencePersisted:false},{contractHead:{revision:0,headDigest:'GENESIS'}}]){
  const bad=createNativeReviewHostProtocol({flow,checkPreparation:{prepareChecks:async()=>({...receipt(),...change})}});
  const result=await bad.dispatchLine(encode());assert.equal(JSON.parse(result).ok,false);assert.equal(result.includes('PRIVATE'),false);
 }
});
test('in-flight preparation blocks replacements; failed reply permits original-ID retry in a fresh transport',async()=>{
 let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);let calls=0;
 const host=createNativeReviewHostProtocol({flow,checkPreparation:{prepareChecks:async()=>{calls++;entered();await gate;if(calls===1)throw Error('lost acknowledgement');return {...receipt(),idempotent:true};}}});
 const pending=host.dispatchLine(encode());await started;
 assert.equal(JSON.parse(await host.dispatchLine(encode(payload,'transport-2'))).error.code,'NATIVE_REVIEW_BUSY');release();assert.equal(JSON.parse(await pending).ok,false);
 assert.equal(JSON.parse(await host.dispatchLine(encode(payload,'transport-3'))).result.idempotent,true);
});
