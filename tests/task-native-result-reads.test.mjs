import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskNativeResultReads} from '../src/node/taskNativeResultReads.mjs';
function fixture(){
 const intent={kind:'TASK_EXECUTION_INTENT_RECEIPT',projectId:'pp_fixture',rootIdentity:'a'.repeat(64),runId:'run-original',recordDigest:'b'.repeat(64),grantId:'grant-original',binding:{taskId:'T0001',checkId:'unit',attemptId:'attempt1',attemptNumber:1,workerId:'worker1'},executionAuthorized:false};
 const saved={receipt:{schemaVersion:1,kind:'NATIVE_TASK_OBSERVATION_RECEIPT',projectId:intent.projectId,rootIdentity:intent.rootIdentity,runId:intent.runId,intentDigest:intent.recordDigest,artifactDigest:'c'.repeat(64),state:'result-unverified',executionAuthorized:false},observation:{schemaVersion:1,kind:'NATIVE_TASK_OBSERVATION',runId:intent.runId,exitCode:7,timedOut:false,cancelObserved:false,outputTruncated:false,cpuTimeExceeded:false,cpuObservationFailed:false,processExited:true,jobEmptyObserved:true,ioSettled:true,ioFailed:false,stdout:'sensitive captured text',stderr:'more private text'}};
 let authCalls=0,reads=0;
 const review={inspectOwnGrantReceipt:async()=>{authCalls++;return {intentReceipt:structuredClone(intent)};}};
 const observations={inspect:async value=>{reads++;assert.deepEqual(value,intent);return structuredClone(saved);}};
 return {intent,saved,review,observations,counts:()=>({authCalls,reads})};
}
test('authenticated summary names observed failure without leaking raw output or granting success',async()=>{
 const f=fixture(),reader=createTaskNativeResultReads(f),r=await reader.readOwn({credentials:{token:'private-token'}});
 assert.deepEqual(f.counts(),{authCalls:2,reads:1});assert.equal(r.state,'failure-observed');assert.deepEqual(r.failureReasons,['nonzero-exit']);assert.equal(r.process.exitCode,7);assert.equal(r.taskId,'T0001');assert.equal(r.cause,'unknown');assert.equal(r.cleanup,'unknown');assert.equal(r.authorityVerified,false);
 assert.equal(JSON.stringify(r).includes('private'),false);assert.equal(JSON.stringify(r).includes('sensitive'),false);assert.ok(Object.isFrozen(r.process));
 f.saved.observation.exitCode=0;assert.equal((await reader.readOwn({})).state,'result-unverified');
 f.saved.observation.timedOut=true;assert.deepEqual((await reader.readOwn({})).failureReasons,['time-limit']);
});
test('authentication failure prevents disk access and revalidation refuses revoked reads',async()=>{
 const f=fixture();f.review.inspectOwnGrantReceipt=async()=>{throw Error('revoked');};await assert.rejects(createTaskNativeResultReads(f).readOwn({}),/revoked/);assert.equal(f.counts().reads,0);
 const g=fixture();let n=0;g.review.inspectOwnGrantReceipt=async()=>{if(++n===2)throw Error('revoked during read');return {intentReceipt:g.intent};};await assert.rejects(createTaskNativeResultReads(g).readOwn({}),/revoked during read/);
});
test('foreign, malformed, changed or absent result identity refuses historical read',async()=>{
 for(const field of ['projectId','rootIdentity','runId','intentDigest','artifactDigest']){const f=fixture();f.saved.receipt[field]='wrong';await assert.rejects(createTaskNativeResultReads(f).readOwn({}),/UNAVAILABLE/);}
 const g=fixture();g.saved.observation.runId='wrong';await assert.rejects(createTaskNativeResultReads(g).readOwn({}),/MISMATCH/);
 const h=fixture();let n=0;h.review.inspectOwnGrantReceipt=async()=>({intentReceipt:{...h.intent,recordDigest:++n===2?'d'.repeat(64):h.intent.recordDigest}});await assert.rejects(createTaskNativeResultReads(h).readOwn({}),/UNAVAILABLE/);
 const j=fixture();j.review.inspectOwnGrantReceipt=async()=>({intentReceipt:null});await assert.rejects(createTaskNativeResultReads(j).readOwn({}),/UNAVAILABLE/);assert.equal(j.counts().reads,0);
});
