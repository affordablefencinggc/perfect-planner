import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createImportedProjectId} from '../src/project/projectIds.js';
import {currentComponentPlanInput} from '../src/engine/componentPlanSeed.js';
import {freezeArchitectureContract} from '../src/engine/rulebookEngine.js';
import {publishArchitectureContract,inspectArchitectureContracts} from '../src/node/architectureContractStore.mjs';
import {publishFolderContract} from '../src/node/folderContractStore.mjs';
import {publishComponentPlans,inspectComponentAuthoringContext} from '../src/node/componentPlanStore.mjs';
import {bindComponentParents,componentArchitectureInput} from './fixtures/componentParents.mjs';
import {createPlanningLedgerCustody} from '../src/node/planningLedgerCustody.mjs';
import {createPlanApprovalDraft} from '../src/project/planApprovalDraft.js';
import {withCurrentPlanningReview} from '../src/node/currentPlanningReview.mjs';

const at='2026-09-13T01:00:00.000Z',rootIdentity='a'.repeat(64),censusDigest='b'.repeat(64);
async function refuses(root,request){
 let calls=0;
 await assert.rejects(withCurrentPlanningReview(root,request,()=>{calls++;return 'must not reach callback';}));
 assert.equal(calls,0,'refusal must occur before the callback');
}
async function fixture(t,{dependency=false}={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'pp-current-planning-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const seed=structuredClone(currentComponentPlanInput);seed.planId=createImportedProjectId(rootIdentity);
 seed.components=seed.components.slice(0,2).map(component=>({...component,dependencies:[],fileClaims:component.fileClaims.map(file=>({...file,access:'read'}))}));seed.inventory=seed.inventory.slice(0,2);
 if(dependency)seed.components[1].dependencies=[{componentId:seed.components[0].id,reason:'Requires upstream result',critical:false}];
 const input=await bindComponentParents(root,seed);
 await publishComponentPlans(root,input,{planId:input.planId,expectedRevision:0,expectedHeadDigest:'GENESIS'},{actor:'fixture-owner',timestamp:at});
 const context=await inspectComponentAuthoringContext(root,input.planId,{actor:'fixture-owner'});
 const ledger={schemaVersion:1,kind:'LOCAL_DRAFT',binding:{projectId:input.planId,rootIdentity,censusDigest},revision:1,nextTaskNumber:4,updatedAt:at,tasks:context.catalog.components.map((component,index)=>({id:`T000${index+1}`,title:`Review ${component.name}`,description:'Retain the entire task obligation',owner:'fixture-owner',acceptance:'Verify exact output',recovery:'Keep original work',claims:component.fileClaims.map(({path,access})=>({path,access})),dependsOn:[],archived:false}))};
 ledger.tasks.push({id:'T0003',title:'Retained archived task',description:'Do not discard archived obligations',owner:'fixture-owner',acceptance:'Preserved',recovery:'Restore original',claims:[],dependsOn:[],archived:true});
 const custody=createPlanningLedgerCustody({root});
 const retained=await custody.submit({ledger,request:{requestId:'first',expectedRevision:0,expectedHeadDigest:'GENESIS'},expectedCensusDigest:null});
 const draftInput={ledger,parents:{architecture:{revision:context.architectureHead.revision,digest:context.architectureHead.contractDigest},folder:{revision:context.folderHead.revision,digest:context.folderHead.contractDigest},component:{revision:context.catalogHead.revision,digest:context.catalogHead.contractDigest}},catalog:context.catalog,mappings:context.catalog.components.map((component,index)=>({taskId:`T000${index+1}`,componentIds:[component.id]}))};
 const proposal=await createPlanApprovalDraft(draftInput);
 return {root,input,context,ledger,custody,draftInput,request:{proposal,expectedProposalHead:retained.observedHead}};
}

test('current full proposal reaches a frozen host callback without approval or execution',async t=>{
 const f=await fixture(t);let calls=0;
 const result=await withCurrentPlanningReview(f.root,f.request,value=>{calls++;assert.equal(value.scope,'cooperating-writer-locked-review');assert.equal(value.approvalAuthorized,false);assert.equal(value.executionAuthorized,false);assert.equal(value.filesystemVerified,false);assert.deepEqual(value.proposal,f.request.proposal);assert.deepEqual(value.retainedProposal.ledger,f.ledger);assert.equal(Object.isFrozen(value),true);assert.equal(Object.isFrozen(value.proposal.ledger.tasks[0]),true);return 'reviewed-only';});
 assert.equal(calls,1);assert.equal(result,'reviewed-only');
 assert.equal((await f.custody.inspect({binding:f.ledger.binding})).observedHead.hostRevision,1);
});
test('advanced architecture prevents callback',async t=>{
 const f=await fixture(t),input=componentArchitectureInput();input.nonFunctional.performanceBudget='startup P80 <1s';
 const contract=await freezeArchitectureContract(input,{planId:f.input.planId,actor:'fixture-owner',approvedAt:at});
 await publishArchitectureContract(f.root,contract,{actor:'fixture-owner',supersedes:f.context.architectureHead.contractDigest});
 await refuses(f.root,f.request);
});
test('advanced folder prevents callback',async t=>{
 const f=await fixture(t),binding={architectureContractDigest:f.context.architectureHead.contractDigest,architectureRevision:f.context.architectureHead.revision};
 const nodes=structuredClone(f.context.folderNodes);nodes[0].purpose+=' revised';
 await publishFolderContract(f.root,{schemaVersion:1,planId:f.input.planId,...binding,workspaceMode:'private',nodes},{planId:f.input.planId,...binding,expectedRevision:f.context.folderHead.revision,expectedHeadDigest:f.context.folderHead.contractDigest},{actor:'fixture-owner',timestamp:at});
 await refuses(f.root,f.request);
});
test('advanced component catalog prevents callback',async t=>{
 const f=await fixture(t),input=structuredClone(f.input);input.components[0].purpose+=' revised';
 await publishComponentPlans(f.root,input,{planId:input.planId,expectedRevision:f.context.catalogHead.revision,expectedHeadDigest:f.context.catalogHead.contractDigest},{actor:'fixture-owner',timestamp:at});
 await refuses(f.root,f.request);
});
test('tampered ledger and census packets never reach callback',async t=>{
 const f=await fixture(t);
 for(const mutate of [p=>p.ledger.tasks[0].description='tampered',p=>p.binding.censusDigest='f'.repeat(64),p=>p.executionAuthorized=true]){const request=structuredClone(f.request);mutate(request.proposal);await refuses(f.root,request);}
});
test('wrong proposal head revision or digest refuses callback',async t=>{
 const f=await fixture(t);
 for(const patch of [{hostRevision:2},{headDigest:'f'.repeat(64)}])await refuses(f.root,{...f.request,expectedProposalHead:{...f.request.expectedProposalHead,...patch}});
});
test('valid locally rebuilt packet cannot replace retained full ledger',async t=>{
 const f=await fixture(t);
 for(const mutate of [input=>input.ledger.tasks[0].description='Different complete obligation',input=>input.ledger.binding.censusDigest='c'.repeat(64)]){const input=structuredClone(f.draftInput);mutate(input);const proposal=await createPlanApprovalDraft(input);await refuses(f.root,{...f.request,proposal});}
});
test('new retained ledger head makes original review historical',async t=>{
 const f=await fixture(t),ledger=structuredClone(f.ledger);ledger.revision=2;ledger.tasks[0].description+=' revised';
 await f.custody.submit({ledger,request:{requestId:'second',expectedRevision:f.request.expectedProposalHead.hostRevision,expectedHeadDigest:f.request.expectedProposalHead.headDigest},expectedCensusDigest:censusDigest});
 await refuses(f.root,f.request);
});
test('unresolved component ordering blocks the host review callback',async t=>{
 const f=await fixture(t,{dependency:true});assert.equal(f.request.proposal.dependencyReview[0].status,'ordering-review-required');
 await refuses(f.root,f.request);
});
test('callback failure releases locks for a subsequent current review',async t=>{
 const f=await fixture(t);await assert.rejects(withCurrentPlanningReview(f.root,f.request,()=>{throw Error('callback failure');}),/callback failure/);
 assert.equal(await withCurrentPlanningReview(f.root,f.request,()=>true),true);
});
test('missing authority root state produces no proposal or approval files',async t=>{
 const f=await fixture(t),empty=await mkdtemp(path.join(os.tmpdir(),'pp-current-planning-empty-'));t.after(()=>rm(empty,{recursive:true,force:true}));
 await refuses(empty,f.request);
 assert.deepEqual(await readdir(empty),[]);
});
test('parent publisher is lock-refused during callback and succeeds after release',async t=>{
 const f=await fixture(t),input=componentArchitectureInput();input.nonFunctional.performanceBudget='startup P80 <500ms';
 const contract=await freezeArchitectureContract(input,{planId:f.input.planId,actor:'fixture-owner',approvedAt:at});
 let entered,release;const enteredPromise=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 const reviewing=withCurrentPlanningReview(f.root,f.request,async()=>{entered();await gate;return 'finished callback';});
 await enteredPromise;
 try{
  // Zero timeout checks the actual held lock, not a sleep-based inference.
  await assert.rejects(publishArchitectureContract(f.root,contract,{actor:'fixture-owner',supersedes:f.context.architectureHead.contractDigest,timeoutMs:0}),/Plan lock timeout/);
  assert.equal((await inspectArchitectureContracts(f.root,f.input.planId)).head.contractDigest,f.context.architectureHead.contractDigest);
 }finally{release();await reviewing;}
 const published=await publishArchitectureContract(f.root,contract,{actor:'fixture-owner',supersedes:f.context.architectureHead.contractDigest});
 assert.equal(published.revision,f.context.architectureHead.revision+1);
});
