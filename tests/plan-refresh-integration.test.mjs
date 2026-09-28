import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {planningApprovalFixture} from './fixtures/planningApproval.mjs';
import {createPlanningLedgerMiddleware} from '../src/node/planningLedgerHttp.mjs';
import {inspectComponentAuthoringContext} from '../src/node/componentPlanStore.mjs';
import {createPlanningClient} from '../src/runtime/planningClient.js';
import {createPlanRefresh} from '../src/project/planRefresh.js';

async function harness(t){
 const f=await planningApprovalFixture(t),middleware=createPlanningLedgerMiddleware({root:f.root});
 const server=createServer((req,res)=>middleware(req,res));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const origin=`http://127.0.0.1:${server.address().port}`,calls=[];
 const client=createPlanningClient({fetchImpl:async(url,options)=>{calls.push(String(url));return fetch(new URL(url,origin),{...options,headers:{...options.headers,origin}});}});
 client.readContext=()=>inspectComponentAuthoringContext(f.root,f.projectId,{actor:'test-observer'});
 const project={projectId:f.projectId,kind:'imported',registration:{rootIdentity:f.rootIdentity},census:{digest:f.ledger.binding.censusDigest},authorities:Object.fromEntries(Object.entries(f.proposal.parents).map(([key,value])=>[key,{...value,state:'authoritative'}]))};
 let current=project,active=f.projectId,ledger=structuredClone(f.ledger),pending=null,dirty=false;
 const registry={get:()=>current,getSnapshot:()=>({activeProjectId:active})};
 const store={read:async()=>structuredClone(ledger)},recovery={inspect:async()=>({pending,completed:[]})};
 const observer=createPlanRefresh({registry,client,store,recovery,formRecovery:{list:async()=>({records:[],history:[]})},getDirty:()=>dirty});t.after(()=>observer.dispose());
 return {...f,client,observer,calls,store,recovery,project,setLedger:value=>ledger=value,setPending:value=>pending=value,setDirty:value=>dirty=value,setActive:value=>active=value,setProject:value=>current=value,publish:()=>client.publishApproval({binding:f.ledger.binding,...f.publishInput})};
}

test('shared observer checks actual host approval and the exact complete local ledger',async t=>{
 const f=await harness(t);await f.publish();const result=await f.observer.refresh(f.projectId);
 assert.equal(result.status,'observed');assert.equal(result.revision,1);assert.deepEqual(result.checkedLedger,f.ledger);assert.deepEqual(result.parents,f.proposal.parents);assert.equal(result.executionAuthorized,false);assert.equal(result.approvalAuthorized,false);
 f.setLedger({...f.ledger,revision:2,tasks:f.ledger.tasks.map((task,index)=>index?task:{...task,description:'New unapproved obligation'})});
 assert.equal((await f.observer.refresh(f.projectId)).status,'stale');
});

test('shared observer does not turn missing approval pending work or dirty form into success',async t=>{
 const f=await harness(t);assert.equal((await f.observer.refresh(f.projectId)).status,'missing');
 f.setPending({kind:'ledger',requestId:'uncertain'});const before=f.calls.length;assert.equal((await f.observer.refresh(f.projectId)).status,'pending');assert.equal(f.calls.length,before);
 f.setPending(null);f.setDirty(true);assert.equal((await f.observer.refresh(f.projectId)).status,'stale');assert.equal(f.calls.length,before);
});

test('later host ledger invalidates historical approval despite unchanged local content',async t=>{
 const f=await harness(t);await f.publish();assert.equal((await f.observer.refresh(f.projectId)).status,'observed');
 await f.client.submitLedger({ledger:{...f.ledger,revision:2},request:{requestId:'host-successor',expectedRevision:1,expectedHeadDigest:f.expectedProposalHead.headDigest},expectedCensusDigest:f.ledger.binding.censusDigest});
 const result=await f.observer.refresh(f.projectId);assert.notEqual(result.status,'observed');assert.equal(result.checkedLedger,undefined);
});

test('local changes during a real host read cannot install checked observation',async t=>{
 const f=await harness(t);await f.publish();let reads=0;f.store.read=async()=>++reads===1?structuredClone(f.ledger):{...structuredClone(f.ledger),revision:2};
 assert.equal((await f.observer.refresh(f.projectId)).status,'stale');
});

test('switching projects while a real inspection is pending discards its result',async t=>{
 const f=await harness(t);await f.publish();const actual=f.client.inspectCurrent;let release,entered;
 const ready=new Promise(resolve=>entered=resolve),barrier=new Promise(resolve=>release=resolve);
 f.client.inspectCurrent=async(...args)=>{entered();await barrier;return actual(...args);};
 const result=f.observer.refresh(f.projectId);await ready;f.setActive('another-project');release();assert.equal(await result,null);
});
