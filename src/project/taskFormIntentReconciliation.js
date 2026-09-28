import {validateTaskSaveIntent} from './taskFormSaveIntent.js';
import {validateTaskDraftBinding,validateTaskDraftLedger} from './taskDraftLedger.js';
import {validateTaskFormHistory} from './taskFormRecovery.js';
import {canonicalArchitectureJson as wire} from '../engine/architectureContractVerification.js';
import {reconcileTaskFormSave} from './taskFormSaveReconciliation.js';

// Bridges two databases without pretending they share a transaction. The Save
// receipt stays immutable; editor disposition and acknowledgment are retryable.
// This function never clears a mounted editor or substitutes a new Save ID.
export async function reconcileTaskFormIntent({binding,requestId,store,recovery}) {
  binding=structuredClone(binding);validateTaskDraftBinding(binding);
  const record=validateTaskSaveIntent(structuredClone(await store.readSaveIntent(binding,requestId)));
  if(record.original.requestId!==requestId||wire(record.original.binding)!==wire(binding))throw Error('Save request identity changed. Keep your text.');
  const checkpoint=structuredClone(record.original.checkpoint);
  if(!record.outcome)throw Error('The original Save has no recorded outcome. Retry or withdraw that original request first.');
  if(record.outcome.kind==='committed') {
    const saved=validateTaskDraftLedger(await store.readRevision(binding,record.outcome.ledger.revision));
    if(wire(saved)!==wire(record.outcome.ledger))throw Error('Saved Ledger revision does not match retained save evidence. Nothing was cleared.');
  }
  const readPreserved=async()=>{
    const all=await recovery.list(binding),history=validateTaskFormHistory(structuredClone(all.history),binding);
    const rows=history.filter(row=>row.editorId===checkpoint.editorId&&wire(row.binding)===wire(binding));
    const original=rows.find(row=>row.revision===checkpoint.revision),later=rows.at(-1);
    if(!original||original.status!=='unfinished'||original.resolution!==null||original.baseLedgerRevision!==checkpoint.baseLedgerRevision||wire(original.form)!==wire(checkpoint.form))throw Error('Original checkpoint is absent or differs in retained history. Nothing was cleared.');
    return {history,original,later};
  };
  // A retained acknowledgment describes an observed historical fact, not the
  // current editor head. Never replace it when later text advances again.
  if(record.acknowledgment) {
    const kept=record.acknowledgment.newerEditorPreserved;
    if(kept){const {history}=await readPreserved();for(const row of [kept.originalCheckpoint,kept.laterCheckpoint])if(!history.some(value=>wire(value)===wire(row)))throw Error('Acknowledged editor history is unavailable. Nothing was cleared.');}
    else if(wire(await recovery.read(binding,checkpoint.editorId))!==wire(record.acknowledgment.editorDisposition))throw Error('Acknowledged editor disposition differs. Nothing was cleared.');
    return structuredClone(record);
  }
  const observed=await recovery.read(binding,checkpoint.editorId);
  const nextTerminal=observed?.status==='resolved'&&observed.revision===checkpoint.revision+1&&observed.baseLedgerRevision===checkpoint.baseLedgerRevision&&wire(observed.form)===wire(checkpoint.form);
  if(observed?.revision>checkpoint.revision&&!nextTerminal) {
    const {original,later}=await readPreserved();
    const newerEditorPreserved={originalCheckpoint:original,laterCheckpoint:later};
    const proposed=validateTaskSaveIntent({...record,acknowledgment:{newerEditorPreserved,declarationSource:'browser-declared'}});
    const acknowledged=validateTaskSaveIntent(await store.acknowledgeSaveIntent(binding,requestId,{newerEditorPreserved}));
    if(wire(acknowledged)!==wire(proposed))throw Error('Save acknowledgment readback differs. Keep the original request.');
    return structuredClone(acknowledged);
  }
  if(record.outcome.kind==='committed') {
    await reconcileTaskFormSave({binding,savedLedger:record.outcome.ledger,checkpoint,store,recovery,session:{
      resolve:async(reason,captured)=>recovery.resolve({binding,editorId:captured.editorId,expectedRevision:captured.revision,reason}),
    }});
  } else if(record.outcome.kind==='withdrawn') {
    // Withdrawal blocks future commit before this separate terminal is written.
    // Superseded retains the original text; it does not mean the task was saved.
    const current=await recovery.read(binding,checkpoint.editorId);
    const exact=current?.schemaVersion===1&&current.kind==='TASK_FORM_RECOVERY'&&wire(current.binding)===wire(binding)&&current.editorId===checkpoint.editorId&&current.baseLedgerRevision===checkpoint.baseLedgerRevision&&wire(current.form)===wire(checkpoint.form);
    if(!exact)throw Error('Withdrawn editor evidence differs. Original history was kept.');
    if(current.status==='unfinished'&&current.resolution===null&&current.revision===checkpoint.revision) {
      await recovery.resolve({binding,editorId:checkpoint.editorId,expectedRevision:checkpoint.revision,reason:'superseded'});
    } else if(current.status!=='resolved'||current.revision!==checkpoint.revision+1||!['discarded','superseded'].includes(current.resolution)) {
      throw Error('Withdrawn editor has a conflicting disposition. Nothing was overwritten.');
    }
  } else throw Error('Unknown Save outcome. Nothing was changed.');
  const terminal=await recovery.read(binding,checkpoint.editorId);
  // The store validates the terminal against the exact retained original again.
  const acknowledged=validateTaskSaveIntent(await store.acknowledgeSaveIntent(binding,requestId,{editorDisposition:terminal}));
  if(wire(acknowledged.original)!==wire(record.original)||wire(acknowledged.outcome)!==wire(record.outcome)||wire(acknowledged.acknowledgment?.editorDisposition)!==wire(terminal))throw Error('Save acknowledgment readback differs. Keep the original request.');
  return structuredClone(acknowledged);
}
