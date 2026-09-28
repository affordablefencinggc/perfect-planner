import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import path from 'node:path';
import {assertProjectId} from '../project/projectIds.js';
import {withPlanLock} from './planLock.mjs';

// Host-only recovery custody. A durable begin precedes showing a dialog. Only
// the host adapter may close it after confirming that exact presentation has
// gone. Neither a supplied digest nor this store proves a native gesture.
// Locks are cooperative; hashes cannot defeat arbitrary same-user rollback.
// File data is flushed; first-file parent directory power-loss durability is
// not portable. An uncertain write is never automatically erased or replayed
// as a fresh native presentation.
// Closing this record does not cancel/recover its confirmation request: that
// requires a separate authenticated host recovery path after watcher loss.
const MAX_BYTES=8*1024*1024,MAX_RECORDS=512,MAX_RECORD_BYTES=16384;
const fail=code=>{throw Error(`NATIVE_PRESENTATION_${code}`);};
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const wire=value=>JSON.stringify(canonical(value));
const hash=value=>createHash('sha256').update(wire(value)).digest('hex');
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const exact=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('|')!==[...keys].sort().join('|'))fail('INVALID');};
const positive=value=>Number.isSafeInteger(value)&&value>0;
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const same=(a,b)=>b.isFile()&&!b.isSymbolicLink()&&b.nlink===1&&a.ino===b.ino&&a.dev===b.dev&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
async function useHandle(handle,operation){let failed=false;try{return await operation(handle);}catch(error){failed=true;throw error;}finally{try{await handle.close();}catch(error){if(!failed)throw error;}}}
async function directories(parent){
  const result=[];
  for(let cursor=parent;;){const info=await lstat(cursor);if(!info.isDirectory()||info.isSymbolicLink())fail('UNSAFE_PATH');result.push({name:cursor,ino:info.ino,dev:info.dev});const next=path.dirname(cursor);if(next===cursor)break;cursor=next;}
  if(path.relative(parent,await realpath(parent)))fail('UNSAFE_PATH');return result;
}
async function assertDirectories(parents){for(const expected of parents){const info=await lstat(expected.name);if(!info.isDirectory()||info.isSymbolicLink()||info.ino!==expected.ino||info.dev!==expected.dev)fail('PATH_CHANGED');}}
async function fileInfo(file){try{const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)fail('UNSAFE_FILE');return info;}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function assertLock(file){try{const info=await lstat(`${file}.pp-lock`);if(!info.isDirectory()||info.isSymbolicLink())fail('UNSAFE_LOCK');const holder=await fileInfo(path.join(`${file}.pp-lock`,'holder.json'));if(holder&&holder.size>4096)fail('UNSAFE_LOCK');}catch(error){if(error.code!=='ENOENT')throw error;}}

