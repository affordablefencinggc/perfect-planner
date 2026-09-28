import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,mkdir,symlink,link} from 'node:fs/promises';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import {planningApprovalFixture} from './fixtures/planningApproval.mjs';
import {componentArchitectureInput} from './fixtures/componentParents.mjs';
import {freezeArchitectureContract} from '../src/engine/rulebookEngine.js';
import {publishArchitectureContract} from '../src/node/architectureContractStore.mjs';
import {publishFolderContract} from '../src/node/folderContractStore.mjs';
import {publishComponentPlans} from '../src/node/componentPlanStore.mjs';
import {createPlanApprovalStore} from '../src/node/planApprovalStore.mjs';
const at='2026-09-13T01:00:00.000Z';
async function fixture(t){const f=await planningApprovalFixture(t);return {...f,request:f.publishInput,store:createPlanApprovalStore(f.config),journal:path.join(f.root,f.projectId,'plan-approvals.jsonl')};}
async function advanceArchitecture(f){const input=componentArchitectureInput();input.nonFunctional.performanceBudget='startup P80 <500ms';const contract=await freezeArchitectureContract(input,{planId:f.projectId,actor:'fixture-owner',approvedAt:at});return publishArchitectureContract(f.root,contract,{actor:'fixture-owner',supersedes:f.context.architectureHead.contractDigest});}
const nextRequest=(f,head,id='approval-next')=>({...f.request,request:{requestId:id,expectedRevision:head.revision,expectedHeadDigest:head.headDigest}});

