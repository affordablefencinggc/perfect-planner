import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createNativeReviewHostProtocol} from '../src/node/nativeReviewHostProtocol.mjs';
import {createNativeTaskDraftSubmission} from '../src/node/nativeTaskDraftSubmission.mjs';
const flow={inspectRecoveryState:async()=>({unresolvedPresentation:null}),reviewProposal:async()=>{throw Error('No review expected');},recoverFailedPresentation:async()=>({recovered:false}),recoverInterruptedRequest:async()=>{},cancelActiveReview:async()=>({cancelRequested:false,presenterSettled:true})};
const encode=(payload,requestId='transport-1')=>JSON.stringify({version:1,requestId,command:'propose-task-change',payload});
const call=async(protocol,payload,id)=>JSON.parse(await protocol.dispatchLine(encode(payload,id)));
const task=(title,file)=>({title,description:'Description',owner:'Display only',acceptance:'Proof required',recovery:'Preserve work',claims:[{path:file,access:'write'}],dependsOn:[],archived:false});
async function fixture(){
 const root=await mkdtemp(path.join(os.tmpdir(),'pp-task-protocol-'));
 const binding={projectId:'pp_protocol',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)};
 const config={proposalConfig:{journalPath:path.join(root,'proposals.jsonl'),projectId:binding.projectId,rootIdentity:binding.rootIdentity},registeredBinding:async()=>binding};
 const submission=createNativeTaskDraftSubmission(config);
 return {binding,config,submission,protocol:createNativeReviewHostProtocol({flow,submission}),input:{binding,request:{requestId:'original-change',expectedRevision:0,expectedHeadDigest:'GENESIS'},task:task('First','src/a.js'),updatedAt:'2026-09-14T00:00:00.000Z'}};
}
test('private task command writes the real journal and preserves original identity after host restart',async()=>{
 const f=await fixture();const first=await call(f.protocol,f.input);assert.equal(first.ok,true);assert.equal(first.executionAuthorized,false);assert.equal(first.nativeGestureVerified,false);assert.equal(first.result.approvalState,'unapproved-proposal');
 const next={...f.input,request:{requestId:'second-change',expectedRevision:1,expectedHeadDigest:first.result.submitted.headDigest},task:task('Second','src/b.js')};
 const second=await call(f.protocol,next,'transport-2');assert.equal(second.ok,true);
 const restarted=createNativeReviewHostProtocol({flow,submission:createNativeTaskDraftSubmission(f.config)});
 const retry=await call(restarted,f.input,'new-transport');assert.equal(retry.ok,true);assert.equal(retry.result.idempotent,true);assert.deepEqual(retry.result.submitted,first.result.submitted);assert.equal(retry.result.submittedMatchesObservedHead,false);assert.equal(retry.result.observedHead.hostRevision,2);
 assert.equal((await f.submission.readProposal()).ledger.tasks.length,2);
 assert.equal((await call(restarted,{...f.input,task:task('Altered','src/a.js')},'conflict')).error.code,'AGENT_TASK_INTENT_REQUEST_CONFLICT');
});
test('absent capability, malformed envelopes and foreign registration cannot write',async()=>{
 const f=await fixture();const absent=createNativeReviewHostProtocol({flow,submission:{inspectHead:f.submission.inspectHead,submitDraft:f.submission.submitDraft}});
 assert.equal((await call(absent,f.input)).error.code,'PROTOCOL_INVALID_REQUEST');
 const invalid=[{...f.input,approved:true},{...f.input,actor:'replacement'},{...f.input,request:{...f.input.request,expectedRevision:1}},{...f.input,binding:{...f.binding,registryPath:'C:/elsewhere'}},{...f.input,updatedAt:'yesterday'}];
 for(let i=0;i<invalid.length;i++)assert.equal((await call(f.protocol,invalid[i],`invalid-${i}`)).error.code,'PROTOCOL_INVALID_REQUEST');
 assert.equal(JSON.parse(await f.protocol.dispatchLine(encode(f.input).replace('"task":','"task":{},"task":'))).error.code,'PROTOCOL_INVALID_REQUEST');
 assert.equal((await call(f.protocol,{...f.input,binding:{...f.binding,censusDigest:'c'.repeat(64)}},'foreign')).error.code,'DRAFT_SUBMISSION_BINDING_MISMATCH');
 assert.equal((await call(f.protocol,{...f.input,task:{...f.input.task,executionAuthorized:true}},'invented')).ok,false);
 assert.equal((await f.submission.inspectHead()).observedHead.hostRevision,0);
});
test('known conflict is actionable, receipt is metadata only, stale changes do not overwrite',async()=>{
 const f=await fixture();const first=await call(f.protocol,f.input);
 const overlap={...f.input,request:{requestId:'overlap',expectedRevision:1,expectedHeadDigest:first.result.submitted.headDigest},task:task('Second','src/a.js')};
 assert.equal((await call(f.protocol,overlap,'overlap-frame')).error.code,'DRAFT_TASK_CHANGE_CONFLICT');
 assert.equal((await call(f.protocol,{...f.input,request:{...f.input.request,requestId:'stale'},task:task('Stale','src/b.js')},'stale-frame')).error.code,'TASK_LEDGER_STALE_HEAD');
 assert.equal((await f.submission.inspectHead()).observedHead.hostRevision,1);
 assert.equal(JSON.stringify(first.result).includes('Description'),false);
 assert.equal(JSON.stringify(first.result).includes('src/a.js'),false);
});
test('lost reply after actual append remains recoverable, not reported as no write',async()=>{
 const f=await fixture();const submission={...f.submission,proposeTaskChange:async input=>{await f.submission.proposeTaskChange(input);throw Error('PRIVATE adapter detail');}};
 const protocol=createNativeReviewHostProtocol({flow,submission});
 const failed=await call(protocol,f.input);assert.equal(failed.ok,false);assert.equal(failed.error.code,'NATIVE_REVIEW_HOST_FAILURE');assert.equal(JSON.stringify(failed).includes('PRIVATE'),false);
 // A failed transport response is not a rollback receipt. Reconcile the same original request.
 const retry=await call(f.protocol,f.input,'reconcile');assert.equal(retry.ok,true);assert.equal(retry.result.idempotent,true);assert.equal(retry.result.submitted.hostRevision,1);
});
