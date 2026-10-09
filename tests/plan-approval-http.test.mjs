import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalArchitectureJson as canonical} from '../src/engine/architectureContractVerification.js';
import {createPlanningLedgerMiddleware} from '../src/node/planningLedgerHttp.mjs';
import {planningApprovalFixture} from './fixtures/planningApproval.mjs';

const token='1'.repeat(64);
const resolveInput=f=>({binding:f.proposal.binding,original:f.publishInput,confirmation:{decision:'withdraw-if-unpublished',requestDigest:createHash('sha256').update(canonical({...f.publishInput,actor:'local-browser-user',source:'browser-declared-local-development'})).digest('hex')}});
async function harness(t){
 const fixture=await planningApprovalFixture(t);
 const middleware=createPlanningLedgerMiddleware({root:fixture.root,token});
 const server=createServer((req,res)=>middleware(req,res));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const origin=`http://127.0.0.1:${server.address().port}`;
 const input={binding:fixture.proposal.binding,...fixture.publishInput};
 async function request(operation,value={},options={}){
  const response=await fetch(`${origin}/api/planning-ledger/${operation}`,{method:'POST',headers:{origin,'content-type':'application/json','x-pp-planning-ledger-token':token,...options.headers},body:options.raw??JSON.stringify(value)});
  return {status:response.status,headers:response.headers,value:await response.json()};
 }
 return {...fixture,input,request,journal:path.join(fixture.root,fixture.projectId,'plan-approvals.jsonl')};
}

test('local approval publish retains complete review and checked historical readback',async t=>{
 const f=await harness(t);
 const first=await f.request('approval-publish',f.input);
 assert.equal(first.status,200,JSON.stringify(first.value));
 assert.equal(first.value.currentParentsChecked,true);
 assert.equal(first.value.record.planApprovalRecorded,true);
 assert.deepEqual(first.value.record.proposal,f.proposal);
 assert.equal(first.value.record.actor,'local-browser-user');
 assert.equal(first.value.record.source,'browser-declared-local-development');
 for(const key of ['executionAuthorized','nativeApprovalAuthorized','filesystemVerified'])assert.equal(first.value[key],false);
 const after=await f.request('approval-inspect',{binding:f.input.binding});
 assert.equal(after.status,200);assert.equal(after.value.currentParentsChecked,false);
 assert.deepEqual(after.value.records,[first.value.record]);
 assert.equal(after.headers.get('cache-control'),'no-store');
 const current=await f.request('approval-current',{binding:f.input.binding,expectedApprovalHead:first.value.observedApprovalHead});
 assert.equal(current.status,200,JSON.stringify(current.value));assert.equal(current.value.currentParentsChecked,true);
 assert.deepEqual(current.value.record,first.value.record);
 assert.equal((await f.request('approval-current',{binding:{...f.input.binding,censusDigest:'f'.repeat(64)},expectedApprovalHead:first.value.observedApprovalHead})).status,400);
});

test('exact HTTP retry recovers one approval without asserting current parents',async t=>{
 const f=await harness(t),first=await f.request('approval-publish',f.input);
 assert.equal(first.status,200);
 const before=await readFile(f.journal),retry=await f.request('approval-publish',f.input);
 assert.equal(retry.status,200);assert.equal(retry.value.idempotent,true);
 assert.equal(retry.value.currentParentsChecked,false);
 assert.deepEqual(retry.value.record,first.value.record);assert.deepEqual(await readFile(f.journal),before);
});

test('approval routes require exact origin and transport capability',async t=>{
 const f=await harness(t);
 for(const operation of ['approval-inspect','approval-publish','approval-current','approval-resolve']){
  const input=operation==='approval-inspect'?{binding:f.input.binding}:f.input;
  assert.equal((await f.request(operation,input,{headers:{origin:'https://other.invalid'}})).status,403);
  assert.equal((await f.request(operation,input,{headers:{'x-pp-planning-ledger-token':''}})).status,403);
 }
 assert.deepEqual((await f.request('approval-inspect',{binding:f.input.binding})).value.records,[]);
});

test('caller path, identity overrides, wrong binding and ambiguous confirmation cannot publish',async t=>{
 const f=await harness(t);
 for(const patch of [{journalPath:'C:/outside/history'},{actor:'native-user'},{source:'trusted-gesture'},
  {binding:{...f.input.binding,censusDigest:'f'.repeat(64)}},
  {confirmation:{proposalDigest:'f'.repeat(64),decision:'approve'}},
  {confirmation:{proposalDigest:f.proposal.digest,decision:'reject'}}]){
  const response=await f.request('approval-publish',{...f.input,...patch});
  assert.equal(response.status,400);assert.equal(JSON.stringify(response.value).includes(f.root),false);
 }
 const raw=JSON.stringify(f.input).replace('"decision":"approve"','"decision":"approve","decision":"approve"');
 assert.equal((await f.request('approval-publish',{}, {raw})).status,400);
 assert.deepEqual((await f.request('approval-inspect',{binding:f.input.binding})).value.records,[]);
});

