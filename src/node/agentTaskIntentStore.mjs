import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import path from 'node:path';
import {validateTaskDraftBinding,validateDraftTask} from '../project/taskDraftLedger.js';
import {canonicalArchitectureJson as wire,deepFreezeArchitecture as freeze} from '../engine/architectureContractVerification.js';
import {withPlanLock} from './planLock.mjs';
const hash=value=>createHash('sha256').update(wire(value)).digest('hex');
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const token=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const fail=code=>{throw Error(`AGENT_TASK_INTENT_${code}`);};
const exact=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('|')!==[...keys].sort().join('|'))fail('INVALID');};
const same=(a,b)=>b.isFile()&&!b.isSymbolicLink()&&b.nlink===1&&a.ino===b.ino&&a.dev===b.dev&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
export function validateAgentTaskOriginal(input){
 exact(input,['binding','request','task','updatedAt']);validateTaskDraftBinding(input.binding);
 exact(input.request,['requestId','expectedRevision','expectedHeadDigest']);const r=input.request;
 if(!token(r.requestId)||!Number.isSafeInteger(r.expectedRevision)||r.expectedRevision<0||(r.expectedRevision===0?r.expectedHeadDigest!=='GENESIS':!digest(r.expectedHeadDigest)))fail('INVALID');
 if(typeof input.updatedAt!=='string'||!Number.isFinite(Date.parse(input.updatedAt))||new Date(input.updatedAt).toISOString()!==input.updatedAt)fail('INVALID');
 // Validate task fields without pretending its dependencies or parent exist.
 // The real submission resolves those against the exact retained Ledger.
 const task=input.task;const fields=['title','description','owner','acceptance','recovery','claims','dependsOn','archived'];
 exact(task,Object.hasOwn(task??{},'id')?[...fields,'id']:fields);
 let id=task.id;if(id==null){let n=999999;while(task.dependsOn?.includes(`T${n}`))n--;id=`T${n}`;}
 validateDraftTask({...task,id});
 if(Buffer.byteLength(wire(input))>65536)fail('INPUT_LIMIT');return input;
}
// Retained original requests only. Outcomes stay in the existing proposal
// journal; this is not another Ledger, authorization grant or completion log.
// Cooperative locks and path checks do not defeat arbitrary same-user changes.
// File sync is used; first-file directory durability is not portable.
export function createAgentTaskIntentStore({file,projectId,rootIdentity,maxRecords=64}){
 if(typeof file!=='string'||!path.isAbsolute(file)||path.normalize(file)!==file||/[:\u0000]/.test(path.basename(file))||/[. ]$/.test(path.basename(file))||!token(projectId)||!digest(rootIdentity)||!Number.isSafeInteger(maxRecords)||maxRecords<1||maxRecords>64)fail('CONFIG_INVALID');
 async function directories(){const rows=[];for(let name=path.dirname(file);;name=path.dirname(name)){const s=await lstat(name);if(!s.isDirectory()||s.isSymbolicLink()||path.relative(name,await realpath(name)))fail('UNSAFE_PATH');rows.push({name,ino:s.ino,dev:s.dev});if(path.dirname(name)===name)break;}return rows;}
 async function unchanged(rows){for(const row of rows){const s=await lstat(row.name);if(!s.isDirectory()||s.isSymbolicLink()||s.ino!==row.ino||s.dev!==row.dev||path.relative(row.name,await realpath(row.name)))fail('PATH_CHANGED');}}
 async function info(){try{const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)fail('UNSAFE_FILE');return s;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 function validate(original){validateAgentTaskOriginal(original);if(original.binding.projectId!==projectId||original.binding.rootIdentity!==rootIdentity)fail('FOREIGN');}
 async function read(rows){
  await unchanged(rows);const stat=await info();if(!stat)return {records:[],stat:null,size:0};if(stat.size===0)fail('CORRUPT');if(stat.size>8*1024*1024)fail('QUOTA');
  const h=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
  try{
   if(!same(stat,await h.stat()))fail('FILE_CHANGED');const bytes=Buffer.alloc(stat.size+1);let length=0;
   while(length<bytes.length){const part=await h.read(bytes,length,Math.min(65536,bytes.length-length),length);if(!part.bytesRead)break;length+=part.bytesRead;}
   const current=await info();if(length!==stat.size||!same(stat,await h.stat())||!current||!same(stat,current))fail('FILE_CHANGED');
   const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length));if(!text.endsWith('\n'))fail('CORRUPT');const lines=text.slice(0,-1).split('\n');if(lines.length>maxRecords)fail('QUOTA');
   const records=[],ids=new Set();let previous='GENESIS';
   for(const [i,line] of lines.entries()){
    if(!line||Buffer.byteLength(line)>70000)fail('CORRUPT');const record=JSON.parse(line);exact(record,['schemaVersion','kind','revision','previousHash','original','originalDigest','retainedAt','executionAuthorized','recordHash']);validate(record.original);
    const {recordHash,...body}=record;
    if(record.schemaVersion!==1||record.kind!=='AGENT_TASK_ORIGINAL'||record.revision!==i+1||record.previousHash!==previous||record.executionAuthorized!==false||record.originalDigest!==hash(record.original)||recordHash!==hash(body)||wire(record)!==line||ids.has(record.original.request.requestId)||typeof record.retainedAt!=='string'||!Number.isFinite(Date.parse(record.retainedAt))||new Date(record.retainedAt).toISOString()!==record.retainedAt)fail('CORRUPT');
    records.push(record);ids.add(record.original.request.requestId);previous=recordHash;
   }
   await unchanged(rows);return {records,stat,size:length};
  }finally{await h.close();}
 }
 async function locked(operation){
  const rows=await directories();try{const lock=await lstat(`${file}.pp-lock`);if(!lock.isDirectory()||lock.isSymbolicLink())fail('UNSAFE_LOCK');const holder=await lstat(path.join(`${file}.pp-lock`,'holder.json'));if(!holder.isFile()||holder.isSymbolicLink()||holder.nlink!==1||holder.size>4096)fail('UNSAFE_LOCK');}catch(e){if(e.code!=='ENOENT')throw e;}
  return withPlanLock(file,{actor:'agent-task-intent',timeoutMs:5000,retryMs:10},()=>operation(rows));
 }
 return Object.freeze({
  inspect:()=>locked(async rows=>freeze({records:(await read(rows)).records,executionAuthorized:false})),
  async retain(original){
   original=structuredClone(original);validate(original);const originalDigest=hash(original);
   return locked(async rows=>{
    const state=await read(rows),prior=state.records.find(r=>r.original.request.requestId===original.request.requestId);
    if(prior&&prior.originalDigest!==originalDigest)fail('REQUEST_CONFLICT');
    const body={schemaVersion:1,kind:'AGENT_TASK_ORIGINAL',revision:state.records.length+1,previousHash:state.records.at(-1)?.recordHash??'GENESIS',original,originalDigest,retainedAt:new Date().toISOString(),executionAuthorized:false};
    const record=prior??{...body,recordHash:hash(body)},bytes=prior?null:Buffer.from(wire(record)+'\n');
    if(!prior&&(state.records.length>=maxRecords||bytes.length>70000||state.size+bytes.length>8*1024*1024))fail('QUOTA');
    const flags=constants.O_WRONLY|(prior?0:constants.O_APPEND)|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0)|(state.stat?0:constants.O_CREAT|constants.O_EXCL);
    const h=await open(file,flags,0o600);
    try{const s=await h.stat();if(!s.isFile()||s.nlink!==1||(state.stat?!same(state.stat,s):s.size!==0))fail('FILE_CHANGED');await unchanged(rows);if(bytes)await h.writeFile(bytes);await h.sync();}finally{await h.close();}
    const after=await read(rows);if(after.size!==state.size+(bytes?.length??0)||after.records.at(-1)?.recordHash!==(prior?state.records.at(-1)?.recordHash:record.recordHash))fail('RETENTION_UNCERTAIN');
    return freeze({record,idempotent:Boolean(prior),originalRetained:true,executionAuthorized:false});
   });
  },
 });
}
