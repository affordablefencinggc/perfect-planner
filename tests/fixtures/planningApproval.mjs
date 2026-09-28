import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createImportedProjectId} from '../../src/project/projectIds.js';
import {currentComponentPlanInput} from '../../src/engine/componentPlanSeed.js';
import {publishComponentPlans,inspectComponentAuthoringContext} from '../../src/node/componentPlanStore.mjs';
import {bindComponentParents} from './componentParents.mjs';
import {createPlanningLedgerCustody} from '../../src/node/planningLedgerCustody.mjs';
import {createPlanApprovalDraft} from '../../src/project/planApprovalDraft.js';

const at='2026-09-13T01:00:00.000Z',rootIdentity='a'.repeat(64),censusDigest='b'.repeat(64);
export async function planningApprovalFixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'pp-plan-approval-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const seed=structuredClone(currentComponentPlanInput);seed.planId=createImportedProjectId(rootIdentity);
 seed.components=seed.components.slice(0,2).map(component=>({...component,dependencies:[],fileClaims:component.fileClaims.map(file=>({...file,access:'read'}))}));seed.inventory=seed.inventory.slice(0,2);
 const input=await bindComponentParents(root,seed);
 await publishComponentPlans(root,input,{planId:input.planId,expectedRevision:0,expectedHeadDigest:'GENESIS'},{actor:'fixture-owner',timestamp:at});
 const context=await inspectComponentAuthoringContext(root,input.planId,{actor:'fixture-owner'});
 const ledger={schemaVersion:1,kind:'LOCAL_DRAFT',binding:{projectId:input.planId,rootIdentity,censusDigest},revision:1,nextTaskNumber:4,updatedAt:at,tasks:context.catalog.components.map((component,index)=>({id:`T000${index+1}`,title:`Review ${component.name}`,description:'Retain the entire task obligation',owner:'fixture-owner',acceptance:'Verify exact output',recovery:'Keep original work',claims:component.fileClaims.map(({path,access})=>({path,access})),dependsOn:[],archived:false}))};
 ledger.tasks.push({id:'T0003',title:'Retained archived task',description:'Do not discard archived obligations',owner:'fixture-owner',acceptance:'Preserved',recovery:'Restore original',claims:[],dependsOn:[],archived:true});
 const custody=createPlanningLedgerCustody({root});
 const retained=await custody.submit({ledger,request:{requestId:'ledger-first',expectedRevision:0,expectedHeadDigest:'GENESIS'},expectedCensusDigest:null});
 const draftInput={ledger,parents:{architecture:{revision:context.architectureHead.revision,digest:context.architectureHead.contractDigest},folder:{revision:context.folderHead.revision,digest:context.folderHead.contractDigest},component:{revision:context.catalogHead.revision,digest:context.catalogHead.contractDigest}},catalog:context.catalog,mappings:context.catalog.components.map((component,index)=>({taskId:`T000${index+1}`,componentIds:[component.id]}))};
 const proposal=await createPlanApprovalDraft(draftInput);
 const config={root,projectId:input.planId,rootIdentity,actor:'fixture-owner',source:'test-host'};
 const request={proposal,expectedProposalHead:retained.observedHead,request:{requestId:'approval-first',expectedRevision:0,expectedHeadDigest:'GENESIS'},confirmation:{proposalDigest:proposal.digest,decision:'approve'}};
 return {root,projectId:input.planId,rootIdentity,proposal,expectedProposalHead:retained.observedHead,publishInput:request,input,context,ledger,custody,draftInput,config};
}
