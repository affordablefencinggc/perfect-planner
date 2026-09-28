import path from 'node:path';
import {validateInstalledTaskCheckProfileProvision,validateInstalledTaskCheckProfile,prepareInstalledTaskCheckProfile} from './installedTaskCheckProfile.mjs';
import {createTaskLedgerAuthorityStore} from './taskLedgerAuthorityStore.mjs';
import {createTaskCheckContractStore} from './taskCheckContractStore.mjs';
import {createInstalledTaskCheckProfileEvidenceStore} from './installedTaskCheckProfileEvidence.mjs';
import {validateTaskDraftBinding,sameTaskDraftBinding} from '../project/taskDraftLedger.js';
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
// Construction captures native-owned configuration only. All filesystem
// observations and writes happen inside the explicit tracked prepare dispatch.
export function createInstalledTaskCheckPreparation({provision,installed,proposalConfig,registeredBinding,actor,source,stateDirectory}){
 provision=validateInstalledTaskCheckProfileProvision(provision);installed=structuredClone(installed);proposalConfig=structuredClone(proposalConfig);
 if(typeof registeredBinding!=='function'||typeof stateDirectory!=='string'||!path.isAbsolute(stateDirectory)||path.normalize(stateDirectory)!==stateDirectory||stateDirectory.includes('\0'))throw Error('INSTALLED_CHECK_PREPARATION_CONFIG_INVALID');
 const storeConfig={journalPath:path.join(stateDirectory,`${proposalConfig.projectId}.check-contracts.jsonl`),proposalConfig,registeredBinding,actor,source};
 const proposals=createTaskLedgerAuthorityStore(proposalConfig),evidence=createInstalledTaskCheckProfileEvidenceStore({directory:path.join(stateDirectory,'check-profile-evidence')}),contracts=createTaskCheckContractStore(storeConfig);
 return Object.freeze({
 async inspectChecks(payload){
  payload=structuredClone(payload);
  if(!exact(payload,['requestId'])||(payload.requestId!==null&&(typeof payload.requestId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(payload.requestId))))throw Error('INSTALLED_CHECK_INSPECTION_INPUT_INVALID');
  const before=validateTaskDraftBinding(structuredClone(await registeredBinding()));
  if(before.projectId!==proposalConfig.projectId||before.rootIdentity!==proposalConfig.rootIdentity)throw Error('INSTALLED_CHECK_INSPECTION_REGISTRATION_CHANGED');
  const state=await contracts.inspect();
  const after=validateTaskDraftBinding(structuredClone(await registeredBinding()));
  if(!sameTaskDraftBinding(before,after))throw Error('INSTALLED_CHECK_INSPECTION_REGISTRATION_CHANGED');
  const record=payload.requestId===null?null:state.history.find(r=>r.request.requestId===payload.requestId);
  // Historical receipts remain historical: reading does not regenerate tool
  // evidence, reconcile a pending original, approve work, or select a contract.
  const original=record?{binding:record.snapshot.binding,request:record.request,contractHead:{revision:record.revision,headDigest:record.recordHash},contractDigest:record.snapshot.contract.contractDigest,policyDigest:record.snapshot.contract.policyDigest,proposalHead:record.snapshot.proposal,matchesObservedContractHead:record.revision===state.revision&&record.recordHash===state.headDigest,observationEvidenceVerified:false}:null;
  return freeze({schemaVersion:1,binding:before,contractHead:{revision:state.revision,headDigest:state.headDigest},requestedOriginalId:payload.requestId,original,registrationLeaseHeld:false,executionAuthorized:false});
 },
 async resolveReview(selection){
  // Native-owner selection only: no new contract, confirmation or execution.
  // Both heads stay locked while retained evidence and current observations
  // are checked. Later review/decision reacquires the same exact custody.
  selection=structuredClone(selection);
  if(!exact(selection,['expected','contractHead']))throw Error('INSTALLED_CHECK_SELECTION_INVALID');
  return contracts.withCurrentContract(selection.expected,selection.contractHead,async({record,proposal})=>{
   const saved=record.snapshot.contract;
   const checkProfileEvidence=await evidence.read(saved.policyDigest);
   const profile={...provision,expectedProposal:selection.expected,request:{requestId:'review-observation-only',expectedRevision:0,expectedHeadDigest:'GENESIS'}};
   const current=await prepareInstalledTaskCheckProfile({profile,installed,proposal});
   if(current.contract.contractDigest!==saved.contractDigest)throw Error('INSTALLED_CHECK_SELECTION_OBSERVATION_CHANGED');
   return freeze({checkContract:saved,checkProfileEvidence,contractCustody:{storeConfig,expectedHead:selection.contractHead},toolchainVerified:false,candidateVerified:false,executionAuthorized:false,registrationLeaseHeld:false});
  });
 },async prepareChecks(payload){
  payload=structuredClone(payload);if(!exact(payload,['expected','request']))throw Error('INSTALLED_CHECK_PREPARATION_INPUT_INVALID');
  const profile=validateInstalledTaskCheckProfile({...provision,expectedProposal:payload.expected,request:payload.request});
  const prepared=await proposals.withCurrentProposal(profile.expectedProposal,proposal=>prepareInstalledTaskCheckProfile({profile,installed,proposal}));
  await evidence.retain(prepared.evidence,prepared.contract.policyDigest);
  const retained=await contracts.retain(profile.expectedProposal,prepared.contract,profile.request);
  await evidence.read(retained.record.snapshot.contract.policyDigest);
  // A changed project/tool observation on retry may leave nonauthoritative
  // orphan evidence before the store rejects REQUEST_CONFLICT. No auto-repair.
  return freeze({schemaVersion:1,profileId:profile.profileId,originalRequestId:profile.request.requestId,contractDigest:retained.record.snapshot.contract.contractDigest,policyDigest:retained.record.snapshot.contract.policyDigest,contractHead:{revision:retained.record.revision,headDigest:retained.record.recordHash},idempotent:retained.idempotent,matchesObservedContractHead:retained.matchesObservedContractHead,preparationPersisted:true,observationEvidencePersisted:true,reviewEnabled:false,toolchainVerified:false,candidateVerified:false,executionAuthorized:false,registrationLeaseHeld:false});
 }});
}