test('changed approval request cannot reuse identity and stale approval CAS refuses',async t=>{
 const f=await harness(t);assert.equal((await f.request('approval-publish',f.input)).status,200);
 const before=await readFile(f.journal);
 const changed={...f.input,request:{...f.input.request,expectedRevision:1,expectedHeadDigest:'f'.repeat(64)}};
 assert.equal((await f.request('approval-publish',changed)).status,409);
 assert.equal((await f.request('approval-publish',{...f.input,request:{...f.input.request,requestId:'another'}})).status,409);
 assert.deepEqual(await readFile(f.journal),before);
});

test('approval input bound rejects oversized JSON without exposing host errors',async t=>{
 const f=await harness(t);
 const response=await f.request('approval-publish',{}, {raw:JSON.stringify({extra:'x'.repeat(8*1024*1024+4096)})});
 assert.equal(response.status,400);assert.equal(JSON.stringify(response.value).includes(f.root),false);
 assert.deepEqual((await f.request('approval-inspect',{binding:f.input.binding})).value.records,[]);
});

test('explicit HTTP withdrawal retains exact original and blocks delayed publication',async t=>{
 const f=await harness(t),input=resolveInput(f);
 const result=await f.request('approval-resolve',input);
 assert.equal(result.status,200,JSON.stringify(result.value));assert.equal(result.value.outcome,'withdrawn');
 assert.deepEqual(result.value.record.original,f.publishInput);assert.equal(result.value.planApprovalRecorded,false);
 assert.equal(result.value.currentParentsChecked,false);
 for(const key of ['executionAuthorized','nativeApprovalAuthorized','filesystemVerified'])assert.equal(result.value[key],false);
 const withdrawalFile=path.join(f.root,f.projectId,'plan-approval-withdrawals.jsonl'),before=await readFile(withdrawalFile);
 const retry=await f.request('approval-resolve',input);assert.equal(retry.status,200);assert.equal(retry.value.idempotent,true);assert.deepEqual(retry.value.record,result.value.record);assert.deepEqual(await readFile(withdrawalFile),before);
 const delayed=await f.request('approval-publish',f.input);assert.equal(delayed.status,400);assert.equal(delayed.value.code,'PLAN_APPROVAL_REQUEST_WITHDRAWN');
 assert.deepEqual((await f.request('approval-inspect',{binding:f.input.binding})).value.records,[]);
});

test('HTTP resolution of already-published original returns real historical publication receipt',async t=>{
 const f=await harness(t),published=await f.request('approval-publish',f.input);assert.equal(published.status,200);
 const before=await readFile(f.journal),result=await f.request('approval-resolve',resolveInput(f));
 assert.equal(result.status,200,JSON.stringify(result.value));assert.equal(result.value.outcome,'published');
 assert.deepEqual(result.value.receipt.record,published.value.record);assert.equal(result.value.receipt.idempotent,true);assert.equal(result.value.receipt.currentParentsChecked,false);
 assert.deepEqual(await readFile(f.journal),before);
});

test('withdrawal route rejects spoofed identity, binding, confirmation and duplicate members',async t=>{
 const f=await harness(t),input=resolveInput(f);
 for(const patch of [{actor:'trusted-user'},{source:'native'},{path:'C:/outside'},{binding:{...input.binding,censusDigest:'f'.repeat(64)}},{confirmation:{...input.confirmation,requestDigest:'f'.repeat(64)}},{confirmation:{...input.confirmation,decision:'approve'}},{original:{...input.original,actor:'native'}}]){
  const result=await f.request('approval-resolve',{...input,...patch});assert.equal(result.status,400,JSON.stringify(patch));assert.equal(JSON.stringify(result.value).includes(f.root),false);
 }
 const raw=JSON.stringify(input).replace('"decision":"withdraw-if-unpublished"','"decision":"withdraw-if-unpublished","decision":"withdraw-if-unpublished"');
 assert.equal((await f.request('approval-resolve',{}, {raw})).status,400);
 // Invalid attempts must not consume the original identity or approve anything.
 assert.equal((await f.request('approval-publish',f.input)).status,200);
});

test('withdrawal route rejects oversized input before retaining an outcome',async t=>{
 const f=await harness(t),result=await f.request('approval-resolve',{}, {raw:JSON.stringify({extra:'x'.repeat(8*1024*1024+4096)})});
 assert.equal(result.status,400);assert.equal(JSON.stringify(result.value).includes(f.root),false);
 assert.equal((await f.request('approval-publish',f.input)).status,200);
});
