import path from 'node:path';
import {createHash} from 'node:crypto';
import {validateNativeExecutionRequest} from './nativeTaskExecutionRequests.mjs';
import {mkdir,lstat,realpath} from 'node:fs/promises';
import {createTaskExecutionGrantStore} from './taskExecutionGrantStore.mjs';
import {createTaskNativeObservationStore} from './taskNativeObservationStore.mjs';
import {createTaskNativeResultCustody} from './taskNativeResultCustody.mjs';
import {createTaskNativeOwnerResultReads} from './taskNativeOwnerResultReads.mjs';
import {createTaskProposalReview} from './taskProposalReview.mjs';
import {createTaskNativeDispatch,nativeTaskSettlementObserved} from './taskNativeDispatch.mjs';
import {createNativeTaskExecutionAdapter} from './nativeTaskExecutionAdapter.mjs';
import {createSession,heartbeatSession,releaseSession,inspectReleasedSession} from './sessionRegistry.mjs';
import {createTaskEnrollmentStore} from './taskEnrollmentStore.mjs';

// Supervisor-owned shared path derivation for later admitted execution and
// current owner reads. Construction does not create files or enable execution.
export function createInstalledTaskExecutionCustody({stateDirectory,binding,observeBinding}){
 binding=Object.freeze(structuredClone(binding));
 const grantConfig={journalPath:path.join(stateDirectory,`${binding.projectId}.execution-grants.jsonl`),projectId:binding.projectId,rootIdentity:binding.rootIdentity};
 const grants=createTaskExecutionGrantStore(grantConfig);
 const observationDirectory=path.join(stateDirectory,`${binding.projectId}.native-observations`);
 const observations=createTaskNativeObservationStore({directory:observationDirectory,projectId:binding.projectId,rootIdentity:binding.rootIdentity});
 const results=createTaskNativeOwnerResultReads({grants,observations,binding,observeBinding});
 const custody=createTaskNativeResultCustody({grants,observations});
 function createExecution({proposalConfig,confirmationPath,checkContract,contractCustody,registeredRoot,nativeConfig,actor,secretCustody}){
  if(proposalConfig.projectId!==binding.projectId||proposalConfig.rootIdentity!==binding.rootIdentity||typeof actor!=='string'||!actor.trim())throw Error('INSTALLED_EXECUTION_CONFIG_INVALID');
  const sessionRegistryPath=path.join(stateDirectory,`${binding.projectId}.execution-sessions.json`);
  const enrollmentConfig={journalPath:path.join(stateDirectory,`${binding.projectId}.execution-enrollments.jsonl`),projectId:binding.projectId,rootIdentity:binding.rootIdentity};
  const review=createTaskProposalReview({proposalConfig,confirmationPath,checkContract,contractCustody,preflightConfig:{registeredRoot,sessionRegistryPath,enrollmentConfig,grantConfig}});
  const options={secretCustody:secretCustody?{...secretCustody}:undefined};
  const dispatch=createTaskNativeDispatch({review,executeNative:createNativeTaskExecutionAdapter(nativeConfig),nativeCustody:custody});
  let closed=false,cleanupUncertain=false;const pending=new Set();
  async function current(){if(closed)throw Error('INSTALLED_EXECUTION_CLOSED');const observed=await observeBinding();if(closed)throw Error('INSTALLED_EXECUTION_CLOSED');if(['projectId','rootIdentity','censusDigest'].some(k=>observed?.[k]!==binding[k]))throw Error('INSTALLED_EXECUTION_BINDING_CHANGED');}
  async function prepareResults(){
   async function safe(directory){for(let p=directory;;p=path.dirname(p)){const s=await lstat(p);if(!s.isDirectory()||s.isSymbolicLink()||path.relative(p,await realpath(p)))throw Error('INSTALLED_EXECUTION_STORAGE_UNSAFE');if(path.dirname(p)===p)break;}}
   await safe(stateDirectory);try{await mkdir(observationDirectory);}catch(error){if(error.code!=='EEXIST')throw error;}await safe(observationDirectory);
  }
  // Private owner capabilities only. Worker credentials never become renderer
  // results; transport composition must keep them inside the native host.
  const methods={
   async inspectAttempt(input){
    input=structuredClone(input);await current();
    const fail=code=>{throw Error(`NATIVE_TASK_COVERAGE_${code}`);};
    if(!input||Object.keys(input).sort().join('|')!=='confirmationId|expected|grantId'||typeof input.grantId!=='string')fail('REQUEST_INVALID');
    const enrollmentStore=createTaskEnrollmentStore(enrollmentConfig);
    const snapshot=await review.withApprovedProposal(input.expected,input.confirmationId,async context=>{
     const state=await grants.inspect(),enrollments=await enrollmentStore.inspect();
     const anchor=state.grants.find(entry=>entry.grant.grantId===input.grantId),bound=anchor?.grant.binding,contract=context.checkContract;
     if(!bound||state.projectId!==binding.projectId||state.rootIdentity!==binding.rootIdentity)fail('GRANT_UNAVAILABLE');
     if(bound.proposalRevision!==context.proposal.hostRevision||bound.proposalDigest!==context.proposal.recordHash||bound.checkContractDigest!==contract.contractDigest||bound.policyVersion!==contract.policyVersion||bound.policyDigest!==contract.policyDigest)fail('CONTEXT_MISMATCH');
     const task=contract.tasks.find(task=>task.taskId===bound.taskId);if(!task)fail('CONTEXT_MISMATCH');
     const requiredCheckIds=task.checks.map(check=>check.checkId),required=new Set(requiredCheckIds);
     const entries=state.grants.filter(entry=>entry.grant.binding.taskId===bound.taskId&&entry.grant.binding.attemptId===bound.attemptId);
     if(entries.length>256)fail('LIMIT');
     const grouped=new Map(),failed=[],unresolved=[],checks=[];
     for(const entry of entries){
      const b=entry.grant.binding;
      for(const key of ['proposalRevision','proposalDigest','checkContractDigest','attemptNumber','candidateSchemaVersion','candidateDigest','policyVersion','policyDigest'])if(b[key]!==bound[key])fail('CONFLICT');
      if(!required.has(b.checkId)||grouped.has(b.checkId))fail('CONFLICT');grouped.set(b.checkId,entry);
      // Check each retained mapping independently. Current grant admission also
      // requires a shared worker/session/enrollment for checks in one attempt.
      const enrollment=enrollments.history.find(row=>row.epoch===b.enrollmentEpoch),mapping=enrollment?.snapshot;
      if(!mapping||mapping.hostRevision!==b.proposalRevision||mapping.proposalDigest!==b.proposalDigest||mapping.checkContractDigest!==b.checkContractDigest||mapping.policyVersion!==b.policyVersion||mapping.policyDigest!==b.policyDigest||!mapping.assignments.some(a=>a.taskId===b.taskId&&a.workerId===b.workerId&&a.sessionId===b.sessionId))fail('ENROLLMENT_MISMATCH');
     }
     for(const checkId of requiredCheckIds){
      const entry=grouped.get(checkId);if(!entry)continue;
      let result=null;
      if(entry.state==='result-recorded'&&entry.intentReceipt&&entry.observationLink){
       try{result=await results.readOwner({grantId:entry.grant.grantId});}catch{ /* retain an explicit unresolved check */ }
      }
      const linked=result?.journalLinked===true&&result.runId===entry.intentReceipt?.runId&&result.intentDigest===entry.intentReceipt?.recordDigest&&result.artifactDigest===entry.observationLink?.artifactDigest;
      const settled=linked&&nativeTaskSettlementObserved(result?.process)&&result.process.exitCode!==null;
      if(!settled)unresolved.push(checkId);
      if(linked&&result.failureReasons.length)failed.push(checkId);
      checks.push({checkId,grantId:entry.grant.grantId,runId:entry.intentReceipt?.runId??null,artifactDigest:linked?result.artifactDigest:null,state:!settled?'unresolved':result.process.exitCode===0&&result.failureReasons.length===0?'pass-observed':'failure-observed'});
     }
     const missing=requiredCheckIds.filter(id=>!grouped.has(id));
     return {approvalDigest:createHash('sha256').update(JSON.stringify(context.confirmation)).digest('hex'),grantHead:state.headDigest,grantRevision:state.revision,enrollmentHead:enrollments.headDigest,enrollmentRevision:enrollments.revision,
      value:{schemaVersion:1,kind:'NATIVE_TASK_REQUIRED_CHECK_COVERAGE',projectId:binding.projectId,rootIdentity:binding.rootIdentity,proposalRevision:bound.proposalRevision,proposalDigest:bound.proposalDigest,checkContractDigest:contract.contractDigest,taskId:bound.taskId,attemptId:bound.attemptId,attemptNumber:bound.attemptNumber,candidateDigest:bound.candidateDigest,requiredCheckIds,checks,missing,failed,unresolved,allRequiredChecksPassed:missing.length===0&&failed.length===0&&unresolved.length===0,authorityVerified:false,promotionAuthority:false,executionAuthorized:false}};
    });
    // Reacquire all current review gates after asynchronous artifact reads.
    // This is observed historical coverage, never a candidate/producer lease.
    return review.withApprovedProposal(input.expected,input.confirmationId,async context=>{
     await current();const state=await grants.inspect(),enrollments=await enrollmentStore.inspect();await current();
     if(createHash('sha256').update(JSON.stringify(context.confirmation)).digest('hex')!==snapshot.approvalDigest||state.headDigest!==snapshot.grantHead||state.revision!==snapshot.grantRevision||enrollments.headDigest!==snapshot.enrollmentHead||enrollments.revision!==snapshot.enrollmentRevision)fail('STALE');
     const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};return freeze(snapshot.value);
    });
   },
   async inspectHeads(){await current();const enrollment=await createTaskEnrollmentStore(enrollmentConfig).inspect(),grant=await grants.inspect();return {enrollmentRevision:enrollment.revision,grantRevision:grant.revision};},
   async createWorker(claim){await current();return createSession(sessionRegistryPath,{actor,claim},options);},
   async heartbeatWorker(credentials){await current();return heartbeatSession(sessionRegistryPath,credentials,options);},
   async releaseWorker(credentials){return releaseSession(sessionRegistryPath,credentials,options);},
   async enroll(expected,confirmationId,assignments,request){await current();return review.enrollReviewedWorkers(expected,confirmationId,assignments,request,options);},
   async issue(expected,confirmationId,enrollmentHead,input,request,capture={}){await current();return review.issueAssignedGrant(expected,confirmationId,enrollmentHead,input,request,options,capture);},
   async consume(expected,confirmationId,enrollmentHead,input,request,capture={}){await current();return review.consumeAssignedGrant(expected,confirmationId,enrollmentHead,input,request,options,capture);},
   async dispatch(input,capture={}){await current();await prepareResults();return dispatch.dispatch(input,options,capture);},
   inspectOriginal:input=>review.inspectOwnGrantReceipt(input,options),
   // Read-only owner proof, not a retry or a receipt claiming task execution.
   // A released exact session cannot subsequently authenticate grant admission.
   // Keep proposal/approval/enrollment stable while checking the grant journal.
   async inspectNotStarted(input){
    const request=validateNativeExecutionRequest(input);await current();
    const unavailable=()=>{throw Error('NATIVE_EXECUTION_REQUEST_UNRESOLVED');};
    const key=createHash('sha256').update(request.requestId).digest('hex'),workerId=`native-${key.slice(0,32)}`;
    return review.withApprovedProposal(request.expected,request.confirmationId,async context=>{
     const store=createTaskEnrollmentStore(enrollmentConfig),state=await store.inspect(),head=state.head;
     if(!head||head.requestId!==`enroll-${key}`)unavailable();
     return store.withCurrentEnrollment({revision:head.revision,epoch:head.epoch,headDigest:head.recordHash},async retained=>{
      const s=retained.snapshot,c=context.checkContract,a=s.assignments[0];
      if(s.hostRevision!==request.expected.hostRevision||s.proposalDigest!==request.expected.headDigest
       ||s.checkContractDigest!==c.contractDigest||s.policyVersion!==c.policyVersion||s.policyDigest!==c.policyDigest
       ||s.assignments.length!==1||a?.taskId!==request.taskId||a.workerId!==workerId||a.actor!==actor
       ||!c.tasks.some(t=>t.taskId===request.taskId&&t.checks.some(check=>check.checkId===request.checkId)))unavailable();
      if(!await inspectReleasedSession(sessionRegistryPath,{id:a.sessionId,actor}))unavailable();
      const journal=await grants.inspect();
      if(journal.history.some(item=>item.request.requestId===`issue-${key}`||item.grant.binding.workerId===workerId||item.grant.binding.sessionId===a.sessionId))unavailable();
      await current();
      const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
      return Object.freeze({schemaVersion:1,kind:'NATIVE_CHECK_NOT_STARTED_PROOF',requestId:request.requestId,
       requestDigest:createHash('sha256').update(JSON.stringify(canonical(request))).digest('hex'),
       enrollmentDigest:retained.recordHash,grantRevision:journal.revision,grantHeadDigest:journal.headDigest,
       sessionReleased:true,grantAbsent:true,launchObserved:false,executionAuthorized:false});
     });
    });
   },
   async recoverStoredResult({grantId,request,key}){
    await current();
    const unavailable=()=>{throw Error('NATIVE_EXECUTION_REQUEST_UNRESOLVED');};
    const state=await grants.inspect(),entry=state.grants.find(item=>item.grant.grantId===grantId);
    const issued=state.history.find(item=>item.event==='issued'&&item.grant.grantId===grantId);
    const b=entry?.grant.binding;
    if(!b||issued?.request.requestId!==`issue-${key}`||entry.state!=='result-recorded'
     ||b.proposalRevision!==request.expected.hostRevision||b.proposalDigest!==request.expected.headDigest
     ||b.workerId!==`native-${key.slice(0,32)}`||['taskId','checkId','attemptId','attemptNumber'].some(k=>b[k]!==request[k]))unavailable();
    const result=await results.readOwner({grantId});
    if(!result.journalLinked||!nativeTaskSettlementObserved(result.process))unavailable();
    if(!await inspectReleasedSession(sessionRegistryPath,{id:b.sessionId,actor}))unavailable();
    await current();
    return {runId:result.runId,intentDigest:result.intentDigest,artifactDigest:result.artifactDigest};
   },
  };
  return Object.freeze({...Object.fromEntries(Object.entries(methods).map(([name,operation])=>[name,(...args)=>{
   if(closed)throw Error('INSTALLED_EXECUTION_CLOSED');
   const active=Promise.resolve().then(()=>{if(closed)throw Error('INSTALLED_EXECUTION_CLOSED');return operation(...args);}).then(value=>{
    if(name==='dispatch'&&value?.observation&&!(nativeTaskSettlementObserved(value.observation)))cleanupUncertain=true;
    return value;
   },error=>{if(error?.cleanupComplete===false||error?.message==='NATIVE_TASK_DISPATCH_UNRESOLVED')cleanupUncertain=true;throw error;});pending.add(active);
   return active.finally(()=>pending.delete(active));
  }])),async shutdown(){closed=true;const outcomes=await Promise.allSettled([...pending]);return {cleanupComplete:!cleanupUncertain&&outcomes.every(r=>r.status==='fulfilled'&&(!r.value?.observation||(nativeTaskSettlementObserved(r.value.observation)))),executionAuthorized:false};},executionAuthorized:false});
 }
 return Object.freeze({grants,observations,results,custody,createExecution,executionAuthorized:false});
}
