import {taskDraftBinding,validateTaskDraftLedger,sameTaskDraftBinding} from '../project/taskDraftLedger.js';
import {validateSubmissionRequest,submissionReceiptFromHost,validSubmissionId} from '../project/taskDraftSubmission.js';
import {isNativeWorkspaceRuntime} from './workspaceCensus.js';
import {readSharedLedgerSnapshot} from './sharedLedgerSnapshot.js';
import {nativeStorageFailure} from './storageFailure.js';

const fail=()=>{throw new Error('Native draft connection is unavailable or returned an invalid receipt. Your saved draft and original submission were kept.');};
const exact=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join('|')!==[...keys].sort().join('|'))fail();};
export function createNativeTaskDraftHost(project,{runtime=globalThis,invoke}={}){
  const binding=taskDraftBinding(project),registration=structuredClone(project.registration);
  if(!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(registration.workspaceId)||!Number.isSafeInteger(registration.registryRevision)||registration.registryRevision<1)fail();
  const request=Object.freeze({schemaVersion:1,workspaceId:registration.workspaceId,registryRevision:registration.registryRevision,rootIdentity:binding.rootIdentity,censusDigest:binding.censusDigest});
  const available=isNativeWorkspaceRuntime(runtime);
  function projectReceipt(value,submitted){
    exact(value,['schemaVersion','binding','observedHead','submission','registrationCurrent','registrationLeaseHeld','approvalState','executionAuthorized','cleanupComplete']);
    exact(value.binding,['projectId','rootIdentity','censusDigest']);
    exact(value.observedHead,['hostRevision','headDigest']);
    if(!sameTaskDraftBinding(value.binding,binding)||value.schemaVersion!==1||value.cleanupComplete!==true||typeof value.registrationCurrent!=='boolean'||value.registrationLeaseHeld!==false||value.executionAuthorized!==false||value.approvalState!=='unapproved-proposal')fail();
    const head=value.observedHead;
    if(!Number.isSafeInteger(head.hostRevision)||head.hostRevision<0||(head.hostRevision===0?head.headDigest!=='GENESIS':typeof head.headDigest!=='string'||!/^[a-f0-9]{64}$/.test(head.headDigest)))fail();
    const result={schemaVersion:1,observedHead:{...head},registrationCurrent:value.registrationCurrent,registrationLeaseHeld:false,approvalState:'unapproved-proposal',executionAuthorized:false};
    if(submitted){
      exact(value.submission,['record','submissionPersisted','idempotent','submittedMatchesObservedHead']);
      Object.assign(result,{submitted:structuredClone(value.submission.record),submissionPersisted:value.submission.submissionPersisted,idempotent:value.submission.idempotent,submittedMatchesObservedHead:value.submission.submittedMatchesObservedHead});
      submissionReceiptFromHost(result);
    }else if(value.submission!==null)fail();
    return Object.freeze(result);
  }
  async function call(command,body,submitted,projectResult=projectReceipt){
    if(!available)fail();
    let value;
    try{const nativeInvoke=invoke??(await import('@tauri-apps/api/core')).invoke;value=await nativeInvoke(command,{request:body});}catch(cause){
      const storage=nativeStorageFailure(cause);if(storage)throw storage;
      const known=new Set(['NATIVE_DRAFT_SESSION_UNRESOLVED','NATIVE_DRAFT_OUTCOME_UNKNOWN','NATIVE_DRAFT_BUSY','NATIVE_DRAFT_DIAGNOSTIC_INVALID','NATIVE_DRAFT_DIAGNOSTIC_LIMIT','NATIVE_DRAFT_DIAGNOSTIC_UNAVAILABLE','TASK_LEDGER_STALE_HEAD','TASK_LEDGER_REQUEST_CONFLICT']);
      if(cause&&known.has(cause.code)&&cause.executionAuthorized===false&&typeof cause.requiresRecovery==='boolean'&&typeof cause.requestMayHaveCommitted==='boolean'){
        const error=new Error(cause.requiresRecovery?'A previous native session has not been confirmed stopped. Keep the original submission; native recovery is required before another send.':'Native delivery was not confirmed. Keep the original submission and inspect its status before retrying.');
        error.code=cause.code;error.requiresRecovery=cause.requiresRecovery;error.requestMayHaveCommitted=cause.requestMayHaveCommitted;
        if(validSubmissionId(cause.originalRequestId))error.originalRequestId=cause.originalRequestId;
        throw error;
      }
      fail();
    }
    return projectResult(value,submitted);
  }
  return Object.freeze({available,binding,
    readSnapshot(){return readSharedLedgerSnapshot(binding,input=>call('read_native_draft_snapshot',{identity:request,...input},false,value=>value));},
    inspect(){return call('inspect_native_draft_proposal',request,false);},
    submit(payload){
      exact(payload,['ledger','request']);
      const ledger=validateTaskDraftLedger(structuredClone(payload.ledger)),originalRequest=validateSubmissionRequest(structuredClone(payload.request));
      if(!sameTaskDraftBinding(ledger.binding,binding))fail();
      return call('submit_native_draft_proposal',{...request,ledger,originalRequest},true);
    },
  });
}
