import path from 'node:path';
import {nativeTaskSettlementObserved} from './taskNativeDispatch.mjs';
import {mkdir,lstat,realpath,open,unlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {withPlanLock} from './planLock.mjs';

const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const token=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const positive=v=>Number.isSafeInteger(v)&&v>0;
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const wire=v=>JSON.stringify(canonical(v)),hash=v=>createHash('sha256').update(v).digest('hex');
const fail=code=>{throw Error(`NATIVE_EXECUTION_REQUEST_${code}`);};
// Diagnostic codes are an explicit vocabulary, never arbitrary exception text.
// These observations do not settle execution or grant recovery permission.
const failureCodes=new Set(['NATIVE_TASK_DISPATCH_UNRESOLVED','NATIVE_TASK_CANDIDATE_CHANGED','NATIVE_TASK_CANDIDATE_CLEANUP_UNCERTAIN','NATIVE_TASK_GRANT_EXPIRED','NATIVE_TASK_TRANSPORT_CLEANUP_UNCERTAIN','NATIVE_TASK_TRANSPORT_UNRESOLVED','NATIVE_TASK_OBSERVATION_INVALID','NATIVE_TASK_OBSERVATION_MISMATCH','NATIVE_TASK_OBSERVATION_CONTRADICTORY','NATIVE_TASK_OUTPUT_INVALID','NATIVE_TASK_OBSERVATION_CUSTODY_UNRESOLVED','NATIVE_RESULT_CUSTODY_INTENT_MISMATCH','NATIVE_RESULT_CUSTODY_ARTIFACT_CHANGED','NATIVE_EXECUTION_REQUEST_UNRESOLVED','TASK_CANDIDATE_UNVERIFIED','TASK_CANDIDATE_CLEANUP_UNCERTAIN','TASK_GRANT_CONTEXT_MISMATCH']);
function failureCauses(error){
 const codes=[],seen=new Set();
 for(let current=error;current&&codes.length<4&&!seen.has(current);current=current.cause){seen.add(current);codes.push(failureCodes.has(current.message)?current.message:'UNCLASSIFIED');}
 return codes.length?codes:['UNCLASSIFIED'];
}
export function validateNativeExecutionRequest(v){
 v=structuredClone(v);
 if(!exact(v,['requestId','expected','contractHead','confirmationId','taskId','checkId','attemptId','attemptNumber'])||![v.requestId,v.confirmationId,v.checkId,v.attemptId].every(token)||!positive(v.attemptNumber)
  ||!/^T\d{4,6}$/.test(v.taskId)||v.taskId!==`T${String(Number(v.taskId.slice(1))).padStart(4,'0')}`||Number(v.taskId.slice(1))<1
  ||!exact(v.expected,['hostRevision','headDigest'])||!positive(v.expected.hostRevision)||!digest(v.expected.headDigest)
  ||!exact(v.contractHead,['revision','headDigest'])||!positive(v.contractHead.revision)||!digest(v.contractHead.headDigest))fail('INVALID');
 return v;
}
export function validateNativeTaskExecutionRequest(input){
 const v=structuredClone(input);
 if(!exact(v,['requestId','expected','contractHead','confirmationId','taskId','attemptId','attemptNumber']))fail('INVALID');
 validateNativeExecutionRequest({...v,checkId:'batch'});return v;
}
async function safe(directory){for(let p=directory;;p=path.dirname(p)){const s=await lstat(p);if(!s.isDirectory()||s.isSymbolicLink()||path.relative(p,await realpath(p)))fail('STORAGE_UNSAFE');if(path.dirname(p)===p)break;}}
async function read(file,maxBytes=16384){
 await safe(path.dirname(file));let handle;
 try{handle=await open(file,'r');}catch(error){if(error.code==='ENOENT')return null;throw error;}
 try{
  const before=await lstat(file),same=s=>s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&['ino','dev','size','mtimeMs','ctimeMs'].every(k=>s[k]===before[k]);
  if(before.size<1||before.size>maxBytes||!same(before)||!same(await handle.stat()))fail('STORAGE_INVALID');
  const buffer=Buffer.alloc(maxBytes+1);let used=0;for(;;){const part=await handle.read(buffer,used,buffer.length-used,null);if(!part.bytesRead)break;used+=part.bytesRead;if(used===buffer.length)fail('STORAGE_LIMIT');}
  const bytes=buffer.subarray(0,used);if(bytes.length!==before.size||!same(await handle.stat())||!same(await lstat(file)))fail('STORAGE_CHANGED');await safe(path.dirname(file));
  return JSON.parse(bytes.toString('utf8'));
 }finally{await handle.close();}
}
async function retain(file,value,maxBytes=16384){
 await safe(path.dirname(file));const bytes=wire(value);if(Buffer.byteLength(bytes)>maxBytes)fail('STORAGE_LIMIT');
 let handle;try{handle=await open(file,'wx',0o600);}catch(error){if(error.code!=='EEXIST')throw error;}
 if(handle){try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}}
 if(wire(await read(file,maxBytes))!==bytes)fail('CONFLICT');
 const sync=await open(file,'r+');try{await sync.sync();}finally{await sync.close();}
 if(wire(await read(file,maxBytes))!==bytes)fail('CONFLICT');
}
function terminal(value,original){
 if(value?.kind==='NATIVE_TASK_EXECUTION_RECEIPT'){
  if(!exact(value,['schemaVersion','kind','requestId','originalDigest','anchorGrantId','checkCount','checkSetDigest','checksDigest','state','cleanupComplete','authorityVerified','executionAuthorized'])||value.schemaVersion!==1||value.requestId!==original.request.requestId||value.originalDigest!==hash(wire(original))||!token(value.anchorGrantId)||!positive(value.checkCount)||value.checkCount>256||![value.checkSetDigest,value.checksDigest].every(digest)||value.state!=='results-recorded'||value.cleanupComplete!==true||value.authorityVerified!==false||value.executionAuthorized!==false)fail('RESULT_INVALID');
  return Object.freeze(value);
 }
 if(value?.kind==='NATIVE_CHECK_NOT_STARTED_RECEIPT'){
  if(!exact(value,['schemaVersion','kind','requestId','originalDigest','proofDigest','state','cleanupComplete','executionAuthorized'])||value.schemaVersion!==1||value.requestId!==original.request.requestId||value.originalDigest!==hash(wire(original))||!digest(value.proofDigest)||value.state!=='not-started'||value.cleanupComplete!==true||value.executionAuthorized!==false)fail('RESULT_INVALID');
  return Object.freeze(value);
 }
 if(!exact(value,['schemaVersion','kind','requestId','originalDigest','grantId','runId','intentDigest','artifactDigest','state','cleanupComplete','executionAuthorized'])||value.schemaVersion!==1||value.kind!=='NATIVE_CHECK_EXECUTION_RECEIPT'
  ||value.requestId!==original.request.requestId||value.originalDigest!==hash(wire(original))||![value.grantId,value.runId].every(v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v))
  ||![value.intentDigest,value.artifactDigest].every(digest)||value.state!=='result-recorded'||value.cleanupComplete!==true||value.executionAuthorized!==false)fail('RESULT_INVALID');
 return Object.freeze(value);
}
// Private owner composition. Request data never contains a credential, path,
// executable or policy. An unresolved original cannot be replayed or replaced.
export function createNativeTaskExecutionRequests({directory,binding,selection,owner}){
 binding=structuredClone(binding);selection=structuredClone(selection);
 let closed=false,uncertain=false;const pending=new Set();
 if(typeof directory!=='string'||!path.isAbsolute(directory)||path.normalize(directory)!==directory||directory.includes('\0'))fail('CONFIG_INVALID');
 if(!exact(binding,['projectId','rootIdentity','censusDigest'])||!token(binding.projectId)||!digest(binding.rootIdentity)||!digest(binding.censusDigest)
  ||['createWorker','inspectHeads','enroll','issue','consume','dispatch','releaseWorker'].some(name=>typeof owner?.[name]!=='function'))fail('CONFIG_INVALID');
 async function prepare(){await safe(path.dirname(directory));try{await mkdir(directory);}catch(e){if(e.code!=='EEXIST')throw e;}await safe(directory);}
 async function retainedTerminal(value,original,key){
  const receipt=terminal(value,original);
  if(receipt.kind==='NATIVE_TASK_EXECUTION_RECEIPT'){
   const checkSet=await read(path.join(directory,`${key}.checks.json`),65536),refs=[];
   if(hash(wire(checkSet))!==receipt.checkSetDigest||checkSet.checks.length!==receipt.checkCount)fail('RESULT_INVALID');
   for(let index=0;index<receipt.checkCount;index++){const ref=await read(path.join(directory,`${key}.check-${index}.result.json`));if(!ref||ref.checkId!==checkSet.checks[index].checkId)fail('RESULT_INVALID');refs.push(ref);}
   if(hash(wire(refs))!==receipt.checksDigest||refs[0].grantId!==receipt.anchorGrantId)fail('RESULT_INVALID');
  }
  if(receipt.state==='not-started'){
   const proof=await read(path.join(directory,`${key}.not-started-proof.json`));
   if(!proof||hash(wire(proof))!==receipt.proofDigest||proof.requestDigest!==hash(wire(original.request)))fail('RESULT_INVALID');
  }
  await retain(path.join(directory,`${key}.result.json`),receipt);
  return receipt;
 }
 async function performTask(input,recoverOnly){
  const request=validateNativeTaskExecutionRequest(input);
  if(['reviewTaskChecks','recoverTaskResults','heartbeatWorker'].some(name=>typeof owner?.[name]!=='function'))fail('BATCH_UNCONFIGURED');
  if(wire(request.expected)!==wire(selection.expected)||wire(request.contractHead)!==wire(selection.contractHead))fail('SELECTION_CHANGED');
  const original={schemaVersion:2,binding,request},key=hash(`task:${request.requestId}`),originalDigest=hash(wire(original));await prepare();
  return withPlanLock(path.join(directory,'owner'),{actor:'native-task-execution-owner',timeoutMs:1000},async()=>{
   const file=suffix=>path.join(directory,`${key}.${suffix}.json`),activeFile=path.join(directory,'active.json');
   const saved=await read(file('original'));if(saved&&wire(saved)!==wire(original))fail('CONFLICT');
   const result=await read(file('result'));
   if(result){if(!saved)fail('RESULT_INVALID');return retainedTerminal(result,original,key);}
   async function publish(checkSet,session){
    const checkRefs=[];
    for(let index=0;index<checkSet.checks.length;index++){
     let ref=await read(file(`check-${index}.result`));
     if(!ref){const grant=await read(file(`check-${index}.grant`));if(!exact(grant,['grantId','originalDigest'])||grant.originalDigest!==originalDigest)fail('UNRESOLVED');ref={checkId:checkSet.checks[index].checkId,grantId:grant.grantId};}
     checkRefs.push(ref);
    }
    const recovered=await owner.recoverTaskResults({request,key,checkSet,session,checkRefs});
    if(!Array.isArray(recovered.checkRefs)||recovered.checkRefs.length!==checkSet.checks.length)fail('UNRESOLVED');
    for(let index=0;index<recovered.checkRefs.length;index++)await retain(file(`check-${index}.result`),recovered.checkRefs[index]);
    const receipt=terminal({schemaVersion:1,kind:'NATIVE_TASK_EXECUTION_RECEIPT',requestId:request.requestId,originalDigest,anchorGrantId:recovered.anchorGrantId,checkCount:recovered.checkCount,checkSetDigest:recovered.checkSetDigest,checksDigest:recovered.checksDigest,state:'results-recorded',cleanupComplete:true,authorityVerified:false,executionAuthorized:false},original);
    await retain(file('result'),receipt);return receipt;
   }
   if(saved&&recoverOnly){
    const checkSet=await read(file('checks'),65536),session=await read(file('session'));
    if(!checkSet||!session)fail('UNRESOLVED');return publish(checkSet,session);
   }
   if(saved||recoverOnly)fail('UNRESOLVED');
   const active=await read(activeFile);
   if(active){
    if(!exact(active,['key','originalDigest'])||!digest(active.key)||!digest(active.originalDigest))fail('STORAGE_INVALID');
    const prior=await read(path.join(directory,`${active.key}.original.json`)),done=await read(path.join(directory,`${active.key}.result.json`));
    if(!prior||hash(wire(prior))!==active.originalDigest||!done)fail('UNRESOLVED');await retainedTerminal(done,prior,active.key);await unlink(activeFile);
   }
   const checkSet=await owner.reviewTaskChecks(request);
   if(!exact(checkSet,['schemaVersion','kind','projectId','rootIdentity','proposalRevision','proposalDigest','checkContractDigest','policyVersion','policyDigest','taskId','candidateDigest','checks','totalBudgetMs','executionAuthorized'])||checkSet.schemaVersion!==1||checkSet.kind!=='NATIVE_TASK_CHECK_SET'||checkSet.projectId!==binding.projectId||checkSet.rootIdentity!==binding.rootIdentity||checkSet.proposalRevision!==request.expected.hostRevision||checkSet.taskId!==request.taskId||checkSet.proposalDigest!==request.expected.headDigest||![checkSet.checkContractDigest,checkSet.policyDigest,checkSet.candidateDigest].every(digest)||!positive(checkSet.policyVersion)||!Array.isArray(checkSet.checks)||checkSet.checks.length<1||checkSet.checks.length>256||checkSet.checks.some(c=>!exact(c,['checkId','timeoutMs'])||!token(c.checkId)||!positive(c.timeoutMs)||c.timeoutMs>300000)||new Set(checkSet.checks.map(c=>c.checkId)).size!==checkSet.checks.length||checkSet.totalBudgetMs!==180000+checkSet.checks.reduce((sum,c)=>sum+c.timeoutMs+675000,0)||checkSet.executionAuthorized!==false)fail('CHECK_SET_INVALID');
   // Cooperative stage budget only: in-flight custody operations must settle.
   // Transport integration must additionally budget the preceding capture.
   const deadline=Date.now()+checkSet.totalBudgetMs,checkpoint=()=>{if(Date.now()>=deadline)fail('BATCH_TIME_LIMIT');};
   // Claim directory-wide ownership before any request record. An interrupted
   // claim remains unresolved, preventing another request from bypassing it.
   await retain(activeFile,{key,originalDigest});await retain(file('original'),original);await retain(file('checks'),checkSet,65536);
   let credentials,stage='create-worker',index=-1;
   try{
    checkpoint();credentials=await owner.createWorker(`Native task ${request.requestId}`);
    const session={sessionId:credentials.id,actor:credentials.actor,workerId:`native-${key.slice(0,32)}`};await retain(file('session'),session);
    stage='enroll';const heads=await owner.inspectHeads();
    const {enrollment:e}=await owner.enroll(request.expected,request.confirmationId,[{taskId:request.taskId,workerId:session.workerId,credentials}],{expectedRevision:heads.enrollmentRevision,requestId:`enroll-${key}`});
    const enrollmentHead={revision:e.revision,epoch:e.epoch,headDigest:e.recordHash};await retain(file('enrollment'),enrollmentHead);
    for(index=0;index<checkSet.checks.length;index++){
     checkpoint();await owner.heartbeatWorker(credentials);const current=await owner.inspectHeads(),check=checkSet.checks[index];
     const task={taskId:request.taskId,checkId:check.checkId,attemptId:request.attemptId,attemptNumber:request.attemptNumber,workerId:session.workerId,credentials};
     stage='issue';const issued=await owner.issue(request.expected,request.confirmationId,enrollmentHead,task,{requestId:`issue-${key}-${index}`,expectedRevision:current.grantRevision,ttlMs:300000});
     await retain(file(`check-${index}.grant`),{grantId:issued.grant.grantId,originalDigest});
     if(issued.grant.binding.candidateDigest!==checkSet.candidateDigest||issued.grant.binding.checkContractDigest!==checkSet.checkContractDigest)fail('BATCH_CONTEXT_CHANGED');
     checkpoint();await owner.heartbeatWorker(credentials);stage='consume';
     const consumed=await owner.consume(request.expected,request.confirmationId,enrollmentHead,task,{grantId:issued.grant.grantId,requestId:`consume-${key}-${index}`,expectedRevision:current.grantRevision+1});
     checkpoint();await owner.heartbeatWorker(credentials);stage='dispatch';
     const output=await owner.dispatch({expected:request.expected,confirmationId:request.confirmationId,enrollmentHead,input:task,consumptionReceipt:consumed.consumptionReceipt,request:{grantId:issued.grant.grantId,requestId:`intent-${key}-${index}`,expectedRevision:current.grantRevision+2}});
     const observed=output.observation;
     if(!output.dispatchObserved||!output.observationReceipt||!nativeTaskSettlementObserved(observed)||observed.exitCode===null||['timedOut','cancelObserved','outputTruncated','cpuTimeExceeded','cpuObservationFailed','ioFailed'].some(k=>observed[k]))fail('UNRESOLVED');
     stage='retain-check';await retain(file(`check-${index}.result`),{checkId:check.checkId,grantId:issued.grant.grantId,runId:output.intentReceipt.runId,intentDigest:output.intentReceipt.recordDigest,artifactDigest:output.observationReceipt.artifactDigest});
    }
    checkpoint();stage='release-worker';await owner.releaseWorker(credentials);credentials=null;
    stage='retain-result';return await publish(checkSet,session);
   }catch(error){
    await retain(file('failure'),{schemaVersion:1,kind:'NATIVE_TASK_EXECUTION_FAILURE',requestId:request.requestId,originalDigest,stage,checkIndex:index,causes:failureCauses(error),cleanup:'unknown',executionAuthorized:false,recoveryAuthorized:false});throw error;
   }finally{if(credentials)await owner.releaseWorker(credentials);}
  });
 }
 async function perform(input,recoverOnly){
  const request=validateNativeExecutionRequest(input);
  if(wire(request.expected)!==wire(selection.expected)||wire(request.contractHead)!==wire(selection.contractHead))fail('SELECTION_CHANGED');
  const original={schemaVersion:1,binding,request},key=hash(request.requestId),originalDigest=hash(wire(original));
  await prepare();
  return withPlanLock(path.join(directory,'owner'),{actor:'native-execution-owner',timeoutMs:1000},async()=>{
   const originalFile=path.join(directory,`${key}.original.json`),resultFile=path.join(directory,`${key}.result.json`),activeFile=path.join(directory,'active.json');
   const saved=await read(originalFile);
   if(saved&&wire(saved)!==wire(original))fail('CONFLICT');
   const result=await read(resultFile);
   if(result){if(!saved)fail('RESULT_INVALID');return retainedTerminal(result,original,key);}
   if(saved&&recoverOnly&&typeof owner.recoverStoredResult==='function'){
    const grant=await read(path.join(directory,`${key}.grant.json`));
    if(grant===null&&typeof owner.inspectNotStarted==='function'){
     const proof=await owner.inspectNotStarted(request);
     if(!exact(proof,['schemaVersion','kind','requestId','requestDigest','enrollmentDigest','grantRevision','grantHeadDigest','sessionReleased','grantAbsent','launchObserved','executionAuthorized'])||proof.schemaVersion!==1||proof.kind!=='NATIVE_CHECK_NOT_STARTED_PROOF'||proof.requestId!==request.requestId||proof.requestDigest!==hash(wire(request))||!digest(proof.enrollmentDigest)||!Number.isSafeInteger(proof.grantRevision)||proof.grantRevision<0||(proof.grantRevision===0?proof.grantHeadDigest!=='GENESIS':!digest(proof.grantHeadDigest))||proof.sessionReleased!==true||proof.grantAbsent!==true||proof.launchObserved!==false||proof.executionAuthorized!==false)fail('UNRESOLVED');
     await retain(path.join(directory,`${key}.not-started-proof.json`),proof);
     const receipt=terminal({schemaVersion:1,kind:'NATIVE_CHECK_NOT_STARTED_RECEIPT',requestId:request.requestId,originalDigest,proofDigest:hash(wire(proof)),state:'not-started',cleanupComplete:true,executionAuthorized:false},original);
     await retain(resultFile,receipt);return receipt;
    }
    if(!exact(grant,['grantId','originalDigest'])||grant.originalDigest!==originalDigest)fail('UNRESOLVED');
    const recovered=await owner.recoverStoredResult({grantId:grant.grantId,request,key});
    const receipt=terminal({schemaVersion:1,kind:'NATIVE_CHECK_EXECUTION_RECEIPT',requestId:request.requestId,originalDigest,
     grantId:grant.grantId,runId:recovered.runId,intentDigest:recovered.intentDigest,artifactDigest:recovered.artifactDigest,
     state:'result-recorded',cleanupComplete:true,executionAuthorized:false},original);
    await retain(resultFile,receipt);return receipt;
   }
   if(saved||recoverOnly)fail('UNRESOLVED');
   const active=await read(activeFile);
   if(active){
    if(!exact(active,['key','originalDigest'])||!digest(active.key)||!digest(active.originalDigest))fail('STORAGE_INVALID');
    const prior=await read(path.join(directory,`${active.key}.original.json`)),done=await read(path.join(directory,`${active.key}.result.json`));
    if(!prior||hash(wire(prior))!==active.originalDigest||!done)fail('UNRESOLVED');await retainedTerminal(done,prior,active.key);await unlink(activeFile);
   }
   await retain(originalFile,original);await retain(activeFile,{key,originalDigest});
   let credentials,stage='create-worker';
   try{
    credentials=await owner.createWorker(`Native check ${request.requestId}`);
    stage='inspect-heads';
    const heads=await owner.inspectHeads(),workerId=`native-${key.slice(0,32)}`;
    stage='enroll';
    const enrolled=await owner.enroll(request.expected,request.confirmationId,[{taskId:request.taskId,workerId,credentials}],{expectedRevision:heads.enrollmentRevision,requestId:`enroll-${key}`});
    const e=enrolled.enrollment,enrollmentHead={revision:e.revision,epoch:e.epoch,headDigest:e.recordHash};
    const task={taskId:request.taskId,checkId:request.checkId,attemptId:request.attemptId,attemptNumber:request.attemptNumber,workerId,credentials};
    stage='issue';
    const issued=await owner.issue(request.expected,request.confirmationId,enrollmentHead,task,{requestId:`issue-${key}`,expectedRevision:heads.grantRevision,ttlMs:300000});
    await retain(path.join(directory,`${key}.grant.json`),{grantId:issued.grant.grantId,originalDigest});
    stage='consume';
    const consumed=await owner.consume(request.expected,request.confirmationId,enrollmentHead,task,{grantId:issued.grant.grantId,requestId:`consume-${key}`,expectedRevision:heads.grantRevision+1});
    stage='dispatch';
    const output=await owner.dispatch({expected:request.expected,confirmationId:request.confirmationId,enrollmentHead,input:task,consumptionReceipt:consumed.consumptionReceipt,request:{grantId:issued.grant.grantId,requestId:`intent-${key}`,expectedRevision:heads.grantRevision+2}});
    if(!output.dispatchObserved||!nativeTaskSettlementObserved(output.observation)||!output.observationReceipt)fail('UNRESOLVED');
    stage='release-worker';
    await owner.releaseWorker(credentials);credentials=null;
    stage='retain-result';
    const receipt=terminal({schemaVersion:1,kind:'NATIVE_CHECK_EXECUTION_RECEIPT',requestId:request.requestId,originalDigest,grantId:issued.grant.grantId,runId:output.intentReceipt.runId,intentDigest:output.intentReceipt.recordDigest,artifactDigest:output.observationReceipt.artifactDigest,state:'result-recorded',cleanupComplete:true,executionAuthorized:false},original);
    await retain(resultFile,receipt);return receipt;
   }catch(error){
    try{await retain(path.join(directory,`${key}.failure.json`),{schemaVersion:1,kind:'NATIVE_CHECK_EXECUTION_FAILURE',requestId:request.requestId,originalDigest,stage,causes:failureCauses(error),cleanup:'unknown',executionAuthorized:false,recoveryAuthorized:false});}
    catch{throw Object.assign(Error('NATIVE_EXECUTION_DIAGNOSTIC_UNAVAILABLE',{cause:error}),{executionAuthorized:false});}
    throw error;
   }finally{if(credentials)await owner.releaseWorker(credentials);}
  });
 }
 function tracked(input,recoverOnly,batch=false){
  if(closed)throw Error('NATIVE_EXECUTION_REQUEST_CLOSED');
  const active=Promise.resolve().then(()=>{if(closed)throw Error('NATIVE_EXECUTION_REQUEST_CLOSED');return batch?performTask(input,recoverOnly):perform(input,recoverOnly);}).catch(error=>{if(!['NATIVE_EXECUTION_REQUEST_INVALID','NATIVE_EXECUTION_REQUEST_SELECTION_CHANGED','NATIVE_EXECUTION_REQUEST_CONFLICT','NATIVE_EXECUTION_REQUEST_CLOSED'].includes(error?.message))uncertain=true;throw error;});pending.add(active);
  return active.finally(()=>pending.delete(active));
 }
 return Object.freeze({execute:input=>tracked(input,false),recover:input=>tracked(input,true),executeTask:input=>tracked(input,false,true),recoverTask:input=>tracked(input,true,true),async shutdown(){closed=true;await Promise.allSettled([...pending]);return {cleanupComplete:!uncertain,executionAuthorized:false};}});
}

