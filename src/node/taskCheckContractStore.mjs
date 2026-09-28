import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { assertProjectId } from '../project/projectIds.js';
import { withPlanLock } from './planLock.mjs';

// Host-only check-contract custody, not authenticated policy authorship, approval or execution.
// File appends
// are flushed; first-file directory durability is not portable or guaranteed.
// Cooperative locks and hashes cannot defeat arbitrary same-user replacement,
// rollback or changes between filesystem checks. Never auto-clear stale locks.
const MAX_BYTES = 16 * 1024 * 1024, MAX_RECORDS = 128, MAX_RECORD_BYTES = 1024 * 1024 + 8192;
const fail = code => { throw new Error(`TASK_CHECK_STORE_${code}`); };
const exact = (value, keys) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) fail('INVALID'); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const wire = value => JSON.stringify(canonical(value));
const hash = value => createHash('sha256').update(wire(value)).digest('hex');
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const same = (a, b) => b.isFile() && !b.isSymbolicLink() && b.nlink === 1 && a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
async function useHandle(handle, operation) {
  let failed = false;
  try { return await operation(handle); } catch (error) { failed = true; throw error; }
  finally { try { await handle.close(); } catch (error) { if (!failed) throw error; } }
}
async function directories(parent) {
  const result = [];
  for (let cursor = parent;;) {
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('UNSAFE_PATH');
    result.push({ name: cursor, ino: info.ino, dev: info.dev });
    const next = path.dirname(cursor); if (next === cursor) break; cursor = next;
  }
  if (path.relative(parent, await realpath(parent))) fail('UNSAFE_PATH');
  return result;
}
async function assertDirectories(snapshot) {
  for (const expected of snapshot) {
    const info = await lstat(expected.name);
    if (!info.isDirectory() || info.isSymbolicLink() || info.ino !== expected.ino || info.dev !== expected.dev) fail('PATH_CHANGED');
  }
}
async function fileInfo(file) {
  try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('UNSAFE_FILE'); return info; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function assertLock(file) {
  try {
    const info = await lstat(`${file}.pp-lock`);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('UNSAFE_LOCK');
    const holder = await fileInfo(path.join(`${file}.pp-lock`, 'holder.json'));
    if (holder && holder.size > 4096) fail('UNSAFE_LOCK');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

import {createTaskLedgerAuthorityStore} from './taskLedgerAuthorityStore.mjs';
import {verifyTaskCheckContract} from './taskCheckContract.mjs';
import {validateTaskDraftBinding,sameTaskDraftBinding} from '../project/taskDraftLedger.js';

const named=value=>typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=128&&!/[\u0000-\u001f\u007f]/.test(value);
function proposalHead(value){exact(value,['hostRevision','headDigest']);if(!positive(value.hostRevision)||!isHash(value.headDigest))fail('REQUEST_INVALID');return value;}
function contractHead(value,genesis=false){exact(value,['revision','headDigest']);if(!Number.isSafeInteger(value.revision)||value.revision<(genesis?0:1)||(value.revision===0?value.headDigest!=='GENESIS':!isHash(value.headDigest)))fail('REQUEST_INVALID');return value;}
function normalizeSnapshot(value,projectId,rootIdentity){
 exact(value,['binding','proposal','ledgerDigest','contract']);validateTaskDraftBinding(value.binding);proposalHead(value.proposal);
 const contract=verifyTaskCheckContract(value.contract);
 if(value.binding.projectId!==projectId||value.binding.rootIdentity!==rootIdentity||contract.projectId!==projectId||contract.rootIdentity!==rootIdentity||!isHash(value.ledgerDigest))fail('BINDING_MISMATCH');
 return freeze({...value,contract});
}
// Callback lock order is proposal -> contract. It must not reenter either store
// or launch work. withCurrentContract is admission/preflight only: observations
// do not lease registration across the callback or grant execution authority.
// Retained census equality is not a live candidate/file lease.
export function createTaskCheckContractStore({journalPath,proposalConfig,registeredBinding,actor,source,maxBytes=MAX_BYTES,maxRecords=MAX_RECORDS}={}){
 proposalConfig=structuredClone(proposalConfig);const projectId=proposalConfig?.projectId,rootIdentity=proposalConfig?.rootIdentity;assertProjectId(projectId);
 const comparable=p=>process.platform==='win32'?p.toLowerCase():p;
 if(typeof journalPath!=='string'||!path.isAbsolute(journalPath)||path.normalize(journalPath)!==journalPath||/[:\u0000]/.test(path.basename(journalPath))||/[. ]$/.test(path.basename(journalPath))||!isHash(rootIdentity)||typeof registeredBinding!=='function'||!positive(maxBytes)||maxBytes>MAX_BYTES||!positive(maxRecords)||maxRecords>MAX_RECORDS||typeof proposalConfig?.journalPath!=='string'||comparable(journalPath)===comparable(proposalConfig.journalPath))fail('CONFIG_INVALID');
 if(!named(actor)||!named(source))fail('CONFIG_INVALID');
 const inside=(file,directory)=>{const relative=path.relative(comparable(directory),comparable(file));return !relative||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));};
 if(inside(journalPath,proposalConfig.journalPath+'.pp-lock')||inside(proposalConfig.journalPath,journalPath+'.pp-lock'))fail('CONFIG_INVALID');
 const proposals=createTaskLedgerAuthorityStore(proposalConfig),observe=registeredBinding,parent=path.dirname(journalPath);
 function replay(bytes){
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(!text||!text.endsWith('\n'))fail('CORRUPT');
  const lines=text.slice(0,-1).split('\n');if(lines.length>maxRecords)fail('QUOTA');let previous='GENESIS';const requests=new Set();
  return lines.map((line,index)=>{
   if(!line||Buffer.byteLength(line)>MAX_RECORD_BYTES)fail('CORRUPT');const record=JSON.parse(line);
   exact(record,['schemaVersion','kind','projectId','rootIdentity','revision','previousHash','request','requestDigest','snapshot','actor','source','executionAuthorized','approvalGranted','recordHash']);
   exact(record.request,['requestId','expectedRevision','expectedHeadDigest']);const request=record.request;
   const snapshot=normalizeSnapshot(structuredClone(record.snapshot),projectId,rootIdentity);
   if(record.schemaVersion!==1||record.kind!=='TASK_CHECK_CONTRACT_CUSTODY'||record.projectId!==projectId||record.rootIdentity!==rootIdentity||record.revision!==index+1||record.previousHash!==previous||request.expectedRevision!==index||request.expectedHeadDigest!==previous||!id(request.requestId)||requests.has(request.requestId)||!named(record.actor)||!named(record.source)||record.executionAuthorized!==false||record.approvalGranted!==false||wire(snapshot)!==wire(record.snapshot)||record.requestDigest!==hash({snapshot,request,actor:record.actor,source:record.source})||wire(record)!==line)fail('CORRUPT');
   const {recordHash,...body}=record;if(recordHash!==hash(body))fail('CORRUPT');previous=recordHash;requests.add(request.requestId);return record;
  });
 }
 async function read(parents){
  await assertDirectories(parents);const info=await fileInfo(journalPath);if(!info)return {records:[],info:null,size:0};
  if(!info.size)fail('CORRUPT');if(info.size>maxBytes)fail('QUOTA');
  return useHandle(await open(journalPath,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0)),async handle=>{
   if(!same(info,await handle.stat()))fail('FILE_CHANGED');const bytes=Buffer.alloc(info.size+1);let length=0;
   while(length<bytes.length){const part=await handle.read(bytes,length,Math.min(65536,bytes.length-length),length);if(!part.bytesRead)break;length+=part.bytesRead;}
   const current=await fileInfo(journalPath);if(length!==info.size||!same(info,await handle.stat())||!current||!same(info,current))fail('FILE_CHANGED');await assertDirectories(parents);
   return {records:replay(bytes.subarray(0,length)),info,size:length};
  });
 }
 async function locked(operation){const parents=await directories(parent);await assertLock(journalPath);let failure;try{return await withPlanLock(journalPath,{actor:'task-check-contract-store',timeoutMs:5000,retryMs:10},async()=>{try{await assertDirectories(parents);return await operation(parents);}catch(error){failure=error;throw error;}});}catch(error){throw failure??error;}}
 async function checkProposal(proposal,contract){
  const observed=validateTaskDraftBinding(structuredClone(await observe()));
  if(!sameTaskDraftBinding(observed,proposal.ledger.binding)||observed.projectId!==projectId||observed.rootIdentity!==rootIdentity)fail('REGISTRATION_MISMATCH');
  if(contract.projectId!==projectId||contract.rootIdentity!==rootIdentity||wire(proposal.ledger.tasks.filter(t=>!t.archived).map(t=>t.id).sort())!==wire(contract.tasks.map(t=>t.taskId).sort()))fail('COVERAGE_MISMATCH');
  return observed;
 }
 return Object.freeze({
  inspect:()=>locked(async parents=>{const state=await read(parents);return freeze({schemaVersion:1,projectId,rootIdentity,revision:state.records.length,headDigest:state.records.at(-1)?.recordHash??'GENESIS',history:state.records,executionAuthorized:false,approvalGranted:false,registrationLeaseHeld:false});}),
  async retain(expectedProposal,contract,request){
   expectedProposal=proposalHead(structuredClone(expectedProposal));contract=verifyTaskCheckContract(contract);request=structuredClone(request);exact(request,['requestId','expectedRevision','expectedHeadDigest']);if(!id(request.requestId))fail('REQUEST_INVALID');contractHead({revision:request.expectedRevision,headDigest:request.expectedHeadDigest},true);
   return proposals.withCurrentProposal(expectedProposal,proposal=>locked(async parents=>{
    const binding=await checkProposal(proposal,contract);const snapshot=normalizeSnapshot({binding,proposal:expectedProposal,ledgerDigest:proposal.ledgerDigest,contract},projectId,rootIdentity),requestDigest=hash({snapshot,request,actor,source});
    const state=await read(parents),prior=state.records.find(r=>r.request.requestId===request.requestId),previous=state.records.at(-1)?.recordHash??'GENESIS';
    if(prior&&prior.requestDigest!==requestDigest)fail('REQUEST_CONFLICT');if(!prior&&(request.expectedRevision!==state.records.length||request.expectedHeadDigest!==previous))fail('STALE_HEAD');
    const body={schemaVersion:1,kind:'TASK_CHECK_CONTRACT_CUSTODY',projectId,rootIdentity,revision:state.records.length+1,previousHash:previous,request,requestDigest,snapshot,actor,source,executionAuthorized:false,approvalGranted:false},record=prior??{...body,recordHash:hash(body)},bytes=prior?null:Buffer.from(wire(record)+'\n');
    if(!prior&&(state.records.length>=maxRecords||bytes.length>MAX_RECORD_BYTES||state.size+bytes.length>maxBytes))fail('QUOTA');
    await assertDirectories(parents);const flags=constants.O_WRONLY|constants.O_APPEND|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0)|(state.info?0:constants.O_CREAT|constants.O_EXCL);
    await useHandle(await open(journalPath,flags,0o600),async handle=>{const info=await handle.stat();if(!info.isFile()||info.nlink!==1||(state.info?!same(state.info,info):info.size!==0))fail('FILE_CHANGED');await assertDirectories(parents);if(bytes)await handle.writeFile(bytes);await handle.sync();});
    const after=await read(parents),head=after.records.at(-1);if(after.records.length!==(prior?state.records.length:record.revision)||head?.recordHash!==(prior?previous:record.recordHash))fail('PUBLICATION_UNCERTAIN');
    // Failure after durable append retains history; it never reports admission.
    try{if(!sameTaskDraftBinding(binding,await checkProposal(proposal,contract)))fail('REGISTRATION_MISMATCH');}catch{fail('PUBLICATION_UNCERTAIN');}
    return freeze({record,idempotent:!!prior,matchesObservedContractHead:head.recordHash===record.recordHash,observedContractHead:{revision:head.revision,headDigest:head.recordHash},executionAuthorized:false,approvalGranted:false,registrationLeaseHeld:false});
   }));
  },
  async withCurrentContract(expectedProposal,expectedContractHead,callback){
   expectedProposal=proposalHead(structuredClone(expectedProposal));expectedContractHead=contractHead(structuredClone(expectedContractHead));if(typeof callback!=='function')fail('REQUEST_INVALID');
   return proposals.withCurrentProposal(expectedProposal,proposal=>locked(async parents=>{
    const state=await read(parents),head=state.records.at(-1);if(!head||head.revision!==expectedContractHead.revision||head.recordHash!==expectedContractHead.headDigest)fail('STALE_HEAD');
    if(wire(head.snapshot.proposal)!==wire(expectedProposal)||head.snapshot.ledgerDigest!==proposal.ledgerDigest)fail('PROPOSAL_MISMATCH');
    const observed=await checkProposal(proposal,head.snapshot.contract);if(!sameTaskDraftBinding(observed,head.snapshot.binding))fail('REGISTRATION_MISMATCH');
    return callback(freeze({record:head,proposal,executionAuthorized:false,approvalGranted:false,registrationLeaseHeld:false}));
   }));
  },
 });
}
