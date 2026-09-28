import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readdir,rm,mkdir,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {canonicalArchitectureJson as canonical} from '../src/engine/architectureContractVerification.js';
import {createPlanningLedgerMiddleware} from '../src/node/planningLedgerHttp.mjs';
import {initializePlanningLedgerHostRoot} from '../src/node/planningLedgerHostRoot.mjs';
import {createImportedProjectId} from '../src/project/projectIds.js';
import {emptyTaskDraftLedger,updateTaskDraft,TASK_DRAFT_BYTES} from '../src/project/taskDraftLedger.js';

const token='1'.repeat(64),rootIdentity='a'.repeat(64);
const binding={projectId:createImportedProjectId(rootIdentity),rootIdentity,censusDigest:'b'.repeat(64)};
const ledger=()=>updateTaskDraft(emptyTaskDraftLedger(binding),{title:'Retain full task',description:'All obligations',owner:'Reviewer',acceptance:'Exact proof',recovery:'Keep rejected work',claims:[{path:'src/app.js',access:'write'}],dependsOn:[],archived:false});
async function harness(t){
 const temporary=await mkdtemp(path.join(os.tmpdir(),'pp-planning-http-'));
 const root=path.join(temporary,'fresh-host','authority');
 await initializePlanningLedgerHostRoot(root);
 const middleware=createPlanningLedgerMiddleware({root,token});
 const server=createServer((req,res)=>middleware(req,res,()=>{res.statusCode=404;res.end();}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`;
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true});});
 async function request(operation,input={},options={}){
  const response=await fetch(`${origin}/api/planning-ledger/${operation}`,{method:'POST',headers:{origin,'content-type':'application/json','x-pp-planning-ledger-token':token,...options.headers},body:options.raw??JSON.stringify(input)});
  return {status:response.status,headers:response.headers,value:await response.json()};
 }
 return {root,request};
}

test('empty session and absent inspection create no planning files',async t=>{
 const {root,request}=await harness(t),session=await request('session');
 assert.equal(session.status,200);assert.equal(session.value.token,token);assert.equal(session.value.approvalAuthorized,false);
 const inspected=await request('inspect',{binding});assert.equal(inspected.status,200);assert.deepEqual(inspected.value.observedHead,{hostRevision:0,headDigest:'GENESIS'});assert.equal(inspected.value.latestProposal,null);assert.equal(inspected.value.filesystemVerified,false);
 assert.deepEqual(await readdir(root),[]);assert.equal(inspected.headers.get('cache-control'),'no-store');
});
test('submit retains complete ledger and original retry returns same head',async t=>{
 const {request}=await harness(t),draft=ledger(),input={ledger:draft,request:{requestId:'first',expectedRevision:0,expectedHeadDigest:'GENESIS'},expectedCensusDigest:null};
 const first=await request('submit',input);assert.equal(first.status,200);assert.equal(first.value.submissionPersisted,true);assert.equal(first.value.idempotent,false);assert.equal(first.value.submittedMatchesObservedHead,true);assert.deepEqual(first.value.latestProposal.ledger,draft);
 const retry=await request('submit',input);assert.equal(retry.status,200);assert.equal(retry.value.idempotent,true);assert.deepEqual(retry.value.observedHead,first.value.observedHead);
 const inspect=await request('inspect',{binding});assert.deepEqual(inspect.value.latestProposal.ledger,draft);assert.equal(inspect.value.declarationSource,'browser-declared');assert.equal(inspect.value.approvalAuthorized,false);assert.equal(inspect.value.executionAuthorized,false);
});
test('foreign origin and missing transport capability cannot submit or inspect',async t=>{
 const {root,request}=await harness(t);
 assert.equal((await request('session',{}, {headers:{origin:'https://other.invalid'}})).status,403);
 assert.equal((await request('inspect',{binding},{headers:{'x-pp-planning-ledger-token':''}})).status,403);
 assert.equal((await request('submit',{}, {headers:{'x-pp-planning-ledger-token':'invalid'}})).status,403);
 assert.deepEqual(await readdir(root),[]);
});
test('unknown routes, extra storage paths and duplicate JSON members refuse without writes',async t=>{
 const {root,request}=await harness(t);
 assert.equal((await request('alias/submit',{})).status,404);
 assert.equal((await request('inspect',{binding,journalPath:'C:/outside/history'})).status,400);
 assert.equal((await request('session',{actor:'forged'})).status,400);
 assert.equal((await request('inspect',{}, {raw:`{"binding":${JSON.stringify(binding)},"binding":${JSON.stringify(binding)}}`})).status,400);
 assert.equal((await request('inspect',{}, {raw:`{"binding":{"projectId":"${binding.projectId}","rootIdentity":"${rootIdentity}","censusDigest":"${binding.censusDigest}","censusDigest":"${binding.censusDigest}"}}`})).status,400);
 assert.deepEqual(await readdir(root),[]);
});
test('malformed oversized and non JSON requests refuse without leaking host paths',async t=>{
 const {root,request}=await harness(t);
 for(const options of [{raw:'{'},{raw:JSON.stringify({extra:'x'.repeat(TASK_DRAFT_BYTES+4096)})},{headers:{'content-type':'text/plain'}}]){
  const result=await request('submit',{},options);assert.ok([400,415].includes(result.status));assert.equal(JSON.stringify(result.value).includes(root),false);
 }
 assert.deepEqual(await readdir(root),[]);
});
test('changed request content cannot reuse original request identity',async t=>{
 const {request}=await harness(t),draft=ledger(),input={ledger:draft,request:{requestId:'same-id',expectedRevision:0,expectedHeadDigest:'GENESIS'},expectedCensusDigest:null};
 assert.equal((await request('submit',input)).status,200);
 const changed=structuredClone(input);changed.ledger.tasks[0].description='Different obligation';
 assert.equal((await request('submit',changed)).status,409);
 const inspected=await request('inspect',{binding});assert.equal(inspected.value.observedHead.hostRevision,1);assert.deepEqual(inspected.value.latestProposal.ledger,draft);
});
test('host initialization rejects linked ancestors without changing target',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'pp-planning-host-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const target=path.join(root,'target');await mkdir(target);await symlink(target,path.join(root,'linked'),process.platform==='win32'?'junction':'dir');
 await assert.rejects(initializePlanningLedgerHostRoot(path.join(root,'linked','authority')),/HOST_ROOT_UNSAFE/);
 assert.deepEqual(await readdir(target),[]);
});

const resolutionFor=original=>({original,confirmation:{decision:'withdraw-if-unpublished',requestDigest:createHash('sha256').update(canonical(original)).digest('hex')}});
const originalLedger=()=>({ledger:ledger(),request:{requestId:'http-withdraw-original',expectedRevision:0,expectedHeadDigest:'GENESIS'},expectedCensusDigest:null});

test('explicit ledger resolution persists original withdrawal and refuses delayed submission',async t=>{
 const {request}=await harness(t),original=originalLedger(),input=resolutionFor(original);
 const first=await request('resolve',input);assert.equal(first.status,200);assert.equal(first.value.outcome,'withdrawn');assert.equal(first.value.idempotent,false);
 assert.deepEqual(first.value.record.original,original);assert.equal(first.value.submissionPersisted,false);assert.equal(first.value.executionAuthorized,false);assert.equal(first.value.approvalAuthorized,false);
 const retry=await request('resolve',input);assert.equal(retry.status,200);assert.equal(retry.value.idempotent,true);assert.deepEqual(retry.value.record,first.value.record);
 const delayed=await request('submit',original);assert.equal(delayed.status,400);assert.match(delayed.value.code,/REQUEST_WITHDRAWN$/);
 const inspected=await request('inspect',{binding});assert.equal(inspected.status,200);assert.equal(inspected.value.observedHead.hostRevision,0);assert.equal(inspected.value.latestProposal,null);
});

test('already submitted ledger resolution returns genuine historical submission receipt',async t=>{
 const {request}=await harness(t),original=originalLedger();
 const first=await request('submit',original);assert.equal(first.status,200);
 const newer=structuredClone(original);newer.request={requestId:'http-newer',expectedRevision:1,expectedHeadDigest:first.value.observedHead.headDigest};newer.expectedCensusDigest=binding.censusDigest;
 assert.equal((await request('submit',newer)).status,200);
 const resolved=await request('resolve',resolutionFor(original));assert.equal(resolved.status,200);assert.equal(resolved.value.outcome,'submitted');assert.equal(resolved.value.receipt.idempotent,true);
 assert.deepEqual(resolved.value.submittedProposal,first.value.latestProposal);assert.equal(resolved.value.submittedProposal.recordHash,resolved.value.receipt.submitted.headDigest);
 assert.equal(resolved.value.receipt.submissionPersisted,true);assert.deepEqual(resolved.value.receipt.submitted,first.value.submitted);assert.equal(resolved.value.receipt.observedHead.hostRevision,2);assert.equal(resolved.value.receipt.submittedMatchesObservedHead,false);
 const wrongCensus=structuredClone(original);wrongCensus.expectedCensusDigest='f'.repeat(64);
 assert.equal((await request('resolve',resolutionFor(wrongCensus))).status,409);
});

test('ledger resolution requires origin capability full original and exact explicit confirmation',async t=>{
 const {root,request}=await harness(t),original=originalLedger(),valid=resolutionFor(original);
 for(const headers of [{origin:'https://foreign.invalid'},{'x-pp-planning-ledger-token':''}])assert.equal((await request('resolve',valid,{headers})).status,403);
 for(const invalid of [{...valid,actor:'forged'},{...valid,root:'C:/outside'},{...valid,binding},{original,confirmation:{...valid.confirmation,decision:'approve'}},{original,confirmation:{...valid.confirmation,requestDigest:'0'.repeat(64)}},{original:{...original,source:'forged'},confirmation:valid.confirmation}]){
  const result=await request('resolve',invalid);assert.equal(result.status,400);assert.equal(JSON.stringify(result.value).includes(root),false);
 }
 assert.equal((await request('resolve',{}, {raw:`{"original":${JSON.stringify(original)},"original":${JSON.stringify(original)},"confirmation":${JSON.stringify(valid.confirmation)}}`})).status,400);
 assert.deepEqual(await readdir(root),[]);
});

test('ledger resolution refuses oversized originals before retaining any files',async t=>{
 const {root,request}=await harness(t);
 const result=await request('resolve',{}, {raw:JSON.stringify({original:'x'.repeat(TASK_DRAFT_BYTES+4096),confirmation:{}})});
 assert.equal(result.status,400);assert.equal(JSON.stringify(result.value).includes(root),false);assert.deepEqual(await readdir(root),[]);
});
