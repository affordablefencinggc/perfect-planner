import {validateTaskDraftBinding,validateTaskDraftLedger,updateTaskDraft} from './taskDraftLedger.js';
import {validateTaskRecoveryForm} from './taskFormRecovery.js';
import {canonicalArchitectureJson as wire} from '../engine/architectureContractVerification.js';

export const TASK_SAVE_INTENT_LIMIT=32;
export const TASK_SAVE_INTENT_BYTES=64*1024*1024;
export const taskSaveIntentBytes=value=>new TextEncoder().encode(wire(value)).length;
const fail=message=>{throw Error(message);};
const exact=(value,keys)=>{if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).sort().join('|')!==[...keys].sort().join('|'))fail('Save intent shape is invalid. Existing records were kept.');};
export const validTaskSaveRequestId=id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(id);
export const sameTaskSaveRoot=(a,b)=>a.projectId===b.projectId&&a.rootIdentity===b.rootIdentity;
export function validateTaskSaveOriginal(original){
 exact(original,['requestId','binding','baseLedger','taskInput','checkpoint']);validateTaskDraftBinding(original.binding);
 if(!validTaskSaveRequestId(original.requestId))fail('Save request identity is invalid.');
 const base=validateTaskDraftLedger(original.baseLedger);
 if(wire(base)!==wire(original.baseLedger)||wire(base.binding)!==wire(original.binding))fail('Save base is not the exact bound Ledger.');
 const cp=original.checkpoint;exact(cp,['binding','editorId','revision','baseLedgerRevision','form']);validateTaskDraftBinding(cp.binding);validateTaskRecoveryForm(cp.form);
 if(wire(cp.binding)!==wire(original.binding)||!validTaskSaveRequestId(cp.editorId)||!Number.isSafeInteger(cp.revision)||cp.revision<1||cp.revision>=5000||cp.baseLedgerRevision!==base.revision)fail('Save checkpoint does not match the exact base.');
 const form=cp.form;
 const parsed={...form,claims:form.claims.split('\n').filter(line=>line.trim()).map(line=>{const match=line.trim().match(/^(read|write)\s+(.+)$/);if(!match)fail('Save checkpoint contains invalid file scope.');return {access:match[1],path:match[2]};}),dependsOn:form.dependsOn.split(/[\s,]+/).filter(Boolean)};
 updateTaskDraft(base,original.taskInput,base.updatedAt);
 if(wire(parsed)!==wire(original.taskInput))fail('Save task does not match its original editor checkpoint.');
 if(taskSaveIntentBytes(original)>2*1024*1024)fail('Save intent original is too large.');return original;
}
function validateDisposition(record,original,outcome){
 exact(record,['schemaVersion','kind','binding','editorId','revision','baseLedgerRevision','form','status','resolution','updatedAt']);validateTaskDraftBinding(record.binding);validateTaskRecoveryForm(record.form);const cp=original.checkpoint;
 if(record.schemaVersion!==1||record.kind!=='TASK_FORM_RECOVERY'||wire(record.binding)!==wire(original.binding)||record.editorId!==cp.editorId||record.revision!==cp.revision+1||record.baseLedgerRevision!==cp.baseLedgerRevision||wire(record.form)!==wire(cp.form)||record.status!=='resolved'||!['saved','discarded','superseded'].includes(record.resolution)||(outcome.kind==='withdrawn'&&record.resolution==='saved')||typeof record.updatedAt!=='string'||record.updatedAt.length!==24||!Number.isFinite(Date.parse(record.updatedAt))||new Date(record.updatedAt).toISOString()!==record.updatedAt)fail('Save acknowledgment does not match its retained editor.');
}
function validatePreservedCheckpoint(record,original,isOriginal){
 exact(record,['schemaVersion','kind','binding','editorId','revision','baseLedgerRevision','form','status','resolution','updatedAt']);validateTaskDraftBinding(record.binding);validateTaskRecoveryForm(record.form);const cp=original.checkpoint;
 if(record.schemaVersion!==1||record.kind!=='TASK_FORM_RECOVERY'||wire(record.binding)!==wire(original.binding)||record.editorId!==cp.editorId||!Number.isSafeInteger(record.revision)||record.revision<1||record.revision>5000||!Number.isSafeInteger(record.baseLedgerRevision)||record.baseLedgerRevision<cp.baseLedgerRevision||record.baseLedgerRevision>5000||typeof record.updatedAt!=='string'||record.updatedAt.length!==24||!Number.isFinite(Date.parse(record.updatedAt))||new Date(record.updatedAt).toISOString()!==record.updatedAt)fail('Preserved editor checkpoint identity is invalid.');
 if(record.status==='unfinished'?record.resolution!==null:record.status!=='resolved'||!['saved','discarded','superseded'].includes(record.resolution))fail('Preserved editor checkpoint status is invalid.');
 if(isOriginal){if(record.revision!==cp.revision||record.baseLedgerRevision!==cp.baseLedgerRevision||wire(record.form)!==wire(cp.form)||record.status!=='unfinished')fail('Preserved original checkpoint differs.');}
 else if(record.revision<=cp.revision||(record.revision===cp.revision+1&&record.status==='resolved'))fail('A newer editor checkpoint is required.');
 if(taskSaveIntentBytes(record)>65536)fail('Preserved editor checkpoint is too large.');
}
export function validateTaskSaveIntent(record){
 exact(record,['schemaVersion','kind','original','outcome','acknowledgment','executionAuthorized']);
 if(record.schemaVersion!==1||record.kind!=='TASK_FORM_SAVE_INTENT'||record.executionAuthorized!==false)fail('Save intent flags are invalid.');validateTaskSaveOriginal(record.original);
 if(record.outcome!==null){
  if(record.outcome.kind==='withdrawn')exact(record.outcome,['kind']);
  else{exact(record.outcome,['kind','ledger']);if(record.outcome.kind!=='committed')fail('Unknown Save outcome.');const ledger=validateTaskDraftLedger(record.outcome.ledger),expected=updateTaskDraft(record.original.baseLedger,record.original.taskInput,ledger.updatedAt);if(wire(ledger)!==wire(record.outcome.ledger)||wire(ledger)!==wire(expected))fail('Save receipt does not match the complete original update.');}
 }
 if(record.acknowledgment!==null){const ack=record.acknowledgment;if(!record.outcome||ack.declarationSource!=='browser-declared')fail('Save acknowledgment requires a retained outcome.');
  if(Object.hasOwn(ack,'newerEditorPreserved')){exact(ack,['newerEditorPreserved','declarationSource']);exact(ack.newerEditorPreserved,['originalCheckpoint','laterCheckpoint']);validatePreservedCheckpoint(ack.newerEditorPreserved.originalCheckpoint,record.original,true);validatePreservedCheckpoint(ack.newerEditorPreserved.laterCheckpoint,record.original,false);}
  else{exact(ack,['editorDisposition','declarationSource']);validateDisposition(ack.editorDisposition,record.original,record.outcome);}
 }
 if(taskSaveIntentBytes(record)>4*1024*1024)fail('Save intent record is too large.');return record;
}
export function assertTaskSaveIntentCapacity(records){
 if(records.length>TASK_SAVE_INTENT_LIMIT)fail('Save intent history is full. Nothing was removed.');let bytes=0;
 for(const record of records){validateTaskSaveIntent(record);bytes+=taskSaveIntentBytes(record);if(record.outcome===null)bytes+=1024*1024+1024;if(record.acknowledgment===null)bytes+=2*65536+2048;}
 if(bytes>TASK_SAVE_INTENT_BYTES)fail('Save intent history is full. Receipt space and existing records were preserved.');
}
