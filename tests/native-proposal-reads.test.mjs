import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {createNativeReviewHostComposition} from '../src/node/nativeReviewHostComposition.mjs';
import {createTaskLedgerAuthorityStore} from '../src/node/taskLedgerAuthorityStore.mjs';
import {emptyTaskDraftLedger,updateTaskDraft} from '../src/project/taskDraftLedger.js';
assert.equal(os.hostname().toLowerCase(),'dans1');
async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'pp-native-reads-'));
  let binding={projectId:'pp_native_reads',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)};
  const proposalConfig={journalPath:path.join(root,'proposals.jsonl'),projectId:binding.projectId,rootIdentity:binding.rootIdentity};
  const config={proposalConfig,confirmationPath:path.join(root,'confirmations.json'),actor:'Owner',source:'native-test',presenterConfig:{executable:path.join(root,'absent.exe'),executableDigest:'c'.repeat(64),cwd:root},registeredBinding:async()=>binding};
  const host=createNativeReviewHostComposition(config);
  let sequence=0;
  const request=async(command,payload={})=>JSON.parse(await host.dispatchLine(JSON.stringify({version:1,requestId:'read-'+(++sequence),command,payload})+'\n'));
  const ledger=updateTaskDraft(emptyTaskDraftLedger(binding),{title:'Actual submission',description:'Exact scope',acceptance:'Proof',recovery:'Preserve work',owner:'Worker',claims:[],dependsOn:[],archived:false});
  return {host,request,proposalConfig,ledger,rebind:()=>{binding={...binding,censusDigest:'d'.repeat(64)};}};
}
test('native private protocol reads the same submitted journal without appending or granting authority',async()=>{
  const f=await fixture();
  try{
    const empty=await f.request('read-proposal-brief',{offset:0,expectedHeadDigest:null});
    assert.equal(empty.ok,true);assert.equal(empty.result.hasProposal,false);
    const saved=await f.request('submit-draft',{ledger:f.ledger,request:{requestId:'original',expectedRevision:0,expectedHeadDigest:'GENESIS'}});
    assert.equal(saved.ok,true);const head=saved.result.observedHead.headDigest;
    const brief=await f.request('read-proposal-brief',{offset:0,expectedHeadDigest:head});
    assert.equal(brief.result.tasks[0].title,'Actual submission');
    const task=await f.request('read-proposal-task',{taskId:'T0001',offset:0,expectedHeadDigest:head});
    assert.equal(task.ok,true);assert.deepEqual(JSON.parse(task.result.chunk),f.ledger.tasks[0]);
    const historical=await f.request('read-proposal-request',{requestId:'original'});
    assert.equal(historical.result.submittedMatchesObservedHead,true);
    for(const reply of [empty,brief,task,historical]){assert.equal(reply.executionAuthorized,false);assert.equal(reply.result.executionAuthorized,false);assert.equal(reply.nativeGestureVerified,false);}
    assert.equal((await createTaskLedgerAuthorityStore(f.proposalConfig).inspect()).proposals.length,1);
    const injected=await f.request('read-proposal-task',{taskId:'T0001',offset:0,expectedHeadDigest:head,journalPath:'C:/foreign'});
    assert.equal(injected.error.code,'PROTOCOL_INVALID_REQUEST');
    f.rebind();assert.equal((await f.request('read-proposal-brief',{offset:0,expectedHeadDigest:head})).ok,false);
  }finally{await f.host.shutdown();}
  assert.equal((await f.request('read-proposal-brief',{offset:0,expectedHeadDigest:null})).error.code,'NATIVE_COMPOSITION_STOPPED');
});
test('private snapshot transport reconstructs the full real journal without altering it and rejects stale continuation',async()=>{
 const f=await fixture();try{
  const ledger=updateTaskDraft(f.ledger,{...f.ledger.tasks[0],description:'Preserve every field 😀 '.repeat(250),archived:true});
  const saved=await f.request('submit-draft',{ledger,request:{requestId:'snapshot-source',expectedRevision:0,expectedHeadDigest:'GENESIS'}});assert.equal(saved.ok,true);
  let offset=0,wire='',snapshotDigest;
  while(offset!==null){const r=await f.request('read-proposal-snapshot',{offset,expectedHeadDigest:saved.result.observedHead.headDigest});assert.equal(r.ok,true,JSON.stringify(r));if(snapshotDigest)assert.equal(r.result.snapshotDigest,snapshotDigest);snapshotDigest=r.result.snapshotDigest;wire+=r.result.chunk;offset=r.result.nextOffset;assert.equal(r.result.executionAuthorized,false);}
  assert.deepEqual(JSON.parse(wire),ledger);assert.equal(createHash('sha256').update(wire).digest('hex'),snapshotDigest);
  assert.equal((await createTaskLedgerAuthorityStore(f.proposalConfig).inspect()).proposals.length,1);
  assert.equal((await f.request('read-proposal-snapshot',{offset:2000,expectedHeadDigest:null})).ok,false);
  assert.equal((await f.request('read-proposal-snapshot',{offset:0,expectedHeadDigest:'e'.repeat(64)})).ok,false);
  assert.equal((await f.request('read-proposal-snapshot',{offset:0,expectedHeadDigest:null,execute:true})).error.code,'PROTOCOL_INVALID_REQUEST');
 }finally{await f.host.shutdown();}
});
