import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlanRefresh} from '../src/project/planRefresh.js';

// Observer sequencing unit tests. Injected receipts do not replace the real
// planning client's full record/hash validation campaigns.
function fixture(){
 const binding={projectId:'pp_test',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)};
 const parents=Object.fromEntries(['architecture','folder','component'].map((kind,index)=>[kind,{revision:1,digest:String(index+1).repeat(64)}]));
 const project={projectId:binding.projectId,kind:'imported',registration:{rootIdentity:binding.rootIdentity},census:{digest:binding.censusDigest},authorities:Object.fromEntries(Object.entries(parents).map(([kind,head])=>[kind,{...head,state:'authoritative'}]))};
 const ledger={schemaVersion:1,kind:'LOCAL_DRAFT',binding,revision:1,nextTaskNumber:1,updatedAt:'2026-09-13T00:00:00.000Z',tasks:[]};
 const context={state:'ready',catalogState:'current',architectureHead:{revision:1,contractDigest:parents.architecture.digest},folderHead:{revision:1,contractDigest:parents.folder.digest},catalogHead:{revision:1,contractDigest:parents.component.digest}};
 let active=binding.projectId,dirty=false;
 const registry={get:()=>project,getSnapshot:()=>({activeProjectId:active})};
 const store={read:async()=>structuredClone(ledger)},recovery={inspect:async()=>({pending:null})};
 const client={readContext:async()=>structuredClone(context),inspectApprovals:async()=>({observedApprovalHead:{revision:1,headDigest:'c'.repeat(64)}}),inspectCurrent:async()=>({record:{revision:1,recordHash:'c'.repeat(64),proposal:{binding,ledger:structuredClone(ledger),parents,ledgerDigest:'d'.repeat(64)}}})};
 const formRecovery={list:async()=>({records:[],history:[]})};
 const observer=createPlanRefresh({registry,client,store,recovery,formRecovery,getDirty:()=>dirty});
 return {binding,project,ledger,parents,client,store,recovery,formRecovery,observer,setActive:value=>active=value,setDirty:value=>dirty=value};
}
test('checked observation compares full ledger and all parent heads without grants',async()=>{const f=fixture(),result=await f.observer.refresh(f.binding.projectId);assert.equal(result.status,'observed');assert.deepEqual(result.checkedLedger,f.ledger);assert.equal(result.executionAuthorized,false);assert.equal(result.approvalAuthorized,false);assert.equal(result.filesystemVerified,false);});
test('pending recovery and dirty state block observation',async()=>{const f=fixture();f.recovery.inspect=async()=>({pending:{}});assert.equal((await f.observer.refresh(f.binding.projectId)).status,'pending');f.setDirty(true);assert.equal((await f.observer.refresh(f.binding.projectId)).status,'stale');});
test('changed full saved ledger between reads refuses current summary',async()=>{const f=fixture();let reads=0;f.store.read=async()=>({...f.ledger,revision:++reads});assert.equal((await f.observer.refresh(f.binding.projectId)).status,'stale');});
test('parent head changing during check refuses observation',async()=>{const f=fixture(),original=f.client.readContext;let reads=0;f.client.readContext=async()=>{const context=await original();if(++reads===2)context.catalogHead.revision++;return context;};assert.equal((await f.observer.refresh(f.binding.projectId)).status,'stale');});
test('pending arriving at final read refuses observation',async()=>{const f=fixture();let reads=0;f.recovery.inspect=async()=>({pending:++reads===2?{}:null});assert.equal((await f.observer.refresh(f.binding.projectId)).status,'pending');});
test('invalidation discards delayed reply',async()=>{const f=fixture();let resolve;f.store.read=()=>new Promise(done=>resolve=done);const pending=f.observer.refresh(f.binding.projectId);f.observer.invalidate(f.binding.projectId);resolve(f.ledger);assert.equal(await pending,null);});
test('project selection and disposal discard delayed reply',async()=>{for(const action of ['selection','dispose']){const f=fixture();let resolve;f.store.read=()=>new Promise(done=>resolve=done);const pending=f.observer.refresh(f.binding.projectId);if(action==='selection')f.setActive('other');else f.observer.dispose();resolve(f.ledger);assert.equal(await pending,null);}});
test('missing approval and service failure remain distinct',async()=>{const f=fixture();f.client.inspectApprovals=async()=>({observedApprovalHead:{revision:0}});assert.equal((await f.observer.refresh(f.binding.projectId)).status,'missing');f.client.inspectApprovals=async()=>{throw Error('offline');};assert.equal((await f.observer.refresh(f.binding.projectId)).status,'unavailable');});
test('unavailable project cannot reuse retained authoritative parents',async()=>{const f=fixture();f.project.state='unavailable';assert.equal((await f.observer.refresh(f.binding.projectId)).status,'stale');});

test('unfinished editor history blocks approval even without an open form',async()=>{const f=fixture();f.formRecovery.list=async()=>({records:[{status:'unfinished'}]});assert.equal((await f.observer.refresh(f.binding.projectId)).status,'unfinished');});
test('unfinished checkpoint arriving during approval inspection removes checked result',async()=>{const f=fixture();let reads=0;f.formRecovery.list=async()=>({records:++reads===2?[{status:'unfinished'}]:[]});assert.equal((await f.observer.refresh(f.binding.projectId)).status,'unfinished');});
test('unavailable editor recovery cannot be interpreted as no unfinished work',async()=>{const f=fixture();f.formRecovery.list=async()=>{throw Error('Recovery unavailable');};assert.equal((await f.observer.refresh(f.binding.projectId)).status,'unavailable');});
test('terminal editor history does not block an exact checked plan',async()=>{const f=fixture();f.formRecovery.list=async()=>({records:[{status:'resolved'}]});assert.equal((await f.observer.refresh(f.binding.projectId)).status,'observed');});

test('project switch during recovery inspection discards its delayed result',async()=>{const f=fixture();let release;const reached=new Promise(done=>{f.formRecovery.list=()=>new Promise(resolve=>{release=resolve;done();});});const pending=f.observer.refresh(f.binding.projectId);await reached;f.setActive('another-project');release({records:[]});assert.equal(await pending,null);});

test('recovery change subscription is released with the shared observer subscription',()=>{const f=fixture();let subscribed=0,released=0;const listener=()=>{};f.formRecovery.subscribe=(binding,callback)=>{assert.deepEqual(binding,f.binding);assert.equal(callback,listener);subscribed++;return()=>released++;};const stop=f.observer.subscribe(f.binding,listener);assert.equal(subscribed,1);stop();assert.equal(released,1);});
