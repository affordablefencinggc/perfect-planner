import test from 'node:test';
import assert from 'node:assert/strict';
import fs,{readFile,writeFile,symlink,link} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {planningApprovalFixture} from './fixtures/planningApproval.mjs';
import {createPlanApprovalStore} from '../src/node/planApprovalStore.mjs';
import {createPlanApprovalDraft} from '../src/project/planApprovalDraft.js';
import {canonicalArchitectureJson as wire} from '../src/engine/architectureContractVerification.js';

async function fixture(t){const f=await planningApprovalFixture(t);return {...f,store:createPlanApprovalStore(f.config),journal:path.join(f.root,f.projectId,'plan-approval-withdrawals.jsonl'),approvalJournal:path.join(f.root,f.projectId,'plan-approvals.jsonl')};}
function resolution(f,original=f.publishInput){return {original,confirmation:{decision:'withdraw-if-unpublished',requestDigest:createHash('sha256').update(wire({...original,actor:f.config.actor,source:f.config.source})).digest('hex')}};}
function noGrants(receipt){for(const key of ['executionAuthorized','nativeApprovalAuthorized','filesystemVerified'])assert.equal(receipt[key],false);}

test('unpublished original withdrawal survives reopen and permanently refuses delayed publication',async t=>{
 const f=await fixture(t),input=resolution(f),result=await f.store.resolveOriginal(input);assert.equal(result.outcome,'withdrawn');assert.equal(result.idempotent,false);assert.equal(result.currentParentsChecked,false);assert.equal(result.planApprovalRecorded,false);noGrants(result);assert.deepEqual(result.record.original,f.publishInput);
 const reopened=createPlanApprovalStore(f.config),retry=await reopened.resolveOriginal(input);assert.equal(retry.idempotent,true);assert.deepEqual(retry.record,result.record);await assert.rejects(reopened.publish(f.publishInput),/PLAN_APPROVAL_REQUEST_WITHDRAWN/);assert.equal((await reopened.inspect()).records.length,0);
});

test('stale original can be withdrawn then a freshly reviewed ledger approved',async t=>{
 const f=await fixture(t),ledger=structuredClone(f.ledger);ledger.revision++;ledger.tasks[0].description+=' revised';const retained=await f.custody.submit({ledger,request:{requestId:'ledger-new',expectedRevision:f.expectedProposalHead.hostRevision,expectedHeadDigest:f.expectedProposalHead.headDigest},expectedCensusDigest:ledger.binding.censusDigest});
 await assert.rejects(f.store.publish(f.publishInput));assert.equal((await f.store.resolveOriginal(resolution(f))).outcome,'withdrawn');
 const proposal=await createPlanApprovalDraft({...f.draftInput,ledger}),fresh={...f.publishInput,proposal,expectedProposalHead:retained.observedHead,request:{...f.publishInput.request,requestId:'approval-new'},confirmation:{proposalDigest:proposal.digest,decision:'approve'}};const approved=await f.store.publish(fresh);assert.equal(approved.record.proposal.ledger.revision,2);noGrants(approved);await assert.rejects(f.store.publish(f.publishInput),/PLAN_APPROVAL_REQUEST_WITHDRAWN/);
});

test('publication and withdrawal race has one consistent outcome',async t=>{
 const f=await fixture(t),[publication,resolutionResult]=await Promise.allSettled([f.store.publish(f.publishInput),f.store.resolveOriginal(resolution(f))]);assert.equal(resolutionResult.status,'fulfilled');
 if(resolutionResult.value.outcome==='published'){assert.equal(publication.status,'fulfilled');assert.deepEqual(resolutionResult.value.receipt.record,publication.value.record);assert.equal((await f.store.inspect()).records.length,1);}
 else{assert.equal(resolutionResult.value.outcome,'withdrawn');assert.equal(publication.status,'rejected');assert.match(publication.reason.message,/PLAN_APPROVAL_REQUEST_WITHDRAWN/);assert.equal((await f.store.inspect()).records.length,0);}
});

test('simultaneous exact withdrawals produce one retained record',async t=>{
 const f=await fixture(t),results=await Promise.all([f.store.resolveOriginal(resolution(f)),f.store.resolveOriginal(resolution(f))]);assert.equal(results.filter(value=>value.idempotent).length,1);assert.deepEqual(results[0].record,results[1].record);assert.equal((await readFile(f.journal,'utf8')).trim().split('\n').length,1);
});

