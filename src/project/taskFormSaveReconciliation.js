import {validateTaskDraftLedger,validateTaskDraftBinding} from './taskDraftLedger.js';
import {validateTaskRecoveryForm} from './taskFormRecovery.js';
import {canonicalArchitectureJson as wire} from '../engine/architectureContractVerification.js';

// Reconcile two retained facts, not a replacement disposition or authority.
// A peer's terminal reason remains immutable even when the Ledger save won.
export async function reconcileTaskFormSave({binding,savedLedger,checkpoint,store,recovery,session}){
 binding=structuredClone(binding);savedLedger=structuredClone(savedLedger);checkpoint=structuredClone(checkpoint);
 validateTaskDraftBinding(binding);validateTaskDraftLedger(savedLedger);
 if(savedLedger.revision<1||wire(savedLedger.binding)!==wire(binding)||!checkpoint||wire(checkpoint.binding)!==wire(binding))throw Error('Saved editor evidence is incomplete. Keep or export your text.');
 if(Object.keys(checkpoint).sort().join('|')!==['binding','editorId','revision','form','baseLedgerRevision'].sort().join('|')||typeof checkpoint.editorId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(checkpoint.editorId)||!Number.isSafeInteger(checkpoint.revision)||checkpoint.revision<1||checkpoint.revision>5000||!Number.isSafeInteger(checkpoint.baseLedgerRevision)||checkpoint.baseLedgerRevision<0||checkpoint.baseLedgerRevision>=savedLedger.revision)throw Error('Saved editor checkpoint is invalid. Nothing was cleared.');
 validateTaskRecoveryForm(checkpoint.form);
 const persisted=validateTaskDraftLedger(await store.readRevision(binding,savedLedger.revision));
 if(wire(persisted)!==wire(savedLedger))throw Error('Saved Ledger revision does not match retained save evidence. Nothing was cleared.');
 const matches=(record,status)=>record?.schemaVersion===1&&record.kind==='TASK_FORM_RECOVERY'&&record.status===status&&wire(record.binding)===wire(binding)&&record.editorId===checkpoint.editorId&&record.revision===checkpoint.revision+(status==='resolved'?1:0)&&record.baseLedgerRevision===checkpoint.baseLedgerRevision&&wire(record.form)===wire(checkpoint.form);
 const terminal=await recovery.read(binding,checkpoint.editorId);
 if(terminal?.status==='resolved'){
  if(!matches(terminal,'resolved')||!['saved','discarded','superseded'].includes(terminal.resolution))throw Error('Closed editor does not match the saved checkpoint. Nothing was cleared.');
  return {ledgerRevision:savedLedger.revision,resolution:terminal.resolution,executionAuthorized:false};
 }
 if(!matches(terminal,'unfinished')||terminal.resolution!==null)throw Error('Unfinished editor does not match the saved checkpoint. Nothing was cleared.');
 await session.resolve('saved',checkpoint);
 const resolved=await recovery.read(binding,checkpoint.editorId);
 if(!matches(resolved,'resolved')||resolved.resolution!=='saved')throw Error('Saved editor resolution readback does not match. Nothing was cleared.');
 return {ledgerRevision:savedLedger.revision,resolution:'saved',executionAuthorized:false};
}
