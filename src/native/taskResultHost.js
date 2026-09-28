import {taskDraftBinding,sameTaskDraftBinding} from '../project/taskDraftLedger.js';
import {isNativeWorkspaceRuntime} from './workspaceCensus.js';
import {validateNativeTaskIndexRequest,validateNativeTaskResultIndex} from '../shared/nativeTaskResultIndex.js';
import {validateNativeTaskOutcomePage} from '../shared/nativeTaskOutcomePage.js';
import {nativeStorageFailure} from './storageFailure.js';

const fail=()=>{throw Error('NATIVE_TASK_RESULT_UNAVAILABLE');};
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const token=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const exact=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join('|')!==[...keys].sort().join('|'))fail();};
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const reasons=['nonzero-exit','time-limit','cancellation-observed','output-limit','cpu-limit','cpu-observation-failed','output-read-failed'];
function projectResult(v,binding,grantId){
 exact(v,['schemaVersion','projectId','rootIdentity','grantId','runId','taskId','checkId','attemptId','attemptNumber','workerId','state','exitCode','failureReasons','artifactDigest','intentDigest','journalLinked','observationLinkDigest','cleanup','authorityVerified','executionAuthorized','binding','transportCleanupComplete']);
 exact(v.binding,['projectId','rootIdentity','censusDigest']);
 if(v.schemaVersion!==1||!sameTaskDraftBinding(v.binding,binding)||v.projectId!==binding.projectId||v.rootIdentity!==binding.rootIdentity||v.grantId!==grantId||!uuid(v.runId)
  ||typeof v.taskId!=='string'||!/^T\d{4,6}$/.test(v.taskId)||!['checkId','attemptId','workerId'].every(k=>token(v[k]))||!Number.isSafeInteger(v.attemptNumber)||v.attemptNumber<1
  ||!hash(v.artifactDigest)||!hash(v.intentDigest)||typeof v.journalLinked!=='boolean'||(v.journalLinked?!hash(v.observationLinkDigest):v.observationLinkDigest!==null)
  ||v.cleanup!=='unknown'||v.authorityVerified!==false||v.executionAuthorized!==false||v.transportCleanupComplete!==true
  ||(v.exitCode!==null&&(!Number.isSafeInteger(v.exitCode)||Math.abs(v.exitCode)>4294967295))||!Array.isArray(v.failureReasons)||v.failureReasons.length>reasons.length)fail();
 let last=-1;for(const reason of v.failureReasons){const index=reasons.indexOf(reason);if(index<=last)fail();last=index;}
 if(v.failureReasons.includes('nonzero-exit')!==(v.exitCode!==null&&v.exitCode!==0)||v.state!==(v.failureReasons.length?'failure-observed':'result-unverified'))fail();
 return freeze(v);
}

// Result IDs come from native custody. This read cannot approve, retry or launch
// work and never accepts a worker secret, storage path or executable selection.
export function createNativeTaskResultHost(project,{runtime=globalThis,invoke}={}){
 const binding=taskDraftBinding(project),registration=structuredClone(project.registration);
 if(typeof registration.workspaceId!=='string'||!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(registration.workspaceId)||!Number.isSafeInteger(registration.registryRevision)||registration.registryRevision<1)fail();
 const identity=freeze({schemaVersion:1,workspaceId:registration.workspaceId,registryRevision:registration.registryRevision,rootIdentity:binding.rootIdentity,censusDigest:binding.censusDigest});
 const available=isNativeWorkspaceRuntime(runtime);
 const current=()=>sameTaskDraftBinding(taskDraftBinding(project),binding)&&project.registration.workspaceId===identity.workspaceId&&project.registration.registryRevision===identity.registryRevision;
 async function call(command,input,projectReply,signal){
  if(!available||signal?.aborted||!current())fail();
  let rejectAbort;const abort=()=>rejectAbort(Error('NATIVE_TASK_RESULT_UNAVAILABLE'));
  const cancelled=new Promise((_,reject)=>{rejectAbort=reject;});signal?.addEventListener('abort',abort,{once:true});
  try{
   const pending=(async()=>{const fn=invoke??(await import('@tauri-apps/api/core')).invoke;
    const value=structuredClone(await fn(command,{request:{identity,...input}}));
    if(signal?.aborted||!current())fail();return projectReply(value);
   })();
   return await Promise.race([pending,cancelled]);
  }catch(cause){if(signal?.aborted||!current())fail();const storage=nativeStorageFailure(cause);if(storage)throw storage;if(['list_native_task_results','read_native_task_result_page'].includes(command)&&cause?.code==='NATIVE_TASK_INDEX_STALE'&&cause.executionAuthorized===false){const e=Error('NATIVE_TASK_INDEX_STALE');e.code='NATIVE_TASK_INDEX_STALE';throw e;}fail();}finally{signal?.removeEventListener('abort',abort);}
  // Aborting observation does not claim that native I/O was cancelled.
 }
 return freeze({available,binding,
  async readPage(input={offset:0,expectedHeadDigest:null},{signal}={}){
   input=validateNativeTaskIndexRequest(structuredClone(input));
   return call('read_native_task_result_page',input,v=>{
    exact(v,['page','outcomes','binding','transportCleanupComplete']);exact(v.binding,['projectId','rootIdentity','censusDigest']);
    if(v.transportCleanupComplete!==true||!sameTaskDraftBinding(v.binding,binding)||v.page?.transportCleanupComplete!==true)fail();
    exact(v.page.binding,['projectId','rootIdentity','censusDigest']);if(!sameTaskDraftBinding(v.page.binding,binding))fail();
    const {binding:pageBinding,transportCleanupComplete,...page}=v.page;
    return validateNativeTaskOutcomePage({page,outcomes:v.outcomes},input,binding,(value,id)=>projectResult(value,binding,id));
   },signal);
  },
  async read(input,{signal}={}){input=structuredClone(input);exact(input,['grantId']);if(!uuid(input.grantId))fail();return call('inspect_native_task_result',input,v=>projectResult(v,binding,input.grantId),signal);},
  async list(input={offset:0,expectedHeadDigest:null},{signal}={}){
   input=validateNativeTaskIndexRequest(structuredClone(input));
   return call('list_native_task_results',input,v=>{
    if(v?.transportCleanupComplete!==true)fail();exact(v.binding,['projectId','rootIdentity','censusDigest']);if(!sameTaskDraftBinding(v.binding,binding))fail();
    const {binding:returnedBinding,transportCleanupComplete,...page}=v;
    return validateNativeTaskResultIndex(page,input,binding);
   },signal);
  },
 });
}
