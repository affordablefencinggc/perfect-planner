import path from 'node:path';
import {lstat,realpath,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createImportedProjectId} from '../project/projectIds.js';
import {runBoundedProcess} from './guardedGitRunner.mjs';
import {allocateCompilationTemp,removeEmptyCompilationTemp} from './nativeCompilationScratch.mjs';

const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const fail=()=>{throw Error('NATIVE_CENSUS_BINDING_UNAVAILABLE');};
const identity=(a,b)=>['dev','ino','size','mtimeMs','ctimeMs'].every(k=>a[k]===b[k]);
async function canonicalDirectory(dir){for(let p=dir;;){const s=await lstat(p);if(!s.isDirectory()||s.isSymbolicLink()||path.relative(p,await realpath(p))!=='')fail();const next=path.dirname(p);if(next===p)break;p=next;}}
async function resource(file,pin){
 await canonicalDirectory(path.dirname(file));const before=await lstat(file);
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>128*1024*1024||path.relative(file,await realpath(file))!=='')fail();
 const handle=await open(file,'r');try{
  if(!identity(before,await handle.stat()))fail();const digest=createHash('sha256'),buffer=Buffer.alloc(65536);let count=0;
  for(;;){const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;count+=bytesRead;if(count>before.size)fail();digest.update(buffer.subarray(0,bytesRead));}
  if(count!==before.size||digest.digest('hex')!==pin||!identity(before,await handle.stat())||!identity(before,await lstat(file)))fail();
 }finally{await handle.close();}
}
// Factory installed by the native host, never constructed from renderer/MCP
// request data. Pinned bytes are not publisher proof or a filesystem lease.
// The resulting binding describes a retained scan, never live file contents.
export function createNativeCensusBindingProvider({executable,executableDigest,registryRoot,workspaceId,registryRevision,rootIdentity,compilationTempRoot,execute=runBoundedProcess}){
 if([executable,registryRoot,compilationTempRoot].some(v=>typeof v!=='string'||!path.isAbsolute(v)||path.normalize(v)!==v||v.includes('\0'))||!hash(executableDigest)||!hash(rootIdentity)||typeof workspaceId!=='string'||! /^[A-Za-z0-9_-]{3,64}$/.test(workspaceId)||!Number.isInteger(registryRevision)||registryRevision<1||registryRevision>4294967295||typeof execute!=='function')throw Error('NATIVE_CENSUS_PROVIDER_CONFIG_INVALID');
 const projectId=createImportedProjectId(rootIdentity);
 return async function registeredBinding(){
  let scratch,cleanupProven=false;
  try{
   await canonicalDirectory(registryRoot);await resource(executable,executableDigest);
   const input=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'perfect-planner-native-binding',version:'1'}}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'planner_retained_census_observation',arguments:{workspaceId,registryRevision,rootIdentity}}}].map(v=>JSON.stringify(v)+'\n').join('');
   scratch=await allocateCompilationTemp(compilationTempRoot);
   const run=await execute(executable,['--planner-mcp-stdio','--registry-root',registryRoot],{cwd:path.dirname(executable),env:{SystemRoot:'C:\\Windows',WINDIR:'C:\\Windows',TEMP:scratch.directory,TMP:scratch.directory},timeoutMs:10000,maxBytes:65536,input});
   cleanupProven=run?.cleanupComplete===true;
   if(run?.cleanupComplete!==true)throw Object.assign(Error('NATIVE_CENSUS_CLEANUP_UNCERTAIN'),{cleanupComplete:false});
   if(run.exit!==0||run.reason||run.outputComplete!==true||typeof run.stdout!=='string'||Buffer.byteLength(run.stdout)>65536||!run.stdout.endsWith('\n'))fail();
   const lines=run.stdout.trimEnd().split(/\r?\n/);if(lines.length!==2||lines.some(v=>Buffer.byteLength(v)>16384))fail();
   const [init,reply]=lines.map(v=>JSON.parse(v));
   if(!exact(init,['jsonrpc','id','result'])||init.jsonrpc!=='2.0'||init.id!==1||init.result?.protocolVersion!=='2025-11-25'||init.result.serverInfo?.name!=='perfect-planner-bundled-metadata'||!exact(reply,['jsonrpc','id','result'])||reply.jsonrpc!=='2.0'||reply.id!==2||reply.result?.isError!==false)fail();
   const observed=reply.result.structuredContent;
   if(!observed||observed.schemaVersion!==1||observed.workspaceId!==workspaceId||observed.registryRevision!==registryRevision||observed.rootIdentity!==rootIdentity||!hash(observed.censusDigest)||!hash(observed.observationHash)||observed.retainedObservation!==true||observed.liveFilesystemVerified!==false||observed.executionAuthorized!==false||!Number.isSafeInteger(observed.sequence)||observed.sequence<1)fail();
   if(!Array.isArray(reply.result.content)||reply.result.content.length!==1||reply.result.content[0].type!=='text'||JSON.stringify(JSON.parse(reply.result.content[0].text))!==JSON.stringify(observed))fail();
   return Object.freeze({projectId,rootIdentity,censusDigest:observed.censusDigest});
  }catch(error){if(error?.cleanupComplete===false)throw Object.assign(Error('NATIVE_CENSUS_CLEANUP_UNCERTAIN'),{cleanupComplete:false});fail();}
  finally{if(cleanupProven)await removeEmptyCompilationTemp(scratch);}
 };
}
