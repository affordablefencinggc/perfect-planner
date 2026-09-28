import {taskDraftBinding,sameTaskDraftBinding} from '../project/taskDraftLedger.js';
import {isNativeWorkspaceRuntime} from './workspaceCensus.js';
import {nativeStorageFailure} from './storageFailure.js';
const fail=()=>{throw Error('Check setup could not be verified. Keep the original request and refresh its status. No execution was authorized.');};
const exact=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join('|')!==[...keys].sort().join('|'))fail();};
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const profile=v=>['perfect-planner-checks-v1','npm-project-checks-v1'].includes(v);
const token=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
function head(v,key='revision',positive=false){exact(v,[key,'headDigest']);if(!Number.isSafeInteger(v[key])||v[key]<(positive?1:0)||(v[key]===0?v.headDigest!=='GENESIS':!hash(v.headDigest)))fail();}
function original(v){exact(v,['requestId','expectedRevision','expectedHeadDigest']);if(!token(v.requestId)||v.expectedRevision===Number.MAX_SAFE_INTEGER)fail();head({revision:v.expectedRevision,headDigest:v.expectedHeadDigest});}
function assignments(v){if(!Array.isArray(v)||!v.length||v.length>256)fail();const ids=new Set();for(const a of v){exact(a,['taskId','categories']);if(!/^T\d{4,6}$/.test(a.taskId)||ids.has(a.taskId)||!Array.isArray(a.categories)||!a.categories.length||a.categories.length>3||new Set(a.categories).size!==a.categories.length||a.categories.some(c=>!['tests','build','secrets'].includes(c)))fail();ids.add(a.taskId);}}
// Renderer adapter: no roots, executable paths, shell arguments or permissions
// are accepted here. Native selection and custody remain the authority.
export function createNativeCheckSetupHost(project,{runtime=globalThis,invoke}={}){
 const binding=taskDraftBinding(project),r=structuredClone(project.registration);
 if(!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(r.workspaceId)||!Number.isSafeInteger(r.registryRevision)||r.registryRevision<1)fail();
 const identity=freeze({schemaVersion:1,workspaceId:r.workspaceId,registryRevision:r.registryRevision,rootIdentity:binding.rootIdentity,censusDigest:binding.censusDigest});
 const available=isNativeWorkspaceRuntime(runtime);
 function bound(v){exact(v,['projectId','rootIdentity','censusDigest']);if(!sameTaskDraftBinding(v,binding))fail();}
 function validateOriginal(v){exact(v,['identity','setupReference','expected','originalRequest']);exact(v.identity,Object.keys(identity));if(JSON.stringify(Object.entries(v.identity).sort())!==JSON.stringify(Object.entries(identity).sort())||!hash(v.setupReference))fail();head(v.expected,'hostRevision',true);original(v.originalRequest);return v;}
 async function call(command,request,validate){
  if(!available)fail();let value;
  try{const fn=invoke??(await import('@tauri-apps/api/core')).invoke;value=structuredClone(await fn(command,{request:structuredClone(request)}));}
  catch(cause){const storage=nativeStorageFailure(cause);if(storage)throw storage;const e=new Error('Native check request was not confirmed. Recover its saved status before retrying; keep the original request.');
   // Only bounded diagnostic codes and recovery flags leave native custody.
   if(cause?.executionAuthorized===false&&typeof cause.requiresRecovery==='boolean'&&typeof cause.requestMayHaveCommitted==='boolean'){
    if(typeof cause.code==='string'&&/^(NATIVE_(CHECK|DRAFT)_[A-Z_]{1,64}|TASK_LEDGER_[A-Z_]{1,64})$/.test(cause.code))e.code=cause.code;
    e.requiresRecovery=cause.requiresRecovery;e.requestMayHaveCommitted=cause.requestMayHaveCommitted;if(token(cause.originalRequestId))e.originalRequestId=cause.originalRequestId;
    if(e.code==='NATIVE_CHECK_REVIEW_NOT_STARTED'&&e.requiresRecovery===false&&e.requestMayHaveCommitted===false)e.message='The native review did not start. Its processes have closed and no decision was recorded. Refresh check status. You can retry Review prepared checks after refreshing.';
   }throw e;
  }
  validate(value);return freeze(value);
 }
 function execution(input,recovery,batch=false){
  input=structuredClone(input);exact(input,['setupReference','expected','contractHead','requestId','confirmationId','taskId',...(batch?[]:['checkId']),'attemptId','attemptNumber']);
  if(!hash(input.setupReference)||!['requestId','confirmationId',...(batch?[]:['checkId']),'attemptId'].every(k=>token(input[k]))||!/^T\d{4,6}$/.test(input.taskId)||input.taskId!==`T${String(Number(input.taskId.slice(1))).padStart(4,'0')}`||Number(input.taskId.slice(1))<1||!Number.isSafeInteger(input.attemptNumber)||input.attemptNumber<1)fail();
  head(input.expected,'hostRevision',true);head(input.contractHead,'revision',true);
  return call(batch?(recovery?'recover_native_task_execution':'execute_native_task'):(recovery?'recover_native_check_execution':'execute_native_check'),{identity,...input},v=>{
   exact(v,['schemaVersion','binding','requestId','expected','contractHead','receipt','retainedResult','recoveredSession','executionAuthorized','cleanupComplete']);bound(v.binding);head(v.expected,'hostRevision',true);head(v.contractHead,'revision',true);
   const receipt=v.receipt,notStarted=!batch&&receipt?.kind==='NATIVE_CHECK_NOT_STARTED_RECEIPT';exact(receipt,batch?['schemaVersion','kind','requestId','originalDigest','anchorGrantId','checkCount','checkSetDigest','checksDigest','state','cleanupComplete','authorityVerified','executionAuthorized']:notStarted?['schemaVersion','kind','requestId','originalDigest','proofDigest','state','cleanupComplete','executionAuthorized']:['schemaVersion','kind','requestId','originalDigest','grantId','runId','intentDigest','artifactDigest','state','cleanupComplete','executionAuthorized']);
   const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
   if(v.schemaVersion!==1||v.requestId!==input.requestId||v.expected.hostRevision!==input.expected.hostRevision||v.expected.headDigest!==input.expected.headDigest||v.contractHead.revision!==input.contractHead.revision||v.contractHead.headDigest!==input.contractHead.headDigest||typeof v.retainedResult!=='boolean'||typeof v.recoveredSession!=='boolean'||(recovery&&v.retainedResult!==true)||v.executionAuthorized!==false||v.cleanupComplete!==true||receipt.schemaVersion!==1||receipt.requestId!==input.requestId||!hash(receipt.originalDigest)||(batch?(receipt.kind!=='NATIVE_TASK_EXECUTION_RECEIPT'||!uuid(receipt.anchorGrantId)||!Number.isSafeInteger(receipt.checkCount)||receipt.checkCount<1||receipt.checkCount>256||!hash(receipt.checkSetDigest)||!hash(receipt.checksDigest)||receipt.state!=='results-recorded'||receipt.authorityVerified!==false):notStarted?(!hash(receipt.proofDigest)||receipt.state!=='not-started'):(receipt.kind!=='NATIVE_CHECK_EXECUTION_RECEIPT'||!['intentDigest','artifactDigest'].every(k=>hash(receipt[k]))||!uuid(receipt.grantId)||!uuid(receipt.runId)||receipt.state!=='result-recorded'))||receipt.cleanupComplete!==true||receipt.executionAuthorized!==false)fail();
  });
 }
 return freeze({available,binding,execute:input=>execution(input,false),recoverExecution:input=>execution(input,true),executeTask:input=>execution(input,false,true),recoverTaskExecution:input=>execution(input,true,true),
  choose(input,profileId='perfect-planner-checks-v1'){input=structuredClone(input);assignments(input);if(!profile(profileId))fail();return call('choose_native_check_setup',{identity,assignments:input,profileId},v=>{
   if(v.selectionState==='cancelled'){exact(v,['schemaVersion','binding','selectionState','setupReference','setupPersisted','executionAuthorized']);if(v.setupReference!==null||v.setupPersisted!==false)fail();}
   else{exact(v,['schemaVersion','binding','selectionState','setupReference','toolName','toolDigest','profileId','assignments','setupPersisted','toolchainVerified','executionAuthorized']);if(v.selectionState!=='saved'||!hash(v.setupReference)||!hash(v.toolDigest)||v.toolName!=='npm-cli.js'||v.profileId!==profileId||v.setupPersisted!==true||v.toolchainVerified!==false)fail();assignments(v.assignments);if(JSON.stringify(v.assignments)!==JSON.stringify(input))fail();}
   bound(v.binding);if(v.schemaVersion!==1||v.executionAuthorized!==false)fail();
  });},
  inspect(setupReference){if(!hash(setupReference))fail();return call('inspect_native_checks',{identity,setupReference},v=>{
   exact(v,['schemaVersion','binding','contractHead','requestedOriginalId','original','registrationLeaseHeld','executionAuthorized','retainedOriginal','cleanupComplete','setup']);bound(v.binding);head(v.contractHead);exact(v.setup,['setupReference','profileId','assignments']);if(v.setup.setupReference!==setupReference||!profile(v.setup.profileId))fail();assignments(v.setup.assignments);
   if(v.schemaVersion!==1||v.registrationLeaseHeld!==false||v.executionAuthorized!==false||v.cleanupComplete!==true||(v.requestedOriginalId!==null&&!token(v.requestedOriginalId)))fail();
   if(v.retainedOriginal!==null){validateOriginal(v.retainedOriginal);if(v.retainedOriginal.originalRequest.requestId!==v.requestedOriginalId)fail();}else if(v.requestedOriginalId!==null)fail();
   if(v.original!==null){const o=v.original;exact(o,['binding','request','contractHead','contractDigest','policyDigest','proposalHead','matchesObservedContractHead','observationEvidenceVerified']);exact(o.binding,['projectId','rootIdentity','censusDigest']);if(o.binding.projectId!==binding.projectId||o.binding.rootIdentity!==binding.rootIdentity||!hash(o.binding.censusDigest))fail();original(o.request);head(o.contractHead);head(o.proposalHead,'hostRevision',true);
    if(o.request.requestId!==v.requestedOriginalId||o.contractHead.revision!==o.request.expectedRevision+1||o.contractHead.revision>v.contractHead.revision||!hash(o.contractDigest)||!hash(o.policyDigest)||o.observationEvidenceVerified!==false||o.matchesObservedContractHead!==(o.contractHead.revision===v.contractHead.revision&&o.contractHead.headDigest===v.contractHead.headDigest))fail();
    // A matching ID alone cannot reconcile a retained preparation. Require
    // the exact original base, proposal and census before exposing its result.
    const retained=v.retainedOriginal;
    if(!retained||o.request.expectedRevision!==retained.originalRequest.expectedRevision||o.request.expectedHeadDigest!==retained.originalRequest.expectedHeadDigest||o.proposalHead.hostRevision!==retained.expected.hostRevision||o.proposalHead.headDigest!==retained.expected.headDigest||o.binding.censusDigest!==retained.identity.censusDigest)fail();
   }
  });},
  recoverReview(input){input=structuredClone(input);exact(input,['setupReference','expected','contractHead','requestId']);if(!hash(input.setupReference)||!token(input.requestId))fail();head(input.expected,'hostRevision',true);head(input.contractHead,'revision',true);
   return call('recover_native_check_review',{identity,...input},v=>{
    exact(v,['schemaVersion','binding','requestId','expected','contractHead','confirmation','retainedResult','recoveredSession','executionAuthorized','cleanupComplete']);bound(v.binding);head(v.expected,'hostRevision',true);head(v.contractHead,'revision',true);exact(v.confirmation,['id','status']);
    if(v.schemaVersion!==1||v.requestId!==input.requestId||v.expected.hostRevision!==input.expected.hostRevision||v.expected.headDigest!==input.expected.headDigest||v.contractHead.revision!==input.contractHead.revision||v.contractHead.headDigest!==input.contractHead.headDigest||!token(v.confirmation.id)||!['approved','rejected','cancelled'].includes(v.confirmation.status)||v.retainedResult!==true||typeof v.recoveredSession!=='boolean'||v.executionAuthorized!==false||v.cleanupComplete!==true)fail();
   });
  },
  review(input){input=structuredClone(input);exact(input,['setupReference','expected','contractHead','requestId']);if(!hash(input.setupReference)||!token(input.requestId))fail();head(input.expected,'hostRevision',true);head(input.contractHead,'revision',true);
   return call('review_native_checks',{identity,...input},v=>{
    exact(v,['schemaVersion','binding','requestId','expected','contractHead','confirmation','retainedResult','recoveredSession','executionAuthorized','cleanupComplete']);bound(v.binding);head(v.expected,'hostRevision',true);head(v.contractHead,'revision',true);exact(v.confirmation,['id','status']);
    if(v.schemaVersion!==1||v.requestId!==input.requestId||v.expected.hostRevision!==input.expected.hostRevision||v.expected.headDigest!==input.expected.headDigest||v.contractHead.revision!==input.contractHead.revision||v.contractHead.headDigest!==input.contractHead.headDigest||!token(v.confirmation.id)||!['approved','rejected','cancelled'].includes(v.confirmation.status)||typeof v.retainedResult!=='boolean'||v.recoveredSession!==false||v.executionAuthorized!==false||v.cleanupComplete!==true)fail();
   });
  },
  prepare(input){input=structuredClone(input);exact(input,['setupReference','expected','originalRequest']);const request=validateOriginal({identity,...input});return call('prepare_native_checks',request,v=>{
   exact(v,['schemaVersion','profileId','originalRequestId','contractDigest','policyDigest','contractHead','idempotent','matchesObservedContractHead','preparationPersisted','observationEvidencePersisted','reviewEnabled','toolchainVerified','candidateVerified','executionAuthorized','registrationLeaseHeld','binding','setupReference','expectedProposal','cleanupComplete']);bound(v.binding);head(v.contractHead);head(v.expectedProposal,'hostRevision',true);
   if(v.schemaVersion!==1||!profile(v.profileId)||v.originalRequestId!==input.originalRequest.requestId||v.setupReference!==input.setupReference||v.expectedProposal.hostRevision!==input.expected.hostRevision||v.expectedProposal.headDigest!==input.expected.headDigest||v.contractHead.revision!==input.originalRequest.expectedRevision+1||!hash(v.contractDigest)||!hash(v.policyDigest)||typeof v.idempotent!=='boolean'||typeof v.matchesObservedContractHead!=='boolean'||['preparationPersisted','observationEvidencePersisted','cleanupComplete'].some(k=>v[k]!==true)||['reviewEnabled','toolchainVerified','candidateVerified','executionAuthorized','registrationLeaseHeld'].some(k=>v[k]!==false))fail();
  });}
 });
}


