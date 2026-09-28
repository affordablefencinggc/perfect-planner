import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createInstalledTaskExecutionCustody} from '../src/node/installedTaskExecutionCustody.mjs';
import {createTaskNativeOwnerResultReads} from '../src/node/taskNativeOwnerResultReads.mjs';
import {createNativeReviewHostComposition} from '../src/node/nativeReviewHostComposition.mjs';
async function fixture(){
 const root=await mkdtemp(path.join(os.tmpdir(),'pp-owner-results-'));
 const binding={projectId:'pp_owner_results',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)};let current=binding;
 const observeBinding=async()=>current;
 const c=createInstalledTaskExecutionCustody({stateDirectory:root,binding,observeBinding});assert.deepEqual(await readdir(root),[]);
 await mkdir(path.join(root,`${binding.projectId}.native-observations`));
 const bound={proposalRevision:1,proposalDigest:'a'.repeat(64),checkContractDigest:'b'.repeat(64),enrollmentEpoch:1,taskId:'T0001',checkId:'unit',attemptId:'attempt1',attemptNumber:1,workerId:'worker1',sessionId:'session1',candidateSchemaVersion:2,candidateDigest:'c'.repeat(64),policyVersion:1,policyDigest:'d'.repeat(64)};
 const issued=await c.grants.issue(bound,{requestId:'issue',expectedRevision:0,ttlMs:300000}),grantId=issued.grant.grantId;
 const consumed=await c.grants.consume(bound,{grantId,requestId:'consume',expectedRevision:1});
 const intent=(await c.grants.recordExecutionIntent(consumed.consumptionReceipt,{grantId,requestId:'intent',expectedRevision:2})).intentReceipt;
 const observation={schemaVersion:1,kind:'NATIVE_TASK_OBSERVATION',runId:intent.runId,exitCode:7,timedOut:false,cancelObserved:false,outputTruncated:false,cpuTimeExceeded:false,cpuObservationFailed:false,processExited:true,jobEmptyObserved:true,ioSettled:true,ioFailed:false,stdout:'PRIVATE OUTPUT',stderr:'PRIVATE FAILURE'};
 await c.custody.record({intentReceipt:intent,executionSpec:{runId:intent.runId,intentDigest:intent.recordDigest,outputLimits:{stdoutBytes:100,stderrBytes:100,combinedBytes:200}},observation});
 const config={proposalConfig:{journalPath:path.join(root,'proposals.jsonl'),projectId:binding.projectId,rootIdentity:binding.rootIdentity},confirmationPath:path.join(root,'confirmations.json'),registeredBinding:observeBinding,actor:'Owner',source:'controlled-owner-host',presenterConfig:{executable:path.join(root,'not-launched.exe'),executableDigest:'e'.repeat(64),cwd:root},taskResults:c.results};
 return {root,binding,observeBinding,c,grantId,config,rebind:()=>{current={...binding,rootIdentity:'f'.repeat(64)};}};
}
const wire=(grantId,id='read',extra={})=>JSON.stringify({version:1,requestId:id,command:'inspect-task-result',payload:{grantId,...extra}})+'\n';
test('native owner protocol returns linked project result without credentials, output or mutations',async()=>{
 assert.equal(os.hostname().toLowerCase(),'dans1');const f=await fixture(),host=createNativeReviewHostComposition(f.config);
 const journal=path.join(f.root,`${f.binding.projectId}.execution-grants.jsonl`),before=await readFile(journal);
 const reply=await host.dispatchLine(wire(f.grantId));assert.equal(reply.includes('PRIVATE'),false);assert.equal(reply.includes('session1'),false);
 const r=JSON.parse(reply);assert.equal(r.ok,true);assert.equal(r.result.exitCode,7);assert.equal(r.result.state,'failure-observed');assert.equal(r.result.journalLinked,true);assert.equal(r.executionAuthorized,false);assert.equal(r.result.cleanup,'unknown');
 assert.deepEqual(await readFile(journal),before);await host.shutdown();assert.equal(JSON.parse(await host.dispatchLine(wire(f.grantId,'later'))).ok,false);
});
test('owner result scope rechecks refuse rebound registration including during disk read',async()=>{
 const f=await fixture(),reader=createTaskNativeOwnerResultReads({grants:f.c.grants,observations:{inspect:async intent=>{const saved=await f.c.observations.inspect(intent);f.rebind();return saved;}},binding:f.binding,observeBinding:f.observeBinding});
 await assert.rejects(reader.readOwner({grantId:f.grantId}),/SCOPE_CHANGED/);
 const g=await fixture();g.rebind();await assert.rejects(g.c.results.readOwner({grantId:g.grantId}),/SCOPE_CHANGED/);
});
test('native owner endpoint rejects smuggled credentials/paths and missing result capability',async()=>{
 const f=await fixture(),host=createNativeReviewHostComposition(f.config);
 for(const extra of [{path:'C:/other'},{credentials:{token:'secret'}},{executionAuthorized:true}])assert.equal(JSON.parse(await host.dispatchLine(wire(f.grantId,'bad',extra))).ok,false);
 assert.equal(JSON.parse(await host.dispatchLine(wire('invalid','invalid'))).ok,false);
 const absent=createNativeReviewHostComposition({...f.config,taskResults:undefined});assert.equal(JSON.parse(await absent.dispatchLine(wire(f.grantId))).ok,false);
 await absent.shutdown();await host.shutdown();
});
test('protocol refuses fabricated success and foreign summary identity',async()=>{
 const f=await fixture(),good=await f.c.results.readOwner({grantId:f.grantId});
 for(const change of [{authorityVerified:true},{state:'passed'},{failureReasons:[]},{grantId:'wrong'},{projectId:'pp_foreign'}]){
  const host=createNativeReviewHostComposition({...f.config,taskResults:{readOwner:async()=>({...good,...change})}});
  assert.equal(JSON.parse(await host.dispatchLine(wire(f.grantId))).ok,false);await host.shutdown();
 }
});
test('owner index retains all lifecycle references newest-first and pins continuation to the journal',async()=>{
 const f=await fixture(),initial=await f.c.grants.inspect(),bound=initial.grants[0].grant.binding;
 for(let i=0;i<24;i++)await f.c.grants.issue({...bound,checkId:`unit-${i}`},{requestId:`page-${i}`,expectedRevision:initial.revision+i,ttlMs:300000});
 const host=createNativeReviewHostComposition(f.config);
 const list=async(input,id)=>JSON.parse(await host.dispatchLine(JSON.stringify({version:1,requestId:id,command:'list-task-results',payload:input})+'\n'));
 const first=await list({offset:0,expectedHeadDigest:null},'first');assert.equal(first.ok,true);assert.equal(first.result.entries.length,20);assert.equal(first.result.totalGrants,25);assert.equal(first.result.nextOffset,20);
 assert.equal(first.result.entries[0].lifecycleState,'issued');assert.equal(first.result.entries[0].runId,null);assert.equal(first.result.entries[0].journalRevision,28);
 assert.equal(JSON.stringify(first).includes('session1'),false);assert.equal(JSON.stringify(first).includes('PRIVATE'),false);
 const last=await list({offset:20,expectedHeadDigest:first.result.journalHead.headDigest},'last');assert.equal(last.ok,true);assert.equal(last.result.entries.length,5);assert.equal(last.result.nextOffset,null);assert.equal(last.result.entries.at(-1).grantId,f.grantId);assert.equal(last.result.entries.at(-1).lifecycleState,'result-recorded');
 assert.equal(new Set([...first.result.entries,...last.result.entries].map(r=>r.grantId)).size,25);
 await f.c.grants.issue({...bound,checkId:'new'},{requestId:'new',expectedRevision:28,ttlMs:300000});
 const stale=await list({offset:20,expectedHeadDigest:first.result.journalHead.headDigest},'stale');assert.equal(stale.ok,false);assert.equal(stale.error.code,'NATIVE_TASK_INDEX_STALE');
 const refreshed=await list({offset:0,expectedHeadDigest:null},'refresh');assert.equal(refreshed.result.totalGrants,26);
 await host.shutdown();
});
test('index read rechecks registration after disk access and refuses injected scope',async()=>{
 const f=await fixture();const reader=createTaskNativeOwnerResultReads({grants:{inspect:async()=>{const state=await f.c.grants.inspect();f.rebind();return state;}},observations:f.c.observations,binding:f.binding,observeBinding:f.observeBinding});
 await assert.rejects(reader.listOwner({offset:0,expectedHeadDigest:null}),/SCOPE_CHANGED/);
 const g=await fixture();for(const input of [{offset:0,expectedHeadDigest:null,projectId:'other'},{offset:20,expectedHeadDigest:null},{offset:2049,expectedHeadDigest:'a'.repeat(64)}])await assert.rejects(g.c.results.listOwner(input),/INVALID/);
});
test('index can show empty custody without interpreting it as completed work',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'pp-empty-index-'));const binding={projectId:'pp_empty',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)};
 const c=createInstalledTaskExecutionCustody({stateDirectory:root,binding,observeBinding:async()=>binding});const page=await c.results.listOwner({offset:0,expectedHeadDigest:null});
 assert.equal(page.totalGrants,0);assert.equal(page.journalHead.headDigest,'GENESIS');assert.equal(page.authorityVerified,false);assert.equal(page.executionAuthorized,false);
});

