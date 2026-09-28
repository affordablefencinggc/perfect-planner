import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import path from 'node:path';
import {canonicalArchitectureJson as wire} from '../engine/architectureContractVerification.js';
export const ledgerWithdrawalDigest=value=>createHash('sha256').update(wire(value)).digest('hex');
const fail=code=>{throw Error(`PLANNING_LEDGER_${code}`);};
const exact=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('|')!==keys.sort().join('|'))fail('WITHDRAWAL_CORRUPT');};
export const ledgerWithdrawalFlags={declarationSource:'browser-declared',submissionPersisted:false,approvalAuthorized:false,executionAuthorized:false,filesystemVerified:false};
const same=(a,b)=>b.isFile()&&!b.isSymbolicLink()&&b.nlink===1&&a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
// Internal host helper. Caller MUST hold the custody outer lock throughout.
export function createPlanningLedgerWithdrawalStore({file,binding,validateOriginal}){
 const maxBytes=32*1024*1024,maxRecords=64,maxRecordBytes=1024*1024+16384;
 async function directories(){const rows=[];for(let name=path.dirname(file);;name=path.dirname(name)){const stat=await lstat(name);if(!stat.isDirectory()||stat.isSymbolicLink()||path.relative(name,await realpath(name)))fail('UNSAFE_DIRECTORY');rows.push({name,dev:stat.dev,ino:stat.ino});if(path.dirname(name)===name)break;}return rows;}
 async function unchanged(rows){for(const row of rows){const stat=await lstat(row.name);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.dev!==row.dev||stat.ino!==row.ino||path.relative(row.name,await realpath(row.name)))fail('DIRECTORY_CHANGED');}}
 async function info(){try{const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)fail('UNSAFE_FILE');return stat;}catch(error){if(error.code==='ENOENT')return null;throw error;}}
 async function use(handle,operation){let failed=false;try{return await operation(handle);}catch(error){failed=true;throw error;}finally{try{await handle.close();}catch(error){if(!failed)throw error;}}}
 const head=state=>({revision:state.records.length,headDigest:state.records.at(-1)?.recordHash??'GENESIS'});
 async function read(){
  const rows=await directories(),stat=await info();if(!stat)return {records:[],info:null,size:0};if(!stat.size)fail('WITHDRAWAL_CORRUPT');if(stat.size>maxBytes)fail('WITHDRAWAL_QUOTA');
  return use(await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0)),async handle=>{
   if(!same(stat,await handle.stat()))fail('FILE_CHANGED');const buffer=Buffer.alloc(stat.size+1);let length=0;
   while(length<buffer.length){const part=await handle.read(buffer,length,Math.min(65536,buffer.length-length),length);if(!part.bytesRead)break;length+=part.bytesRead;}
   const current=await info();if(length!==stat.size||!same(stat,await handle.stat())||!current||!same(stat,current))fail('FILE_CHANGED');
   const text=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length));if(!text.endsWith('\n'))fail('WITHDRAWAL_CORRUPT');const lines=text.slice(0,-1).split('\n');if(lines.length>maxRecords)fail('WITHDRAWAL_QUOTA');
   const records=[],ids=new Set();let previous='GENESIS';
   for(const [index,line] of lines.entries()){
    if(!line||Buffer.byteLength(line)>maxRecordBytes)fail('WITHDRAWAL_CORRUPT');const record=JSON.parse(line);
    exact(record,['schemaVersion','kind','binding','revision','previousHash','original','requestDigest','confirmation','withdrawnAt',...Object.keys(ledgerWithdrawalFlags),'recordHash']);validateOriginal(record.original);exact(record.confirmation,['decision','requestDigest']);
    if(record.schemaVersion!==1||record.kind!=='TASK_LEDGER_WITHDRAWAL'||record.binding.projectId!==binding.projectId||record.binding.rootIdentity!==binding.rootIdentity||wire(record.binding)!==wire(record.original.ledger.binding)||record.revision!==index+1||record.previousHash!==previous||ids.has(record.original.request.requestId)||record.requestDigest!==ledgerWithdrawalDigest(record.original)||record.confirmation.decision!=='withdraw-if-unpublished'||record.confirmation.requestDigest!==record.requestDigest||typeof record.withdrawnAt!=='string'||!Number.isFinite(Date.parse(record.withdrawnAt))||new Date(record.withdrawnAt).toISOString()!==record.withdrawnAt||Object.keys(ledgerWithdrawalFlags).some(key=>record[key]!==ledgerWithdrawalFlags[key])||wire(record)!==line)fail('WITHDRAWAL_CORRUPT');
    const {recordHash,...body}=record;if(recordHash!==ledgerWithdrawalDigest(body))fail('WITHDRAWAL_CORRUPT');records.push(record);ids.add(record.original.request.requestId);previous=recordHash;
   }
   await unchanged(rows);if(!same(stat,await lstat(file)))fail('FILE_CHANGED');return {records,info:stat,size:length};
  });
 }
 async function persist(state,record,idempotent){
  const rows=await directories(),bytes=idempotent?null:Buffer.from(wire(record)+'\n');
  if(!idempotent&&(state.records.length>=maxRecords||bytes.length>maxRecordBytes||state.size+bytes.length>maxBytes))fail('WITHDRAWAL_QUOTA');
  const mode=constants.O_WRONLY|constants.O_APPEND|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0)|(state.info?0:constants.O_CREAT|constants.O_EXCL);
  await use(await open(file,mode,0o600),async handle=>{const stat=await handle.stat();if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(state.info?!same(state.info,stat):stat.size!==0))fail('FILE_CHANGED');await unchanged(rows);if(bytes)await handle.writeFile(bytes);await handle.sync();});
  const observed=await read(),expected=idempotent?head(state):{revision:record.revision,headDigest:record.recordHash};if(wire(head(observed))!==wire(expected))fail('WITHDRAWAL_UNCERTAIN');await unchanged(rows);
  return {outcome:'withdrawn',record,idempotent,observedWithdrawalHead:head(observed),...ledgerWithdrawalFlags};
 }
 return {read,persist,head};
}
