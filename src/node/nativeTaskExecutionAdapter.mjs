import path from 'node:path';
import {open,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {runBoundedTaskConversation,runBoundedRetainedTaskConversation} from './guardedGitRunner.mjs';
import {readRetainedInputArtifactBytes,MAX_RETAINED_INPUT_ARTIFACT_BYTES} from './proofArtifactRead.mjs';
import {allocateCompilationTemp,removeEmptyCompilationTemp} from './nativeCompilationScratch.mjs';
import {parseNativeTaskObservation} from './taskNativeDispatch.mjs';
import {candidateSnapshot} from './mergedStateRunner.mjs';

const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const absolute=value=>typeof value==='string'&&path.isAbsolute(value)&&path.normalize(value)===value&&!value.includes('\0');
async function verifyExecutable(file,digest){
 for(let current=path.dirname(file);;current=path.dirname(current)){
  const info=await lstat(current);if(!info.isDirectory()||info.isSymbolicLink()||path.relative(current,await realpath(current)))throw Error('NATIVE_TASK_HOST_PATH_INVALID');
  if(path.dirname(current)===current)break;
 }
 const before=await lstat(file);
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size<1||before.size>256*1024*1024||path.relative(file,await realpath(file)))throw Error('NATIVE_TASK_HOST_INVALID');
 const handle=await open(file,'r');
 try{
  const same=info=>['ino','dev','size','mtimeMs','ctimeMs'].every(key=>info[key]===before[key]);
  if(!same(await handle.stat()))throw Error('NATIVE_TASK_HOST_CHANGED');
  const hasher=createHash('sha256'),buffer=Buffer.alloc(65536);let bytes=0;
  for(;;){const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;bytes+=bytesRead;if(bytes>before.size)throw Error('NATIVE_TASK_HOST_CHANGED');hasher.update(buffer.subarray(0,bytesRead));}
  if(bytes!==before.size||!same(await handle.stat())||!same(await lstat(file))||hasher.digest('hex')!==digest)throw Error('NATIVE_TASK_HOST_CHANGED');
 }finally{await handle.close();}
}
// Installed-host configuration only. This is not exposed in renderer/MCP data.
// The caller must first record a one-use execution intent through review custody.
export function createNativeTaskExecutionAdapter(config){return createAdapter(config,false);}
// Selection belongs to installed owner composition, never a worker request.
// This factory requires the isolated writer; it cannot fall back to legacy.
export function createRetainedNativeTaskExecutionAdapter(config){return createAdapter(config,true);}
function createAdapter({executable,executableDigest,cwd,compilationTempRoot,rootIdentity},isolated){
 if(!absolute(executable)||!hash(executableDigest)||!absolute(cwd)||!absolute(compilationTempRoot))throw Error('NATIVE_TASK_ADAPTER_CONFIG_INVALID');
 if(isolated&&!hash(rootIdentity))throw Error('NATIVE_TASK_ADAPTER_CONFIG_INVALID');
 let busy=false;
 return async function executeNative(input,{signal,expiresAt,retainProvisional,retainCandidate,retainInputs,retainIsolatedProvisional}={}){
  if(isolated?(typeof retainInputs!=='function'||typeof retainIsolatedProvisional!=='function'):typeof retainProvisional!=='function')throw Error('NATIVE_TASK_RETENTION_REQUIRED');
  if(busy)throw Error('NATIVE_TASK_ADAPTER_BUSY');busy=true;let scratch,settled=false;
  try{
   const spec=structuredClone(input),expiresAtMs=Date.parse(expiresAt);
   if(!Number.isSafeInteger(expiresAtMs)||expiresAtMs<=Date.now())throw Error('NATIVE_TASK_GRANT_EXPIRED');
   if(typeof retainCandidate!=='function')throw Error('NATIVE_TASK_CANDIDATE_RETENTION_REQUIRED');
   let wire=JSON.stringify({schemaVersion:isolated?3:2,executionSpec:spec,expiresAtMs});
   if(!wire||Buffer.byteLength(wire)>65536||!Number.isInteger(spec.timeoutMs)||spec.timeoutMs<1||spec.timeoutMs>300000||!hash(spec.intentDigest))throw Error('NATIVE_TASK_SPEC_INVALID');
   if(signal?.aborted)throw Error('NATIVE_TASK_CANCELLED_BEFORE_DISPATCH');
   await verifyExecutable(executable,executableDigest);
   if(Date.now()>=expiresAtMs)throw Error('NATIVE_TASK_GRANT_EXPIRED');
   if(path.relative(cwd,await realpath(cwd))||!(await lstat(cwd)).isDirectory())throw Error('NATIVE_TASK_HOST_PATH_INVALID');
   scratch=await allocateCompilationTemp(compilationTempRoot);
   if(isolated){wire=JSON.stringify({schemaVersion:3,executionSpec:spec,expiresAtMs,rootIdentity,ownerDirectory:scratch.directory});if(Buffer.byteLength(wire)>65536)throw Error('NATIVE_TASK_SPEC_INVALID');}
   const base={schemaVersion:isolated?3:2,runId:spec.runId,intentDigest:spec.intentDigest,candidateDigest:spec.candidateDigest,checkContractDigest:spec.checkContractDigest,executionAuthorized:false};
   let phase=0,observation,retained,finalization,candidateReceipt,inputReceipt;
   const exact=(value,expected)=>value&&Object.keys(value).sort().join('|')===Object.keys(expected).sort().join('|')&&Object.entries(expected).every(([key,item])=>JSON.stringify(value[key])===JSON.stringify(item));
   const converse=isolated?runBoundedRetainedTaskConversation:runBoundedTaskConversation;
   const result=await converse(executable,[isolated?'--planner-retained-task-stdio':'--planner-task-custody-stdio'],{cwd,env:{SystemRoot:'C:\\Windows',WINDIR:'C:\\Windows',TEMP:scratch.directory,TMP:scratch.directory},timeoutMs:spec.timeoutMs+255000,maxBytes:13*1024*1024,input:wire,signal},async(frame,{signal:conversationSignal})=>{
    if(phase===0){
     if(!exact(frame,{...base,kind:'NATIVE_TASK_GUARD_READY'}))throw Error('NATIVE_TASK_PROTOCOL_BINDING');
     const candidate=await candidateSnapshot(spec.registeredRoot,undefined,{signal:conversationSignal,includeManifest:true});
     if(candidate.cleanupComplete===false)throw Object.assign(Error('NATIVE_TASK_CANDIDATE_CLEANUP_UNCERTAIN'),{cleanupComplete:false});
     if(!candidate.valid||candidate.snapshotSchemaVersion!==2||candidate.digest!==spec.candidateDigest)throw Error('NATIVE_TASK_CANDIDATE_CHANGED');
     candidateReceipt=await retainCandidate(candidate.manifest);
     if(candidateReceipt?.kind!=='NATIVE_TASK_CANDIDATE_MANIFEST_RECEIPT'||candidateReceipt.runId!==spec.runId||candidateReceipt.intentDigest!==spec.intentDigest||candidateReceipt.candidateDigest!==spec.candidateDigest||candidateReceipt.executionAuthorized!==false||!hash(candidateReceipt.artifactDigest))throw Error('NATIVE_TASK_CANDIDATE_RETENTION_INVALID');
     if(Date.now()>=expiresAtMs)throw Error('NATIVE_TASK_GRANT_EXPIRED');
     phase=1;return {...base,kind:'NATIVE_TASK_CANDIDATE_CONFIRMED'};
    }
    if(isolated&&phase===1){
     const file=path.join(scratch.directory,'retained-node-inputs.json');
     if(!exact(frame,{...base,kind:'NATIVE_TASK_INPUTS_READY',path:file,bytes:frame?.bytes,retainedInputsDigest:frame?.retainedInputsDigest})||!Number.isSafeInteger(frame.bytes)||frame.bytes<1||frame.bytes>MAX_RETAINED_INPUT_ARTIFACT_BYTES||!hash(frame.retainedInputsDigest))throw Error('NATIVE_TASK_PROTOCOL_BINDING');
     const bytes=await readRetainedInputArtifactBytes(file);if(bytes.length!==frame.bytes||createHash('sha256').update(bytes).digest('hex')!==frame.retainedInputsDigest)throw Error('NATIVE_TASK_INPUT_ARTIFACT_CHANGED');
     inputReceipt=await retainInputs(bytes,frame.retainedInputsDigest);
     if(inputReceipt?.kind!=='NATIVE_TASK_RETAINED_INPUT_RECEIPT'||inputReceipt.rootIdentity!==rootIdentity||inputReceipt.runId!==spec.runId||inputReceipt.intentDigest!==spec.intentDigest||inputReceipt.candidateDigest!==spec.candidateDigest||inputReceipt.artifactDigest!==frame.retainedInputsDigest||inputReceipt.executionAuthorized!==false)throw Error('NATIVE_TASK_INPUT_RETENTION_INVALID');
     if(conversationSignal.aborted||Date.now()>=expiresAtMs)throw Error('NATIVE_TASK_GRANT_EXPIRED');phase=2;return {...base,kind:'NATIVE_TASK_INPUTS_RETAINED',retainedInputsDigest:inputReceipt.artifactDigest};
    }
    const inputBinding=isolated?{retainedInputsDigest:inputReceipt?.artifactDigest}:{};
    if(phase===(isolated?2:1)){
     if(!exact(frame,{...base,kind:'NATIVE_TASK_OBSERVATION_READY',observation:frame?.observation,...inputBinding}))throw Error('NATIVE_TASK_PROTOCOL_BINDING');
     observation=parseNativeTaskObservation(frame.observation,spec);
     // The retained observation includes this manifest's hash. The existing
     // native output acknowledgment/finalization binds that complete artifact.
     retained=isolated?await retainIsolatedProvisional(observation,candidateReceipt.artifactDigest,inputReceipt.artifactDigest):await retainProvisional(observation,candidateReceipt.artifactDigest);
     if(retained?.kind!=='NATIVE_TASK_PROVISIONAL_RECEIPT'||retained.state!=='retained-provisional'||retained.runId!==spec.runId||retained.intentDigest!==spec.intentDigest||retained.executionAuthorized!==false||!hash(retained.artifactDigest))throw Error('NATIVE_TASK_RETENTION_INVALID');
     phase=isolated?3:2;return {...base,kind:'NATIVE_TASK_OUTPUT_RETAINED',artifactDigest:retained.artifactDigest,...inputBinding};
    }
    if(phase!==(isolated?3:2)||!exact(frame,{...base,kind:'NATIVE_TASK_GUARD_FINALIZED',artifactDigest:retained.artifactDigest,...inputBinding}))throw Error('NATIVE_TASK_PROTOCOL_BINDING');
    finalization=structuredClone(frame);phase=isolated?4:3;return null;
   });
   settled=result.cleanupComplete===true;
   if(!settled)throw Object.assign(Error('NATIVE_TASK_TRANSPORT_CLEANUP_UNCERTAIN'),{cleanupComplete:false});
   if(result.exit!==0||result.reason||!result.outputComplete)throw Error('NATIVE_TASK_TRANSPORT_UNRESOLVED');
   if(phase!==(isolated?4:3)||!finalization)throw Error('NATIVE_TASK_OBSERVATION_INVALID');
   return {observation,finalization};
  }finally{if(settled)await removeEmptyCompilationTemp(scratch);busy=false;}
 };
}
