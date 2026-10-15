import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createImportedProjectId} from '../project/projectIds.js';
import {verifyPlanApprovalDraft,PLAN_REVIEW_BYTES} from '../project/planApprovalDraft.js';
import {canonicalArchitectureJson as wire,deepFreezeArchitecture as freeze} from '../engine/architectureContractVerification.js';
import {withCurrentPlanningReview} from './currentPlanningReview.mjs';
import {withPlanLock} from './planLock.mjs';

const MAX_BYTES=32*1024*1024,MAX_RECORDS=64,MAX_RECORD_BYTES=PLAN_REVIEW_BYTES+16384;
const flags={executionAuthorized:false,nativeApprovalAuthorized:false,filesystemVerified:false};
const fail=code=>{throw Error(`PLAN_APPROVAL_${code}`);};
const exact=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('|')!==[...keys].sort().join('|'))fail('INVALID');};
const hash=value=>createHash('sha256').update(wire(value)).digest('hex');
const isHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const named=value=>typeof value==='string'&&value===value.trim()&&value.length>0&&value.length<=128&&!/[\u0000-\u001f\u007f]/.test(value);
const requestId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const same=(a,b)=>b.isFile()&&!b.isSymbolicLink()&&b.nlink===1&&a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
async function useHandle(handle,operation){let failed=false;try{return await operation(handle);}catch(error){failed=true;throw error;}finally{try{await handle.close();}catch(error){if(!failed)throw error;}}}
async function directories(parent){const result=[];for(let cursor=parent;;cursor=path.dirname(cursor)){const stat=await lstat(cursor);if(!stat.isDirectory()||stat.isSymbolicLink()||path.relative(cursor,await realpath(cursor)))fail('UNSAFE_PATH');result.push({name:cursor,ino:stat.ino,dev:stat.dev});if(path.dirname(cursor)===cursor)break;}return result;}
async function checkDirectories(snapshot){for(const before of snapshot){const stat=await lstat(before.name);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.ino!==before.ino||stat.dev!==before.dev||path.relative(before.name,await realpath(before.name)))fail('PATH_CHANGED');}}
async function fileInfo(file){try{const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)fail('UNSAFE_FILE');return stat;}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function checkLock(file){try{const stat=await lstat(file+'.pp-lock');if(!stat.isDirectory()||stat.isSymbolicLink())fail('UNSAFE_LOCK');const holder=await fileInfo(path.join(file+'.pp-lock','holder.json'));if(holder&&holder.size>4096)fail('UNSAFE_LOCK');}catch(error){if(error.code!=='ENOENT')throw error;}}

