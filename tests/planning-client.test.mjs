import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {canonicalArchitectureJson as canonical} from '../src/engine/architectureContractVerification.js';
import {createPlanningLedgerMiddleware} from '../src/node/planningLedgerHttp.mjs';
import {createPlanningClient} from '../src/runtime/planningClient.js';
import {planningApprovalFixture} from './fixtures/planningApproval.mjs';
const resolutionInput=f=>({binding:f.proposal.binding,original:f.publishInput,confirmation:{decision:'withdraw-if-unpublished',requestDigest:createHash('sha256').update(canonical({...f.publishInput,actor:'local-browser-user',source:'browser-declared-local-development'})).digest('hex')}});

async function fixture(t){
 const f=await planningApprovalFixture(t),middleware=createPlanningLedgerMiddleware({root:f.root});
 const server=createServer((req,res)=>middleware(req,res));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const origin=`http://127.0.0.1:${server.address().port}`,calls=[];
 const fetchImpl=async(url,options)=>{calls.push({url,options});return fetch(new URL(url,origin),{...options,headers:{...options.headers,origin}});};
 return {...f,client:createPlanningClient({fetchImpl}),fetchImpl,calls,approvalInput:{binding:f.proposal.binding,...f.publishInput}};
}
test('browser client validates real retained ledger, approval and current readback',async t=>{
 const f=await fixture(t),ledger=await f.client.inspectLedger(f.proposal.binding);
 assert.deepEqual(ledger.latestProposal.ledger,f.ledger);
 const published=await f.client.publishApproval(f.approvalInput);
 assert.deepEqual(published.record.proposal,f.proposal);assert.equal(published.currentParentsChecked,true);
 const history=await f.client.inspectApprovals(f.proposal.binding);
 assert.deepEqual(history.records,[published.record]);assert.equal(history.currentParentsChecked,false);
 const current=await f.client.inspectCurrent(f.proposal.binding,published.observedApprovalHead);
 assert.deepEqual(current.record,published.record);assert.equal(current.currentParentsChecked,true);
});
test('original approval retry returns checked historical receipt, not new current approval',async t=>{
 const f=await fixture(t),first=await f.client.publishApproval(f.approvalInput),retry=await f.client.publishApproval(f.approvalInput);
 assert.equal(retry.idempotent,true);assert.equal(retry.currentParentsChecked,false);assert.deepEqual(retry.record,first.record);
});
test('client ledger submission binds the complete saved original and exact host head',async t=>{
 const f=await fixture(t),before=await f.client.inspectLedger(f.proposal.binding);
 const input={ledger:f.ledger,request:{requestId:'browser-ledger',expectedRevision:before.observedHead.hostRevision,expectedHeadDigest:before.observedHead.headDigest},expectedCensusDigest:f.ledger.binding.censusDigest};
 const saved=await f.client.submitLedger(input);assert.equal(saved.submittedMatchesObservedHead,true);assert.deepEqual(saved.latestProposal.ledger,f.ledger);
 const retry=await f.client.submitLedger(input);assert.equal(retry.idempotent,true);assert.deepEqual(retry.submitted,saved.submitted);
});
test('failed mutation transport is never automatically resubmitted',async t=>{
 const f=await fixture(t);let submissions=0;
 const client=createPlanningClient({fetchImpl:async(url,options)=>{if(String(url).endsWith('/approval-publish')){submissions++;throw Error('offline after dispatch');}return f.fetchImpl(url,options);}});
 await assert.rejects(client.publishApproval(f.approvalInput));assert.equal(submissions,1);
});
test('tampered receipt content or authority flags are rejected',async t=>{
 const f=await fixture(t);
 for(const mutate of [value=>value.record.proposal.ledger.tasks[0].title='tampered',value=>value.executionAuthorized=true,value=>value.record.nativeApprovalAuthorized=true]){
  const client=createPlanningClient({fetchImpl:async(url,options)=>{const response=await f.fetchImpl(url,options);if(!String(url).endsWith('/approval-publish'))return response;const value=await response.json();mutate(value);return new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});}});
  await assert.rejects(client.publishApproval(f.approvalInput));
 }
});
test('current readback must match the requested approval head and folder inventory',async t=>{
 const f=await fixture(t),first=await f.client.publishApproval(f.approvalInput);
 await assert.rejects(f.client.inspectCurrent(f.proposal.binding,{revision:1,headDigest:'f'.repeat(64)}));
 await assert.rejects(f.client.inspectCurrent({...f.proposal.binding,censusDigest:'f'.repeat(64)},first.observedApprovalHead));
});
test('transport refusal never leaks host exception text or silently retries publication',async t=>{
 const f=await fixture(t);let mutations=0;
 const client=createPlanningClient({fetchImpl:async(url,options)=>{if(String(url).endsWith('/approval-publish')){mutations++;return new Response(JSON.stringify({error:'C:/private/authority'}),{status:403});}return f.fetchImpl(url,options);}});
 let error;try{await client.publishApproval(f.approvalInput);}catch(caught){error=caught;}
 assert.ok(error);assert.equal(String(error).includes('C:/private'),false);assert.equal(mutations,1);
});

