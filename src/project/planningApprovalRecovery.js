import {validateTaskDraftLedger} from './taskDraftLedger.js';
import {verifyPlanApprovalDraft} from './planApprovalDraft.js';
import {checkedPlanningBinding,planningWire as wire,planningExact as exact,checkLedgerReceipt,checkApprovalReceipt,checkResolutionReceipt,planningResolutionConfirmation,planningApprovalOriginal,checkLedgerResolutionReceipt,planningLedgerResolutionConfirmation} from './planningApprovalReceipt.js';

const empty=()=>({pending:null,completed:[]});
const fail=message=>{throw Error(message);};
const bytes=value=>new TextEncoder().encode(wire(value)).length;
async function checkedInput(binding,kind,input){
  if(!['ledger','approval'].includes(kind))fail('Unknown planning recovery stage.');
  exact(input,kind==='ledger'?['ledger','request','expectedCensusDigest']:['binding','proposal','expectedProposalHead','request','confirmation']);
  exact(input.request,['requestId','expectedRevision','expectedHeadDigest']);
  if(typeof input.request.requestId!=='string'||typeof input.request.expectedHeadDigest!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.request.requestId)||!Number.isSafeInteger(input.request.expectedRevision)||input.request.expectedRevision<0||(input.request.expectedRevision===0?input.request.expectedHeadDigest!=='GENESIS':!/^[a-f0-9]{64}$/.test(input.request.expectedHeadDigest)))fail('Invalid original planning request.');
  if(kind==='ledger'){
    const ledger=validateTaskDraftLedger(input.ledger);
    if(wire(ledger)!==wire(input.ledger)||ledger.revision<1||wire(binding)!==wire(ledger.binding)||(input.expectedCensusDigest!==null&&(typeof input.expectedCensusDigest!=='string'||!/^[a-f0-9]{64}$/.test(input.expectedCensusDigest))))fail('Invalid retained ledger request.');
  }else{
    exact(input.expectedProposalHead,['hostRevision','headDigest']);exact(input.confirmation,['proposalDigest','decision']);
    if(typeof input.expectedProposalHead.headDigest!=='string'||typeof input.confirmation.proposalDigest!=='string')fail('Invalid approval digest.');
    if(wire(binding)!==wire(input.binding)||wire(binding)!==wire(input.proposal.binding)||!(await verifyPlanApprovalDraft(input.proposal)).valid||input.proposal.dependencyReview.some(item=>item.status!=='ordered')||!Number.isSafeInteger(input.expectedProposalHead.hostRevision)||input.expectedProposalHead.hostRevision<1||!/^[a-f0-9]{64}$/.test(input.expectedProposalHead.headDigest)||input.confirmation.decision!=='approve'||input.confirmation.proposalDigest!==input.proposal.digest)fail('Invalid retained approval request.');
  }
  if(bytes(input)>8*1024*1024+4096)fail('Planning recovery request is too large.');
}
const resolutionFor=entry=>entry.kind==='ledger'?planningLedgerResolutionConfirmation(entry.input):planningResolutionConfirmation(entry.input);
async function checkedReceipt(binding,entry,receipt){if(Object.hasOwn(entry,'resolution'))return entry.kind==='ledger'?checkLedgerResolutionReceipt(receipt,binding,{original:entry.input,confirmation:entry.resolution}):checkResolutionReceipt(receipt,binding,{binding,original:planningApprovalOriginal(entry.input),confirmation:entry.resolution});return entry.kind==='ledger'?checkLedgerReceipt(receipt,binding,entry.input):checkApprovalReceipt(receipt,binding,'publish',entry.input);}
async function checkedState(binding,state){
  exact(state,['pending','completed']);
  if(!Array.isArray(state.completed)||state.completed.length>32||bytes(state)>64*1024*1024)fail('Planning recovery history limit or corruption. Existing work was preserved.');
  const ids=new Set();
  for(const entry of [...state.completed,...(state.pending===null?[]:[state.pending])]){
    exact(entry,['kind','input','requestId',...(Object.hasOwn(entry,'resolution')?['resolution']:[]),...(entry===state.pending?[]:['receipt'])]);
    await checkedInput(binding,entry.kind,entry.input);
    if(Object.hasOwn(entry,'resolution')&&wire(entry.resolution)!==wire(await resolutionFor(entry)))fail('Invalid retained resolution intent.');
    if(entry.requestId!==entry.input.request.requestId||ids.has(entry.requestId))fail('Planning recovery identity conflict.');
    ids.add(entry.requestId);if(entry!==state.pending)await checkedReceipt(binding,entry,entry.receipt);
  }
  return state;
}

