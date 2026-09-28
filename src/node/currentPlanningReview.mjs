import {verifyPlanApprovalDraft} from '../project/planApprovalDraft.js';
import {canonicalArchitectureJson as canonical,deepFreezeArchitecture as freeze} from '../engine/architectureContractVerification.js';
import {createImportedProjectId} from '../project/projectIds.js';
import {withCurrentArchitectureContract} from './architectureContractStore.mjs';
import {withCurrentFolderContract} from './folderContractStore.mjs';
import {withStoredComponentPlans} from './componentPlanStore.mjs';
import {createPlanningLedgerCustody} from './planningLedgerCustody.mjs';

const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const fail=()=>{throw Error('CURRENT_PLANNING_REVIEW_REFUSED');};

// Host-only composition for a future approval writer, never a browser-supplied
// callback. Locks coordinate participating writers, not arbitrary filesystem
// edits. The callback must not reacquire any of these locks or call a publisher
// for a parent; it may acquire only the downstream approval lock.
// No approval, native registration, execution grant or enduring lease results
// merely from completing this check. Returned data is an observation, not a lock.
export async function withCurrentPlanningReview(root,input,operation){
 input=structuredClone(input);
 if(!exact(input,['proposal','expectedProposalHead'])||typeof operation!=='function')fail();
 const {proposal,expectedProposalHead}=input;
 if(!exact(expectedProposalHead,['hostRevision','headDigest'])||!Number.isSafeInteger(expectedProposalHead.hostRevision)||expectedProposalHead.hostRevision<1||typeof expectedProposalHead.headDigest!=='string'||!/^[a-f0-9]{64}$/.test(expectedProposalHead.headDigest))fail();
 if(!(await verifyPlanApprovalDraft(proposal)).valid||createImportedProjectId(proposal.binding.rootIdentity)!==proposal.binding.projectId)fail();
 if(proposal.dependencyReview.some(item=>item.status!=='ordered'))throw Error('CURRENT_PLANNING_DEPENDENCY_REVIEW_REQUIRED');
 const {binding,parents}=proposal,planId=binding.projectId;
 const expected=head=>({revision:head.revision,contractDigest:head.digest});
 const custody=createPlanningLedgerCustody({root});
 return withCurrentArchitectureContract(root,planId,expected(parents.architecture),architecture=>
  withCurrentFolderContract(root,planId,expected(parents.folder),folder=>{
   if(folder.architectureContractDigest!==architecture.contractDigest||folder.architectureRevision!==architecture.revision)fail();
   return withStoredComponentPlans(root,{planId,catalogRevision:parents.component.revision,contractDigest:parents.component.digest},catalog=>{
    if(canonical(catalog)!==canonical(proposal.catalog))fail();
    return custody.withCurrentProposal({binding,expectedHead:expectedProposalHead},retained=>{
     if(retained.proposal.ledgerDigest!==proposal.ledgerDigest||canonical(retained.proposal.ledger)!==canonical(proposal.ledger))fail();
     return operation(freeze({proposal,retainedProposal:retained.proposal,scope:'cooperating-writer-locked-review',approvalAuthorized:false,executionAuthorized:false,filesystemVerified:false}));
    });
   });
  },{actor:'current-planning-review'}),{actor:'current-planning-review'});
}
