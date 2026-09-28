import {createPlanningClient} from '../runtime/planningClient.js';
import {createTaskDraftStore} from './taskDraftStore.js';
import {createPlanningApprovalRecovery} from './planningApprovalRecovery.js';
import {createTaskFormRecovery} from './taskFormRecovery.js';
import {validateTaskDraftLedger,taskDraftBinding} from './taskDraftLedger.js';
import {canonicalArchitectureJson as wire} from '../engine/architectureContractVerification.js';

const noGrants={approvalAuthorized:false,executionAuthorized:false,filesystemVerified:false};
const parentRefs=context=>Object.fromEntries(['architecture','folder','component'].map(kind=>{const head=context[kind==='component'?'catalogHead':`${kind}Head`];return [kind,{revision:head?.revision,digest:head?.contractDigest}];}));
const stamp=project=>wire({state:project.state??null,registration:project.registration,census:project.census,parents:Object.fromEntries(['architecture','folder','component'].map(kind=>[kind,project.authorities?.[kind]??null]))});

// Ephemeral checked observation only. Never writes ProjectSession authority or
// confers an execution lease; every refresh checks the full saved draft again.
export function createPlanRefresh({registry,client=createPlanningClient(),store=createTaskDraftStore(),recovery=createPlanningApprovalRecovery(),formRecovery=createTaskFormRecovery(),getDirty=()=>false}={}){
 const sequences=new Map();let disposed=false;
 function invalidate(id){sequences.set(id,(sequences.get(id)??0)+1);}
 async function refresh(projectId){
  const project=registry.get(projectId);if(disposed||project?.kind!=='imported'||!project.registration||!project.census||registry.getSnapshot().activeProjectId!==projectId)return null;
  const binding=taskDraftBinding(project),identity=stamp(project),sequence=(sequences.get(projectId)??0)+1;sequences.set(projectId,sequence);
  const current=()=>!disposed&&sequences.get(projectId)===sequence&&registry.getSnapshot().activeProjectId===projectId&&registry.get(projectId)&&stamp(registry.get(projectId))===identity;
  const result=(status,extra={})=>({status,projectId,rootIdentity:binding.rootIdentity,censusDigest:binding.censusDigest,...noGrants,...extra});
  try{
   if(getDirty(projectId)||['stale','unavailable'].includes(project.state))return result('stale');
   const before=validateTaskDraftLedger(await store.read(binding));if(!current())return null;
   if(wire(before.binding)!==wire(binding)||before.revision<1)return result('stale');
   const pending=await recovery.inspect(binding);if(!current())return null;if(pending.pending)return result('pending');
   const forms=await formRecovery.list(binding);if(!current())return null;if(forms.records.some(record=>record.status==='unfinished'))return result('unfinished');
   const context=await client.readContext(projectId);if(!current())return null;
   if(context.state!=='ready'||context.catalogState!=='current')return result('stale');
   const parents=parentRefs(context);
   if(['architecture','folder','component'].some(kind=>project.authorities?.[kind]?.state!=='authoritative'||project.authorities[kind].revision!==parents[kind].revision||project.authorities[kind].digest!==parents[kind].digest))return result('stale');
   const history=await client.inspectApprovals(binding);if(!current())return null;if(!history.observedApprovalHead.revision)return result('missing');
   const checked=await client.inspectCurrent(binding,history.observedApprovalHead);if(!current())return null;
   const after=validateTaskDraftLedger(await store.read(binding));if(!current())return null;
   const contextAfter=await client.readContext(projectId);if(!current())return null;
   const recoveryAfter=await recovery.inspect(binding);if(!current())return null;if(recoveryAfter.pending)return result('pending');
   const formsAfter=await formRecovery.list(binding);if(!current())return null;if(formsAfter.records.some(record=>record.status==='unfinished'))return result('unfinished');
   const proposal=checked.record.proposal;
   if(getDirty(projectId)||contextAfter.state!=='ready'||contextAfter.catalogState!=='current'||wire(parentRefs(contextAfter))!==wire(parents)||wire(proposal.parents)!==wire(parents)||wire(before)!==wire(after)||wire(proposal.ledger)!==wire(after)||wire(proposal.binding)!==wire(binding))return result('stale');
   return result('observed',{revision:checked.record.revision,digest:checked.record.recordHash,ledgerRevision:after.revision,ledgerDigest:proposal.ledgerDigest,parents,checkedLedger:after});
  }catch{return current()?result('unavailable'):null;}
 }
 function subscribe(binding,listener){const releases=[store.subscribe?.(binding,listener),recovery.subscribe?.(binding,listener),formRecovery.subscribe?.(binding,listener)];return()=>releases.forEach(release=>release?.());}
 return {refresh,invalidate,subscribe,dispose(){disposed=true;sequences.clear();for(const target of [store,recovery,formRecovery]){try{Promise.resolve(target.close?.()).catch(()=>{});}catch{}}}};
}
