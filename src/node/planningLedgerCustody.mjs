import path from 'node:path';
import {lstat,mkdir,realpath} from 'node:fs/promises';
import {createImportedProjectId} from '../project/projectIds.js';
import {validateTaskDraftBinding,validateTaskDraftLedger} from '../project/taskDraftLedger.js';
import {canonicalArchitectureJson as canonical,deepFreezeArchitecture as freeze} from '../engine/architectureContractVerification.js';
import {createTaskLedgerAuthorityStore} from './taskLedgerAuthorityStore.mjs';
import {withPlanLock} from './planLock.mjs';
import {createPlanningLedgerWithdrawalStore,ledgerWithdrawalDigest,ledgerWithdrawalFlags} from './planningLedgerWithdrawalStore.mjs';
const fail=message=>{throw Error(`PLANNING_LEDGER_${message}`);};
const exact=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('|')!==[...keys].sort().join('|'))fail('INVALID');};
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function bindingOf(value){validateTaskDraftBinding(value);if(createImportedProjectId(value.rootIdentity)!==value.projectId)fail('PROJECT_ROOT_MISMATCH');return value;}
async function info(name){try{return await lstat(name);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function directory(name){const value=await lstat(name);if(!value.isDirectory()||value.isSymbolicLink()||path.relative(name,await realpath(name)))fail('UNSAFE_DIRECTORY');return {name,dev:value.dev,ino:value.ino};}
async function ancestors(root){const values=[];for(let cursor=root;;cursor=path.dirname(cursor)){values.push(await directory(cursor));if(path.dirname(cursor)===cursor)break;}return values;}
async function unchanged(values){for(const value of values){const current=await directory(value.name);if(current.ino!==value.ino||current.dev!==value.dev)fail('DIRECTORY_CHANGED');}}
async function safeLock(target){const name=`${target}.pp-lock`;if(await info(name)){await directory(name);const holder=await info(path.join(name,'holder.json'));if(holder&&(!holder.isFile()||holder.isSymbolicLink()||holder.nlink!==1||holder.size>4096))fail('UNSAFE_LOCK');}}

// Host-selected storage root, browser-declared project identity. No native
// registration or filesystem access is established by retaining these bytes.
// Cooperating locks and path checks do not defeat arbitrary same-user changes.
export function createPlanningLedgerCustody({root}={}){
 if(typeof root!=='string'||!path.isAbsolute(root)||path.normalize(root)!==root||path.dirname(root)===root)fail('CONFIG_INVALID');
 function locations(binding){const project=path.join(root,binding.projectId);return {project,lock:path.join(root,`planning-${binding.projectId}`),journal:path.join(project,'planning-ledger.jsonl')};}
 const receipt=(binding,state)=>({schemaVersion:1,binding,declaredBinding:state.proposals.at(-1)?.ledger.binding??null,observedHead:{hostRevision:state.hostRevision,headDigest:state.headDigest},latestProposal:state.proposals.at(-1)??null,declarationSource:'browser-declared',filesystemVerified:false,approvalAuthorized:false,executionAuthorized:false});
 const empty=()=>({hostRevision:0,headDigest:'GENESIS',proposals:[]});
 function store(binding,where){return createTaskLedgerAuthorityStore({journalPath:where.journal,projectId:binding.projectId,rootIdentity:binding.rootIdentity});}
 async function locked(binding,operation){const where=locations(binding),snapshot=await ancestors(root);await safeLock(where.lock);return withPlanLock(where.lock,{actor:'browser-planning-custody',timeoutMs:5000,retryMs:10},async()=>{await unchanged(snapshot);const result=await operation(where,snapshot);await unchanged(snapshot);return result;});}
 function validateOriginal(input){
  exact(input,['ledger','request','expectedCensusDigest']);const ledger=validateTaskDraftLedger(input.ledger);bindingOf(ledger.binding);
  if(canonical(ledger)!==canonical(input.ledger)||ledger.revision<1)fail('INVALID_LEDGER');const {request,expectedCensusDigest}=input;
  exact(request,['requestId','expectedRevision','expectedHeadDigest']);if(typeof request.requestId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.requestId)||!Number.isSafeInteger(request.expectedRevision)||request.expectedRevision<0||(request.expectedRevision===0?request.expectedHeadDigest!=='GENESIS':!hash(request.expectedHeadDigest))||(expectedCensusDigest!==null&&!hash(expectedCensusDigest)))fail('INVALID_REQUEST');
  return ledger.binding;
 }
 function withdrawalStore(binding,where){return createPlanningLedgerWithdrawalStore({file:path.join(where.project,'planning-ledger-withdrawals.jsonl'),binding,validateOriginal});}
 async function combined(binding,where,custody){const state=await custody.inspect(),withdrawals=withdrawalStore(binding,where),withdrawn=await withdrawals.read(),ids=new Set(state.proposals.map(record=>record.requestId));if(withdrawn.records.some(record=>ids.has(record.original.request.requestId)))fail('WITHDRAWAL_CORRUPT');return {state,withdrawals,withdrawn};}
 async function submitLocked(input,binding,where,snapshot){
  const {ledger,request,expectedCensusDigest}=input;let existing=await info(where.project);if(!existing){if(expectedCensusDigest!==null||request.expectedRevision!==0)fail('CENSUS_OR_HEAD_MISMATCH');await mkdir(where.project);await unchanged(snapshot);}
  const projectSnapshot=await directory(where.project),custody=store(binding,where),{state,withdrawn}=await combined(binding,where,custody);
  const denied=withdrawn.records.find(record=>record.original.request.requestId===request.requestId);if(denied){if(denied.requestDigest!==ledgerWithdrawalDigest(input))fail('REQUEST_CONFLICT');fail('REQUEST_WITHDRAWN');}
  const prior=state.proposals.find(record=>record.requestId===request.requestId),predecessor=prior?state.proposals[prior.hostRevision-2]:state.proposals.at(-1);
  if(expectedCensusDigest!==(predecessor?.ledger.binding.censusDigest??null))fail('CENSUS_MISMATCH');
  if(!prior&&predecessor&&(ledger.revision<predecessor.ledger.revision||(ledger.revision===predecessor.ledger.revision&&canonical(ledger)!==canonical(predecessor.ledger))))fail('LOCAL_REVISION_CONFLICT');
  const result=await custody.propose(ledger,request);await unchanged([projectSnapshot]);const {state:observed}=await combined(binding,where,custody);await unchanged([projectSnapshot]);
  return freeze({...receipt(binding,observed),submissionPersisted:true,idempotent:result.idempotent,submitted:{hostRevision:result.proposal.hostRevision,headDigest:result.proposal.recordHash,ledgerDigest:result.proposal.ledgerDigest},submittedMatchesObservedHead:result.proposal.hostRevision===observed.hostRevision&&result.proposal.recordHash===observed.headDigest});
 }
 return Object.freeze({
  // Trusted host composition only. Never expose a callback through HTTP/MCP.
  // Lock order: planning wrapper -> retained proposal -> caller's later lock.
  async withCurrentProposal(input,operation){input=structuredClone(input);exact(input,['binding','expectedHead']);const binding=bindingOf(input.binding),{expectedHead}=input;exact(expectedHead,['hostRevision','headDigest']);if(!Number.isSafeInteger(expectedHead.hostRevision)||expectedHead.hostRevision<1||!hash(expectedHead.headDigest)||typeof operation!=='function')fail('INVALID_REQUEST');
   const where=locations(binding),snapshot=await ancestors(root);if(!await info(where.project)){await unchanged(snapshot);fail('HEAD_MISSING');}
   return locked(binding,async where=>{const projectSnapshot=await directory(where.project),custody=store(binding,where);await combined(binding,where,custody);return custody.withCurrentProposal(expectedHead,async record=>{if(canonical(record.ledger.binding)!==canonical(binding))fail('CENSUS_MISMATCH');try{return await operation(freeze({proposal:record,declarationSource:'browser-declared',filesystemVerified:false,approvalAuthorized:false,executionAuthorized:false}));}finally{await unchanged([projectSnapshot]);}});});
  },
  async inspect(input){input=structuredClone(input);exact(input,['binding']);const binding=bindingOf(input.binding),where=locations(binding),snapshot=await ancestors(root);
   // No folder, journal or lock is created by an absent inspection.
   if(!await info(where.project)){await unchanged(snapshot);if(await info(where.project))fail('DIRECTORY_CHANGED');return freeze(receipt(binding,empty()));}
   return locked(binding,async where=>{await directory(where.project);const {state}=await combined(binding,where,store(binding,where));return freeze(receipt(binding,state));});
  },
  async submit(input){input=structuredClone(input);const binding=validateOriginal(input);return locked(binding,(where,snapshot)=>submitLocked(input,binding,where,snapshot));},
  async resolveOriginal(input){
   input=structuredClone(input);exact(input,['original','confirmation']);const binding=validateOriginal(input.original),requestDigest=ledgerWithdrawalDigest(input.original);exact(input.confirmation,['decision','requestDigest']);
   if(input.confirmation.decision!=='withdraw-if-unpublished'||input.confirmation.requestDigest!==requestDigest)fail('CONFIRMATION_INVALID');
   return locked(binding,async(where,snapshot)=>{
    if(!await info(where.project)){await mkdir(where.project);await unchanged(snapshot);}const projectSnapshot=await directory(where.project),custody=store(binding,where),{state,withdrawals,withdrawn}=await combined(binding,where,custody);
    const prior=state.proposals.find(record=>record.requestId===input.original.request.requestId);
    // Reuse the real submission retry: its original predecessor census and
    // digest are checked and bytes re-flushed. Never manufacture a receipt.
    if(prior)return freeze({outcome:'submitted',submittedProposal:prior,receipt:await submitLocked(input.original,binding,where,snapshot)});
    const existing=withdrawn.records.find(record=>record.original.request.requestId===input.original.request.requestId);
    if(existing&&existing.requestDigest!==requestDigest)fail('REQUEST_CONFLICT');
    const previous=withdrawals.head(withdrawn),body={schemaVersion:1,kind:'TASK_LEDGER_WITHDRAWAL',binding,revision:previous.revision+1,previousHash:previous.headDigest,original:input.original,requestDigest,confirmation:input.confirmation,withdrawnAt:new Date().toISOString(),...ledgerWithdrawalFlags};
    const result=await withdrawals.persist(withdrawn,existing??{...body,recordHash:ledgerWithdrawalDigest(body)},Boolean(existing));await combined(binding,where,custody);await unchanged([projectSnapshot]);return freeze(result);
   });
  },
 });
}
