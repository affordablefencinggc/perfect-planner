import {createHash} from 'node:crypto';
import {resolveRegisteredWorkspace} from './perfectPlannerMcpCore.mjs';
import {createImportedProjectId} from '../src/project/projectIds.js';
import {validateTaskDraftLedger,inspectTaskDraft} from '../src/project/taskDraftLedger.js';

// Preparation only: no filesystem write, UI database access, approval or execution.
// The existing UI import checks its current census binding before accepting tasks.
export async function preparePlannerDraft(registryRoot, workspaceId, input) {
  const ledger=validateTaskDraftLedger(structuredClone(input));
  const registration=await resolveRegisteredWorkspace(registryRoot,workspaceId);
  if(ledger.binding.rootIdentity!==registration.rootIdentity || ledger.binding.projectId!==createImportedProjectId(registration.rootIdentity))throw Error('PLANNER_DRAFT_FOREIGN_PROJECT');
  if(!ledger.tasks.length)throw Error('PLANNER_DRAFT_EMPTY');
  const review=inspectTaskDraft(ledger);
  const current=await resolveRegisteredWorkspace(registryRoot,workspaceId);
  if(current.rootIdentity!==registration.rootIdentity || current.registryRevision!==registration.registryRevision)throw Error('PLANNER_DRAFT_REGISTRATION_CHANGED');
  const draftJson=JSON.stringify(ledger,null,2);
  return {schemaVersion:1,kind:'PLANNER_DRAFT_HANDOFF',workspaceId,registryRevision:registration.registryRevision,
    projectId:ledger.binding.projectId,taskCount:ledger.tasks.length,sha256:createHash('sha256').update(draftJson).digest('hex'),
    draftJson,planningFindings:review.findings,approvalState:'unapproved-proposal',executionAuthorized:false,
    savedToPlanner:false,censusBindingVerified:false,
    nextAction:'Save draftJson as a JSON file, then in this project open Ledger > Import an exported draft. Review the task copies and import them. The UI rejects mismatched inventory. This tool has not updated the live ledger.'};
}
