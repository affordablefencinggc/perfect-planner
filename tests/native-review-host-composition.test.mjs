import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {PassThrough} from 'node:stream';
import {createNativeReviewHostComposition} from '../src/node/nativeReviewHostComposition.mjs';
import {createTaskCheckContract} from '../src/node/taskCheckContract.mjs';
import {createTaskCheckContractStore} from '../src/node/taskCheckContractStore.mjs';
import {createTaskLedgerAuthorityStore} from '../src/node/taskLedgerAuthorityStore.mjs';
import {createNativeReviewPresentationStore} from '../src/node/nativeReviewPresentationStore.mjs';
import {inspectConfirmations} from '../src/node/confirmationStore.mjs';
import {emptyTaskDraftLedger,updateTaskDraft} from '../src/project/taskDraftLedger.js';
async function fixture(){const root=await mkdtemp(path.join(os.tmpdir(),'pp-host-composition-'));const binding={projectId:'pp_composition',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)};const proposalConfig={journalPath:path.join(root,'proposals.jsonl'),projectId:binding.projectId,rootIdentity:binding.rootIdentity};const ledger=updateTaskDraft(emptyTaskDraftLedger(binding),{title:'Retain exact task',description:'Scope',owner:'Owner',acceptance:'Verify',recovery:'Preserve',claims:[],dependsOn:[],archived:false});return {root,binding,proposalConfig,confirmationPath:path.join(root,'confirmations.json'),actor:'Danie',source:'configured-native-host',presenterConfig:{executable:path.join(root,'missing-native-helper.exe'),executableDigest:'c'.repeat(64),cwd:root},registeredBinding:async()=>binding,ledger};}
const wire=(command,payload={},requestId=command)=>JSON.stringify({version:1,command,payload,requestId})+'\n';
test('composed host forwards check inspection without preparing or authorizing execution',async()=>{
 const f=await fixture();let reads=0,writes=0;
 const checkPreparation={prepareChecks:async()=>{writes++;throw Error('unexpected preparation');},inspectChecks:async payload=>{
  assert.equal(this,undefined);assert.deepEqual(payload,{requestId:null});reads++;
  return {schemaVersion:1,binding:f.binding,contractHead:{revision:0,headDigest:'GENESIS'},requestedOriginalId:null,original:null,registrationLeaseHeld:false,executionAuthorized:false};
 }};
 const host=createNativeReviewHostComposition({...f,checkPreparation});
 const reply=JSON.parse(await host.dispatchLine(wire('inspect-checks',{requestId:null})));
 assert.equal(reply.ok,true);assert.equal(reply.result.contractHead.revision,0);assert.equal(reply.result.executionAuthorized,false);
 assert.equal(reads,1);assert.equal(writes,0);await host.shutdown();
 assert.equal(JSON.parse(await host.dispatchLine(wire('inspect-checks',{requestId:null}))).ok,false);assert.equal(reads,1);
});
async function submit(host,f){return JSON.parse(await host.dispatchLine(wire('submit-draft',{ledger:f.ledger,request:{requestId:'submit-1',expectedRevision:0,expectedHeadDigest:'GENESIS'}})));}
function contract(f){return createTaskCheckContract({schemaVersion:1,kind:'TASK_CHECK_CONTRACT',projectId:f.binding.projectId,rootIdentity:f.binding.rootIdentity,policyVersion:1,policyDigest:'d'.repeat(64),tasks:[{taskId:'T0001',checks:[{checkId:'unit',executablePath:process.execPath,executableDigest:'e'.repeat(64),args:['--version'],cwd:'.',timeoutMs:1000,outputLimits:{stdoutBytes:1000,stderrBytes:1000,combinedBytes:2000}}]}]});}
test('native composition refuses saved check-head replacement before creating confirmation',async()=>{
 const f=await fixture(),seed=createNativeReviewHostComposition(f);
 const saved=await submit(seed,f);await seed.shutdown();const expected={hostRevision:saved.result.submitted.hostRevision,headDigest:saved.result.submitted.headDigest};
 const checkContract=contract(f),storeConfig={journalPath:path.join(f.root,'checks.jsonl'),proposalConfig:f.proposalConfig,registeredBinding:f.registeredBinding,actor:f.actor,source:f.source};
 const custody=createTaskCheckContractStore(storeConfig),first=await custody.retain(expected,checkContract,{requestId:'checks-1',expectedRevision:0,expectedHeadDigest:'GENESIS'});
 const host=createNativeReviewHostComposition({...f,checkContract,contractCustody:{storeConfig,expectedHead:{revision:1,headDigest:first.record.recordHash}}});
 // Advance custody using the same content: the exact revision, not only the
 // contract digest, must be honoured by the composed native review path.
 await custody.retain(expected,checkContract,{requestId:'checks-2',expectedRevision:1,expectedHeadDigest:first.record.recordHash});
 const result=JSON.parse(await host.dispatchLine(wire('review-proposal',{expected})));
 assert.equal(result.ok,false);assert.equal(result.executionAuthorized,false);
 assert.deepEqual(await inspectConfirmations(f.confirmationPath),[]);
 assert.equal((await newCreatePresentation(f).inspect()).unresolved,null);
 assert.equal((await host.shutdown()).cleanupComplete,true);
});
function newCreatePresentation(f){return createNativeReviewPresentationStore({journalPath:`${f.confirmationPath}.presentations.jsonl`,projectId:f.binding.projectId,rootIdentity:f.binding.rootIdentity});}
test('native composition refuses custody without checks or foreign proposal storage',async()=>{
 const f=await fixture();assert.throws(()=>createNativeReviewHostComposition({...f,contractCustody:{}}),/CUSTODY_WITHOUT_CONTRACT/);
 assert.throws(()=>createNativeReviewHostComposition({...f,checkContract:contract(f),contractCustody:{expectedHead:{revision:1,headDigest:'f'.repeat(64)},storeConfig:{proposalConfig:{...f.proposalConfig,journalPath:path.join(f.root,'foreign.jsonl')},registeredBinding:f.registeredBinding}}}),/CUSTODY_INVALID/);
});
for(const command of ['submit-draft','propose-task-change'])test(`shutdown drains admitted ${command} and prevents late writes`,async()=>{
 const f=await fixture();let enter,release,observed=0;
 const started=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
 const host=createNativeReviewHostComposition({...f,registeredBinding:async()=>{if(++observed===1){enter();await gate;}return f.binding;}});
 const request={requestId:'drained-original',expectedRevision:0,expectedHeadDigest:'GENESIS'};
 const payload=command==='submit-draft'?{ledger:f.ledger,request}:{binding:f.binding,request,task:{...f.ledger.tasks[0],id:undefined},updatedAt:f.ledger.updatedAt};
 const pending=host.dispatchLine(wire(command,payload,'in-flight'));await started;
 let settled=false;const closing=host.shutdown().then(result=>{settled=true;return result;});
 // Event-loop boundary, not a timing estimate: registration remains held.
 await new Promise(r=>setImmediate(r));assert.equal(settled,false);
 assert.equal(JSON.parse(await host.dispatchLine(wire(command,payload,'late'))).error.code,'NATIVE_COMPOSITION_STOPPED');
 release();const saved=JSON.parse(await pending);assert.equal(saved.ok,true);assert.equal(saved.result.executionAuthorized,false);
 assert.equal((await closing).cleanupComplete,true);
 const store=createTaskLedgerAuthorityStore(f.proposalConfig);assert.equal((await store.inspect()).proposals.length,1);
 const replacement=createNativeReviewHostComposition(f);const retry=JSON.parse(await replacement.dispatchLine(wire(command,payload,'reconcile')));
 assert.equal(retry.ok,true);assert.equal(retry.result.idempotent,true);assert.deepEqual(retry.result.submitted,saved.result.submitted);await replacement.shutdown();
});
test('failed admitted proposal settles before shutdown without fabricating a save',async()=>{
 const f=await fixture();let enter,release;
 const started=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
 const host=createNativeReviewHostComposition({...f,registeredBinding:async()=>{enter();await gate;throw Error('registration offline');}});
 const pending=submit(host,f);await started;let settled=false;const closing=host.shutdown().then(v=>{settled=true;return v;});
 await new Promise(r=>setImmediate(r));assert.equal(settled,false);release();assert.equal((await pending).ok,false);assert.equal((await closing).cleanupComplete,true);
 assert.equal((await createTaskLedgerAuthorityStore(f.proposalConfig).inspect()).proposals.length,0);
});
test('stream disconnect after append reports uncertainty and suppresses late reply without losing proposal',async()=>{
 const f=await fixture();const store=createTaskLedgerAuthorityStore(f.proposalConfig);let enter,release;
 const started=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
 const host=createNativeReviewHostComposition({...f,registeredBinding:async()=>{if((await store.inspect()).proposals.length){enter();await gate;}return f.binding;}});
 const input=new PassThrough(),output=new PassThrough();let replies=0;output.on('data',()=>replies++);
 const stream=host.attach({input,output}),done=stream.start();
 const request={requestId:'lost-stream-original',expectedRevision:0,expectedHeadDigest:'GENESIS'};
 input.write(wire('submit-draft',{ledger:f.ledger,request}));await started;input.end();
 const stopped=await done;assert.equal(stopped.transportStopped,true);assert.equal(stopped.cleanupComplete,false);assert.equal(stopped.shutdownSettled,false);assert.equal(stopped.dispatchesSettled,false);assert.equal(replies,0);
 release();assert.equal((await host.shutdown()).cleanupComplete,true);await new Promise(r=>setImmediate(r));assert.equal(replies,0);
 const replacement=createNativeReviewHostComposition(f);const retry=JSON.parse(await replacement.dispatchLine(wire('submit-draft',{ledger:f.ledger,request},'retry')));
 assert.equal(retry.ok,true);assert.equal(retry.result.idempotent,true);assert.equal((await store.inspect()).proposals.length,1);await replacement.shutdown();
});
test('submission works without checks while review explicitly refuses missing configuration',async()=>{const f=await fixture();const host=createNativeReviewHostComposition(f);const before=JSON.parse(await host.dispatchLine(wire('inspect-proposal')));assert.equal(before.ok,true);const saved=await submit(host,f);assert.equal(saved.ok,true);const expected=saved.result.submitted;const result=JSON.parse(await host.dispatchLine(wire('review-proposal',{expected:{hostRevision:expected.hostRevision,headDigest:expected.headDigest}})));assert.equal(result.ok,false);assert.equal(result.error.code,'CHECKS_NOT_CONFIGURED');assert.equal((await createTaskLedgerAuthorityStore(f.proposalConfig).inspect()).proposals.length,1);});
test('configured review refuses changed census before invoking nonexistent helper',async()=>{const f=await fixture();let binding=f.binding;const host=createNativeReviewHostComposition({...f,checkContract:contract(f),registeredBinding:async()=>binding});const saved=await submit(host,f);binding={...binding,censusDigest:'f'.repeat(64)};const head=saved.result.submitted;const result=JSON.parse(await host.dispatchLine(wire('review-proposal',{expected:{hostRevision:head.hostRevision,headDigest:head.headDigest}})));assert.equal(result.ok,false);assert.equal(result.executionAuthorized,false);const recovery=JSON.parse(await host.dispatchLine(wire('inspect-recovery')));assert.equal(recovery.result.unresolvedPresentation,null);});
test('factory rejects execution override and changed renderer paths never configure host',async()=>{const f=await fixture();assert.throws(()=>createNativeReviewHostComposition({...f,presenterConfig:{...f.presenterConfig,execute:async()=>{}}}),/PRESENTER_INVALID/);assert.throws(()=>createNativeReviewHostComposition({...f,presenterConfig:{...f.presenterConfig,compilationTempRoot:f.root}}),/PRESENTER_INVALID/);const host=createNativeReviewHostComposition(f);assert.equal(JSON.parse(await host.dispatchLine(wire('submit-draft',{ledger:f.ledger,request:{requestId:'x',expectedRevision:0,expectedHeadDigest:'GENESIS'},proposalConfig:{}}))).ok,false);});
test('idle shutdown is idempotent and prevents submissions without claiming a window was closed',async()=>{const f=await fixture();const host=createNativeReviewHostComposition(f);const first=await host.shutdown();assert.deepEqual(await host.shutdown(),first);assert.equal(first.cleanupComplete,true);assert.equal(first.dialogClosed,null);assert.equal((await submit(host,f)).ok,false);assert.equal((await createTaskLedgerAuthorityStore(f.proposalConfig).inspect()).proposals.length,0);});
test('actual stream carries submission and stops on disconnect',async()=>{const f=await fixture();const host=createNativeReviewHostComposition(f);const input=new PassThrough(),output=new PassThrough();const stream=host.attach({input,output});const response=new Promise(resolve=>output.once('data',chunk=>resolve(JSON.parse(chunk.toString()))));const done=stream.start();input.write(wire('submit-draft',{ledger:f.ledger,request:{requestId:'stream-submit',expectedRevision:0,expectedHeadDigest:'GENESIS'}}));assert.equal((await response).ok,true);input.end();const ended=await done;assert.equal(ended.executionAuthorized,false);assert.equal(ended.dialogClosed,null);assert.throws(()=>host.attach({input:new PassThrough(),output:new PassThrough()}));});
test('retained unresolved native window prevents clean shutdown even with no active presenter',async()=>{const f=await fixture();const store=createNativeReviewPresentationStore({journalPath:`${f.confirmationPath}.presentations.jsonl`,projectId:f.binding.projectId,rootIdentity:f.binding.rootIdentity});await store.begin({projectId:f.binding.projectId,rootIdentity:f.binding.rootIdentity,requestId:'unresolved-1',proposalRevision:1,proposalDigest:'a'.repeat(64),checkContractDigest:'b'.repeat(64),source:f.source},{expectedRevision:0,operationId:'begin-unresolved'});const host=createNativeReviewHostComposition(f);const result=await host.shutdown();assert.equal(result.presenterSettled,true);assert.equal(result.cleanupComplete,false);assert.equal(result.dialogClosed,null);});
test('attached stream uses stopped dispatcher and cannot append after host shutdown',async()=>{const f=await fixture();const host=createNativeReviewHostComposition(f),input=new PassThrough(),output=new PassThrough();const stream=host.attach({input,output});const done=stream.start();await host.shutdown();const response=new Promise(resolve=>output.once('data',chunk=>resolve(JSON.parse(chunk.toString()))));input.write(wire('submit-draft',{ledger:f.ledger,request:{requestId:'late-submit',expectedRevision:0,expectedHeadDigest:'GENESIS'}}));assert.equal((await response).error.code,'NATIVE_COMPOSITION_STOPPED');input.end();await done;assert.equal((await createTaskLedgerAuthorityStore(f.proposalConfig).inspect()).proposals.length,0);});
test('shutdown during deferred registration cannot create a new confirmation afterward',async()=>{const f=await fixture();let hold=false,entered,release;const started=new Promise(resolve=>{entered=resolve;});const gate=new Promise(resolve=>{release=resolve;});const host=createNativeReviewHostComposition({...f,checkContract:contract(f),registeredBinding:async()=>{if(hold){entered();await gate;}return f.binding;}});const saved=await submit(host,f);hold=true;const head=saved.result.submitted;const pending=host.dispatchLine(wire('review-proposal',{expected:{hostRevision:head.hostRevision,headDigest:head.headDigest}}));await started;await host.shutdown();release();assert.equal(JSON.parse(await pending).ok,false);assert.deepEqual(await inspectConfirmations(f.confirmationPath),[]);const presentation=createNativeReviewPresentationStore({journalPath:`${f.confirmationPath}.presentations.jsonl`,projectId:f.binding.projectId,rootIdentity:f.binding.rootIdentity});assert.equal((await presentation.inspect()).unresolved,null);});

