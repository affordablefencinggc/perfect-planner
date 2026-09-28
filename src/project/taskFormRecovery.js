import {validateTaskDraftBinding} from './taskDraftLedger.js';
import {canonicalArchitectureJson as wire} from '../engine/architectureContractVerification.js';

export const TASK_FORM_HISTORY_LIMIT=256;
export const TASK_FORM_HISTORY_BYTES=4*1024*1024;
const fail=message=>{throw Error(message);};
const exact=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('|')!==keys.sort().join('|'))fail('Task form recovery shape is invalid. Existing text was kept.');};
const bytes=value=>new TextEncoder().encode(wire(value)).length;
const validEditor=id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(id);
const revision=value=>Number.isSafeInteger(value)&&value>=0&&value<=5000;
const sameRoot=(a,b)=>a.projectId===b.projectId&&a.rootIdentity===b.rootIdentity;
export function validateTaskRecoveryForm(form){
 exact(form,['id','title','description','owner','acceptance','recovery','claims','dependsOn','archived']);
 if((form.id!==null&&(typeof form.id!=='string'||!/^T\d{4,6}$/.test(form.id)||Number(form.id.slice(1))<1||form.id!==`T${String(Number(form.id.slice(1))).padStart(4,'0')}`))||typeof form.archived!=='boolean')fail('Task form identity is invalid.');
 const limits={title:160,description:8000,owner:120,acceptance:8000,recovery:8000,claims:16384,dependsOn:4096};
 for(const [key,limit]of Object.entries(limits))if(typeof form[key]!=='string'||form[key].length>limit)fail('Task form recovery field limit reached. Text was not replaced.');
 // Raw/incomplete claims and whitespace are intentionally not normalized.
 if(bytes(form)>65536)fail('Task form recovery size limit reached.');return form;
}
export function validateTaskFormHistory(value,binding){
 validateTaskDraftBinding(binding);if(!Array.isArray(value)||value.length>TASK_FORM_HISTORY_LIMIT)fail('Task form recovery history is corrupt or full.');
 const heads=new Map();
 for(const record of value){
  exact(record,['schemaVersion','kind','binding','editorId','revision','baseLedgerRevision','form','status','resolution','updatedAt']);validateTaskDraftBinding(record.binding);validateTaskRecoveryForm(record.form);
  if(record.schemaVersion!==1||record.kind!=='TASK_FORM_RECOVERY'||!sameRoot(binding,record.binding)||!validEditor(record.editorId)||!revision(record.revision)||record.revision<1||!revision(record.baseLedgerRevision)||!['unfinished','resolved'].includes(record.status)||(record.status==='unfinished'?record.resolution!==null:!['saved','discarded','superseded'].includes(record.resolution))||typeof record.updatedAt!=='string'||!Number.isFinite(Date.parse(record.updatedAt))||new Date(record.updatedAt).toISOString()!==record.updatedAt||bytes(record)>65536)fail('Task form recovery record is invalid.');
  const prior=heads.get(record.editorId);if(record.revision!==(prior?.revision??0)+1||(prior&&(prior.status==='resolved'||wire(prior.binding)!==wire(record.binding)||record.baseLedgerRevision<prior.baseLedgerRevision)))fail('Task form recovery sequence is invalid.');
  if(record.status==='resolved'&&(!prior||prior.status!=='unfinished'||wire(prior.form)!==wire(record.form)||prior.baseLedgerRevision!==record.baseLedgerRevision))fail('Task form resolution does not retain its original.');
  heads.set(record.editorId,record);
 }
 if(bytes(value)>TASK_FORM_HISTORY_BYTES)fail('Task form recovery history is full.');return value;
}
// Pure transition used by the live IndexedDB transaction. It never mutates a
// caller's form, repairs corrupt history, trims text or overwrites another tab.
export function appendTaskFormHistory(history,input,action,now=new Date().toISOString()){
 input=structuredClone(input);exact(input,action==='put'?['binding','editorId','expectedRevision','baseLedgerRevision','form']:['binding','editorId','expectedRevision','reason']);validateTaskFormHistory(history,input.binding);
 if(!validEditor(input.editorId)||!revision(input.expectedRevision))fail('Task form recovery request is invalid.');
 const prior=history.filter(row=>row.editorId===input.editorId).at(-1);
 if((prior?.revision??0)!==input.expectedRevision||(prior&&(prior.status==='resolved'||wire(prior.binding)!==wire(input.binding))))fail('Task form recovery changed or was resolved. Start a new editor after resolution.');
 if(!['put','resolve'].includes(action))fail('Unknown task form operation.');
 if(action==='resolve'&&(!prior||prior.status!=='unfinished'))fail('No unfinished task form to resolve.');
 const record={schemaVersion:1,kind:'TASK_FORM_RECOVERY',binding:input.binding,editorId:input.editorId,revision:input.expectedRevision+1,baseLedgerRevision:action==='put'?input.baseLedgerRevision:prior.baseLedgerRevision,form:action==='put'?input.form:prior.form,status:action==='put'?'unfinished':'resolved',resolution:action==='put'?null:input.reason,updatedAt:now};
 const next=[...history,record];validateTaskFormHistory(next,input.binding);
 if(action==='put'){
  const heads=new Map();next.forEach(row=>heads.set(row.editorId,row));const unfinished=[...heads.values()].filter(row=>row.status==='unfinished');
  if(next.length+unfinished.length>TASK_FORM_HISTORY_LIMIT||bytes(next)+unfinished.reduce((total,row)=>total+bytes(row)+64,0)>TASK_FORM_HISTORY_BYTES)fail('Task form recovery is full. Existing text and room for resolutions were kept.');
 }
 return structuredClone(next);
}

