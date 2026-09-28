import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {withPlanLock} from './planLock.mjs';
import {readRetainedInputArtifactBytes,MAX_RETAINED_INPUT_ARTIFACT_BYTES} from './proofArtifactRead.mjs';

const fail=()=>{throw Error('NATIVE_RETAINED_INPUT_CUSTODY_UNRESOLVED');};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const win=path.win32;
const absolute=v=>typeof v==='string'&&/^[a-z]:[\\/]/i.test(v)&&!v.includes('\0')&&!v.split(/[\\/]/).some(v=>v==='.'||v==='..');
const samePath=(a,b)=>absolute(a)&&absolute(b)&&win.normalize(a).toLowerCase()===win.normalize(b).toLowerCase();
const relative=v=>typeof v==='string'&&v.length<=4096&&(v===''||v.split('/').every(s=>s.length>0&&s.length<=255&&!/[<>:"\\|?*\u0000-\u001f\u007f-\u009f]/.test(s)&&!/[. ]$/.test(s)&&s!=='.'&&s!=='..'&&!/^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(s)));
const descriptor=v=>typeof v==='string'&&v.length>0&&v.length<=16384;

// Rust's typed archive serializer has an explicit field order. Reconstruct it
// for the archive digest; the surrounding native record has sorted Value keys.
function archiveWire(a){return JSON.stringify({schemaVersion:a.schemaVersion,kind:a.kind,binding:{runId:a.binding.runId,rootIdentity:a.binding.rootIdentity,candidateDigest:a.binding.candidateDigest,intentDigest:a.binding.intentDigest},profileName:a.profileName,profileSid:a.profileSid,root:a.root,readonlyPolicy:a.readonlyPolicy,entries:a.entries.map(e=>({path:e.path,kind:e.kind,bytes:e.bytes,sha256:e.sha256,descriptor:e.descriptor})),totalBytes:a.totalBytes,executionAuthorized:a.executionAuthorized});}

export function parseRetainedNodeInputs(bytes,expectedDigest,{intentReceipt:intent,executionSpec:spec}){
 if(!(bytes instanceof Uint8Array)||bytes.byteLength<1||bytes.byteLength>MAX_RETAINED_INPUT_ARTIFACT_BYTES||!hex(expectedDigest)||hash(bytes)!==expectedDigest)fail();
 if(!intent||intent.kind!=='TASK_EXECUTION_INTENT_RECEIPT'||intent.schemaVersion!==1||intent.state!=='launch-unresolved'||intent.executionAuthorized!==false||!hex(intent.rootIdentity)||!hex(intent.recordDigest)||!hex(intent.binding?.candidateDigest)||!spec||spec.runId!==intent.runId||spec.intentDigest!==intent.recordDigest||spec.candidateDigest!==intent.binding.candidateDigest||spec.checkContractDigest!==intent.binding.checkContractDigest||!hex(spec.checkContractDigest))fail();
 let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail();}
 if(!exact(value,['schemaVersion','kind','binding','archive','archiveDigest','runtime','invocation','outputDirectory','executionAuthorized'])||value.schemaVersion!==1||value.kind!=='NATIVE_RETAINED_NODE_INPUTS'||value.executionAuthorized!==false)fail();
 const b=value.binding,a=value.archive,r=value.runtime,i=value.invocation;
 const binding={runId:intent.runId,rootIdentity:intent.rootIdentity,candidateDigest:intent.binding.candidateDigest,intentDigest:intent.recordDigest};
 if(!exact(b,Object.keys(binding))||Object.entries(binding).some(([k,v])=>b[k]!==v))fail();
 if(!exact(a,['schemaVersion','kind','binding','profileName','profileSid','root','readonlyPolicy','entries','totalBytes','executionAuthorized'])||a.schemaVersion!==1||a.kind!=='NATIVE_TASK_RETAINED_INPUTS'||a.readonlyPolicy!=='appcontainer-rx-owner-full-v1'||a.executionAuthorized!==false||!exact(a.binding,Object.keys(binding))||Object.entries(binding).some(([k,v])=>a.binding[k]!==v)||!/^perfect-planner\.execution\.[0-9]+-[0-9]+$/.test(a.profileName)||a.profileName.length>64||!/^S-1-15-2(?:-[0-9]+){1,8}$/.test(a.profileSid)||!absolute(a.root)||win.basename(a.root)!=='inputs'||!Array.isArray(a.entries)||a.entries.length<1||a.entries.length>108192)fail();
 const names=new Set(),byPath=new Map();let total=0,files=0,dirs=0,previous;
 for(const e of a.entries){
  if(!exact(e,['path','kind','bytes','sha256','descriptor'])||!relative(e.path)||!descriptor(e.descriptor)||!Number.isSafeInteger(e.bytes)||e.bytes<0||!['file','directory'].includes(e.kind)||names.has(e.path.toUpperCase())||(previous!==undefined&&Buffer.compare(Buffer.from(previous),Buffer.from(e.path))>=0))fail();
  previous=e.path;names.add(e.path.toUpperCase());byPath.set(e.path,e);
  if(e.kind==='file'){files++;if(e.path===''||!hex(e.sha256))fail();total+=e.bytes;}else{dirs++;if(e.bytes!==0||e.sha256!==null)fail();}
 }
 if(files>100000||dirs>8192||byPath.get('')?.kind!=='directory'||!Number.isSafeInteger(total)||total>2*1024*1024*1024||a.totalBytes!==total||hash(archiveWire(a))!==value.archiveDigest)fail();
 for(const e of a.entries){if(e.path!==''&&byPath.get(e.path.includes('/')?e.path.slice(0,e.path.lastIndexOf('/')):'')?.kind!=='directory')fail();}
 const profile=win.dirname(a.root);
 if(!exact(r,['root','node','bytes','sha256','rootDescriptor','nodeDescriptor'])||!samePath(r.root,win.join(profile,'runtime'))||!samePath(r.node,win.join(r.root,'node.exe'))||!Number.isSafeInteger(r.bytes)||r.bytes<1||r.bytes>256*1024*1024||r.sha256!==spec.executableDigest||!hex(r.sha256)||!descriptor(r.rootDescriptor)||!descriptor(r.nodeDescriptor)||!samePath(value.outputDirectory,win.join(profile,'output')))fail();
 if(!exact(i,['sourceNode','sourceRoot','cwd','script','args','timeoutMs','outputLimits'])||!samePath(i.sourceNode,spec.executablePath)||!samePath(i.sourceRoot,spec.registeredRoot)||!absolute(spec.cwd)||!Number.isSafeInteger(i.timeoutMs)||i.timeoutMs<1||i.timeoutMs>300000||i.timeoutMs!==spec.timeoutMs||!exact(i.outputLimits,['stdoutBytes','stderrBytes','combinedBytes'])||Object.keys(i.outputLimits).some(k=>i.outputLimits[k]!==spec.outputLimits?.[k]||!Number.isSafeInteger(i.outputLimits[k])||i.outputLimits[k]<1||i.outputLimits[k]>2*1024*1024)||i.outputLimits.combinedBytes>i.outputLimits.stdoutBytes+i.outputLimits.stderrBytes||!Array.isArray(spec.args)||spec.args.length<1||spec.args.length>64||spec.args.some(a=>typeof a!=='string'||/[\u0000-\u001f\u007f-\u009f]/.test(a))||spec.args.reduce((sum,a)=>sum+Buffer.byteLength(a),0)>32768||spec.args[0].startsWith('-'))fail();
 const sourceScript=win.isAbsolute(spec.args[0])?spec.args[0]:win.join(spec.cwd,spec.args[0]);
 const scriptRelative=win.relative(spec.registeredRoot,sourceScript).replaceAll('\\','/'),cwdRelative=win.relative(spec.registeredRoot,spec.cwd).replaceAll('\\','/');
 if(!relative(scriptRelative)||!relative(cwdRelative)||byPath.get(scriptRelative)?.kind!=='file'||byPath.get(cwdRelative)?.kind!=='directory'||!samePath(i.script,win.join(a.root,scriptRelative))||!samePath(i.cwd,win.join(a.root,cwdRelative))||!equal(i.args,['--preserve-symlinks','--preserve-symlinks-main',i.script,...spec.args.slice(1)]))fail();
 return value;
}

// This store persists owner-provided native bytes. It does not execute or
// authenticate a producer, certify live archive files, or finalize a result.
export function createTaskRetainedInputsStore({directory,projectId,rootIdentity}){
 if(typeof directory!=='string'||!path.isAbsolute(directory)||path.normalize(directory)!==directory||typeof projectId!=='string'||!projectId||!hex(rootIdentity))fail();
 function context(input){const value=structuredClone(input);if(value.intentReceipt?.projectId!==projectId||value.intentReceipt.rootIdentity!==rootIdentity||!/^([a-f0-9]{8}-)([a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.intentReceipt.runId))fail();return value;}
 async function directoryCheck(){
  const parents=[];for(let current=directory;;current=path.dirname(current)){const stat=await lstat(current);if(!stat.isDirectory()||stat.isSymbolicLink()||path.relative(current,await realpath(current)))fail();parents.push({current,ino:stat.ino,dev:stat.dev});if(path.dirname(current)===current)break;}
  return async()=>{for(const p of parents){const s=await lstat(p.current);if(!s.isDirectory()||s.isSymbolicLink()||s.ino!==p.ino||s.dev!==p.dev||path.relative(p.current,await realpath(p.current)))fail();}};
 }
 async function check(file,expected,ctx,recheck){const bytes=await readRetainedInputArtifactBytes(file);parseRetainedNodeInputs(bytes,expected,ctx);await recheck();return bytes;}
 const receipt=(ctx,digest)=>Object.freeze({schemaVersion:1,kind:'NATIVE_TASK_RETAINED_INPUT_RECEIPT',projectId,rootIdentity,runId:ctx.intentReceipt.runId,intentDigest:ctx.intentReceipt.recordDigest,candidateDigest:ctx.intentReceipt.binding.candidateDigest,artifactDigest:digest,executionAuthorized:false});
 return Object.freeze({
  async retain(input){
   const ctx=context(input),bytes=Buffer.from(ctx.artifactBytes??[]);parseRetainedNodeInputs(bytes,ctx.artifactDigest,ctx);
   const file=path.join(directory,ctx.intentReceipt.runId+'.inputs.json'),recheck=await directoryCheck();
   return withPlanLock(file,{actor:'native-retained-inputs',timeoutMs:5000},async()=>{
    await recheck();let handle;try{handle=await open(file,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);}catch(e){if(e.code!=='EEXIST')throw e;}
    if(handle){try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}}
    if(!(await check(file,ctx.artifactDigest,ctx,recheck)).equals(bytes))fail();
    const sync=await open(file,constants.O_RDWR|(constants.O_NOFOLLOW??0));try{await sync.sync();}finally{await sync.close();}
    if(!(await check(file,ctx.artifactDigest,ctx,recheck)).equals(bytes))fail();return receipt(ctx,ctx.artifactDigest);
   });
  },
  async inspect(input){
   const ctx=context(input),file=path.join(directory,ctx.intentReceipt.runId+'.inputs.json'),recheck=await directoryCheck();const bytes=await check(file,ctx.artifactDigest,ctx,recheck);
   // Complete bytes may remain after an earlier failed sync. Recovery must
   // re-establish file persistence, never assume it or recreate a missing file.
   const sync=await open(file,constants.O_RDWR|(constants.O_NOFOLLOW??0));try{await sync.sync();}finally{await sync.close();}
   if(!(await check(file,ctx.artifactDigest,ctx,recheck)).equals(bytes))fail();return {receipt:receipt(ctx,ctx.artifactDigest),bytes};
  },
 });
}