for(const clean of [true,false])test(`execution shutdown drains the admitted request and retains cleanup ${clean}`,async()=>{
 const f=await fixture();let enter,release,closed=0;const started=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
 const payload={requestId:'run-1',expected:{hostRevision:1,headDigest:'a'.repeat(64)},contractHead:{revision:1,headDigest:'b'.repeat(64)},confirmationId:'approved-1',taskId:'T0001',checkId:'unit',attemptId:'attempt-1',attemptNumber:1};
 const execute=async()=>{enter();await gate;return {schemaVersion:1,kind:'NATIVE_CHECK_EXECUTION_RECEIPT',requestId:payload.requestId,originalDigest:'c'.repeat(64),grantId:'11111111-1111-4111-8111-111111111111',runId:'22222222-2222-4222-8222-222222222222',intentDigest:'d'.repeat(64),artifactDigest:'e'.repeat(64),state:'result-recorded',cleanupComplete:true,executionAuthorized:false};};
 const host=createNativeReviewHostComposition({...f,executionRequests:{execute,recover:execute,shutdown:async()=>{closed++;return {cleanupComplete:clean};}}});
 const pending=host.dispatchLine(wire('execute-check',payload));await started;let settled=false;const stopping=host.shutdown().then(value=>{settled=true;return value;});await new Promise(r=>setImmediate(r));assert.equal(settled,false);assert.equal(closed,0);
 assert.equal(JSON.parse(await host.dispatchLine(wire('execute-check',payload,'late'))).ok,false);release();assert.equal(JSON.parse(await pending).ok,true);assert.equal((await stopping).cleanupComplete,clean);assert.equal(closed,1);await host.shutdown();assert.equal(closed,1);
});
