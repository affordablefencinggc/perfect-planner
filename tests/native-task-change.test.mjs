import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {createNativeTaskDraftSubmission} from '../src/node/nativeTaskDraftSubmission.mjs';
import {createTaskLedgerAuthorityStore} from '../src/node/taskLedgerAuthorityStore.mjs';
const task=(title,file)=>({title,description:'Description',owner:'Display only',acceptance:'Required proof',recovery:'Preserve work',claims:[{path:file,access:'write'}],dependsOn:[],archived:false});
async function fixture(){const root=await mkdtemp(path.join(os.tmpdir(),'pp-task-change-'));const binding={projectId:'pp_task_change',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)};const proposalConfig={journalPath:path.join(root,'proposal.jsonl'),projectId:binding.projectId,rootIdentity:binding.rootIdentity};const config={proposalConfig,registeredBinding:async()=>binding};return {binding,config,api:createNativeTaskDraftSubmission(config),store:createTaskLedgerAuthorityStore(proposalConfig)};}
const change=(f,t,requestId,receipt)=>({binding:f.binding,request:{requestId,expectedRevision:receipt?.submitted.hostRevision??0,expectedHeadDigest:receipt?.submitted.headDigest??'GENESIS'},task:t,updatedAt:'2026-09-14T00:00:00.000Z'});
test('single-task proposals preserve other tasks and retry original parents after host restart',async()=>{
 const f=await fixture(),first=change(f,task('First','src/a.js'),'first');const one=await f.api.proposeTaskChange(first);
 const second=change(f,task('Second','src/b.js'),'second',one);const two=await f.api.proposeTaskChange(second);
 const current=await f.api.readProposal();const archived={...current.ledger.tasks[0],archived:true};const three=await f.api.proposeTaskChange(change(f,archived,'archive',two));
 const after=await f.api.readProposal();assert.deepEqual(after.ledger.tasks[1],current.ledger.tasks[1]);assert.equal(after.ledger.tasks[0].archived,true);
 const restarted=createNativeTaskDraftSubmission(f.config);const retry=await restarted.proposeTaskChange(second);assert.equal(retry.idempotent,true);assert.deepEqual(retry.submitted,two.submitted);assert.deepEqual(retry.observedHead,{hostRevision:three.submitted.hostRevision,headDigest:three.submitted.headDigest});assert.equal(retry.submittedMatchesObservedHead,false);assert.equal(retry.executionAuthorized,false);assert.equal((await f.store.inspect()).proposals.length,3);
 await assert.rejects(restarted.proposeTaskChange({...second,task:task('Changed same ID','src/b.js')}),/REQUEST_CONFLICT/);
});
test('competing task proposals never overwrite or silently rebase',async()=>{
 const f=await fixture();const results=await Promise.allSettled([f.api.proposeTaskChange(change(f,task('A','src/a.js'),'a')),f.api.proposeTaskChange(change(f,task('B','src/b.js'),'b'))]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.match(results.find(r=>r.status==='rejected').reason.message,/STALE_HEAD/);assert.equal((await f.store.inspect()).proposals.length,1);
});
test('new file and dependency conflicts are refused without saving partial changes',async()=>{
 const f=await fixture();const one=await f.api.proposeTaskChange(change(f,task('A','src/a.js'),'a'));
 await assert.rejects(f.api.proposeTaskChange(change(f,task('Overlap','src/a.js'),'overlap',one)),/DRAFT_TASK_CHANGE_CONFLICT/);
 const two=await f.api.proposeTaskChange(change(f,{...task('B','src/b.js'),dependsOn:['T0001']},'b',one));
 const current=await f.api.readProposal();await assert.rejects(f.api.proposeTaskChange(change(f,{...current.ledger.tasks[0],dependsOn:['T0002']},'cycle',two)),/DRAFT_TASK_CHANGE_CONFLICT/);
 await assert.rejects(f.api.proposeTaskChange(change(f,{...current.ledger.tasks[0],archived:true},'archive-required',two)),/DRAFT_TASK_CHANGE_CONFLICT/);
 assert.equal((await f.store.inspect()).proposals.length,2);
});
test('foreign binding, invented authority, invalid parent and missing task are refused',async()=>{
 const f=await fixture(),input=change(f,task('A','src/a.js'),'a');
 for(const bad of [{...input,binding:{...f.binding,censusDigest:'c'.repeat(64)}},{...input,approved:true},{...input,task:{...input.task,status:'complete'}},{...input,task:{...input.task,id:'T0999'}},{...input,updatedAt:'yesterday'},{...input,request:{...input.request,expectedRevision:1,expectedHeadDigest:'d'.repeat(64)}}])await assert.rejects(f.api.proposeTaskChange(bad));
 assert.equal((await f.store.inspect()).proposals.length,0);
});
test('explicit dependency order admits sequential file work, removing the order is refused',async()=>{
 const f=await fixture();const one=await f.api.proposeTaskChange(change(f,task('First','src/shared.js'),'first'));
 const two=await f.api.proposeTaskChange(change(f,{...task('Then','src/shared.js'),dependsOn:['T0001']},'then',one));
 assert.equal(two.executionAuthorized,false);assert.equal(two.approvalState,'unapproved-proposal');
 const current=await f.api.readProposal();await assert.rejects(f.api.proposeTaskChange(change(f,{...current.ledger.tasks[1],dependsOn:[]},'remove-order',two)),/DRAFT_TASK_CHANGE_CONFLICT/);
 assert.equal((await f.store.inspect()).proposals.length,2);
});