export function createTaskFormRecovery({indexedDB=globalThis.indexedDB,name='perfect-planner-task-form-recovery-v1'}={}){
 // Bounded checkpoints, not an unbounded keystroke journal. The UI must coalesce
 // pending edits and show unsaved/quota/export states until put resolves.
 // Resolution is the caller's declared disposition, not evidence that the
 // Ledger was saved. Resolved editor IDs are terminal. Explicit put may move
 // the base revision forward (reviewed reapply), never backward or to a new binding.
 let connection=null;
 const eventName=`${name}:changed`;
 function notify(binding){
  const detail={projectId:binding.projectId,rootIdentity:binding.rootIdentity};
  try{if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent(eventName,{detail}));}catch{}
  try{if(typeof BroadcastChannel!=='undefined'){const channel=new BroadcastChannel(eventName);channel.postMessage(detail);channel.close();}}catch{}
 }
 function open(){
  if(!indexedDB)return Promise.reject(Error('Durable unfinished form recovery is unavailable. Keep or export your text.'));
  if(!connection){const pending=new Promise((resolve,reject)=>{const request=indexedDB.open(name,1);let abandoned=false;
   request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('histories'))request.result.createObjectStore('histories');};
   request.onblocked=()=>{abandoned=true;reject(Error('Close older Planner tabs before opening form recovery.'));};
   request.onerror=()=>{reject(Error('Form recovery could not open. Existing data was not reset.'));};
   request.onsuccess=()=>{const db=request.result;if(abandoned){db.close();return;}db.onversionchange=()=>{db.close();if(connection===pending)connection=null;};resolve(db);};
  });connection=pending;pending.catch(()=>{if(connection===pending)connection=null;});}return connection;
 }
 const key=binding=>wire({projectId:binding.projectId,rootIdentity:binding.rootIdentity});
 async function history(binding){binding=structuredClone(binding);validateTaskDraftBinding(binding);const db=await open();return new Promise((resolve,reject)=>{const tx=db.transaction('histories','readonly'),request=tx.objectStore('histories').get(key(binding));let result,failure;request.onsuccess=()=>{try{result=validateTaskFormHistory(request.result===undefined?[]:request.result,binding);}catch(error){failure=error;tx.abort();}};tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(failure||Error('Task form recovery read failed.'));tx.onerror=()=>{};});}
 async function change(input,action){
  input=structuredClone(input);validateTaskDraftBinding(input.binding);const db=await open();
  const record=await new Promise((resolve,reject)=>{const tx=db.transaction('histories','readwrite',{durability:'strict'});if(tx.durability!=='strict'){tx.abort();reject(Error('Strict form recovery durability is unavailable. Keep or export your text.'));return;}const store=tx.objectStore('histories'),request=store.get(key(input.binding));let result,failure;
   request.onsuccess=()=>{try{const next=appendTaskFormHistory(request.result===undefined?[]:request.result,input,action);result=next.at(-1);store.put(next,key(input.binding));}catch(error){failure=error;tx.abort();}};
   tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(failure||Error('Task form recovery was not committed. Keep your text.'));tx.onerror=()=>{};
  });
  notify(input.binding);
  const after=await history(input.binding),saved=after.find(row=>row.editorId===record.editorId&&row.revision===record.revision);
  if(!saved||wire(saved)!==wire(record))fail('Task form recovery readback is uncertain. Original history was not cleared.');return structuredClone(saved);
 }
 return {
  put:input=>change(input,'put'),resolve:input=>change(input,'resolve'),
  async list(binding){const rows=await history(binding),heads=new Map();rows.forEach(row=>heads.set(row.editorId,row));return structuredClone({records:[...heads.values()],history:rows});},
  async read(binding,editorId){binding=structuredClone(binding);if(!validEditor(editorId))fail('Editor identity is invalid.');const rows=await history(binding);return structuredClone(rows.filter(row=>row.editorId===editorId&&wire(row.binding)===wire(binding)).at(-1)??null);},
  subscribe(binding,listener){
   binding=structuredClone(binding);validateTaskDraftBinding(binding);if(typeof listener!=='function')fail('Recovery listener is invalid.');
   const matches=value=>value?.projectId===binding.projectId&&value?.rootIdentity===binding.rootIdentity;
   const onEvent=event=>{if(matches(event.detail))listener();};let channel;
   if(typeof window!=='undefined')window.addEventListener(eventName,onEvent);
   try{if(typeof BroadcastChannel!=='undefined'){channel=new BroadcastChannel(eventName);channel.onmessage=event=>{if(matches(event.data))listener();};}}catch{}
   return()=>{if(typeof window!=='undefined')window.removeEventListener(eventName,onEvent);channel?.close();};
  },
  async close(){const pending=connection;connection=null;if(pending)(await pending).close();},
 };
}