test('owner page reads 20 real retained outcomes with two journal inspections and no mutation',async()=>{
 const f=await fixture();const initial=await f.c.grants.inspect(),bound=initial.grants[0].grant.binding;
 const original=await f.c.observations.inspect(initial.grants[0].intentReceipt);
 for(let i=1;i<20;i++){
  const b={...bound,checkId:`check-${i}`},revision=4*i;
  const {grant}=await f.c.grants.issue(b,{requestId:`issue-${i}`,expectedRevision:revision,ttlMs:300000});
  const consumed=await f.c.grants.consume(b,{grantId:grant.grantId,requestId:`consume-${i}`,expectedRevision:revision+1});
  const {intentReceipt:intent}=await f.c.grants.recordExecutionIntent(consumed.consumptionReceipt,{grantId:grant.grantId,requestId:`intent-${i}`,expectedRevision:revision+2});
  await f.c.custody.record({intentReceipt:intent,executionSpec:{runId:intent.runId,intentDigest:intent.recordDigest,outputLimits:{stdoutBytes:100,stderrBytes:100,combinedBytes:200}},observation:{...original.observation,runId:intent.runId,exitCode:i%2?0:7}});
 }
 let inspections=0,artifacts=0;
 const reader=createTaskNativeOwnerResultReads({grants:{inspect:async()=>{inspections++;return f.c.grants.inspect();}},observations:{inspect:async intent=>{artifacts++;return f.c.observations.inspect(intent);}},binding:f.binding,observeBinding:f.observeBinding});
 const journal=path.join(f.root,`${f.binding.projectId}.execution-grants.jsonl`),before=await readFile(journal);
 const result=await reader.readPageOwner({offset:0,expectedHeadDigest:null});
 assert.equal(inspections,2);assert.equal(artifacts,20);assert.equal(result.outcomes.length,20);
 assert.equal(result.outcomes.filter(o=>o.value.state==='failure-observed').length,10);
 assert.equal(result.outcomes.filter(o=>o.value.state==='result-unverified').length,10);
 assert.deepEqual(result.outcomes.map(o=>o.grantId),result.page.entries.map(e=>e.grantId));
 assert.equal(JSON.stringify(result).includes('PRIVATE'),false);assert.equal(JSON.stringify(result).includes('session1'),false);
 assert(Object.isFrozen(result));assert(Object.isFrozen(result.outcomes));assert.deepEqual(await readFile(journal),before);
 const host=createNativeReviewHostComposition(f.config);
 const encoded=await host.dispatchLine(JSON.stringify({version:1,requestId:'twenty',command:'read-task-result-page',payload:{offset:0,expectedHeadDigest:null}})+'\n');
 assert.equal(JSON.parse(encoded).ok,true);assert.equal(JSON.parse(encoded).result.outcomes.length,20);assert(Buffer.byteLength(encoded)<65536);await host.shutdown();
});
test('page retains missing or corrupt outcomes as unknown, never success',async()=>{
 for(const inspect of [async()=>{throw Error('PRIVATE disk failure');},async()=>({receipt:{},observation:{}})]){
  const f=await fixture(),reader=createTaskNativeOwnerResultReads({grants:f.c.grants,observations:{inspect},binding:f.binding,observeBinding:f.observeBinding});
  const result=await reader.readPageOwner({offset:0,expectedHeadDigest:null});
  assert.deepEqual(result.outcomes,[{grantId:f.grantId,phase:'unavailable',value:null}]);assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
 }
});
test('page refuses a changed journal even after successful outcome reads',async()=>{
 const f=await fixture();const reader=createTaskNativeOwnerResultReads({grants:f.c.grants,observations:{inspect:async intent=>{
  const saved=await f.c.observations.inspect(intent),state=await f.c.grants.inspect();
  await f.c.grants.issue({...state.grants[0].grant.binding,checkId:'concurrent'},{requestId:'concurrent',expectedRevision:state.revision,ttlMs:300000});return saved;
 }},binding:f.binding,observeBinding:f.observeBinding});
 await assert.rejects(reader.readPageOwner({offset:0,expectedHeadDigest:null}),/NATIVE_TASK_INDEX_STALE/);
});
test('page does not downgrade scope changes during outcome reads to a partial result',async()=>{
 const f=await fixture(),reader=createTaskNativeOwnerResultReads({grants:f.c.grants,observations:{inspect:async intent=>{const saved=await f.c.observations.inspect(intent);f.rebind();return saved;}},binding:f.binding,observeBinding:f.observeBinding});
 await assert.rejects(reader.readPageOwner({offset:0,expectedHeadDigest:null}),/SCOPE_CHANGED/);
});
test('page refuses caller-selected grants and stale heads before reading artifacts',async()=>{
 const f=await fixture();let artifacts=0;
 const reader=createTaskNativeOwnerResultReads({grants:f.c.grants,observations:{inspect:async()=>{artifacts++;throw Error();}},binding:f.binding,observeBinding:f.observeBinding});
 await assert.rejects(reader.readPageOwner({offset:0,expectedHeadDigest:null,grantIds:[f.grantId]}),/INVALID/);
 await assert.rejects(reader.readPageOwner({offset:0,expectedHeadDigest:'f'.repeat(64)}),/STALE/);assert.equal(artifacts,0);
});
test('owner page protocol projects linked failures and explicit unknowns without private fields',async()=>{
 const f=await fixture(),host=createNativeReviewHostComposition(f.config);
 const request={version:1,requestId:'page',command:'read-task-result-page',payload:{offset:0,expectedHeadDigest:null}};
 const reply=JSON.parse(await host.dispatchLine(JSON.stringify(request)+'\n'));
 assert.equal(reply.ok,true);assert.equal(reply.result.outcomes[0].value.exitCode,7);assert.equal(JSON.stringify(reply).includes('PRIVATE'),false);assert.equal(JSON.stringify(reply).includes('session1'),false);
 assert.equal(reply.result.outcomes[0].value.process,undefined);
 await host.shutdown();assert.equal(JSON.parse(await host.dispatchLine(JSON.stringify({...request,requestId:'closed'})+'\n')).ok,false);
});
test('owner page protocol refuses summaries from another reference or arbitrary unknown payload',async()=>{
 const f=await fixture(),good=await f.c.results.readPageOwner({offset:0,expectedHeadDigest:null});
 for(const change of [r=>r.outcomes[0].value.workerId='other',r=>r.outcomes[0].value.intentDigest='e'.repeat(64),r=>r.outcomes=[],r=>r.outcomes[0]={grantId:f.grantId,phase:'unavailable',value:{secret:'no'}}]){
  const r=structuredClone(good);change(r);
  const host=createNativeReviewHostComposition({...f.config,taskResults:{readOwner:f.c.results.readOwner,readPageOwner:async()=>r}});
  const reply=JSON.parse(await host.dispatchLine(JSON.stringify({version:1,requestId:'page',command:'read-task-result-page',payload:{offset:0,expectedHeadDigest:null}})+'\n'));
  assert.equal(reply.ok,false);assert.equal(reply.error.code,'NATIVE_TASK_RESULT_UNAVAILABLE');await host.shutdown();
 }
});
