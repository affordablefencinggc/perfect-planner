import {createHash} from 'node:crypto';
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readdir,readFile,writeFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {createNativeTaskExecutionRequests} from '../src/node/nativeTaskExecutionRequests.mjs';
async function fixture(mode='success'){
 assert.equal(process.env.COMPUTERNAME.toLowerCase(),'dans1');
 const root=await mkdtemp(path.join(os.tmpdir(),'pp-execution-request-')),directory=path.join(root,'requests');
 const request={requestId:'request-1',expected:{hostRevision:1,headDigest:'a'.repeat(64)},contractHead:{revision:1,headDigest:'b'.repeat(64)},confirmationId:'confirmation-1',taskId:'T0001',checkId:'unit',attemptId:'attempt-1',attemptNumber:1};
 let runs=0,workers=0,released=0;const grantId='11111111-1111-4111-8111-111111111111',runId='22222222-2222-4222-8222-222222222222';
 const owner={createWorker:async()=>{workers++;return {token:'private-fixture-only'};},inspectHeads:async()=>({enrollmentRevision:0,grantRevision:0}),
  enroll:async()=>({enrollment:{revision:1,epoch:1,recordHash:'c'.repeat(64)}}),issue:async()=>({grant:{grantId}}),consume:async()=>({consumptionReceipt:{grantId}}),
  dispatch:async()=>{runs++;if(mode==='lost')throw Error('NATIVE_TASK_DISPATCH_UNRESOLVED');return {dispatchObserved:true,intentReceipt:{runId,recordDigest:'d'.repeat(64)},observationReceipt:{artifactDigest:'e'.repeat(64)},observation:{schemaVersion:mode==='legacy'?1:2,descendantsSettled:mode!=='descendant-unknown',processExited:true,jobEmptyObserved:mode!=='unclean',ioSettled:true}};},releaseWorker:async()=>{released++;}};
 const config={directory,binding:{projectId:'pp_requests',rootIdentity:'f'.repeat(64),censusDigest:'a'.repeat(64)},selection:{expected:request.expected,contractHead:request.contractHead},owner};
 return {request,directory,config,api:createNativeTaskExecutionRequests(config),counts:()=>({runs,workers,released})};
}
test('exact retained execution survives reopening and never exposes worker secrets',async()=>{
 const f=await fixture();const first=await f.api.execute(f.request),second=await createNativeTaskExecutionRequests(f.config).execute(f.request);
 assert.deepEqual(second,first);assert.deepEqual(await f.api.recover(f.request),first);assert.deepEqual(f.counts(),{runs:1,workers:1,released:1});
 for(const name of await readdir(f.directory)){if(name.endsWith('.json'))assert.equal((await readFile(path.join(f.directory,name),'utf8')).includes('private-fixture-only'),false);}
 assert.equal(first.executionAuthorized,false);assert.equal(first.state,'result-recorded');
 const next=await f.api.execute({...f.request,requestId:'request-2',attemptId:'attempt-2',attemptNumber:2});assert.equal(next.requestId,'request-2');assert.equal(f.counts().runs,2);
});
test('lost result or unclean execution blocks original and replacement after reopening',async()=>{
 for(const mode of ['lost','unclean','descendant-unknown','legacy']){const f=await fixture(mode);await assert.rejects(f.api.execute(f.request));const reopened=createNativeTaskExecutionRequests(f.config);
  await assert.rejects(reopened.execute(f.request),/UNRESOLVED/);await assert.rejects(reopened.recover(f.request),/UNRESOLVED/);await assert.rejects(reopened.execute({...f.request,requestId:'replacement'}),/UNRESOLVED/);assert.equal(f.counts().runs,1);assert.equal(f.counts().released,1);
 }
});
test('changed original, selected contract and caller authority fields are refused',async()=>{
 const f=await fixture();await f.api.execute(f.request);
 await assert.rejects(f.api.execute({...f.request,attemptNumber:2}),/CONFLICT/);
 await assert.rejects(f.api.execute({...f.request,contractHead:{...f.request.contractHead,revision:2}}),/SELECTION_CHANGED/);
 await assert.rejects(f.api.execute({...f.request,credentials:{token:'untrusted'}}),/INVALID/);assert.equal(f.counts().runs,1);
});
test('corrupt retained result cannot trigger execution or recovery',async()=>{
 const f=await fixture();await f.api.execute(f.request);const name=(await readdir(f.directory)).find(n=>n.endsWith('.result.json'));await writeFile(path.join(f.directory,name),'damaged');
 await assert.rejects(f.api.execute(f.request));await assert.rejects(f.api.recover(f.request));assert.equal(f.counts().runs,1);
});
test('shutdown drains an admitted request and refuses later work',async()=>{
 const f=await fixture();let release,entered;
 const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;}),dispatch=f.config.owner.dispatch;
 f.config.owner.dispatch=async()=>{entered();await gate;return dispatch();};
 const active=f.api.execute(f.request);await started;let done=false;const shutdown=f.api.shutdown().then(value=>{done=true;return value;});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(done,false);assert.throws(()=>f.api.execute(f.request),/CLOSED/);
 release();await active;assert.equal((await shutdown).cleanupComplete,true);
 const failed=await fixture('lost');await assert.rejects(failed.api.execute(failed.request));assert.equal((await failed.api.shutdown()).cleanupComplete,false);
});

