import {validateTaskDraftBinding,sameTaskDraftBinding} from './taskDraftLedger.js';
import {validateTaskDraftSubmission,submissionReceiptFromHost,validSubmissionId,submissionWire} from './taskDraftSubmission.js';
import {validateSharedTaskReconciliation} from './sharedTaskReconciliation.js';

function failure(code,requestId=null){
  const messages={BUSY:'A submission is already being handled. Its original record has been kept.',
    PENDING:'Resolve the pending submission before sending a new revision. Retry uses its original saved content.',
    REMOTE_CHANGED:'The shared plan has changes this local draft has not reconciled. Nothing was sent. Keep your local draft and review the shared Ledger before submitting a replacement.',
    UNAVAILABLE:'Native draft delivery is unavailable. Nothing was sent.',
    PREPARE_FAILED:'The original submission could not be saved. Nothing was sent.',
    NOT_CONFIRMED:'Delivery is not confirmed on this device. Keep and retry the original submission; do not create a replacement ID.',
    INVALID:'The saved submission or project binding is invalid. Existing records were kept.'};
  const error=new Error(messages[code]);error.code=code;error.requestId=requestId;return error;
}
function inspectedHead(value){
  const keys=['schemaVersion','observedHead','registrationCurrent','registrationLeaseHeld','approvalState','executionAuthorized'];
  if(!value||Object.keys(value).sort().join('|')!==keys.sort().join('|')||value.schemaVersion!==1||value.registrationCurrent!==true||value.registrationLeaseHeld!==false||value.approvalState!=='unapproved-proposal'||value.executionAuthorized!==false)throw failure('UNAVAILABLE');
  const head=value.observedHead;
  if(!head||Object.keys(head).sort().join('|')!=='headDigest|hostRevision'||!Number.isSafeInteger(head.hostRevision)||head.hostRevision<0||(head.hostRevision===0?head.headDigest!=='GENESIS':!/^[a-f0-9]{64}$/.test(head.headDigest)))throw failure('UNAVAILABLE');
  return {...head};
}

function nativeRecovery(error,cause){
  error.requiresRecovery=cause?.requiresRecovery===true;
  // Native may require an older original, distinct from this local attempt.
  if(validSubmissionId(cause?.originalRequestId))error.originalRequestId=cause.originalRequestId;
  return error;
}

