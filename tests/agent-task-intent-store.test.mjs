import "./helpers/hermetic-env.mjs";
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,appendFile,link,mkdir} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createAgentTaskIntentStore} from '../src/node/agentTaskIntentStore.mjs';
import {createNativeTaskDraftSubmission} from '../src/node/nativeTaskDraftSubmission.mjs';
import {createTaskLedgerAuthorityStore} from '../src/node/taskLedgerAuthorityStore.mjs';
const task={title:'Original',description:'Exact description',owner:'Display only',acceptance:'Required proof',recovery:'Preserve work',claims:[{path:'src/a.js',access:'write'}],dependsOn:[],archived:false};
async function fixture(){const root=await mkdtemp(path.join(os.tmpdir(),'pp-agent-intent-'));const binding={projectId:'pp_agent_intent',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)};const proposalConfig={journalPath:path.join(root,'proposals.jsonl'),projectId:binding.projectId,rootIdentity:binding.rootIdentity};const file=`${proposalConfig.journalPath}.agent-intents.jsonl`,config={file,projectId:binding.projectId,rootIdentity:binding.rootIdentity};const original={binding,request:{requestId:'original-1',expectedRevision:0,expectedHeadDigest:'GENESIS'},task:structuredClone(task),updatedAt:'2026-09-14T00:00:00.000Z'};return {root,binding,proposalConfig,file,config,original,store:createAgentTaskIntentStore(config),submission:createNativeTaskDraftSubmission({proposalConfig,registeredBinding:async()=>binding})};}
test('exact originals survive reconstruction; retry flushes without duplicating or replacing',async()=>{
 const f=await fixture(),original=structuredClone(f.original);const pending=f.store.retain(f.original);f.original.task.title='mutated caller';const saved=await pending;
 assert.equal(saved.originalRetained,true);assert.equal(saved.executionAuthorized,false);assert.deepEqual(saved.record.original,original);assert.equal(Object.isFrozen(saved.record.original.task),true);
 const restarted=createAgentTaskIntentStore(f.config),retry=await restarted.retain(original);assert.equal(retry.idempotent,true);assert.deepEqual(retry.record,saved.record);assert.equal((await restarted.inspect()).records.length,1);
 await assert.rejects(restarted.retain(f.original),/REQUEST_CONFLICT/);assert.equal((await restarted.inspect()).records.length,1);
});
test('concurrent callers retain one exact original and refuse conflicting reuse',async()=>{
 const f=await fixture();const values=await Promise.all([f.store.retain(f.original),createAgentTaskIntentStore(f.config).retain(f.original)]);assert.equal(values.filter(v=>v.idempotent).length,1);
 const changed={...f.original,task:{...task,title:'Other'}};await assert.rejects(f.store.retain(changed),/REQUEST_CONFLICT/);assert.equal((await f.store.inspect()).records.length,1);
});
test('quota preserves originals and still permits exact retry',async()=>{
 const f=await fixture(),store=createAgentTaskIntentStore({...f.config,maxRecords:1});await store.retain(f.original);const before=await readFile(f.file);
 await assert.rejects(store.retain({...f.original,request:{...f.original.request,requestId:'second'}}),/QUOTA/);assert.deepEqual(await readFile(f.file),before);assert.equal((await store.retain(f.original)).idempotent,true);
});
test('partial, duplicate-key and linked files are refused without altering preserved bytes',async()=>{
 const f=await fixture();await f.store.retain(f.original);await appendFile(f.file,'{"partial":');const damaged=await readFile(f.file);await assert.rejects(f.store.retain(f.original),/CORRUPT/);assert.deepEqual(await readFile(f.file),damaged);
 const g=await fixture();await g.store.retain(g.original);const raw=await readFile(g.file,'utf8');await writeFile(g.file,raw.replace('"schemaVersion":1','"schemaVersion":1,"schemaVersion":1'));await assert.rejects(g.store.inspect(),/CORRUPT/);
 const h=await fixture();await h.store.retain(h.original);await link(h.file,path.join(h.root,'preserved-hardlink.jsonl'));await assert.rejects(h.store.retain(h.original),/UNSAFE_FILE/);
});
test('untrusted shape, foreign root and invented task authority cannot be retained',async()=>{
 const f=await fixture();for(const input of [{...f.original,approved:true},{...f.original,task:{...task,status:'complete'}},{...f.original,binding:{...f.binding,rootIdentity:'c'.repeat(64)}},{...f.original,task:{...task,claims:[{path:'../escape',access:'write'}]}}])await assert.rejects(f.store.retain(input));assert.equal((await f.store.inspect()).records.length,0);
});
test('native proposals retain exact original before append and recover it without auto-submission',async()=>{
 const f=await fixture();const receipt=await f.submission.proposeTaskChange(f.original);const host=createNativeTaskDraftSubmission({proposalConfig:f.proposalConfig,registeredBinding:async()=>f.binding});
 const recovered=await host.readTaskChangeOriginal('original-1');assert.deepEqual(recovered.original,f.original);assert.equal(recovered.originalRetained,true);assert.equal(recovered.submissionOutcome,'not-checked');assert.equal(recovered.executionAuthorized,false);
 const retry=await host.proposeTaskChange(recovered.original);assert.equal(retry.idempotent,true);assert.deepEqual(retry.submitted,receipt.submitted);
 const stale={...f.original,request:{...f.original.request,requestId:'stale-original'},task:{...task,claims:[{path:'src/b.js',access:'write'}]}};await assert.rejects(host.proposeTaskChange(stale),/STALE_HEAD/);
 const pending=await host.readTaskChangeOriginal('stale-original');assert.equal(pending.originalRetained,true);assert.equal(pending.submissionOutcome,'not-checked');assert.equal((await host.readRequestResult('stale-original')).outcome,'not-found');assert.equal((await createTaskLedgerAuthorityStore(f.proposalConfig).inspect()).proposals.length,1);
});
test('intent retention failure prevents proposal append and stale census prevents original disclosure',async()=>{
 const f=await fixture();await mkdir(f.file);await assert.rejects(f.submission.proposeTaskChange(f.original),/UNSAFE_FILE/);assert.equal((await createTaskLedgerAuthorityStore(f.proposalConfig).inspect()).proposals.length,0);
 const g=await fixture();await g.submission.proposeTaskChange(g.original);const changed=createNativeTaskDraftSubmission({proposalConfig:g.proposalConfig,registeredBinding:async()=>({...g.binding,censusDigest:'c'.repeat(64)})});await assert.rejects(changed.readTaskChangeOriginal('original-1'),/INVENTORY_STALE/);
});