test('pre-grant recovery retains a not-started proof and never replays the old request',async()=>{
 const {createHash}=await import('node:crypto');const f=await fixture();
 const issue=f.config.owner.issue;f.config.owner.issue=async()=>{throw Error('controlled quota refusal');};
 await assert.rejects(f.api.execute(f.request),/quota/);assert.equal(f.counts().runs,0);
 const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
 f.config.owner.recoverStoredResult=async()=>{throw Error('No grant to recover');};
 f.config.owner.inspectNotStarted=async request=>({schemaVersion:1,kind:'NATIVE_CHECK_NOT_STARTED_PROOF',requestId:request.requestId,requestDigest:createHash('sha256').update(JSON.stringify(canonical(request))).digest('hex'),enrollmentDigest:'a'.repeat(64),grantRevision:0,grantHeadDigest:'GENESIS',sessionReleased:true,grantAbsent:true,launchObserved:false,executionAuthorized:false});
 const reopened=createNativeTaskExecutionRequests(f.config),receipt=await reopened.recover(f.request);
 assert.equal(receipt.state,'not-started');assert.equal(Object.hasOwn(receipt,'grantId'),false);
 assert.deepEqual(await reopened.execute(f.request),receipt);assert.equal(f.counts().runs,0);
 f.config.owner.issue=issue;await reopened.execute({...f.request,requestId:'new-explicit-attempt',attemptId:'attempt-2',attemptNumber:2});assert.equal(f.counts().runs,1);
 const proofFile=(await readdir(f.directory)).find(n=>n.endsWith('.not-started-proof.json'));
 await writeFile(path.join(f.directory,proofFile),'corrupt');await assert.rejects(createNativeTaskExecutionRequests(f.config).recover(f.request));assert.equal(f.counts().runs,1);
});

test('failed dispatch retains bounded private causes without changing replay authority',async()=>{
 const f=await fixture();
 f.config.owner.dispatch=async()=>{const hidden=Error('private-fixture-only C:/secret/path');hidden.cause=hidden;throw Error('NATIVE_TASK_DISPATCH_UNRESOLVED',{cause:Error('NATIVE_TASK_TRANSPORT_UNRESOLVED',{cause:hidden})});};
 await assert.rejects(f.api.execute(f.request),/NATIVE_TASK_DISPATCH_UNRESOLVED/);
 const names=await readdir(f.directory),name=names.find(n=>n.endsWith('.failure.json'));assert.ok(name);
 const bytes=await readFile(path.join(f.directory,name),'utf8'),diagnostic=JSON.parse(bytes);
 assert.equal(diagnostic.stage,'dispatch');assert.deepEqual(diagnostic.causes,['NATIVE_TASK_DISPATCH_UNRESOLVED','NATIVE_TASK_TRANSPORT_UNRESOLVED','UNCLASSIFIED']);
 assert.equal(bytes.includes('private-fixture-only'),false);assert.equal(bytes.includes('C:/secret'),false);assert.equal(diagnostic.cleanup,'unknown');assert.equal(diagnostic.executionAuthorized,false);assert.equal(diagnostic.recoveryAuthorized,false);
 assert.equal(names.some(n=>n.endsWith('.result.json')),false);
 const original=JSON.parse(await readFile(path.join(f.directory,names.find(n=>n.endsWith('.original.json'))),'utf8'));assert.equal(diagnostic.requestId,original.request.requestId);assert.equal(diagnostic.originalDigest,createHash('sha256').update(await readFile(path.join(f.directory,names.find(n=>n.endsWith('.original.json'))))).digest('hex'));
 const reopened=createNativeTaskExecutionRequests(f.config);await assert.rejects(reopened.execute(f.request),/UNRESOLVED/);await assert.rejects(reopened.recover(f.request),/UNRESOLVED/);
 assert.equal(await readFile(path.join(f.directory,name),'utf8'),bytes);assert.equal((await f.api.shutdown()).cleanupComplete,false);
});

test('diagnostic storage refusal remains unresolved and preserves the original failure',async()=>{
 const f=await fixture();f.config.owner.dispatch=async()=>{
  const key=createHash('sha256').update(f.request.requestId).digest('hex');await mkdir(path.join(f.directory,`${key}.failure.json`));throw Error('NATIVE_TASK_DISPATCH_UNRESOLVED');
 };
 await assert.rejects(f.api.execute(f.request),error=>error.message==='NATIVE_EXECUTION_DIAGNOSTIC_UNAVAILABLE'&&error.cause?.message==='NATIVE_TASK_DISPATCH_UNRESOLVED');
 const names=await readdir(f.directory);assert.ok(names.some(n=>n.endsWith('.original.json')));assert.equal(names.some(n=>n.endsWith('.result.json')),false);
 await assert.rejects(createNativeTaskExecutionRequests(f.config).execute(f.request),/UNRESOLVED/);assert.equal((await f.api.shutdown()).cleanupComplete,false);
});