// The host adapter must be bound to the native registration, not a URL or
// renderer-provided executable. This controller never owns the unsaved form.
// Its durable receipt write continues even when the originating view unmounts.
export function createTaskDraftDelivery({store,host,createRequestId=()=>globalThis.crypto.randomUUID()}){
  if(!store||!['prepareSubmission','readSubmission','submissionHistory','recordSubmissionReceipt'].every(k=>typeof store[k]==='function')||!host||!['inspect','submit'].every(k=>typeof host[k]==='function'))throw failure('UNAVAILABLE');
  store=Object.freeze(Object.fromEntries(['prepareSubmission','readSubmission','submissionHistory','recordSubmissionReceipt','reconciliationHistory','readRevision'].filter(k=>typeof store[k]==='function').map(k=>[k,store[k].bind(store)])));
  host=Object.freeze(Object.fromEntries(['inspect','submit'].map(k=>[k,host[k].bind(host)])));
  let busy=false;
  async function exclusive(work){if(busy)throw failure('BUSY');busy=true;try{return await work();}finally{busy=false;}}
  function original(value,binding){
    const record=validateTaskDraftSubmission(structuredClone(value));
    if(!sameTaskDraftBinding(record.binding,binding))throw failure('INVALID');return record;
  }
  async function deliver(record){
    if(record.receipt)return Object.freeze({status:'previously-acknowledged',record,executionAuthorized:false});
    try{
      // Exactly the immutable saved ledger and original nested ID. Each adapter
      // invocation allocates a fresh outer transport ID in the native host.
      const result=structuredClone(await host.submit({ledger:record.ledger,request:record.request}));
      submissionReceiptFromHost(result);
      const saved=original(await store.recordSubmissionReceipt(record.binding,record.request.requestId,result),record.binding);
      if(!saved.receipt||submissionWire(saved.ledger)!==submissionWire(record.ledger)||submissionWire(saved.request)!==submissionWire(record.request))throw failure('INVALID');
      return Object.freeze({status:'acknowledged',record:saved,registrationCurrent:result.registrationCurrent,executionAuthorized:false});
    }catch(cause){throw nativeRecovery(failure('NOT_CONFIRMED',record.request.requestId),cause);}
  }
  return Object.freeze({
    start(binding,localRevision){
      binding={...validateTaskDraftBinding(binding)};
      return exclusive(async()=>{
        let history;try{history=await store.submissionHistory(binding);}catch{throw failure('PREPARE_FAILED');}
        if(!Array.isArray(history))throw failure('INVALID');
        const originals=history.map(record=>original(record,binding));
        if(originals.some(record=>record.receipt===null))throw failure('PENDING');
        let head;try{head=inspectedHead(await host.inspect());}catch(cause){throw nativeRecovery(failure('UNAVAILABLE'),cause);}
        // Inspecting today's head is not evidence that this local editor has
        // incorporated it. Never silently rebase a whole-ledger replacement
        // over an agent's or another device's changes. Retried originals keep
        // their immutable parent and remain handled by the host CAS journal.
        const parents=originals.map(record=>({localRevision:record.localRevision,head:record.receipt.submitted,kind:'acknowledged'}));
        if(store.reconciliationHistory){
          if(!store.readRevision)throw failure('INVALID');
          let reviews;try{reviews=await store.reconciliationHistory(binding);}catch{throw failure('PREPARE_FAILED');}
          if(!Array.isArray(reviews)||reviews.length>64)throw failure('INVALID');
          const seen=new Set();
          for(const value of reviews){
            let review,saved;try{review=await validateSharedTaskReconciliation(value);saved=await store.readRevision(binding,review.ledger.revision);}catch{throw failure('INVALID');}
            if(!sameTaskDraftBinding(review.localBase.binding,binding)||submissionWire(saved)!==submissionWire(review.ledger)||seen.has(review.ledger.revision))throw failure('INVALID');
            seen.add(review.ledger.revision);
            parents.push({localRevision:review.ledger.revision,head:review.sharedSnapshot.observedHead,kind:'reconciled'});
          }
        }
        // Follow the most recent local incorporation, not the largest remote
        // revision. A later local review may not borrow an earlier receipt's
        // authority. An acknowledgment at the same local revision wins because
        // that exact revision has already been sent.
        parents.sort((a,b)=>b.localRevision-a.localRevision||Number(b.kind==='acknowledged')-Number(a.kind==='acknowledged'));
        const parent=parents[0];
        if(parent?parent.head.hostRevision!==head.hostRevision||parent.head.headDigest!==head.headDigest||localRevision<parent.localRevision||(parent.kind==='acknowledged'&&localRevision===parent.localRevision):head.hostRevision!==0)throw failure('REMOTE_CHANGED');
        let record;
        try{
          const requestId=createRequestId();if(!validSubmissionId(requestId))throw failure('INVALID');
          record=original(await store.prepareSubmission(binding,localRevision,{requestId,expectedRevision:head.hostRevision,expectedHeadDigest:head.headDigest}),binding);
          if(record.localRevision!==localRevision||record.request.requestId!==requestId||record.request.expectedRevision!==head.hostRevision||record.request.expectedHeadDigest!==head.headDigest)throw failure('INVALID');
        }catch{throw failure('PREPARE_FAILED');}
        return deliver(record);
      });
    },
    retry(binding,requestId){
      binding={...validateTaskDraftBinding(binding)};
      if(!validSubmissionId(requestId))return Promise.reject(failure('INVALID'));
      return exclusive(async()=>{
        let record;try{record=original(await store.readSubmission(binding,requestId),binding);}catch{throw failure('INVALID');}
        if(record.request.requestId!==requestId)throw failure('INVALID');
        return deliver(record);
      });
    },
  });
}