test('same request identifier with changed content conflicts after withdrawal',async t=>{
 const f=await fixture(t);await f.store.resolveOriginal(resolution(f));const changed=structuredClone(f.publishInput);changed.expectedProposalHead.hostRevision++;await assert.rejects(f.store.resolveOriginal(resolution(f,changed)),/PLAN_APPROVAL_REQUEST_CONFLICT/);await assert.rejects(f.store.publish(changed),/PLAN_APPROVAL_REQUEST_CONFLICT/);
});

test('withdrawal requires exact explicit confirmation and preserves bytes on refusal',async t=>{
 const f=await fixture(t);for(const confirmation of [null,{decision:'approve',requestDigest:resolution(f).confirmation.requestDigest},{decision:'withdraw-if-unpublished',requestDigest:'f'.repeat(64)}])await assert.rejects(f.store.resolveOriginal({original:f.publishInput,confirmation}));assert.equal((await f.store.inspect()).records.length,0);
});

test('published original resolution returns real idempotent receipt without withdrawing',async t=>{
 const f=await fixture(t),first=await f.store.publish(f.publishInput),result=await f.store.resolveOriginal(resolution(f));assert.equal(result.outcome,'published');assert.equal(result.receipt.idempotent,true);assert.equal(result.receipt.currentParentsChecked,false);assert.deepEqual(result.receipt.record,first.record);noGrants(result.receipt);assert.equal((await f.store.inspect()).records.length,1);
});

test('failed withdrawal flush requires exact retry reflush before confirmation',async t=>{
 const f=await fixture(t),actualOpen=fs.open;let failSync=true,syncCalls=0;const mocked=t.mock.method(fs,'open',async(...args)=>{const handle=await actualOpen(...args);if(args[0]===f.journal){const actualSync=handle.sync.bind(handle);handle.sync=async()=>{syncCalls++;if(failSync)throw Error('Controlled withdrawal sync failure');return actualSync();};}return handle;});syncBuiltinESMExports();
 try{await assert.rejects(f.store.resolveOriginal(resolution(f)),/Controlled withdrawal sync failure/);const bytes=await readFile(f.journal,'utf8');await assert.rejects(f.store.resolveOriginal(resolution(f)),/Controlled withdrawal sync failure/);assert.equal(await readFile(f.journal,'utf8'),bytes);failSync=false;const result=await f.store.resolveOriginal(resolution(f));assert.equal(result.idempotent,true);assert.equal(syncCalls,3);assert.equal(await readFile(f.journal,'utf8'),bytes);await assert.rejects(f.store.publish(f.publishInput),/PLAN_APPROVAL_REQUEST_WITHDRAWN/);}finally{mocked.mock.restore();syncBuiltinESMExports();}
});

test('published original resolution reflush failure cannot return a success receipt',async t=>{
 const f=await fixture(t);await f.store.publish(f.publishInput);const bytes=await readFile(f.approvalJournal,'utf8'),actualOpen=fs.open;let failSync=true,calls=0;const mocked=t.mock.method(fs,'open',async(...args)=>{const handle=await actualOpen(...args);if(args[0]===f.approvalJournal){const actualSync=handle.sync.bind(handle);handle.sync=async()=>{calls++;if(failSync)throw Error('Controlled published sync failure');return actualSync();};}return handle;});syncBuiltinESMExports();
 try{await assert.rejects(f.store.resolveOriginal(resolution(f)),/Controlled published sync failure/);failSync=false;const result=await f.store.resolveOriginal(resolution(f));assert.equal(result.outcome,'published');assert.equal(result.receipt.idempotent,true);assert.equal(calls,2);assert.equal(await readFile(f.approvalJournal,'utf8'),bytes);}finally{mocked.mock.restore();syncBuiltinESMExports();}
});

test('corrupt or partial withdrawal journal remains untouched and blocks delayed publication',async t=>{
 for(const partial of [false,true]){const f=await fixture(t);await f.store.resolveOriginal(resolution(f));const original=await readFile(f.journal,'utf8'),bytes=partial?original.slice(0,-8):original.replace('Retained archived task','Altered archived task');assert.notEqual(bytes,original);await writeFile(f.journal,bytes);await assert.rejects(f.store.resolveOriginal(resolution(f)));await assert.rejects(f.store.publish(f.publishInput));assert.equal(await readFile(f.journal,'utf8'),bytes);}
});