// Explicit local planning intent, not an authenticated person/native gesture.
// No execution grants. Cooperative locks and content hashes do not defeat
// arbitrary same-user tampering; first-file directory durability is not promised.
export function createPlanApprovalStore({root,projectId,rootIdentity,actor,source,maxBytes=MAX_BYTES,maxRecords=MAX_RECORDS}={}){
 if(typeof root!=='string'||!path.isAbsolute(root)||path.normalize(root)!==root||path.dirname(root)===root||!isHash(rootIdentity)||createImportedProjectId(rootIdentity)!==projectId||!named(actor)||!named(source)||!positive(maxBytes)||maxBytes>MAX_BYTES||!positive(maxRecords)||maxRecords>MAX_RECORDS)fail('CONFIG_INVALID');
 const parent=path.join(root,projectId),journal=path.join(parent,'plan-approvals.jsonl'),withdrawals=path.join(parent,'plan-approval-withdrawals.jsonl');
 function requestValid(request){exact(request,['requestId','expectedRevision','expectedHeadDigest']);if(!requestId(request.requestId)||!Number.isSafeInteger(request.expectedRevision)||request.expectedRevision<0||(request.expectedRevision===0?request.expectedHeadDigest!=='GENESIS':!isHash(request.expectedHeadDigest)))fail('REQUEST_INVALID');}
 async function inputValid(input){exact(input,['proposal','expectedProposalHead','request','confirmation']);if(Buffer.byteLength(wire(input))>MAX_RECORD_BYTES)fail('QUOTA');requestValid(input.request);exact(input.expectedProposalHead,['hostRevision','headDigest']);if(!positive(input.expectedProposalHead.hostRevision)||!isHash(input.expectedProposalHead.headDigest))fail('REQUEST_INVALID');exact(input.confirmation,['proposalDigest','decision']);if(input.confirmation.decision!=='approve'||input.confirmation.proposalDigest!==input.proposal?.digest)fail('CONFIRMATION_INVALID');if(input.proposal?.binding?.projectId!==projectId||input.proposal.binding.rootIdentity!==rootIdentity||!(await verifyPlanApprovalDraft(input.proposal)).valid||input.proposal.dependencyReview.some(item=>item.status!=='ordered'))fail('PROPOSAL_INVALID');}
 const digestRequest=(input,who=actor,origin=source)=>hash({...input,actor:who,source:origin});
 async function replay(bytes){const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(!text||!text.endsWith('\n'))fail('CORRUPT');const lines=text.slice(0,-1).split('\n');if(lines.length>maxRecords)fail('QUOTA');const records=[],ids=new Set();let previous='GENESIS';for(const [index,line]of lines.entries()){if(!line||Buffer.byteLength(line)>MAX_RECORD_BYTES)fail('CORRUPT');const record=JSON.parse(line);exact(record,['schemaVersion','kind','projectId','rootIdentity','revision','previousHash','proposal','expectedProposalHead','request','requestDigest','confirmation','actor','source','approvedAt','planApprovalRecorded','executionAuthorized','nativeApprovalAuthorized','filesystemVerified','recordHash']);const input={proposal:record.proposal,expectedProposalHead:record.expectedProposalHead,request:record.request,confirmation:record.confirmation};await inputValid(input);if(record.schemaVersion!==1||record.kind!=='PLAN_APPROVAL_RECORD'||record.projectId!==projectId||record.rootIdentity!==rootIdentity||record.revision!==index+1||record.previousHash!==previous||record.request.expectedRevision!==index||record.request.expectedHeadDigest!==previous||ids.has(record.request.requestId)||!named(record.actor)||!named(record.source)||typeof record.approvedAt!=='string'||!Number.isFinite(Date.parse(record.approvedAt))||new Date(record.approvedAt).toISOString()!==record.approvedAt||record.planApprovalRecorded!==true||Object.keys(flags).some(key=>record[key]!==false)||record.requestDigest!==digestRequest(input,record.actor,record.source)||wire(record)!==line)fail('CORRUPT');const {recordHash,...body}=record;if(recordHash!==hash(body))fail('CORRUPT');records.push(record);ids.add(record.request.requestId);previous=recordHash;}return records;}
 async function replayWithdrawals(bytes){
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(!text||!text.endsWith('\n'))fail('CORRUPT');
  const lines=text.slice(0,-1).split('\n');if(lines.length>maxRecords)fail('QUOTA');
  const records=[],ids=new Set();let previous='GENESIS';
  for(const [index,line]of lines.entries()){
   if(!line||Buffer.byteLength(line)>MAX_RECORD_BYTES)fail('CORRUPT');const record=JSON.parse(line);
   exact(record,['schemaVersion','kind','projectId','rootIdentity','revision','previousHash','original','requestDigest','confirmation','actor','source','withdrawnAt','planApprovalRecorded','executionAuthorized','nativeApprovalAuthorized','filesystemVerified','recordHash']);
   await inputValid(record.original);exact(record.confirmation,['decision','requestDigest']);
   if(record.schemaVersion!==1||record.kind!=='PLAN_APPROVAL_WITHDRAWAL'||record.projectId!==projectId||record.rootIdentity!==rootIdentity||record.revision!==index+1||record.previousHash!==previous||ids.has(record.original.request.requestId)||!named(record.actor)||!named(record.source)||record.confirmation.decision!=='withdraw-if-unpublished'||record.confirmation.requestDigest!==record.requestDigest||record.requestDigest!==digestRequest(record.original,record.actor,record.source)||typeof record.withdrawnAt!=='string'||!Number.isFinite(Date.parse(record.withdrawnAt))||new Date(record.withdrawnAt).toISOString()!==record.withdrawnAt||record.planApprovalRecorded!==false||Object.keys(flags).some(key=>record[key]!==false)||wire(record)!==line)fail('CORRUPT');
   const {recordHash,...body}=record;if(recordHash!==hash(body))fail('CORRUPT');records.push(record);ids.add(record.original.request.requestId);previous=recordHash;
  }
  return records;
 }
 async function read(snapshot,file=journal,decode=replay){await checkDirectories(snapshot);const info=await fileInfo(file);if(!info)return {records:[],info:null,size:0};if(!info.size)fail('CORRUPT');if(info.size>maxBytes)fail('QUOTA');return useHandle(await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0)),async handle=>{if(!same(info,await handle.stat()))fail('FILE_CHANGED');const bytes=Buffer.alloc(info.size+1);let length=0;while(length<bytes.length){const part=await handle.read(bytes,length,Math.min(65536,bytes.length-length),length);if(!part.bytesRead)break;length+=part.bytesRead;}const current=await fileInfo(file);if(length!==info.size||!same(info,await handle.stat())||!current||!same(info,current))fail('FILE_CHANGED');await checkDirectories(snapshot);const records=await decode(bytes.subarray(0,length));if(!same(info,await lstat(file)))fail('FILE_CHANGED');await checkDirectories(snapshot);return {records,info,size:length};});}
 async function combined(snapshot){
  const state=await read(snapshot),withdrawn=await read(snapshot,withdrawals,replayWithdrawals),ids=new Set(state.records.map(record=>record.request.requestId));
  if(withdrawn.records.some(record=>ids.has(record.original.request.requestId)))fail('CORRUPT');
  return {state,withdrawn};
 }
 function refuseWithdrawn(withdrawn,input,requestDigest){const prior=withdrawn.records.find(record=>record.original.request.requestId===input.request.requestId);if(prior){if(prior.requestDigest!==requestDigest)fail('REQUEST_CONFLICT');fail('REQUEST_WITHDRAWN');}}
 async function locked(operation){const snapshot=await directories(parent);await checkLock(journal);let failure;try{return await withPlanLock(journal,{actor:'plan-approval-store',timeoutMs:5000,retryMs:10},async()=>{try{await checkDirectories(snapshot);return await operation(snapshot);}catch(error){failure=error;throw error;}});}catch(error){throw failure??error;}}
 const head=state=>({revision:state.records.length,headDigest:state.records.at(-1)?.recordHash??'GENESIS'});
 async function persist(snapshot,state,record,idempotent,currentParentsChecked){const bytes=idempotent?null:Buffer.from(wire(record)+'\n');if(!idempotent&&(state.records.length>=maxRecords||bytes.length>MAX_RECORD_BYTES||state.size+bytes.length>maxBytes))fail('QUOTA');await checkDirectories(snapshot);const mode=constants.O_WRONLY|constants.O_APPEND|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0)|(state.info?0:constants.O_CREAT|constants.O_EXCL);await useHandle(await open(journal,mode,0o600),async handle=>{const stat=await handle.stat();if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(state.info?!same(state.info,stat):stat.size!==0))fail('FILE_CHANGED');await checkDirectories(snapshot);if(bytes)await handle.writeFile(bytes);await handle.sync();});const observed=await read(snapshot),expected=idempotent?head(state):{revision:record.revision,headDigest:record.recordHash};if(wire(head(observed))!==wire(expected))fail('PUBLICATION_UNCERTAIN');return freeze({record,idempotent,observedApprovalHead:head(observed),matchesObservedApprovalHead:record.recordHash===head(observed).headDigest,currentParentsChecked,...flags});}
 async function persistWithdrawal(snapshot,state,record,idempotent){
  const bytes=idempotent?null:Buffer.from(wire(record)+'\n');if(!idempotent&&(state.records.length>=maxRecords||bytes.length>MAX_RECORD_BYTES||state.size+bytes.length>maxBytes))fail('QUOTA');
  await checkDirectories(snapshot);const mode=constants.O_WRONLY|constants.O_APPEND|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0)|(state.info?0:constants.O_CREAT|constants.O_EXCL);
  await useHandle(await open(withdrawals,mode,0o600),async handle=>{const stat=await handle.stat();if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(state.info?!same(state.info,stat):stat.size!==0))fail('FILE_CHANGED');await checkDirectories(snapshot);if(bytes)await handle.writeFile(bytes);await handle.sync();});
  const observed=(await combined(snapshot)).withdrawn,expected=idempotent?head(state):{revision:record.revision,headDigest:record.recordHash};
  if(wire(head(observed))!==wire(expected))fail('PUBLICATION_UNCERTAIN');
  return freeze({outcome:'withdrawn',record,idempotent,observedWithdrawalHead:head(observed),currentParentsChecked:false,planApprovalRecorded:false,...flags});
 }
 // A project folder that does not exist yet simply has no approval history.
 // The root chain is still checked, so a symlinked root keeps failing closed.
 async function absent(){try{await lstat(parent);return false;}catch(error){if(error.code!=='ENOENT')throw error;}try{await directories(root);}catch(error){if(error.code!=='ENOENT')throw error;}return true;}
 const emptyHistory=()=>freeze({schemaVersion:1,projectId,rootIdentity,records:[],observedApprovalHead:{revision:0,headDigest:'GENESIS'},currentParentsChecked:false,...flags});
 return Object.freeze({
  async inspect(){if(await absent())return emptyHistory();return locked(async snapshot=>{const {state}=await combined(snapshot);return freeze({schemaVersion:1,projectId,rootIdentity,records:state.records,observedApprovalHead:head(state),currentParentsChecked:false,...flags});});},
  async inspectCurrent(input){input=structuredClone(input);exact(input,['expectedApprovalHead']);exact(input.expectedApprovalHead,['revision','headDigest']);const expected=input.expectedApprovalHead;if(!positive(expected.revision)||!isHash(expected.headDigest))fail('REQUEST_INVALID');
   // Capture under the approval lock, then release before taking parent locks.
   const captured=await locked(async snapshot=>{const {state}=await combined(snapshot);if(wire(head(state))!==wire(expected))fail('STALE_HEAD');return state.records.at(-1);});
   return withCurrentPlanningReview(root,{proposal:captured.proposal,expectedProposalHead:captured.expectedProposalHead},()=>locked(async snapshot=>{const {state}=await combined(snapshot),record=state.records.at(-1);if(wire(head(state))!==wire(expected)||wire(record)!==wire(captured))fail('STALE_HEAD');return freeze({record,observedApprovalHead:head(state),currentParentsChecked:true,...flags});}));
  },
  async publish(input){input=structuredClone(input);await inputValid(input);const requestDigest=digestRequest(input);
   // Historical retry lock is released before acquiring any parent lock.
   const historical=await locked(async snapshot=>{const {state,withdrawn}=await combined(snapshot);refuseWithdrawn(withdrawn,input,requestDigest);const prior=state.records.find(record=>record.request.requestId===input.request.requestId);if(!prior)return null;if(prior.requestDigest!==requestDigest)fail('REQUEST_CONFLICT');return persist(snapshot,state,prior,true,false);});if(historical)return historical;
   return withCurrentPlanningReview(root,{proposal:input.proposal,expectedProposalHead:input.expectedProposalHead},()=>locked(async snapshot=>{const {state,withdrawn}=await combined(snapshot);refuseWithdrawn(withdrawn,input,requestDigest);const prior=state.records.find(record=>record.request.requestId===input.request.requestId);if(prior){if(prior.requestDigest!==requestDigest)fail('REQUEST_CONFLICT');return persist(snapshot,state,prior,true,false);}const previous=head(state);if(input.request.expectedRevision!==previous.revision||input.request.expectedHeadDigest!==previous.headDigest)fail('STALE_HEAD');const body={schemaVersion:1,kind:'PLAN_APPROVAL_RECORD',projectId,rootIdentity,revision:previous.revision+1,previousHash:previous.headDigest,...input,requestDigest,actor,source,approvedAt:new Date().toISOString(),planApprovalRecorded:true,...flags};return persist(snapshot,state,{...body,recordHash:hash(body)},false,true);}));
  },
  async resolveOriginal(input){
   input=structuredClone(input);exact(input,['original','confirmation']);await inputValid(input.original);exact(input.confirmation,['decision','requestDigest']);
   const requestDigest=digestRequest(input.original);
   if(input.confirmation.decision!=='withdraw-if-unpublished'||input.confirmation.requestDigest!==requestDigest)fail('CONFIRMATION_INVALID');
   // No parent locks: this terminal intent prevents a future append, rather
   // than asserting that the original ever passed current-parent validation.
   return locked(async snapshot=>{
    const {state,withdrawn}=await combined(snapshot),published=state.records.find(record=>record.request.requestId===input.original.request.requestId);
    if(published){if(published.requestDigest!==requestDigest)fail('REQUEST_CONFLICT');return freeze({outcome:'published',receipt:await persist(snapshot,state,published,true,false)});}
    const prior=withdrawn.records.find(record=>record.original.request.requestId===input.original.request.requestId);
    if(prior){if(prior.requestDigest!==requestDigest)fail('REQUEST_CONFLICT');return persistWithdrawal(snapshot,withdrawn,prior,true);}
    const previous=head(withdrawn),body={schemaVersion:1,kind:'PLAN_APPROVAL_WITHDRAWAL',projectId,rootIdentity,revision:previous.revision+1,previousHash:previous.headDigest,original:input.original,requestDigest,confirmation:input.confirmation,actor,source,withdrawnAt:new Date().toISOString(),planApprovalRecorded:false,...flags};
    return persistWithdrawal(snapshot,withdrawn,{...body,recordHash:hash(body)},false);
   });
  },
 });
}