test('client verifies real withdrawal and exact original retry without approving',async t=>{
 const f=await fixture(t),input=resolutionInput(f),result=await f.client.resolveApproval(input);
 assert.equal(result.outcome,'withdrawn');assert.equal(result.planApprovalRecorded,false);assert.equal(result.currentParentsChecked,false);assert.deepEqual(result.record.original,f.publishInput);
 const retry=await f.client.resolveApproval(input);assert.equal(retry.idempotent,true);assert.deepEqual(retry.record,result.record);
 await assert.rejects(f.client.publishApproval(f.approvalInput),/PLAN_APPROVAL_REQUEST_WITHDRAWN/);
 assert.deepEqual((await f.client.inspectApprovals(f.proposal.binding)).records,[]);
});

test('client resolution returns genuine historical receipt when original was already approved',async t=>{
 const f=await fixture(t),approved=await f.client.publishApproval(f.approvalInput),result=await f.client.resolveApproval(resolutionInput(f));
 assert.equal(result.outcome,'published');assert.deepEqual(result.receipt.record,approved.record);assert.equal(result.receipt.idempotent,true);assert.equal(result.receipt.currentParentsChecked,false);
});

test('lost resolution reply is not retried automatically and explicit retry recovers actual outcome',async t=>{
 const f=await fixture(t),input=resolutionInput(f);let mutations=0;
 const client=createPlanningClient({fetchImpl:async(url,options)=>{const response=await f.fetchImpl(url,options);if(String(url).endsWith('/approval-resolve')){mutations++;await response.json();throw Error('Controlled reply loss after server result');}return response;}});
 await assert.rejects(client.resolveApproval(input),/Controlled reply loss/);assert.equal(mutations,1);
 const retry=await f.client.resolveApproval(input);assert.equal(retry.outcome,'withdrawn');assert.equal(retry.idempotent,true);assert.deepEqual(retry.record.original,input.original);
});

test('client rejects altered withdrawal outcome, identity, confirmation and authority flags',async t=>{
 const f=await fixture(t),input=resolutionInput(f);
 for(const mutate of [value=>value.record.original.proposal.ledger.tasks[0].title='forged',value=>value.record.actor='native',value=>value.record.confirmation.requestDigest='f'.repeat(64),value=>value.record.recordHash='f'.repeat(64),value=>value.observedWithdrawalHead.headDigest='f'.repeat(64),value=>value.executionAuthorized=true,value=>value.planApprovalRecorded=true]){
  const client=createPlanningClient({fetchImpl:async(url,options)=>{const response=await f.fetchImpl(url,options);if(!String(url).endsWith('/approval-resolve'))return response;const value=await response.json();mutate(value);return new Response(JSON.stringify(value),{status:200});}});
  await assert.rejects(client.resolveApproval(input));
 }
});

const ledgerResolution=original=>({original,confirmation:{decision:'withdraw-if-unpublished',requestDigest:createHash('sha256').update(canonical(original)).digest('hex')}});
const staleLedgerOriginal=f=>({ledger:f.ledger,request:{requestId:'browser-stale-ledger',expectedRevision:0,expectedHeadDigest:'GENESIS'},expectedCensusDigest:null});

test('client verifies ledger withdrawal full original and exact retry with no grants',async t=>{
 const f=await fixture(t),original=staleLedgerOriginal(f),input=ledgerResolution(original);
 await assert.rejects(f.client.submitLedger(original));
 const result=await f.client.resolveLedger(input);assert.equal(result.outcome,'withdrawn');assert.equal(result.submissionPersisted,false);assert.equal(result.approvalAuthorized,false);assert.equal(result.executionAuthorized,false);assert.deepEqual(result.record.original,original);
 const retry=await f.client.resolveLedger(input);assert.equal(retry.idempotent,true);assert.deepEqual(retry.record,result.record);
 await assert.rejects(f.client.submitLedger(original),/REQUEST_WITHDRAWN/);
});

