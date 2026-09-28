import {validateTaskDraftLedger,validateTaskDraftBinding,sameTaskDraftBinding,inspectTaskDraft} from './taskDraftLedger.js';
import {submissionWire} from './taskDraftSubmission.js';

const fail=message=>{throw Error(message);};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('|')===[...keys].sort().join('|');
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const digest=async value=>Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(submissionWire(value)))),n=>n.toString(16).padStart(2,'0')).join('');

export async function validateSharedTaskReconciliation(input){
 const value=structuredClone(input);
 const rebuilt=await planSharedTaskReconciliation(value?.localBase,value?.sharedSnapshot,value?.choices,value?.ledger?.updatedAt);
 if(submissionWire(rebuilt)!==submissionWire(value))fail('Reconciliation record is inconsistent. Originals were kept.');
 return rebuilt;
}

// This is a review proposal, not a commit, submission acknowledgment or grant.
// Both complete inputs travel with it so a later atomic store operation can
// retain the alternatives and compare the exact local base before committing.
export async function planSharedTaskReconciliation(localInput,snapshotInput,choicesInput,now=new Date().toISOString()){
 const local=validateTaskDraftLedger(structuredClone(localInput));
 const snapshot=structuredClone(snapshotInput),choices=structuredClone(choicesInput);
 if(!exact(snapshot,['binding','observedHead','ledger','ledgerDigest','snapshotDigest','approvalState','executionAuthorized'])||snapshot.approvalState!=='unapproved-proposal'||snapshot.executionAuthorized!==false)fail('Shared review is not an unapproved snapshot. Nothing was changed.');
 validateTaskDraftBinding(snapshot.binding);
 if(!sameTaskDraftBinding(local.binding,snapshot.binding))fail('Shared review belongs to a different project or inventory.');
 const head=snapshot.observedHead;
 if(!exact(head,['hostRevision','headDigest'])||!Number.isSafeInteger(head.hostRevision)||head.hostRevision<1||!hash(head.headDigest)||!hash(snapshot.ledgerDigest)||!hash(snapshot.snapshotDigest)||snapshot.ledger===null)fail('Read a submitted shared plan before reconciliation.');
 const shared=validateTaskDraftLedger(snapshot.ledger);
 if(!sameTaskDraftBinding(shared.binding,local.binding)||await digest(shared)!==snapshot.ledgerDigest)fail('Shared task content does not match its snapshot receipt.');
 const left=new Map(local.tasks.map(task=>[task.id,task])),right=new Map(shared.tasks.map(task=>[task.id,task]));
 const ids=[...new Set([...left.keys(),...right.keys()])].sort((a,b)=>Number(a.slice(1))-Number(b.slice(1)));
 if(!Array.isArray(choices)||choices.length!==ids.length)fail('Review every task, including tasks present in only one version.');
 const selections=new Map();
 for(const choice of choices){
  if(!exact(choice,['taskId','version'])||!ids.includes(choice.taskId)||selections.has(choice.taskId)||!['local','shared'].includes(choice.version))fail('Each task needs one explicit local or shared choice.');
  if(!(choice.version==='local'?left:right).has(choice.taskId))fail('A choice cannot remove a task. Select the version that contains it.');
  selections.set(choice.taskId,choice.version);
 }
 const tasks=ids.map(id=>(selections.get(id)==='local'?left:right).get(id));
 const next=validateTaskDraftLedger({...local,revision:local.revision+1,updatedAt:now,nextTaskNumber:Math.max(local.nextTaskNumber,shared.nextTaskNumber),tasks});
 // Mixing independently sound plans can introduce overlaps or dependency
 // cycles. Expose the full ordinary draft review; never turn choices into proof.
 const review=inspectTaskDraft(next);
 return freeze({schemaVersion:1,kind:'SHARED_TASK_RECONCILIATION_REVIEW',localBase:local,sharedSnapshot:snapshot,
  choices:ids.map(taskId=>({taskId,version:selections.get(taskId)})),ledger:next,findings:review.findings,
  executionAuthorized:false});
}