test('withdrawal quotas preserve original history',async t=>{
 const f=await fixture(t),limited=createPlanApprovalStore({...f.config,maxRecords:1});await limited.resolveOriginal(resolution(f));const bytes=await readFile(f.journal,'utf8'),other={...f.publishInput,request:{...f.publishInput.request,requestId:'second'}};await assert.rejects(limited.resolveOriginal(resolution(f,other)));assert.equal(await readFile(f.journal,'utf8'),bytes);
 const g=await fixture(t);await assert.rejects(createPlanApprovalStore({...g.config,maxBytes:1}).resolveOriginal(resolution(g)));assert.equal((await g.store.inspect()).records.length,0);
});

test('resolution snapshots the original and confirmation before asynchronous validation',async t=>{
 const f=await fixture(t),input=resolution(f),original=structuredClone(input),pending=f.store.resolveOriginal(input);input.original.request.requestId='changed-late';input.confirmation.decision='approve';const result=await pending;assert.equal(result.outcome,'withdrawn');assert.deepEqual(result.record.original,original.original);assert.deepEqual(result.record.confirmation,original.confirmation);noGrants(result);
});

test('withdrawal between first publication lookup and parent lock blocks final append',async t=>{
 const f=await fixture(t),actualMkdir=fs.mkdir;
 const parentLock=path.join(f.root,'contracts',createHash('sha256').update(`perfect-planner-architecture:${f.projectId}`).digest('hex'),'registry.pp-lock');
 let reached,release;const entered=new Promise(resolve=>reached=resolve),gate=new Promise(resolve=>release=resolve);
 const mocked=t.mock.method(fs,'mkdir',async(...args)=>{if(args[0]===parentLock){reached();await gate;}return actualMkdir(...args);});syncBuiltinESMExports();
 let publication;
 try{
  publication=f.store.publish(f.publishInput);const outcome=publication.then(value=>({value}),error=>({error}));
  await Promise.race([entered,outcome.then(()=>{throw Error('Publication finished before parent-lock checkpoint');})]);
  const withdrawn=await f.store.resolveOriginal(resolution(f));assert.equal(withdrawn.outcome,'withdrawn');release();
  const result=await outcome;assert.match(result.error?.message??'',/PLAN_APPROVAL_REQUEST_WITHDRAWN/);assert.equal((await f.store.inspect()).records.length,0);
 }finally{release();if(publication)await publication.catch(()=>{});mocked.mock.restore();syncBuiltinESMExports();}
});

test('linked and hardlinked withdrawal journals refuse all reads without changing target',async t=>{
 for(const kind of ['symbolic','hard']){
  const f=await fixture(t),target=path.join(f.root,`existing-${kind}.jsonl`),bytes='preserve target bytes\n';await writeFile(target,bytes);
  if(kind==='symbolic')await symlink(target,f.journal,'file');else await link(target,f.journal);
  await assert.rejects(f.store.resolveOriginal(resolution(f)),/PLAN_APPROVAL_UNSAFE_FILE/);await assert.rejects(f.store.publish(f.publishInput),/PLAN_APPROVAL_UNSAFE_FILE/);await assert.rejects(f.store.inspect(),/PLAN_APPROVAL_UNSAFE_FILE/);assert.equal(await readFile(target,'utf8'),bytes);
 }
});

test('corrupt withdrawal blocks historical and current approval inspection',async t=>{
 const f=await fixture(t),published=await f.store.publish(f.publishInput),other={...f.publishInput,request:{...f.publishInput.request,requestId:'withdraw-other'}};await f.store.resolveOriginal(resolution(f,other));const original=await readFile(f.journal,'utf8'),corrupt=original.slice(0,-4);await writeFile(f.journal,corrupt);
 await assert.rejects(f.store.inspect(),/PLAN_APPROVAL_CORRUPT/);await assert.rejects(f.store.inspectCurrent({expectedApprovalHead:published.observedApprovalHead}),/PLAN_APPROVAL_CORRUPT/);assert.equal(await readFile(f.journal,'utf8'),corrupt);assert.deepEqual(JSON.parse((await readFile(f.approvalJournal,'utf8')).trim()),published.record);
});
