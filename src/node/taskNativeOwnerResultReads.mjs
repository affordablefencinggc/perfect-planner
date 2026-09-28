import {createTaskNativeResultReads} from './taskNativeResultReads.mjs';
import {NATIVE_TASK_INDEX_PAGE_SIZE,validateNativeTaskIndexRequest,validateNativeTaskResultIndex} from '../shared/nativeTaskResultIndex.js';

// Native owner's private project capability, not an agent-session substitute.
// Never expose this factory or grant-store selection through MCP/renderer input.
export function createTaskNativeOwnerResultReads({grants,observations,binding,observeBinding}){
 if(typeof grants?.inspect!=='function'||typeof observeBinding!=='function'||!binding?.projectId||!/^[a-f0-9]{64}$/.test(binding.rootIdentity))throw Error('NATIVE_OWNER_RESULT_CONFIG_INVALID');
 const expected=Object.freeze({projectId:binding.projectId,rootIdentity:binding.rootIdentity}),inspect=grants.inspect.bind(grants),observe=observeBinding;
 const reader=createTaskNativeResultReads({observations,review:{inspectOwnGrantReceipt:async input=>{
  if(!input||Object.keys(input).length!==1||typeof input.grantId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.grantId))throw Error('NATIVE_TASK_RESULT_UNAVAILABLE');
  const current=await observe();if(current?.projectId!==expected.projectId||current?.rootIdentity!==expected.rootIdentity)throw Error('NATIVE_OWNER_RESULT_SCOPE_CHANGED');
  const state=await inspect();if(state.projectId!==expected.projectId||state.rootIdentity!==expected.rootIdentity||state.executionAuthorized!==false)throw Error('NATIVE_TASK_RESULT_UNAVAILABLE');
  const entry=state.grants.find(value=>value.grant.grantId===input.grantId);
  if(!entry?.intentReceipt)throw Error('NATIVE_TASK_RESULT_UNAVAILABLE');
  return {intentReceipt:entry.intentReceipt,observationLink:entry.observationLink};
 }}});
 const current=async()=>{const b=await observe();if(b?.projectId!==expected.projectId||b?.rootIdentity!==expected.rootIdentity)throw Error('NATIVE_OWNER_RESULT_SCOPE_CHANGED');};
 const checkedState=async()=>{
  const state=await inspect();
  if(state.projectId!==expected.projectId||state.rootIdentity!==expected.rootIdentity||state.executionAuthorized!==false)throw Error('NATIVE_TASK_RESULT_UNAVAILABLE');
  return state;
 };
 const pageFrom=(state,input)=>{
  if(input.expectedHeadDigest!==null&&input.expectedHeadDigest!==state.headDigest)throw Error('NATIVE_TASK_INDEX_STALE');
  const ordered=[...state.grants].sort((a,b)=>b.revision-a.revision);
  const entries=ordered.slice(input.offset,input.offset+NATIVE_TASK_INDEX_PAGE_SIZE).map(entry=>{
   const event=state.history[entry.revision-1],g=entry.grant;
   if(event?.grant?.grantId!==g.grantId||event.event!==entry.state)throw Error('NATIVE_TASK_RESULT_UNAVAILABLE');
   return {grantId:g.grantId,taskId:g.binding.taskId,checkId:g.binding.checkId,attemptId:g.binding.attemptId,attemptNumber:g.binding.attemptNumber,workerId:g.binding.workerId,
    lifecycleState:entry.state,journalRevision:entry.revision,recordedAt:event.recordedAt,runId:entry.intentReceipt?.runId??null,intentDigest:entry.intentReceipt?.recordDigest??null,artifactDigest:entry.observationLink?.artifactDigest??null};
  });
  return validateNativeTaskResultIndex({schemaVersion:1,kind:'NATIVE_TASK_RESULT_INDEX',...expected,journalHead:{revision:state.revision,headDigest:state.headDigest},offset:input.offset,totalGrants:ordered.length,nextOffset:input.offset+entries.length<ordered.length?input.offset+entries.length:null,entries,authorityVerified:false,executionAuthorized:false},input,expected);
 };
 return Object.freeze({readOwner:input=>reader.readOwn(structuredClone(input)),async listOwner(input){
  input=validateNativeTaskIndexRequest(structuredClone(input));await current();
  const page=pageFrom(await checkedState(),input);await current();return page;
 },async readPageOwner(input){
  input=validateNativeTaskIndexRequest(structuredClone(input));await current();
  // Exactly two journal reads per page, independent of the number of outcomes.
  // Nothing is published before the final scope/head check. This is a historical
  // snapshot, not a cross-process lease or permission to execute work.
  const state=await checkedState(),page=pageFrom(state,input);
  const entries=new Map(state.grants.map(entry=>[entry.grant.grantId,entry]));
  const snapshotReader=createTaskNativeResultReads({observations,review:{inspectOwnGrantReceipt:async({grantId})=>{
   await current();const entry=entries.get(grantId);
   if(!entry?.intentReceipt)throw Error('NATIVE_TASK_RESULT_UNAVAILABLE');
   return {intentReceipt:entry.intentReceipt,observationLink:entry.observationLink};
  }}});
  const outcomes=[];
  for(const row of page.entries){
   if(row.runId===null)continue;
   await current();
   try{outcomes.push(Object.freeze({grantId:row.grantId,phase:'ready',value:await snapshotReader.readOwn({grantId:row.grantId})}));}
   catch{outcomes.push(Object.freeze({grantId:row.grantId,phase:'unavailable',value:null}));}
  }
  await current();const after=await checkedState();await current();
  if(after.revision!==state.revision||after.headDigest!==state.headDigest)throw Error('NATIVE_TASK_INDEX_STALE');
  return Object.freeze({page,outcomes:Object.freeze(outcomes)});
 }});
}
