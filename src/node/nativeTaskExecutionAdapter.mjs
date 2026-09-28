import path from 'node:path';
import {open,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {runBoundedTaskProcess} from './guardedGitRunner.mjs';
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
export function createNativeTaskExecutionAdapter({executable,executableDigest,cwd,compilationTempRoot}){
 if(!absolute(executable)||!hash(executableDigest)||!absolute(cwd)||!absolute(compilationTempRoot))throw Error('NATIVE_TASK_ADAPTER_CONFIG_INVALID');
 let busy=false;
 return async function executeNative(input,{signal,expiresAt}={}){
  if(busy)throw Error('NATIVE_TASK_ADAPTER_BUSY');busy=true;let scratch,settled=false;
  try{
   const spec=structuredClone(input),expiresAtMs=Date.parse(expiresAt);
   if(!Number.isSafeInteger(expiresAtMs)||expiresAtMs<=Date.now())throw Error('NATIVE_TASK_GRANT_EXPIRED');
   const wire=JSON.stringify({schemaVersion:1,executionSpec:spec,expiresAtMs});
   if(!wire||Buffer.byteLength(wire)>65536||!Number.isInteger(spec.timeoutMs)||spec.timeoutMs<1||spec.timeoutMs>300000||!hash(spec.intentDigest))throw Error('NATIVE_TASK_SPEC_INVALID');
   if(signal?.aborted)throw Error('NATIVE_TASK_CANCELLED_BEFORE_DISPATCH');
   await verifyExecutable(executable,executableDigest);
   const candidate=await candidateSnapshot(spec.registeredRoot,undefined,{signal});
   if(candidate.cleanupComplete===false)throw Object.assign(Error('NATIVE_TASK_CANDIDATE_CLEANUP_UNCERTAIN'),{cleanupComplete:false});
   if(!candidate.valid||candidate.snapshotSchemaVersion!==2||candidate.digest!==spec.candidateDigest)throw Error('NATIVE_TASK_CANDIDATE_CHANGED');
   if(Date.now()>=expiresAtMs)throw Error('NATIVE_TASK_GRANT_EXPIRED');
   if(path.relative(cwd,await realpath(cwd))||!(await lstat(cwd)).isDirectory())throw Error('NATIVE_TASK_HOST_PATH_INVALID');
   scratch=await allocateCompilationTemp(compilationTempRoot);
   const result=await runBoundedTaskProcess(executable,['--planner-task-stdio'],{cwd,env:{SystemRoot:'C:\\Windows',WINDIR:'C:\\Windows',TEMP:scratch.directory,TMP:scratch.directory},timeoutMs:spec.timeoutMs+45000,maxBytes:13*1024*1024,input:wire,signal});
   settled=result.cleanupComplete===true;
   if(!settled)throw Object.assign(Error('NATIVE_TASK_TRANSPORT_CLEANUP_UNCERTAIN'),{cleanupComplete:false});
   if(result.exit!==0||result.reason||!result.outputComplete)throw Error('NATIVE_TASK_TRANSPORT_UNRESOLVED');
   let value;try{value=JSON.parse(result.stdout);}catch{throw Error('NATIVE_TASK_OBSERVATION_INVALID');}
   return parseNativeTaskObservation(value,spec);
  }finally{if(settled)await removeEmptyCompilationTemp(scratch);busy=false;}
 };
}