export function createNativeReviewPresentationStore({journalPath,projectId,rootIdentity,maxBytes=MAX_BYTES,maxRecords=MAX_RECORDS}={}){
  assertProjectId(projectId);
  if(typeof journalPath!=='string'||!path.isAbsolute(journalPath)||path.normalize(journalPath)!==journalPath||/[:\u0000]/.test(path.basename(journalPath))||/[. ]$/.test(path.basename(journalPath))||!digest(rootIdentity)||!positive(maxBytes)||maxBytes>MAX_BYTES||!positive(maxRecords)||maxRecords>MAX_RECORDS)fail('CONFIG_INVALID');
  const parent=path.dirname(journalPath);
  function bindingFrom(value){
    exact(value,['projectId','rootIdentity','requestId','proposalRevision','proposalDigest','checkContractDigest','source']);
    if(value.projectId!==projectId||value.rootIdentity!==rootIdentity||!id(value.requestId)||!positive(value.proposalRevision)||![value.proposalDigest,value.checkContractDigest].every(digest)||typeof value.source!=='string'||value.source.trim()!==value.source||!value.source.length||value.source.length>256||/[\u0000-\u001f\u007f]/.test(value.source))fail('BINDING_INVALID');
    return freeze(value);
  }
  function recordFor(action,binding,request,records){
    const body={schemaVersion:1,kind:'NATIVE_REVIEW_PRESENTATION',action,revision:records.length+1,previousHash:records.at(-1)?.recordHash??'GENESIS',binding,...request,requestDigest:hash({action,binding,request}),executionAuthorized:false,nativeGestureVerified:false};
    return {...body,recordHash:hash(body)};
  }
  function replay(bytes){
    const value=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    if(!value||!value.endsWith('\n'))fail('CORRUPT');
    const lines=value.slice(0,-1).split('\n');if(lines.length>maxRecords)fail('QUOTA');
    const records=[],operations=new Set(),presentations=new Map();let unresolved=null;
    for(const line of lines){
      if(!line||Buffer.byteLength(line)>MAX_RECORD_BYTES)fail('CORRUPT');
      const record=JSON.parse(line),closing=record.action==='closed';
      exact(record,['schemaVersion','kind','action','revision','previousHash','binding','expectedRevision','operationId',...(closing?['closureEvidenceDigest']:[]),'requestDigest','executionAuthorized','nativeGestureVerified','recordHash']);
      const binding=bindingFrom(structuredClone(record.binding));
      if(record.schemaVersion!==1||record.kind!=='NATIVE_REVIEW_PRESENTATION'||!['begun','closed'].includes(record.action)||record.revision!==records.length+1||record.expectedRevision!==records.length||record.previousHash!==(records.at(-1)?.recordHash??'GENESIS')||!id(record.operationId)||operations.has(record.operationId)||record.executionAuthorized!==false||record.nativeGestureVerified!==false||(closing&&!digest(record.closureEvidenceDigest)))fail('CORRUPT');
      const request={expectedRevision:record.expectedRevision,operationId:record.operationId,...(closing?{closureEvidenceDigest:record.closureEvidenceDigest}:{})};
      if(wire(record)!==wire(recordFor(record.action,binding,request,records)))fail('CORRUPT');
      if(!closing){if(unresolved||presentations.has(binding.requestId))fail('CORRUPT');unresolved=record;presentations.set(binding.requestId,{binding,status:'unresolved',begun:record,closed:null});}
      else{if(!unresolved||wire(unresolved.binding)!==wire(binding))fail('CORRUPT');presentations.set(binding.requestId,{binding,status:'closed',begun:unresolved,closed:record});unresolved=null;}
      operations.add(record.operationId);records.push(record);
    }
    return {records,presentations,unresolved};
  }
  async function read(parents){
    await assertDirectories(parents);const info=await fileInfo(journalPath);
    if(!info)return {records:[],presentations:new Map(),unresolved:null,info:null,size:0};
    if(!info.size)fail('CORRUPT');if(info.size>maxBytes)fail('QUOTA');
    return useHandle(await open(journalPath,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0)),async handle=>{
      if(!same(info,await handle.stat()))fail('FILE_CHANGED');
      const bytes=Buffer.alloc(info.size+1);let length=0;
      while(length<bytes.length){const result=await handle.read(bytes,length,Math.min(65536,bytes.length-length),length);if(!result.bytesRead)break;length+=result.bytesRead;}
      const current=await fileInfo(journalPath);if(length!==info.size||!same(info,await handle.stat())||!current||!same(info,current))fail('FILE_CHANGED');
      await assertDirectories(parents);return {...replay(bytes.subarray(0,length)),info,size:length};
    });
  }
  async function locked(operation){
    const parents=await directories(parent);await assertLock(journalPath);let firstFailure;
    try{return await withPlanLock(journalPath,{actor:'native-presentation-store',timeoutMs:5000,retryMs:10},async()=>{try{await assertDirectories(parents);return await operation(parents);}catch(error){firstFailure=error;throw error;}});}catch(error){throw firstFailure??error;}
  }
  async function change(action,binding,request){
    binding=bindingFrom(structuredClone(binding));request=structuredClone(request);
    exact(request,['expectedRevision','operationId',...(action==='closed'?['closureEvidenceDigest']:[])]);
    if(!Number.isSafeInteger(request.expectedRevision)||request.expectedRevision<0||!id(request.operationId)||(action==='closed'&&!digest(request.closureEvidenceDigest)))fail('REQUEST_INVALID');
    const requestDigest=hash({action,binding,request});
    return locked(async parents=>{
      const state=await read(parents),prior=state.records.find(record=>record.operationId===request.operationId);
      if(prior&&prior.requestDigest!==requestDigest)fail('REQUEST_CONFLICT');
      if(!prior){
        if(request.expectedRevision!==state.records.length)fail('STALE_HEAD');
        if(action==='begun'){if(state.unresolved)fail('UNRESOLVED');if(state.presentations.has(binding.requestId))fail('ALREADY_PRESENTED');}
        else if(!state.unresolved||wire(state.unresolved.binding)!==wire(binding))fail('CLOSURE_MISMATCH');
      }
      const record=prior??recordFor(action,binding,request,state.records),bytes=prior?null:Buffer.from(`${wire(record)}\n`);
      if(!prior){
        if(bytes.length>MAX_RECORD_BYTES||state.records.length>=maxRecords||state.size+bytes.length>maxBytes)fail('QUOTA');
        if(action==='begun'){
          // Reserve quota for exact closure before opening. Not a disk-space
          // reservation; failures to flush still require explicit recovery.
          const closure=recordFor('closed',binding,{expectedRevision:record.revision,operationId:'r'.repeat(128),closureEvidenceDigest:'a'.repeat(64)},[...state.records,record]);
          if(state.records.length+2>maxRecords||state.size+bytes.length+Buffer.byteLength(`${wire(closure)}\n`)>maxBytes)fail('CLOSURE_CAPACITY');
        }
      }
      await assertDirectories(parents);
      const flags=constants.O_WRONLY|constants.O_APPEND|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0)|(state.info?0:constants.O_CREAT|constants.O_EXCL);
      await useHandle(await open(journalPath,flags,0o600),async handle=>{
        const opened=await handle.stat();if(!opened.isFile()||opened.nlink!==1||(state.info?!same(state.info,opened):opened.size!==0))fail('FILE_CHANGED');
        await assertDirectories(parents);if(bytes)await handle.writeFile(bytes);await handle.sync();
      });
      const after=await read(parents),expectedHead=prior?state.records.at(-1):record;
      if(after.records.length!==(prior?state.records.length:record.revision)||after.records.at(-1)?.recordHash!==expectedHead.recordHash)fail('PUBLICATION_UNCERTAIN');
      return freeze({record,presentation:after.presentations.get(binding.requestId),revision:after.records.length,headDigest:after.records.at(-1).recordHash,idempotent:Boolean(prior),executionAuthorized:false,nativeGestureVerified:false});
    });
  }
  return Object.freeze({
    inspect:()=>locked(async parents=>{const state=await read(parents);return freeze({schemaVersion:1,projectId,rootIdentity,revision:state.records.length,headDigest:state.records.at(-1)?.recordHash??'GENESIS',history:state.records,unresolved:state.unresolved,presentations:[...state.presentations.values()],executionAuthorized:false,nativeGestureVerified:false});}),
    begin:(binding,request)=>change('begun',binding,request),
    close:(binding,request)=>change('closed',binding,request),
  });
}
