import {validateSharedTaskReconciliation as checked} from './sharedTaskReconciliation.js';
import {validateTaskDraftBinding,sameTaskDraftBinding,emptyTaskDraftLedger,validateTaskDraftLedger} from './taskDraftLedger.js';
import {submissionWire,validateTaskDraftSubmission,TASK_SUBMISSION_LIMIT,TASK_SUBMISSION_BYTES} from './taskDraftSubmission.js';
import {validateTaskSaveIntent,TASK_SAVE_INTENT_LIMIT,TASK_SAVE_INTENT_BYTES} from './taskFormSaveIntent.js';

const LIMIT=64,BYTES=16*1024*1024;
const fail=message=>{throw Error(message);};
const size=value=>new TextEncoder().encode(submissionWire(value)).length;

// Device-local history, not an authority receipt. An accepted review and its
// new draft revision are one strict transaction. No editor checkpoint is erased.
export function createSharedReconciliationStorage({open,keyRange,notify}){
 // Select the entire project prefix, not just valid revision numbers. A
 // corrupted key must be rejected by validation, never disappear from history.
 const projectRange=projectId=>keyRange.bound([projectId],[projectId+'\u0000'],false,true);
 async function snapshot(binding){
  binding=structuredClone(validateTaskDraftBinding(binding));const db=await open();
  const records=await new Promise((resolve,reject)=>{
   const tx=db.transaction('reconciliations','readonly'),rows=[];let failure,bytes=0;
   tx.oncomplete=()=>resolve(rows);tx.onabort=()=>reject(failure??Error('Reconciliation history could not be read.'));tx.onerror=()=>{};
   const request=tx.objectStore('reconciliations').openCursor(projectRange(binding.projectId));
   request.onsuccess=()=>{try{const cursor=request.result;if(!cursor)return;const value=cursor.value;bytes+=size(value);if(rows.length>=LIMIT||bytes>BYTES||submissionWire(cursor.primaryKey)!==submissionWire([binding.projectId,value?.ledger?.revision])||value?.localBase?.binding?.projectId!==binding.projectId)fail('Reconciliation history is invalid or full. No history was removed.');rows.push(value);cursor.continue();}catch(error){failure=error;tx.abort();}};
  });
  return Promise.all(records.map(checked));
 }
 async function commitSharedReview(input){
  const review=await checked(input),binding=review.localBase.binding;
  const before=await snapshot(binding),prior=before.find(r=>r.ledger.revision===review.ledger.revision);
  if(prior&&submissionWire(prior)!==submissionWire(review))fail('That reconciliation revision already has a different original.');
  if(!prior&&(before.length>=LIMIT||before.reduce((sum,r)=>sum+size(r),size(review))>BYTES))fail('Reconciliation history is full. Export and preserve work before continuing.');
  const db=await open();
  const result=await new Promise((resolve,reject)=>{
   const tx=db.transaction(['heads','revisions','submissions','saveIntents','reconciliations'],'readwrite',{durability:'strict'});
   let failure,result,pending=4,head,base,history=[];
   const abort=error=>{failure=error;tx.abort();};
   tx.onabort=()=>reject(failure??Error('Reconciliation was not confirmed. Review the retained original before retrying.'));tx.onerror=()=>{};tx.oncomplete=()=>resolve(result);
   if(tx.durability!=='strict'){abort(Error('Strict reconciliation durability is unavailable. Nothing was changed.'));return;}
   const revisions=tx.objectStore('revisions');
   function ready(){if(--pending)return;try{
    if(submissionWire(history)!==submissionWire(before))fail('Reconciliation history changed during review. Refresh before retrying.');
    if(prior){const read=revisions.get([binding.projectId,review.ledger.revision]);read.onsuccess=()=>{try{if(submissionWire(read.result)!==submissionWire(review.ledger))fail('Recorded reconciliation and revision disagree.');result=prior;}catch(e){abort(e);}};return;}
    const current=head===undefined?emptyTaskDraftLedger(binding):validateTaskDraftLedger(base);
    if(head!==undefined&&(Object.keys(head).sort().join('|')!=='projectId|revision'||head.projectId!==binding.projectId||head.revision!==current.revision))fail('Draft head and history disagree.');
    if(submissionWire(current)!==submissionWire(review.localBase))fail('Local draft changed during review. Your newer work was kept.');
    revisions.add(review.ledger);tx.objectStore('heads').put({projectId:binding.projectId,revision:review.ledger.revision});tx.objectStore('reconciliations').add(review);result=review;
   }catch(e){abort(e);}}
   function scan(store,range,limit,maxBytes,visit,done=ready){let count=0,bytes=0;const request=tx.objectStore(store).openCursor(range);request.onsuccess=()=>{try{const cursor=request.result;if(!cursor){done();return;}bytes+=size(cursor.value);if(++count>limit||bytes>maxBytes)fail('Retained history exceeds its safe bound. Nothing was changed.');visit(cursor.value,cursor.primaryKey);cursor.continue();}catch(e){abort(e);}};}
   const stringRange=keyRange.bound([binding.projectId,''],[binding.projectId,'\uffff']);
   scan('reconciliations',projectRange(binding.projectId),LIMIT,BYTES,(r,key)=>{if(submissionWire(key)!==submissionWire([binding.projectId,r?.ledger?.revision]))fail('Reconciliation key mismatch.');history.push(r);});
   scan('submissions',stringRange,TASK_SUBMISSION_LIMIT,TASK_SUBMISSION_BYTES,r=>{const record=validateTaskDraftSubmission(r);if(record.binding.projectId!==binding.projectId)fail('Submission project mismatch.');if(!prior&&record.binding.rootIdentity===binding.rootIdentity&&record.receipt===null)fail('Resolve the pending submission before accepting shared changes.');});
   scan('saveIntents',stringRange,TASK_SAVE_INTENT_LIMIT,TASK_SAVE_INTENT_BYTES,r=>{const record=validateTaskSaveIntent(r);if(record.original.binding.projectId!==binding.projectId)fail('Save intent project mismatch.');if(!prior&&record.original.binding.rootIdentity===binding.rootIdentity&&record.acknowledgment===null)fail('Resolve the pending Save before accepting shared changes.');});
   const request=tx.objectStore('heads').get(binding.projectId);request.onsuccess=()=>{try{head=request.result;if(head===undefined){const orphan=revisions.openCursor(projectRange(binding.projectId));orphan.onsuccess=()=>{try{if(orphan.result)fail('Draft head is missing while history exists.');ready();}catch(e){abort(e);}};}else{const read=revisions.get([binding.projectId,head.revision]);read.onsuccess=()=>{base=read.result;ready();};}}catch(e){abort(e);}};
  });
  notify(binding.projectId);
  const readback=(await snapshot(binding)).find(r=>r.ledger.revision===review.ledger.revision);
  if(!readback||submissionWire(readback)!==submissionWire(result))fail('Reconciliation readback is uncertain. Retry the same original review.');
  return readback;
 }
 return {commitSharedReview,reconciliationHistory:async binding=>(await snapshot(binding)).filter(r=>sameTaskDraftBinding(r.localBase.binding,binding))};
}
