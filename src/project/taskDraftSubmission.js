import {validateTaskDraftBinding,validateTaskDraftLedger,sameTaskDraftBinding} from './taskDraftLedger.js';

export const TASK_SUBMISSION_LIMIT=128;
export const TASK_SUBMISSION_BYTES=8*1024*1024;
const fail=()=>{throw Error('Saved submission is invalid or conflicts with the original. Existing records were kept.');};
const exact=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('|')!==[...keys].sort().join('|'))fail();};
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export const validSubmissionId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
export const submissionWire=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
export function validateSubmissionRequest(value){
  exact(value,['requestId','expectedRevision','expectedHeadDigest']);
  if(!validSubmissionId(value.requestId)||!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<0||(value.expectedRevision===0?value.expectedHeadDigest!=='GENESIS':!hash(value.expectedHeadDigest)))fail();
  return freeze({...value});
}
function submittedIdentity(value){exact(value,['hostRevision','headDigest','ledgerDigest']);if(!Number.isSafeInteger(value.hostRevision)||value.hostRevision<1||!hash(value.headDigest)||!hash(value.ledgerDigest))fail();return {...value};}
export function submissionReceiptFromHost(value){
  exact(value,['schemaVersion','observedHead','registrationCurrent','registrationLeaseHeld','approvalState','executionAuthorized','submitted','submissionPersisted','idempotent','submittedMatchesObservedHead']);
  exact(value.observedHead,['hostRevision','headDigest']);const head=value.observedHead,submitted=submittedIdentity(value.submitted);
  if(value.schemaVersion!==1||value.submissionPersisted!==true||value.executionAuthorized!==false||value.registrationLeaseHeld!==false||value.approvalState!=='unapproved-proposal'||typeof value.registrationCurrent!=='boolean'||typeof value.idempotent!=='boolean'||!Number.isSafeInteger(head.hostRevision)||head.hostRevision<submitted.hostRevision||!hash(head.headDigest)||value.submittedMatchesObservedHead!==(head.hostRevision===submitted.hostRevision&&head.headDigest===submitted.headDigest))fail();
  // This is a renderer-held acknowledgement, not authenticated approval or a
  // claim that the submitted revision remains the current host head.
  return freeze({submitted,executionAuthorized:false});
}
export function validateTaskDraftSubmission(value){
  exact(value,['schemaVersion','kind','binding','localRevision','ledger','request','receipt','executionAuthorized']);
  const binding={...validateTaskDraftBinding(value.binding)},ledger=validateTaskDraftLedger(value.ledger),request=validateSubmissionRequest(value.request);
  if(value.schemaVersion!==1||value.kind!=='LOCAL_DRAFT_SUBMISSION'||value.executionAuthorized!==false||value.localRevision<1||value.localRevision!==ledger.revision||!sameTaskDraftBinding(binding,ledger.binding))fail();
  let receipt=null;if(value.receipt!==null){exact(value.receipt,['submitted','executionAuthorized']);if(value.receipt.executionAuthorized!==false)fail();receipt={submitted:submittedIdentity(value.receipt.submitted),executionAuthorized:false};if(receipt.submitted.hostRevision!==request.expectedRevision+1)fail();}
  return freeze({...value,binding,ledger,request,receipt});
}
