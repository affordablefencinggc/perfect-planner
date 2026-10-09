import { emptyTaskDraftLedger, sameTaskDraftBinding, updateTaskDraft, rebindTaskDraft, importTaskDraft, validateTaskDraftBinding, validateTaskDraftLedger } from './taskDraftLedger.js';
import {TASK_SUBMISSION_LIMIT,TASK_SUBMISSION_BYTES,validSubmissionId,submissionWire,validateSubmissionRequest,validateTaskDraftSubmission,submissionReceiptFromHost} from './taskDraftSubmission.js';
import {validateTaskSaveOriginal,validateTaskSaveIntent,validTaskSaveRequestId,sameTaskSaveRoot,assertTaskSaveIntentCapacity,saveIntentsToEvict,TASK_SAVE_INTENT_LIMIT,TASK_SAVE_INTENT_BYTES,taskSaveIntentBytes} from './taskFormSaveIntent.js';
import {createSharedReconciliationStorage} from './sharedReconciliationStore.js';

const DB_NAME='perfect-planner-task-drafts-v1';
const fail=message=>{throw new Error(message);};

// Device-local planning drafts only. This database is not a protected authority,
// backup, worker grant, completion journal, or synchronized collaboration store.
export function createTaskDraftStore({indexedDB=globalThis.indexedDB,keyRange=globalThis.IDBKeyRange,name=DB_NAME}={}) {
  let connection=null;
  const eventName=`${name}:changed`;
  function notify(projectId){
    // Notifications are refresh hints only. Receivers re-read validated records.
    try{if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent(eventName,{detail:{projectId}}));}catch{}
    try{if(typeof BroadcastChannel!=='undefined'){const channel=new BroadcastChannel(eventName);channel.postMessage({projectId});channel.close();}}catch{}
  }
  function open(){
    if(!indexedDB||!keyRange)return Promise.reject(new Error('Local draft storage is unavailable. Nothing was saved.'));
    if(!connection){const pending=new Promise((resolve,reject)=>{
      const request=indexedDB.open(name,4);let abandoned=false;
      request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains('reconciliations'))db.createObjectStore('reconciliations',{keyPath:['localBase.binding.projectId','ledger.revision']});if(!db.objectStoreNames.contains('heads'))db.createObjectStore('heads',{keyPath:'projectId'});if(!db.objectStoreNames.contains('revisions'))db.createObjectStore('revisions',{keyPath:['binding.projectId','revision']});if(!db.objectStoreNames.contains('submissions'))db.createObjectStore('submissions',{keyPath:['binding.projectId','request.requestId']});if(!db.objectStoreNames.contains('saveIntents'))db.createObjectStore('saveIntents',{keyPath:['original.binding.projectId','original.requestId']});};
      request.onblocked=()=>{abandoned=true;if(connection===pending)connection=null;reject(new Error('Close other Planner versions before opening local drafts.'))};
      request.onerror=()=>{if(connection===pending)connection=null;reject(new Error('Local draft storage could not be opened. Existing data was not reset.'))};
      request.onsuccess=()=>{const db=request.result;if(abandoned){db.close();return;}db.onversionchange=()=>{db.close();if(connection===pending)connection=null;};resolve(db);};
    });connection=pending;pending.catch(()=>{if(connection===pending)connection=null;});}
    return connection;
  }
  function range(projectId){return keyRange.bound([projectId,0],[projectId,Number.MAX_SAFE_INTEGER]);}
  async function transact(binding, mode, operation){
    binding={...validateTaskDraftBinding(binding)};
    const db=await open();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(['heads','revisions'],mode);
      let result, failure=null;
      const abort=error=>{failure=error;tx.abort();};
      tx.oncomplete=()=>resolve(result);
      tx.onabort=()=>reject(failure??new Error('Draft save was not committed. Storage may be full or unavailable; existing revisions were kept.'));
      tx.onerror=()=>{};
      const heads=tx.objectStore('heads'), revisions=tx.objectStore('revisions');
      const request=heads.get(binding.projectId);
      request.onsuccess=()=>{
        try{
          const head=request.result;
          if(head===undefined){
            const orphan=revisions.openCursor(range(binding.projectId));
            orphan.onsuccess=()=>{try{if(orphan.result)fail('Draft head is missing while history exists. Recovery is required; no data was reset.');result=operation(emptyTaskDraftLedger(binding),{heads,revisions});}catch(error){abort(error);}};
            return;
          }
          if(head.projectId!==binding.projectId||!Number.isSafeInteger(head.revision)||head.revision<1||head.revision>5000||Object.keys(head).length!==2)fail('Draft head is invalid. Existing data was not reset.');
          const record=revisions.get([binding.projectId,head.revision]);
          record.onsuccess=()=>{try{
            const current=validateTaskDraftLedger(record.result);
            if(current.revision!==head.revision||current.binding.projectId!==binding.projectId)fail('Draft history and head disagree. Recovery is required.');
            result=operation(current,{heads,revisions});
          }catch(error){abort(error);}};
        }catch(error){abort(error);}
      };
    });
  }
  async function submissionTransaction(binding,mode,operation){
    binding={...validateTaskDraftBinding(binding)};const db=await open();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(['heads','revisions','submissions'],mode);let result,failure;
      const abort=error=>{failure=error;tx.abort();};
      tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(failure??new Error('Submission was not committed. Do not send it; existing records were kept.'));tx.onerror=()=>{};
      const submissions=tx.objectStore('submissions'),records=[];let bytes=0;
      const cursor=submissions.openCursor(keyRange.bound([binding.projectId,''],[binding.projectId,'\uffff']));
      cursor.onsuccess=()=>{try{
        const item=cursor.result;
        if(item){const record=validateTaskDraftSubmission(item.value);if(record.binding.projectId!==binding.projectId)fail('Submission project binding is invalid.');bytes+=new TextEncoder().encode(submissionWire(record)).length;if(records.length>=TASK_SUBMISSION_LIMIT||bytes>TASK_SUBMISSION_BYTES)fail('Submission history limit reached. Existing records were kept.');records.push(record);item.continue();return;}
        operation({records,bytes,submissions,heads:tx.objectStore('heads'),revisions:tx.objectStore('revisions'),done:value=>{result=value;},abort});
      }catch(error){abort(error);}};
    });
  }
  async function intentTransaction(binding,mode,operation){
    binding=structuredClone(validateTaskDraftBinding(binding));const db=await open();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(['heads','revisions','saveIntents'],mode,mode==='readwrite'?{durability:'strict'}:undefined);
      if(mode==='readwrite'&&tx.durability!=='strict'){tx.abort();reject(Error('Strict Save intent durability is unavailable. Nothing may be dispatched.'));return;}
      let result,failure;const abort=error=>{failure=error;tx.abort();};tx.oncomplete=()=>resolve(structuredClone(result));tx.onabort=()=>reject(failure??Error('Save intent transaction outcome is unavailable. Keep the original request.'));tx.onerror=()=>{};
      const intents=tx.objectStore('saveIntents'),heads=tx.objectStore('heads'),revisions=tx.objectStore('revisions'),records=[];let bytes=0;
      const cursor=intents.openCursor(keyRange.bound([binding.projectId,''],[binding.projectId,'\uffff']));
      cursor.onsuccess=()=>{try{const item=cursor.result;if(item){const record=validateTaskSaveIntent(item.value);if(record.original.binding.projectId!==binding.projectId||submissionWire(item.primaryKey)!==submissionWire([binding.projectId,record.original.requestId]))fail('Save intent key/project mismatch.');bytes+=taskSaveIntentBytes(record);if(records.length>=TASK_SAVE_INTENT_LIMIT||bytes>TASK_SAVE_INTENT_BYTES)fail('Save intent history exceeds its bound.');records.push(record);item.continue();return;}
        const put=record=>{validateTaskSaveIntent(record);const evict=saveIntentsToEvict(records,record);const next=records.filter(row=>row.original.requestId!==record.original.requestId&&!evict.includes(row.original.requestId)).concat(record);assertTaskSaveIntentCapacity(next);for(const id of evict)intents.delete([binding.projectId,id]);intents.put(record);result=record;};
        const current=callback=>{const request=heads.get(binding.projectId);request.onsuccess=()=>{try{const head=request.result;if(head===undefined){const orphan=revisions.openCursor(range(binding.projectId));orphan.onsuccess=()=>{try{if(orphan.result)fail('Draft head missing with retained history.');callback(emptyTaskDraftLedger(binding));}catch(error){abort(error);}};return;}if(head.projectId!==binding.projectId||!Number.isSafeInteger(head.revision)||head.revision<1||head.revision>5000||Object.keys(head).length!==2)fail('Draft head invalid.');const read=revisions.get([binding.projectId,head.revision]);read.onsuccess=()=>{try{const ledger=validateTaskDraftLedger(read.result);if(ledger.binding.projectId!==binding.projectId||ledger.revision!==head.revision||submissionWire(ledger)!==submissionWire(read.result))fail('Draft head/history mismatch.');callback(ledger);}catch(error){abort(error);}};}catch(error){abort(error);}};};
        operation({records,put,current,revisions,heads,done:value=>{result=value;}});
      }catch(error){abort(error);}};
    });
  }
  const intentIdentity=(binding,id)=>{binding=structuredClone(validateTaskDraftBinding(binding));if(!validTaskSaveRequestId(id))fail('Save request identity is invalid.');return binding;};
  const findIntent=(records,binding,id)=>{const record=records.find(row=>row.original.requestId===id);if(record&&!sameTaskDraftBinding(record.original.binding,binding))fail('Save intent belongs to a different folder inventory.');return record;};
  async function readSaveIntent(binding,id){binding=intentIdentity(binding,id);return intentTransaction(binding,'readonly',({records,done})=>done(findIntent(records,binding,id)??null));}
  async function intentWrite(binding,operation){const record=await intentTransaction(binding,'readwrite',operation);notify(binding.projectId);const checked=await readSaveIntent(binding,record.original.requestId);if(!checked||submissionWire(checked.original)!==submissionWire(record.original)||(record.outcome!==null&&submissionWire(checked.outcome)!==submissionWire(record.outcome))||(record.acknowledgment!==null&&submissionWire(checked.acknowledgment)!==submissionWire(record.acknowledgment)))fail('Save intent readback is uncertain. Retry the same original request.');return record;}
  return Object.freeze({
    ...createSharedReconciliationStorage({open,keyRange,notify}),
    readSaveIntent,
    listSaveIntents(binding){binding=structuredClone(validateTaskDraftBinding(binding));return intentTransaction(binding,'readonly',({records,done})=>done(records.filter(row=>sameTaskSaveRoot(row.original.binding,binding))));},
    prepareSaveIntent(original){
      original=structuredClone(original);validateTaskSaveOriginal(original);const binding=original.binding;
      return intentWrite(binding,({records,put,current,done})=>{const prior=records.find(row=>row.original.requestId===original.requestId);if(prior){if(submissionWire(prior.original)!==submissionWire(original))fail('Save request ID conflicts with its retained original.');put(prior);return;}if(records.some(row=>sameTaskSaveRoot(row.original.binding,binding)&&row.acknowledgment===null))fail('Another Save intent for this folder still needs reconciliation.');current(ledger=>{if(submissionWire(ledger)!==submissionWire(original.baseLedger))fail('Save base changed. Review the current Ledger.');put({schemaVersion:1,kind:'TASK_FORM_SAVE_INTENT',original,outcome:null,acknowledgment:null,executionAuthorized:false});});});
    },
    commitSaveIntent(binding,id){
      binding=intentIdentity(binding,id);return intentWrite(binding,({records,put,current,revisions,heads,done})=>{const prior=findIntent(records,binding,id);if(!prior)fail('Original Save intent is missing.');if(prior.outcome?.kind==='withdrawn')fail('Original Save intent was withdrawn.');if(prior.outcome?.kind==='committed'){put(prior);return;}current(ledger=>{if(submissionWire(ledger)!==submissionWire(prior.original.baseLedger)||!sameTaskDraftBinding(ledger.binding,binding))fail('Save base changed. Original intent was kept.');const next=updateTaskDraft(ledger,prior.original.taskInput);put({...prior,outcome:{kind:'committed',ledger:next}});revisions.add(next);heads.put({projectId:binding.projectId,revision:next.revision});});});
    },
    withdrawSaveIntent(binding,id,original){binding=intentIdentity(binding,id);if(original!==undefined){original=structuredClone(original);validateTaskSaveOriginal(original);if(original.requestId!==id||!sameTaskDraftBinding(original.binding,binding))fail('Withdrawal original identity differs.');}return intentWrite(binding,({records,put})=>{const prior=findIntent(records,binding,id);if(prior){if(original&&submissionWire(prior.original)!==submissionWire(original))fail('Withdrawal differs from the retained original.');put(prior.outcome!==null?prior:{...prior,outcome:{kind:'withdrawn'}});return;}if(!original)fail('Original Save intent is missing.');put({schemaVersion:1,kind:'TASK_FORM_SAVE_INTENT',original,outcome:{kind:'withdrawn'},acknowledgment:null,executionAuthorized:false});});},
    acknowledgeSaveIntent(binding,id,evidence){binding=intentIdentity(binding,id);evidence=structuredClone(evidence);if(!evidence||!['editorDisposition','newerEditorPreserved'].includes(Object.keys(evidence).join('|')))fail('Save acknowledgment evidence is invalid.');return intentWrite(binding,({records,put,done})=>{const prior=findIntent(records,binding,id);if(!prior||!prior.outcome)fail('Save intent has no terminal outcome.');const acknowledgment={...evidence,declarationSource:'browser-declared'};if(prior.acknowledgment){if(submissionWire(prior.acknowledgment)!==submissionWire(acknowledgment))fail('Save acknowledgment conflicts with retained evidence.');put(prior);return;}put({...prior,acknowledgment});});},
    prepareSubmission(binding,expectedLocalRevision,request){
      binding={...validateTaskDraftBinding(binding)};request=validateSubmissionRequest(structuredClone(request));
      if(!Number.isSafeInteger(expectedLocalRevision)||expectedLocalRevision<1||expectedLocalRevision>5000)return Promise.reject(new Error('Save a draft revision before sending it.'));
      return submissionTransaction(binding,'readwrite',context=>{
        const {records,bytes,submissions,heads,revisions,done,abort}=context;
        const prior=records.find(item=>item.request.requestId===request.requestId);
        if(prior){if(!sameTaskDraftBinding(prior.binding,binding)||prior.localRevision!==expectedLocalRevision||submissionWire(prior.request)!==submissionWire(request))fail('Submission ID already belongs to different original content. Retry the original submission.');done(prior);return;}
        if(records.some(item=>sameTaskDraftBinding(item.binding,binding)&&item.receipt===null))fail('Another original submission is pending for this inventory. Retry that saved submission before creating a new one.');
        const head=heads.get(binding.projectId);head.onsuccess=()=>{try{
          if(!head.result||head.result.projectId!==binding.projectId||head.result.revision!==expectedLocalRevision||Object.keys(head.result).length!==2)fail('The draft changed before submission. Refresh and review it; no submission was created.');
          const read=revisions.get([binding.projectId,expectedLocalRevision]);read.onsuccess=()=>{try{
            const ledger=validateTaskDraftLedger(read.result);if(!sameTaskDraftBinding(ledger.binding,binding)||ledger.revision!==expectedLocalRevision)fail('Draft inventory changed. Review it before submission.');
            const record=validateTaskDraftSubmission({schemaVersion:1,kind:'LOCAL_DRAFT_SUBMISSION',binding,localRevision:expectedLocalRevision,ledger,request,receipt:null,executionAuthorized:false});
            // Reserve room for a receipt for every pending record. No disk-space
            // guarantee: a later storage failure remains recoverable by same ID.
            const projected=bytes+new TextEncoder().encode(submissionWire(record)).length;
            if(records.length>=TASK_SUBMISSION_LIMIT||projected+512*(records.filter(item=>item.receipt===null).length+1)>TASK_SUBMISSION_BYTES)fail('Submission history is full. Nothing was sent or removed.');
            submissions.add(record);done(record);
          }catch(error){abort(error);}};
        }catch(error){abort(error);}};
      }).then(record=>{notify(binding.projectId);return record;});
    },
    readSubmission(binding,requestId){
      binding={...validateTaskDraftBinding(binding)};if(!validSubmissionId(requestId))return Promise.reject(new Error('Submission ID is invalid.'));
      return submissionTransaction(binding,'readonly',({records,done})=>{const record=records.find(item=>item.request.requestId===requestId);if(record&&!sameTaskDraftBinding(record.binding,binding))fail('Submission belongs to a different folder inventory.');done(record??null);});
    },
    submissionHistory(binding){
      binding={...validateTaskDraftBinding(binding)};return submissionTransaction(binding,'readonly',({records,done})=>done(records.filter(item=>sameTaskDraftBinding(item.binding,binding))));
    },
    async recordSubmissionReceipt(binding,requestId,hostResult){
      binding={...validateTaskDraftBinding(binding)};if(!validSubmissionId(requestId))return Promise.reject(new Error('Submission ID is invalid.'));const receipt=submissionReceiptFromHost(structuredClone(hostResult));
      const original=await submissionTransaction(binding,'readonly',({records,done})=>{
        const record=records.find(item=>item.request.requestId===requestId);if(!record||!sameTaskDraftBinding(record.binding,binding))fail('Original submission is missing or belongs to another inventory.');done(record);
      });
      // Web Crypto is asynchronous: hash outside any live IndexedDB transaction,
      // then recheck immutable content in the committing transaction below.
      if(!globalThis.crypto?.subtle)fail('Submission receipt verification is unavailable. Retry the original submission when verification is available.');
      const bytes=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(submissionWire(original.ledger)));
      const ledgerDigest=Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,'0')).join('');
      if(receipt.submitted.ledgerDigest!==ledgerDigest)fail('Host receipt does not match the exact original ledger. Nothing was saved.');
      return submissionTransaction(binding,'readwrite',({records,bytes,submissions,done})=>{
        const prior=records.find(item=>item.request.requestId===requestId);if(!prior||!sameTaskDraftBinding(prior.binding,binding))fail('Original submission is missing or belongs to another inventory.');
        if(submissionWire(prior.ledger)!==submissionWire(original.ledger)||submissionWire(prior.request)!==submissionWire(original.request)||prior.localRevision!==original.localRevision)fail('Original submission changed during receipt verification. Nothing was saved.');
        if(receipt.submitted.hostRevision!==prior.request.expectedRevision+1)fail('Host receipt revision does not match the original submission.');
        if(prior.receipt){if(submissionWire(prior.receipt)!==submissionWire(receipt))fail('The host receipt conflicts with the retained submission receipt. Nothing was overwritten.');done(prior);return;}
        const next=validateTaskDraftSubmission({...prior,receipt});
        if(bytes-new TextEncoder().encode(submissionWire(prior)).length+new TextEncoder().encode(submissionWire(next)).length>TASK_SUBMISSION_BYTES)fail('Submission receipt storage is full. Retry the original submission after recovery.');
        submissions.put(next);done(next);
      }).then(record=>{notify(binding.projectId);return record;});
    },
    subscribe(binding,listener){
      const {projectId}=validateTaskDraftBinding(binding);
      const local=event=>{if(event.detail?.projectId===projectId)listener();};
      if(typeof window!=='undefined')window.addEventListener(eventName,local);
      let channel;try{if(typeof BroadcastChannel!=='undefined'){channel=new BroadcastChannel(eventName);channel.onmessage=event=>{if(event.data?.projectId===projectId)listener();};}}catch{}
      return()=>{if(typeof window!=='undefined')window.removeEventListener(eventName,local);channel?.close();};
    },
    read(binding){return transact(binding,'readonly',ledger=>ledger);},
    importDraft(binding,expectedRevision,incoming){
      binding={...validateTaskDraftBinding(binding)};
      const source=validateTaskDraftLedger(JSON.parse(JSON.stringify(incoming)));
      if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)return Promise.reject(new Error('Refresh this draft before importing.'));
      return transact(binding,'readwrite',(current,{heads,revisions})=>{
        if(!sameTaskDraftBinding(current.binding,binding))fail('The saved folder inventory changed. Review it before importing.');
        if(current.revision!==expectedRevision)fail('Another window saved a newer revision. Refresh and review the import again.');
        const next=importTaskDraft(current,source).ledger;
        revisions.add(next);heads.put({projectId:binding.projectId,revision:next.revision});
        return next;
      }).then(next=>{notify(next.binding.projectId);return next;});
    },
    rebind(binding,review){
      binding={...validateTaskDraftBinding(binding)};
      const capturedReview=JSON.parse(JSON.stringify(review));
      return transact(binding,'readwrite',(current,{heads,revisions})=>{
        const next=rebindTaskDraft(current,binding,capturedReview);
        revisions.add(next);heads.put({projectId:binding.projectId,revision:next.revision});
        return next;
      }).then(next=>{notify(next.binding.projectId);return next;});
    },
    saveTask(binding,expectedRevision,input){
      // Capture pending form data and binding before opening the asynchronous database.
      binding={...validateTaskDraftBinding(binding)};
      const task=JSON.parse(JSON.stringify(input));
      if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)return Promise.reject(new Error('Refresh this draft before saving.'));
      return transact(binding,'readwrite',(current,{heads,revisions})=>{
        if(!sameTaskDraftBinding(current.binding,binding))fail('The folder census changed. Existing drafts are kept; review their binding before editing.');
        if(current.revision!==expectedRevision)fail('Another window saved a newer revision. Your unsaved form is kept; refresh before saving.');
        const next=updateTaskDraft(current,task);
        revisions.add(next);heads.put({projectId:binding.projectId,revision:next.revision});
        return next;
      }).then(next=>{notify(next.binding.projectId);return next;});
    },
    async history(binding){
      binding={...validateTaskDraftBinding(binding)};
      const db=await open();
      return new Promise((resolve,reject)=>{
        const tx=db.transaction('revisions','readonly'), request=tx.objectStore('revisions').openCursor(range(binding.projectId),'prev');
        const records=[];let failure;
        request.onsuccess=()=>{try{const cursor=request.result;if(!cursor||records.length===50)return;const ledger=validateTaskDraftLedger(cursor.value);records.push({revision:ledger.revision,updatedAt:ledger.updatedAt,taskCount:ledger.tasks.length});cursor.continue();}catch(error){failure=error;tx.abort();}};
        tx.oncomplete=()=>resolve(records);tx.onabort=()=>reject(failure??new Error('Draft history could not be read.'));tx.onerror=()=>{};
      });
    },
    async readRevision(binding,revision){
      binding={...validateTaskDraftBinding(binding)};
      if(!Number.isSafeInteger(revision)||revision<1||revision>5000)fail('Draft revision is invalid.');
      const db=await open();
      return new Promise((resolve,reject)=>{const tx=db.transaction('revisions','readonly');const request=tx.objectStore('revisions').get([binding.projectId,revision]);let result,failure;request.onsuccess=()=>{try{result=validateTaskDraftLedger(request.result);if(result.binding.projectId!==binding.projectId||result.revision!==revision)fail('Draft history binding is invalid.');}catch(error){failure=error;tx.abort();}};tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(failure??new Error('Draft revision could not be read.'));tx.onerror=()=>{};});
    },
    async close(){const pending=connection;connection=null;const db=await pending;db?.close();},
  });
}
