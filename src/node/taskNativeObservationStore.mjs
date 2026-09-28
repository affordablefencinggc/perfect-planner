import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {withPlanLock} from './planLock.mjs';
import {readProofArtifactBytes,MAX_PROOF_ARTIFACT_BYTES} from './proofArtifactRead.mjs';
import {parseNativeTaskObservation,nativeTaskSettlementObserved} from './taskNativeDispatch.mjs';

// Private host custody, not an MCP/renderer API. The caller supplies the original
// authenticated intent. This records observations, NOT verified task completion.
// One immutable file contains the intent, observation and captured output; no
// separate terminal pointer can be committed ahead of its output. Same-user
// rollback, first-file directory durability and exclusive candidate custody are
// not established by cooperative locks, file sync or hashes.
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const wire=v=>JSON.stringify(canonical(v));
const hash=v=>createHash('sha256').update(v).digest('hex');
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const fail=()=>{throw Error('NATIVE_TASK_OBSERVATION_CUSTODY_UNRESOLVED');};
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
async function directories(root){
 const parents=[];
 for(let current=root;;){const s=await lstat(current);if(!s.isDirectory()||s.isSymbolicLink()||path.relative(current,await realpath(current)))fail();parents.push({current,ino:s.ino,dev:s.dev});const next=path.dirname(current);if(next===current)break;current=next;}
 return async()=>{for(const p of parents){const s=await lstat(p.current);if(!s.isDirectory()||s.isSymbolicLink()||s.ino!==p.ino||s.dev!==p.dev||path.relative(p.current,await realpath(p.current)))fail();}};
}
export function createTaskNativeObservationStore({directory,projectId,rootIdentity}){
 if(typeof directory!=='string'||!path.isAbsolute(directory)||path.normalize(directory)!==directory||typeof projectId!=='string'||!projectId||!hex(rootIdentity))fail();
 function intent(value){
  if(!value||value.kind!=='TASK_EXECUTION_INTENT_RECEIPT'||value.schemaVersion!==1||value.projectId!==projectId||value.rootIdentity!==rootIdentity||!uuid(value.runId)||!hex(value.recordDigest)||!hex(value.consumptionDigest)||value.executionAuthorized!==false||value.state!=='launch-unresolved'||!value.binding)fail();
  return value;
 }
 function limits(value){if(!exact(value,['stdoutBytes','stderrBytes','combinedBytes'])||!Object.values(value).every(v=>Number.isSafeInteger(v)&&v>0)||value.stdoutBytes>1048576||value.stderrBytes>1048576||value.combinedBytes>2097152)fail();return value;}
 function decode(bytes,original){
  const record=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!exact(record,['schemaVersion','kind','intentReceipt','executionSpecDigest','outputLimits','observation','recordDigest'])||![1,2].includes(record.schemaVersion)||record.kind!=='NATIVE_TASK_RETAINED_OBSERVATION'||wire(record.intentReceipt)!==wire(original)||!hex(record.executionSpecDigest))fail();
  const {recordDigest,...body}=record;if(recordDigest!==hash(wire(body)))fail();
  parseNativeTaskObservation(record.observation,{runId:original.runId,outputLimits:limits(record.outputLimits)});
  return record;
 }
 function receipt(bytes,record,finalized=false){const provisional=record.schemaVersion===2&&!finalized;return freeze({schemaVersion:1,kind:provisional?'NATIVE_TASK_PROVISIONAL_RECEIPT':'NATIVE_TASK_OBSERVATION_RECEIPT',projectId,rootIdentity,runId:record.intentReceipt.runId,intentDigest:record.intentReceipt.recordDigest,artifactDigest:hash(bytes),state:provisional?'retained-provisional':'result-unverified',executionAuthorized:false});}
 function validateFinalization(value,original,bytes){
  if(!exact(value,['schemaVersion','kind','runId','intentDigest','candidateDigest','checkContractDigest','artifactDigest','executionAuthorized'])||value.schemaVersion!==2||value.kind!=='NATIVE_TASK_GUARD_FINALIZED'||value.runId!==original.runId||value.intentDigest!==original.recordDigest||value.artifactDigest!==hash(bytes)||value.executionAuthorized!==false)fail();
  for(const key of ['candidateDigest','checkContractDigest'])if(!hex(original.binding[key])||value[key]!==original.binding[key])fail();
 }
 async function persist(file,bytes,recheck){
  await recheck();let handle;
  try{handle=await open(file,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);}catch(error){if(error.code!=='EEXIST')throw error;}
  if(handle){try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}}
  await syncRetained(file,bytes,recheck);
 }
 async function syncRetained(file,bytes,recheck){
  if(!(await readProofArtifactBytes(file)).equals(bytes))fail();
  const sync=await open(file,constants.O_RDWR|(constants.O_NOFOLLOW??0));
  try{await sync.sync();}finally{await sync.close();}
  await recheck();if(!(await readProofArtifactBytes(file)).equals(bytes))fail();
 }
 async function record({intentReceipt,executionSpec,observation},schemaVersion=1){
   const original=intent(structuredClone(intentReceipt)),spec=structuredClone(executionSpec);
   if(!spec||spec.runId!==original.runId||spec.intentDigest!==original.recordDigest)fail();
   // Bind the handoff to the admitted candidate and required checks before any
   // filesystem mutation. Historical inspection remains observational only.
   for(const key of ['candidateDigest','checkContractDigest']){
    if(!hex(original.binding[key])||!hex(spec[key])||spec[key]!==original.binding[key])fail();
   }
   const outputLimits=limits(spec.outputLimits),result=parseNativeTaskObservation(structuredClone(observation),spec);
   const body={schemaVersion,kind:'NATIVE_TASK_RETAINED_OBSERVATION',intentReceipt:original,executionSpecDigest:hash(wire(spec)),outputLimits,observation:result};
   const record={...body,recordDigest:hash(wire(body))};
   // JSON escapes may expand a valid 2 MiB output capture up to sixfold.
   const bytes=Buffer.from(wire(record)+'\n');if(bytes.length>MAX_PROOF_ARTIFACT_BYTES)fail();
   const recheck=await directories(directory),file=path.join(directory,original.runId+'.json');
   return withPlanLock(file,{actor:'native-observation-custody',timeoutMs:5000},async()=>{
    await recheck();let handle;
    try{handle=await open(file,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);}
    catch(error){if(error.code!=='EEXIST')throw error;}
    if(handle){try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}}
    const retained=await readProofArtifactBytes(file);if(!retained.equals(bytes))fail();
    // Re-sync identical retained bytes on idempotent recovery after a lost sync
    // reply. Never truncate, replace or execute again to repair uncertain data.
    // Windows FlushFileBuffers requires a writable handle. O_RDWR does not
    // truncate or rewrite retained bytes; before/after readback stays required.
    const sync=await open(file,constants.O_RDWR|(constants.O_NOFOLLOW??0));
    try{await sync.sync();}finally{await sync.close();}
    await recheck();const checked=await readProofArtifactBytes(file);if(!checked.equals(bytes))fail();
    return receipt(checked,decode(checked,original));
   });
  }
 return Object.freeze({
  record:input=>record(input),
  retainProvisional:input=>record(input,2),
  async finalize({intentReceipt,finalization}){
   const original=intent(structuredClone(intentReceipt)),value=structuredClone(finalization),recheck=await directories(directory),file=path.join(directory,original.runId+'.json');
   return withPlanLock(file,{actor:'native-observation-finalization',timeoutMs:5000},async()=>{
    const bytes=await readProofArtifactBytes(file),record=decode(bytes,original);
    // Legacy observations cannot acquire guard evidence retroactively.
    if(record.schemaVersion!==2||!nativeTaskSettlementObserved(record.observation))fail();validateFinalization(value,original,bytes);
    await persist(path.join(directory,original.runId+'.finalization.json'),Buffer.from(wire(value)+'\n'),recheck);
    if(!(await readProofArtifactBytes(file)).equals(bytes))fail();await recheck();
    return receipt(bytes,record,true);
   });
  },
  async inspect(intentReceipt){
   const original=intent(structuredClone(intentReceipt)),recheck=await directories(directory);
   const bytes=await readProofArtifactBytes(path.join(directory,original.runId+'.json'));
   const record=decode(bytes,original);let finalized=false;
   if(record.schemaVersion===2){
    const finalPath=path.join(directory,original.runId+'.finalization.json');let exists=true;
    try{await lstat(finalPath);}catch(error){if(error.code!=='ENOENT')throw error;exists=false;}
    if(exists){
     if(!nativeTaskSettlementObserved(record.observation))fail();
     const retained=await readProofArtifactBytes(finalPath);validateFinalization(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(retained)),original,bytes);
     // Complete bytes alone may be the remainder of a failed flush. Recovery
     // must re-establish file persistence before exposing a final receipt.
     // This never creates a missing file or claims directory/power-loss proof.
     await syncRetained(finalPath,retained,recheck);finalized=true;
    }
   }
   if(!(await readProofArtifactBytes(path.join(directory,original.runId+'.json'))).equals(bytes))fail();
   await recheck();return freeze({receipt:receipt(bytes,record,finalized),observation:record.observation});
  },
 });
}