// No network side effects. Only a committed prepare permits the UI to send.
// Never prune unresolved requests or reset corrupt stores automatically.
export function createPlanningApprovalRecovery({indexedDB=globalThis.indexedDB,name='perfect-planner-planning-approval-recovery-v1'}={}){
  let opening;
  const eventName=`${name}:changed`;
  function notify(binding){
    // Committed-state hints only: consumers must re-read and verify storage.
    try{if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent(eventName,{detail:{binding}}));}catch{}
    try{if(typeof BroadcastChannel!=='undefined'){const channel=new BroadcastChannel(eventName);channel.postMessage({binding});channel.close();}}catch{}
  }
  function database(){
    if(!opening)opening=new Promise((resolve,reject)=>{
      if(!indexedDB){reject(Error('Durable planning recovery is unavailable. Nothing was sent.'));return;}
      const request=indexedDB.open(name,1);let abandoned=false;
      request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('bindings'))request.result.createObjectStore('bindings');};
      request.onerror=()=>reject(request.error||Error('Planning recovery could not open.'));
      request.onblocked=()=>{abandoned=true;reject(Error('Close other planning recovery tabs before continuing.'));};
      request.onsuccess=()=>{const db=request.result;if(abandoned){db.close();return;}db.onversionchange=()=>{db.close();opening=null;};resolve(db);};
    }).catch(error=>{opening=null;throw error;});
    return opening;
  }
  async function read(key){const db=await database();return new Promise((resolve,reject)=>{const tx=db.transaction('bindings','readonly'),request=tx.objectStore('bindings').get(key);let value;request.onsuccess=()=>{value=request.result===undefined?empty():request.result;};tx.oncomplete=()=>resolve(value);tx.onabort=tx.onerror=()=>reject(tx.error||Error('Planning recovery read failed.'));});}
  async function replace(key,previous,next){const db=await database();return new Promise((resolve,reject)=>{const tx=db.transaction('bindings','readwrite'),store=tx.objectStore('bindings'),request=store.get(key);let cause;request.onsuccess=()=>{try{if(wire(request.result===undefined?empty():request.result)!==wire(previous))throw Error('Planning recovery changed in another tab. Reload before continuing.');store.put(next,key);}catch(error){cause=error;tx.abort();}};tx.oncomplete=()=>{notify(JSON.parse(key));resolve(structuredClone(next));};tx.onabort=tx.onerror=()=>reject(cause||Error('Planning recovery could not be saved. Nothing new was sent.'));});}
  async function inspect(binding){binding=structuredClone(binding);checkedPlanningBinding(binding);return checkedState(binding,await read(wire(binding)));}
  return {
    inspect,
    subscribe(binding,listener){
      binding=structuredClone(binding);checkedPlanningBinding(binding);if(typeof listener!=='function')throw Error('Planning recovery listener required.');
      const matches=value=>value?.projectId===binding.projectId&&value?.rootIdentity===binding.rootIdentity&&value?.censusDigest===binding.censusDigest;
      const local=event=>{if(matches(event.detail?.binding))listener();};
      if(typeof window!=='undefined')window.addEventListener(eventName,local);
      let channel;try{if(typeof BroadcastChannel!=='undefined'){channel=new BroadcastChannel(eventName);channel.onmessage=event=>{if(matches(event.data?.binding))listener();};}}catch{}
      return()=>{if(typeof window!=='undefined')window.removeEventListener(eventName,local);channel?.close();};
    },
    async close(){const pending=opening;opening=null;const db=await pending;db?.close();},
    async prepare(binding,entry){
      binding=structuredClone(binding);entry=structuredClone(entry);checkedPlanningBinding(binding);exact(entry,['kind','input']);await checkedInput(binding,entry.kind,entry.input);
      const state=await inspect(binding),pending={...entry,requestId:entry.input.request.requestId};
      if(state.pending){if(wire(state.pending)===wire(pending))return state.pending;fail('Recover the existing planning request before starting another.');}
      if(state.completed.some(item=>item.requestId===pending.requestId))fail('This request already has a retained receipt. Use a new explicit request.');
      const next={...state,pending};
      // Reserve room for the receipt before dispatch, including a later ledger
      // head returned by an original retry. Actual browser quota can still fail;
      // in that case the original durable pending request remains recoverable.
      const receiptReserve=(entry.kind==='ledger'?1024*1024:bytes(entry.input))+16384;
      if(state.completed.length>=32||bytes(next)+receiptReserve>64*1024*1024)fail('Planning recovery history is full. Nothing was sent.');
      await checkedState(binding,next);await replace(wire(binding),state,next);return structuredClone(pending);
    },
    async complete(binding,requestId,receipt){
      binding=structuredClone(binding);receipt=structuredClone(receipt);checkedPlanningBinding(binding);const state=await inspect(binding);
      if(!state.pending||state.pending.requestId!==requestId)fail('No matching pending planning request.');
      if(Object.hasOwn(state.pending,'resolution'))fail('Resolve the retained withdrawal intent; ordinary completion is refused.');
      await checkedReceipt(binding,state.pending,receipt);
      const next={pending:null,completed:[...state.completed,{...state.pending,receipt}]};await checkedState(binding,next);return replace(wire(binding),state,next);
    },
    async prepareResolution(binding,requestId){
      binding=structuredClone(binding);checkedPlanningBinding(binding);const state=await inspect(binding);
      if(!state.pending||state.pending.requestId!==requestId)fail('No matching pending request to resolve.');
      if(Object.hasOwn(state.pending,'resolution'))return structuredClone(state.pending);
      const pending={...state.pending,resolution:await resolutionFor(state.pending)},next={...state,pending};
      // Submitted resolution retains both the full original proposal and the
      // possibly larger latest ledger in its real host receipt.
      const receiptReserve=bytes(pending.input)+(pending.kind==='ledger'?1024*1024:0)+16384;
      if(state.completed.length>=32||bytes(next)+receiptReserve>64*1024*1024)fail('Planning recovery history is full. Nothing was sent.');
      await checkedState(binding,next);await replace(wire(binding),state,next);return structuredClone(pending);
    },
    async completeResolution(binding,requestId,receipt){
      binding=structuredClone(binding);receipt=structuredClone(receipt);checkedPlanningBinding(binding);const state=await inspect(binding);
      if(!state.pending||state.pending.requestId!==requestId||!Object.hasOwn(state.pending,'resolution'))fail('No matching durable resolution intent.');
      await checkedReceipt(binding,state.pending,receipt);
      const next={pending:null,completed:[...state.completed,{...state.pending,receipt}]};await checkedState(binding,next);return replace(wire(binding),state,next);
    },
  };
}
