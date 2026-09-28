import {validateTaskDraftLedger,inspectTaskDraft} from './taskDraftLedger.js';
import {verifyComponentPlans} from '../engine/componentPlanEngine.js';
import {COMPONENT_DRAFT_COMPONENT_LIMIT} from '../engine/componentDraftModel.js';
import {canonicalArchitectureJson as canonical,architectureSha256 as sha256,deepFreezeArchitecture as freeze} from '../engine/architectureContractVerification.js';

export const PLAN_REVIEW_BYTES=8*1024*1024;
const fail=message=>{throw Error(`Plan review proposal refused: ${message}`);};
const exact=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('|')!==[...keys].sort().join('|'))fail('unsupported shape');};
const bounded=value=>{const wire=canonical(value);if(new TextEncoder().encode(wire).length>PLAN_REVIEW_BYTES)fail('size limit');return wire;};
const validHead=head=>{exact(head,['revision','digest']);if(!Number.isSafeInteger(head.revision)||head.revision<1||typeof head.digest!=='string'||!/^[a-f0-9]{64}$/.test(head.digest))fail('invalid parent');};

// Content integrity and review compatibility only. Supplied heads are not live
// authority, authenticated signatures, folder access, approval or worker grants.
export async function createPlanApprovalDraft(input){
 const snapshot=structuredClone(input);bounded(snapshot);exact(snapshot,['ledger','parents','catalog','mappings']);
 const {parents,catalog,mappings}=snapshot,ledger=validateTaskDraftLedger(snapshot.ledger);
 // Positive local revision is necessary, not proof of durable host custody.
 if(ledger.revision<1)fail('positive saved draft revision required');
 if(canonical(ledger)!==canonical(snapshot.ledger))fail('ledger must already be canonical; original draft was not changed');
 exact(parents,['architecture','folder','component']);Object.values(parents).forEach(validHead);
 if(catalog?.planId!==ledger.binding.projectId||catalog.digest!==parents.component.digest||catalog.architectureDigest!==parents.architecture.digest||catalog.architectureRevision!==parents.architecture.revision||catalog.folderDigest!==parents.folder.digest||catalog.folderRevision!==parents.folder.revision)fail('catalog parent binding mismatch');
 if(!Array.isArray(catalog.components)||!Array.isArray(catalog.inventory)||catalog.components.length>COMPONENT_DRAFT_COMPONENT_LIMIT||catalog.inventory.length>COMPONENT_DRAFT_COMPONENT_LIMIT)fail('catalog component count limit');
 if(!(await verifyComponentPlans(catalog)).valid)fail('catalog content invalid');
 const review=inspectTaskDraft(ledger);if(!review.activeTasks||review.findings.length)fail('ledger has unresolved planning findings');
 const active=ledger.tasks.filter(task=>!task.archived),tasks=new Map(active.map(task=>[task.id,task])),components=new Map(catalog.components.map(component=>[component.id,component]));
 if(!Array.isArray(mappings)||mappings.length!==active.length)fail('every active task needs an explicit mapping');
 const byTask=new Map(),byComponent=new Map([...components.keys()].map(id=>[id,[]]));
 for(const mapping of mappings){exact(mapping,['taskId','componentIds']);if(!tasks.has(mapping.taskId)||byTask.has(mapping.taskId)||!Array.isArray(mapping.componentIds)||!mapping.componentIds.length||mapping.componentIds.length>components.size||new Set(mapping.componentIds).size!==mapping.componentIds.length)fail('duplicate, unknown or missing task mapping');
  for(const id of mapping.componentIds){if(!components.has(id))fail('unknown component mapping');byComponent.get(id).push(mapping.taskId);}
  byTask.set(mapping.taskId,mapping.componentIds);
  for(const claim of tasks.get(mapping.taskId).claims)if(!mapping.componentIds.some(id=>components.get(id).fileClaims.some(file=>file.path===claim.path&&(claim.access==='read'||file.access==='write'))))fail('task claim exceeds mapped component claims');
 }
 if([...byComponent.values()].some(ids=>!ids.length))fail('catalog component has no active task coverage');
 for(const component of components.values())for(const file of component.fileClaims)if(!byComponent.get(component.id).some(id=>tasks.get(id).claims.some(claim=>claim.path===file.path&&(file.access==='read'||claim.access==='write'))))fail('component file claim has no compatible active task coverage');
 const ancestry=new Map();
 for(const task of active){const ancestors=new Set(),pending=[...task.dependsOn];while(pending.length){const id=pending.pop();if(ancestors.has(id))continue;ancestors.add(id);pending.push(...tasks.get(id).dependsOn);}ancestry.set(task.id,ancestors);}
 // Dependency relationships do not invent an execution order. Unresolved or
 // intra-task ordering is explicit review work for the eventual approval gate.
 const dependencyReview=[];
 for(const component of components.values())for(const dependency of component.dependencies??[]){const taskIds=byComponent.get(component.id),prerequisiteTaskIds=byComponent.get(dependency.componentId);dependencyReview.push({componentId:component.id,dependsOnComponentId:dependency.componentId,taskIds:[...taskIds],prerequisiteTaskIds:[...prerequisiteTaskIds],status:taskIds.some(id=>prerequisiteTaskIds.includes(id))?'within-task-review-required':taskIds.every(id=>prerequisiteTaskIds.every(required=>ancestry.get(id).has(required)))?'ordered':'ordering-review-required'});}
 const body={schemaVersion:1,kind:'PLAN_REVIEW_PROPOSAL',binding:{...ledger.binding},ledger,ledgerDigest:await sha256(canonical(ledger)),parents,catalog,mappings,dependencyReview,approvalAuthorized:false,executionAuthorized:false};
 const proposal={...body,digest:await sha256(bounded(body))};bounded(proposal);return freeze(proposal);
}

export async function verifyPlanApprovalDraft(proposal){
 try{proposal=structuredClone(proposal);bounded(proposal);exact(proposal,['schemaVersion','kind','binding','ledger','ledgerDigest','parents','catalog','mappings','dependencyReview','approvalAuthorized','executionAuthorized','digest']);
  const recreated=await createPlanApprovalDraft({ledger:proposal.ledger,parents:proposal.parents,catalog:proposal.catalog,mappings:proposal.mappings});
  return {valid:canonical(recreated)===canonical(proposal)};
 }catch{return {valid:false};}
}