test('client verifies full historical submitted proposal after successor without claiming current approval',async t=>{
 const f=await fixture(t),before=await f.client.inspectLedger(f.ledger.binding),original={ledger:f.ledger,request:{requestId:'client-accepted-original',expectedRevision:before.observedHead.hostRevision,expectedHeadDigest:before.observedHead.headDigest},expectedCensusDigest:f.ledger.binding.censusDigest};
 const accepted=await f.client.submitLedger(original),successor={...original,request:{requestId:'client-accepted-successor',expectedRevision:accepted.observedHead.hostRevision,expectedHeadDigest:accepted.observedHead.headDigest}};
 await f.client.submitLedger(successor);
 const result=await f.client.resolveLedger(ledgerResolution(original));assert.equal(result.outcome,'submitted');assert.equal(result.receipt.idempotent,true);assert.equal(result.receipt.submittedMatchesObservedHead,false);assert.deepEqual(result.submittedProposal,accepted.latestProposal);assert.equal(result.submittedProposal.requestId,original.request.requestId);assert.equal(result.receipt.approvalAuthorized,false);
});

test('lost real ledger resolution response requires explicit original retry',async t=>{
 const f=await fixture(t),input=ledgerResolution(staleLedgerOriginal(f));let dispatches=0;
 const client=createPlanningClient({fetchImpl:async(url,options)=>{const response=await f.fetchImpl(url,options);if(String(url).endsWith('/resolve')){assert.equal(response.status,200);dispatches++;await response.json();throw Error('Controlled ledger result lost');}return response;}});
 await assert.rejects(client.resolveLedger(input),/Controlled ledger result lost/);assert.equal(dispatches,1);
 const retry=await f.client.resolveLedger(input);assert.equal(retry.outcome,'withdrawn');assert.equal(retry.idempotent,true);assert.deepEqual(retry.record.original,input.original);
});

test('client rejects ledger withdrawal mutations even with a recomputed record hash',async t=>{
 const f=await fixture(t),input=ledgerResolution(staleLedgerOriginal(f));
 for(const mutate of [v=>v.record.original.expectedCensusDigest='f'.repeat(64),v=>v.record.original.request.requestId='another-id',v=>v.record.binding.censusDigest='f'.repeat(64),v=>v.record.confirmation.requestDigest='f'.repeat(64),v=>v.record.previousHash='f'.repeat(64),v=>v.observedWithdrawalHead.headDigest='f'.repeat(64),v=>v.executionAuthorized=true,v=>v.submissionPersisted=true]){
  const client=createPlanningClient({fetchImpl:async(url,options)=>{const response=await f.fetchImpl(url,options);if(!String(url).endsWith('/resolve'))return response;const value=await response.json();mutate(value);const {recordHash,...body}=value.record;value.record.recordHash=createHash('sha256').update(canonical(body)).digest('hex');return new Response(JSON.stringify(value),{status:200});}});
  await assert.rejects(client.resolveLedger(input));
 }
});

test('client rejects substituted historical ledger original despite a coherent forged record',async t=>{
 const f=await fixture(t),original={ledger:f.ledger,request:{requestId:'ledger-first',expectedRevision:0,expectedHeadDigest:'GENESIS'},expectedCensusDigest:null};
 const before=await f.client.inspectLedger(f.ledger.binding);await f.client.submitLedger({ledger:f.ledger,request:{requestId:'later-original',expectedRevision:before.observedHead.hostRevision,expectedHeadDigest:before.observedHead.headDigest},expectedCensusDigest:f.ledger.binding.censusDigest});
 for(const change of ['request','ledger','authority','head']){
  const client=createPlanningClient({fetchImpl:async(url,options)=>{const response=await f.fetchImpl(url,options);if(!String(url).endsWith('/resolve'))return response;const value=await response.json();
   if(change==='request')value.submittedProposal.requestId='forged-id';
   if(change==='ledger'){value.submittedProposal.ledger.tasks[0].description='forged obligation';value.submittedProposal.ledgerDigest=createHash('sha256').update(canonical(value.submittedProposal.ledger)).digest('hex');value.submittedProposal.requestDigest=createHash('sha256').update(canonical({ledger:value.submittedProposal.ledger,expectedRevision:0,expectedHeadDigest:'GENESIS'})).digest('hex');value.receipt.submitted.ledgerDigest=value.submittedProposal.ledgerDigest;}
   if(change==='authority')value.receipt.approvalAuthorized=true;
   const {recordHash,...body}=value.submittedProposal;value.submittedProposal.recordHash=createHash('sha256').update(canonical(body)).digest('hex');value.receipt.submitted.headDigest=change==='head'?'f'.repeat(64):value.submittedProposal.recordHash;
   return new Response(JSON.stringify(value),{status:200});}});
  await assert.rejects(client.resolveLedger(ledgerResolution(original)));
 }
});
