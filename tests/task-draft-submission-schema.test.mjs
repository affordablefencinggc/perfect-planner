import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyTaskDraftLedger,updateTaskDraft} from '../src/project/taskDraftLedger.js';
import {submissionReceiptFromHost,validateTaskDraftSubmission} from '../src/project/taskDraftSubmission.js';

const binding={projectId:'pp_submission_schema',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)};
function hostResult(){return {schemaVersion:1,observedHead:{hostRevision:4,headDigest:'d'.repeat(64)},registrationCurrent:true,registrationLeaseHeld:false,approvalState:'unapproved-proposal',executionAuthorized:false,submitted:{hostRevision:3,headDigest:'c'.repeat(64),ledgerDigest:'e'.repeat(64)},submissionPersisted:true,idempotent:true,submittedMatchesObservedHead:false};}
function record(){
  const ledger=updateTaskDraft(emptyTaskDraftLedger(binding),{id:null,title:'Saved task',description:'',owner:'',acceptance:'',recovery:'',claims:[],dependsOn:[],archived:false});
  return {schemaVersion:1,kind:'LOCAL_DRAFT_SUBMISSION',binding,localRevision:ledger.revision,ledger,request:{requestId:'original-1',expectedRevision:2,expectedHeadDigest:'f'.repeat(64)},receipt:submissionReceiptFromHost(hostResult()),executionAuthorized:false};
}
test('historical host receipt retains submitted identity without claiming current-head authority',()=>{
  const receipt=submissionReceiptFromHost(hostResult());assert.equal(receipt.submitted.hostRevision,3);assert.equal(receipt.executionAuthorized,false);assert.equal(Object.hasOwn(receipt,'observedHead'),false);
  assert.equal(validateTaskDraftSubmission(record()).receipt.submitted.hostRevision,3);
});
test('stored receipt is refused on read when host revision differs from original expected revision plus one',()=>{
  const corrupt=record();corrupt.receipt={...corrupt.receipt,submitted:{...corrupt.receipt.submitted,hostRevision:4}};
  assert.throws(()=>validateTaskDraftSubmission(corrupt),/invalid or conflicts/);
});
test('host acknowledgement cannot claim a submitted revision ahead of its observed head',()=>{
  const corrupt=hostResult();corrupt.observedHead={hostRevision:2,headDigest:'f'.repeat(64)};
  assert.throws(()=>submissionReceiptFromHost(corrupt),/invalid or conflicts/);
});