test('full approval record survives reopen without converting history into current approval',async t=>{
 const f=await fixture(t),result=await f.store.publish(f.request);
 assert.equal(result.idempotent,false);assert.equal(result.currentParentsChecked,true);assert.equal(result.matchesObservedApprovalHead,true);
 assert.equal(result.record.kind,'PLAN_APPROVAL_RECORD');assert.equal(result.record.planApprovalRecorded,true);assert.deepEqual(result.record.proposal,f.proposal);assert.deepEqual(result.record.expectedProposalHead,f.expectedProposalHead);assert.deepEqual(result.record.confirmation,f.request.confirmation);assert.equal(result.record.proposal.ledger.tasks[2].archived,true);
 assert.equal(result.record.actor,f.config.actor);assert.equal(result.record.source,f.config.source);assert.equal(Number.isFinite(Date.parse(result.record.approvedAt)),true);for(const key of ['executionAuthorized','nativeApprovalAuthorized','filesystemVerified']){assert.equal(result[key],false);assert.equal(result.record[key],false);}
 const reopened=await createPlanApprovalStore(f.config).inspect();assert.deepEqual(reopened.records,[result.record]);assert.deepEqual(reopened.observedApprovalHead,result.observedApprovalHead);assert.equal(reopened.currentParentsChecked,false);for(const key of ['executionAuthorized','nativeApprovalAuthorized','filesystemVerified'])assert.equal(reopened[key],false);
});
test('exact original retry retains one approval and does not recheck parents',async t=>{
 const f=await fixture(t),first=await f.store.publish(f.request),retry=await f.store.publish(f.request);assert.equal(retry.idempotent,true);assert.deepEqual(retry.record,first.record);assert.equal(retry.currentParentsChecked,false);assert.equal((await f.store.inspect()).records.length,1);
});
test('reused operation ID with altered request is refused',async t=>{
 const f=await fixture(t);await f.store.publish(f.request);const changed=structuredClone(f.request);changed.expectedProposalHead.hostRevision++;
 await assert.rejects(f.store.publish(changed));assert.equal((await f.store.inspect()).records.length,1);
});
test('stale approval CAS refuses without appending',async t=>{
 const f=await fixture(t);await f.store.publish(f.request);await assert.rejects(f.store.publish({...f.request,request:{...f.request.request,requestId:'stale'}}));assert.equal((await f.store.inspect()).records.length,1);
});
test('each advanced parent refuses a new approval',async t=>{
 for(const kind of ['architecture','folder','component']){
  const f=await fixture(t);
  if(kind==='architecture')await advanceArchitecture(f);
  if(kind==='folder'){const binding={architectureContractDigest:f.context.architectureHead.contractDigest,architectureRevision:f.context.architectureHead.revision},nodes=structuredClone(f.context.folderNodes);nodes[0].purpose+=' changed';await publishFolderContract(f.root,{schemaVersion:1,planId:f.projectId,...binding,workspaceMode:'private',nodes},{planId:f.projectId,...binding,expectedRevision:f.context.folderHead.revision,expectedHeadDigest:f.context.folderHead.contractDigest},{actor:'fixture-owner',timestamp:at});}
  if(kind==='component'){const input=structuredClone(f.input);input.components[0].purpose+=' changed';await publishComponentPlans(f.root,input,{planId:f.projectId,expectedRevision:f.context.catalogHead.revision,expectedHeadDigest:f.context.catalogHead.contractDigest},{actor:'fixture-owner',timestamp:at});}
  await assert.rejects(f.store.publish(f.request));assert.equal((await f.store.inspect()).records.length,0);
 }
});
test('advanced retained ledger refuses original review as a new approval',async t=>{
 const f=await fixture(t),ledger=structuredClone(f.ledger);ledger.revision++;ledger.tasks[0].description+=' changed';await f.custody.submit({ledger,request:{requestId:'ledger-next',expectedRevision:f.expectedProposalHead.hostRevision,expectedHeadDigest:f.expectedProposalHead.headDigest},expectedCensusDigest:f.ledger.binding.censusDigest});
 await assert.rejects(f.store.publish(f.request));assert.equal((await f.store.inspect()).records.length,0);
});
test('explicit confirmation must match reviewed digest and approve decision',async t=>{
 const f=await fixture(t);for(const confirmation of [{proposalDigest:'f'.repeat(64),decision:'approve'},{proposalDigest:f.proposal.digest,decision:'reject'},null])await assert.rejects(f.store.publish({...f.request,confirmation}));assert.equal((await f.store.inspect()).records.length,0);
});
test('concurrent identical submissions produce one original and one retry',async t=>{
 const f=await fixture(t),results=await Promise.all([f.store.publish(f.request),f.store.publish(f.request)]);assert.equal(results.filter(r=>r.idempotent).length,1);assert.equal((await f.store.inspect()).records.length,1);
});
test('concurrent different requests using same CAS have one winner',async t=>{
 const f=await fixture(t),other={...f.request,request:{...f.request.request,requestId:'competitor'}},results=await Promise.allSettled([f.store.publish(f.request),f.store.publish(other)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal((await f.store.inspect()).records.length,1);
});
test('old retry after successor and parent advancement stays historical and unchecked',async t=>{
 const f=await fixture(t),first=await f.store.publish(f.request),second=await f.store.publish(nextRequest(f,first.observedApprovalHead));await advanceArchitecture(f);
 const retry=await f.store.publish(f.request);assert.equal(retry.idempotent,true);assert.deepEqual(retry.record,first.record);assert.deepEqual(retry.observedApprovalHead,second.observedApprovalHead);assert.equal(retry.matchesObservedApprovalHead,false);assert.equal(retry.currentParentsChecked,false);assert.equal((await f.store.inspect()).records.length,2);
});
test('corrupt approval bytes are retained and never replaced',async t=>{
 const f=await fixture(t);await f.store.publish(f.request);const original=await readFile(f.journal,'utf8'),corrupt=original.replace('Retained archived task','Tampered archived task');assert.notEqual(corrupt,original);await writeFile(f.journal,corrupt);await assert.rejects(f.store.inspect());await assert.rejects(f.store.publish(f.request));assert.equal(await readFile(f.journal,'utf8'),corrupt);
});
test('record and byte quotas preserve previous records',async t=>{
 const f=await fixture(t),limited=createPlanApprovalStore({...f.config,maxRecords:1}),first=await limited.publish(f.request),original=await readFile(f.journal,'utf8');await assert.rejects(limited.publish(nextRequest(f,first.observedApprovalHead)));assert.equal(await readFile(f.journal,'utf8'),original);
 const g=await fixture(t),tiny=createPlanApprovalStore({...g.config,maxBytes:1});await assert.rejects(tiny.publish(g.request));assert.equal((await g.store.inspect()).records.length,0);
});
test('publication captures mutable input before awaiting',async t=>{
 const f=await fixture(t),input=structuredClone(f.request),pending=f.store.publish(input);input.proposal.ledger.tasks[0].title='Late mutation';input.request.requestId='late';input.confirmation.decision='reject';const result=await pending;assert.deepEqual(result.record.proposal,f.proposal);assert.equal(result.record.request.requestId,'approval-first');
});
test('linked authority directory refuses without writing target',async t=>{
 const f=await fixture(t),target=path.join(f.root,'outside');await mkdir(target);const targetProject=path.join(target,f.projectId);await mkdir(targetProject);const linked=path.join(f.root,'linked');await symlink(target,linked,process.platform==='win32'?'junction':'dir');const store=createPlanApprovalStore({...f.config,root:linked});await assert.rejects(store.inspect(),/PLAN_APPROVAL_UNSAFE_PATH/);await assert.rejects(store.publish(f.request),/PLAN_APPROVAL_UNSAFE_PATH/);assert.deepEqual(await readdir(targetProject),[]);assert.deepEqual(await readdir(target),[f.projectId]);
});
test('hardlinked journal refuses read and publication without changing bytes',async t=>{
 const f=await fixture(t);await f.store.publish(f.request);const original=await readFile(f.journal,'utf8');await link(f.journal,path.join(f.root,'retained-copy'));await assert.rejects(f.store.inspect());await assert.rejects(f.store.publish(f.request));assert.equal(await readFile(f.journal,'utf8'),original);
});
test('reopened current inspection checks persisted record and exact parents',async t=>{
 const f=await fixture(t),published=await f.store.publish(f.request),reopened=createPlanApprovalStore(f.config),current=await reopened.inspectCurrent({expectedApprovalHead:published.observedApprovalHead});
 assert.deepEqual(current.record,published.record);assert.deepEqual(current.observedApprovalHead,published.observedApprovalHead);assert.equal(current.currentParentsChecked,true);for(const key of ['executionAuthorized','nativeApprovalAuthorized','filesystemVerified'])assert.equal(current[key],false);
});
test('current inspection refuses stale parent but historical record remains readable',async t=>{
 const f=await fixture(t),published=await f.store.publish(f.request);await advanceArchitecture(f);
 await assert.rejects(f.store.inspectCurrent({expectedApprovalHead:published.observedApprovalHead}));const history=await f.store.inspect();assert.deepEqual(history.records,[published.record]);assert.equal(history.currentParentsChecked,false);
});
test('current inspection rejects wrong or superseded approval head',async t=>{
 const f=await fixture(t),first=await f.store.publish(f.request);
 for(const patch of [{revision:0},{revision:2},{headDigest:'f'.repeat(64)}])await assert.rejects(f.store.inspectCurrent({expectedApprovalHead:{...first.observedApprovalHead,...patch}}));
 const second=await f.store.publish(nextRequest(f,first.observedApprovalHead));await assert.rejects(f.store.inspectCurrent({expectedApprovalHead:first.observedApprovalHead}));assert.deepEqual((await f.store.inspectCurrent({expectedApprovalHead:second.observedApprovalHead})).record,second.record);
});
test('failed flush stays uncertain until original retry syncs the same retained bytes',async t=>{
 const f=await fixture(t),actualOpen=fs.open;let failSync=true,syncCalls=0;
 const mocked=t.mock.method(fs,'open',async(...args)=>{const handle=await actualOpen(...args);if(args[0]===f.journal){const actualSync=handle.sync.bind(handle);handle.sync=async()=>{syncCalls++;if(failSync)throw Error('Controlled approval sync failure');return actualSync();};}return handle;});
 syncBuiltinESMExports();
 try{
  await assert.rejects(f.store.publish(f.request),/Controlled approval sync failure/);
  const retained=await f.store.inspect(),bytes=await readFile(f.journal,'utf8');assert.equal(retained.records.length,1);
  await assert.rejects(f.store.publish(f.request),/Controlled approval sync failure/);assert.equal(await readFile(f.journal,'utf8'),bytes);
  failSync=false;const retried=await f.store.publish(f.request);assert.equal(retried.idempotent,true);assert.equal(retried.currentParentsChecked,false);assert.deepEqual(retried.record,retained.records[0]);assert.equal(syncCalls,3);assert.equal(await readFile(f.journal,'utf8'),bytes);assert.equal((await f.store.inspect()).records.length,1);
 }finally{mocked.mock.restore();syncBuiltinESMExports();}
});
