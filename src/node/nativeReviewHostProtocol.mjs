// Private host transport prerequisite, not a production CLI or authenticated IPC.
// The flow (including native presenter, paths and actor) is host-installed only.
import {parseNativeTaskObservation} from './taskNativeDispatch.mjs';
import {validateNativeExecutionRequest} from './nativeTaskExecutionRequests.mjs';
import {validateNativeTaskIndexRequest,validateNativeTaskResultIndex} from '../shared/nativeTaskResultIndex.js';
import {validateNativeTaskOutcomePage} from '../shared/nativeTaskOutcomePage.js';
const LINE_BYTES=16384,RESPONSE_BYTES=65536,MAX_REQUESTS=128;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const token=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const changeRequest=value=>exact(value,['requestId','expectedRevision','expectedHeadDigest'])&&token(value.requestId)&&Number.isSafeInteger(value.expectedRevision)&&value.expectedRevision>=0&&(value.expectedRevision===0?value.expectedHeadDigest==='GENESIS':digest(value.expectedHeadDigest));
const taskChange=value=>exact(value,['binding','request','task','updatedAt'])&&exact(value.binding,['projectId','rootIdentity','censusDigest'])&&token(value.binding.projectId)&&digest(value.binding.rootIdentity)&&digest(value.binding.censusDigest)&&changeRequest(value.request)&&value.task&&typeof value.task==='object'&&!Array.isArray(value.task)&&typeof value.updatedAt==='string'&&Number.isFinite(Date.parse(value.updatedAt))&&new Date(value.updatedAt).toISOString()===value.updatedAt;
const expected=value=>exact(value,['hostRevision','headDigest'])&&Number.isSafeInteger(value.hostRevision)&&value.hostRevision>0&&digest(value.headDigest);
const errors=new Set(['NATIVE_REVIEW_BUSY','NATIVE_REVIEW_PRESENTATION_UNRESOLVED','NATIVE_REVIEW_CLOSURE_UNAVAILABLE','NATIVE_REVIEW_CLOSURE_UNVERIFIED','NATIVE_REVIEW_RESPONSE_INVALID','NATIVE_REVIEW_BEGIN_NOT_FRESH','CHECKS_NOT_CONFIGURED','DRAFT_REGISTRATION_UNAVAILABLE','DRAFT_REGISTRATION_FOREIGN','DRAFT_SUBMISSION_BINDING_MISMATCH','TASK_LEDGER_STALE_HEAD','TASK_LEDGER_REQUEST_CONFLICT']);
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const response=(requestId,ok,result)=>JSON.stringify({version:1,requestId,ok,...(ok?{result}:{error:{code:result}}),...(result==='NATIVE_REVIEW_CLEANUP_UNCERTAIN'?{cleanupComplete:false}:{}),executionAuthorized:false,nativeGestureVerified:false})+'\n';
function uniqueKeys(text) {
  // JSON.parse otherwise silently accepts repeated (including escaped) keys.
  // Inspect already-valid JSON tokens without evaluating any request content.
  const stack=[];
  for(const [token] of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]/g)) {
    if(token==='{'||token==='['){stack.push({object:token==='{',keys:new Set(),key:true});if(stack.length>16)return false;}
    else if(token==='}'||token===']')stack.pop();
    else if(token===','){if(stack.at(-1)?.object)stack.at(-1).key=true;}
    else if(token.startsWith('"')&&stack.at(-1)?.object&&stack.at(-1).key){const frame=stack.at(-1),key=JSON.parse(token);if(frame.keys.has(key))return false;frame.keys.add(key);frame.key=false;}
  }
  return true;
}
function confirmation(value) {
  if(!value||!token(value.id)||!['pending','approved','rejected','cancelled'].includes(value.status))throw Error('PROTOCOL_RESULT_INVALID');
  // Never serialize arbitrary host objects, watcher handles, exception details,
  // user-entered rationale, custody tokens or extra adapter properties.
  return {id:value.id,status:value.status};
}
function recovery(value) {
  const item=value?.unresolvedPresentation;
  if(item===null)return {unresolvedPresentation:null};
  if(!item||!token(item.requestId)||!Number.isSafeInteger(item.proposalRevision)||item.proposalRevision<1||!digest(item.proposalDigest)||!digest(item.checkContractDigest))throw Error('PROTOCOL_RESULT_INVALID');
  return {unresolvedPresentation:{requestId:item.requestId,proposalRevision:item.proposalRevision,proposalDigest:item.proposalDigest,checkContractDigest:item.checkContractDigest}};
}
function proposalResult(value,submitted=false){
  const head=value?.observedHead;
  if(value?.schemaVersion!==1||!exact(head,['hostRevision','headDigest'])||!Number.isSafeInteger(head.hostRevision)||head.hostRevision<0||(head.hostRevision===0?head.headDigest!=='GENESIS':!digest(head.headDigest))||typeof value.registrationCurrent!=='boolean'||value.registrationLeaseHeld!==false||value.executionAuthorized!==false||value.approvalState!=='unapproved-proposal')throw Error('PROTOCOL_RESULT_INVALID');
  const result={schemaVersion:1,observedHead:head,registrationCurrent:value.registrationCurrent,registrationLeaseHeld:false,approvalState:'unapproved-proposal',executionAuthorized:false};
  if(submitted){
    const item=value.submitted;
    if(!exact(item,['hostRevision','headDigest','ledgerDigest'])||!expected({hostRevision:item.hostRevision,headDigest:item.headDigest})||!digest(item.ledgerDigest)||value.submissionPersisted!==true||typeof value.idempotent!=='boolean'||typeof value.submittedMatchesObservedHead!=='boolean'||value.submittedMatchesObservedHead!==(head.hostRevision===item.hostRevision&&head.headDigest===item.headDigest))throw Error('PROTOCOL_RESULT_INVALID');
    Object.assign(result,{submitted:item,submissionPersisted:true,idempotent:value.idempotent,submittedMatchesObservedHead:value.submittedMatchesObservedHead});
  }
  return result;
}
function preparationResult(value,request) {
  const keys=['schemaVersion','profileId','originalRequestId','contractDigest','policyDigest','contractHead','idempotent','matchesObservedContractHead','preparationPersisted','observationEvidencePersisted','reviewEnabled','toolchainVerified','candidateVerified','executionAuthorized','registrationLeaseHeld'];
  if(!exact(value,keys)||value.schemaVersion!==1||!['perfect-planner-checks-v1','npm-project-checks-v1'].includes(value.profileId)||value.originalRequestId!==request.requestId||!digest(value.contractDigest)||!digest(value.policyDigest)||!exact(value.contractHead,['revision','headDigest'])||!Number.isSafeInteger(value.contractHead.revision)||value.contractHead.revision<1||!digest(value.contractHead.headDigest)||typeof value.idempotent!=='boolean'||typeof value.matchesObservedContractHead!=='boolean'||value.preparationPersisted!==true||value.observationEvidencePersisted!==true||['reviewEnabled','toolchainVerified','candidateVerified','executionAuthorized','registrationLeaseHeld'].some(key=>value[key]!==false))throw Error('PROTOCOL_RESULT_INVALID');
  return Object.fromEntries(keys.map(key=>[key,value[key]]));
}
function checkInspectionResult(value,payload){
  const binding=v=>exact(v,['projectId','rootIdentity','censusDigest'])&&token(v.projectId)&&digest(v.rootIdentity)&&digest(v.censusDigest);
  const contractHead=(v,genesis=false)=>exact(v,['revision','headDigest'])&&Number.isSafeInteger(v.revision)&&(genesis?v.revision>=0:v.revision>0)&&(v.revision===0?v.headDigest==='GENESIS':digest(v.headDigest));
  if(!exact(value,['schemaVersion','binding','contractHead','requestedOriginalId','original','registrationLeaseHeld','executionAuthorized'])||value.schemaVersion!==1||!binding(value.binding)||!contractHead(value.contractHead,true)||value.requestedOriginalId!==payload.requestId||value.registrationLeaseHeld!==false||value.executionAuthorized!==false)throw Error('PROTOCOL_RESULT_INVALID');
  const o=value.original;
  if(o!==null&&(!exact(o,['binding','request','contractHead','contractDigest','policyDigest','proposalHead','matchesObservedContractHead','observationEvidenceVerified'])||!binding(o.binding)||o.binding.projectId!==value.binding.projectId||o.binding.rootIdentity!==value.binding.rootIdentity||!changeRequest(o.request)||o.request.requestId!==payload.requestId||!contractHead(o.contractHead)||o.contractHead.revision!==o.request.expectedRevision+1||o.contractHead.revision>value.contractHead.revision||!digest(o.contractDigest)||!digest(o.policyDigest)||!expected(o.proposalHead)||o.matchesObservedContractHead!==(o.contractHead.revision===value.contractHead.revision&&o.contractHead.headDigest===value.contractHead.headDigest)||o.observationEvidenceVerified!==false))throw Error('PROTOCOL_RESULT_INVALID');
  return value;
}
function snapshotResult(value,payload){
  const keys=['schemaVersion','binding','observedHead','ledgerDigest','snapshotDigest','encoding','offset','totalLength','nextOffset','chunk','approvalState','executionAuthorized'];
  if(!exact(value,keys)||value.schemaVersion!==1||!exact(value.binding,['projectId','rootIdentity','censusDigest'])||!token(value.binding.projectId)||!digest(value.binding.rootIdentity)||!digest(value.binding.censusDigest)||!exact(value.observedHead,['hostRevision','headDigest'])||!Number.isSafeInteger(value.observedHead.hostRevision)||value.observedHead.hostRevision<0||(value.observedHead.hostRevision===0?value.observedHead.headDigest!=='GENESIS':!digest(value.observedHead.headDigest))||value.executionAuthorized!==false||value.approvalState!=='unapproved-proposal')throw Error('PROTOCOL_RESULT_INVALID');
  if(value.encoding!=='json; offsets in UTF-16 code units; concatenate all chunks before parsing'||!digest(value.snapshotDigest)||(value.ledgerDigest!==null&&!digest(value.ledgerDigest))||value.offset!==payload.offset||!Number.isSafeInteger(value.totalLength)||value.totalLength<1||value.totalLength>1024*1024||typeof value.chunk!=='string'||value.chunk.length<1||value.chunk.length>1024*1024||value.offset+value.chunk.length>value.totalLength)throw Error('PROTOCOL_RESULT_INVALID');
  const end=value.offset+value.chunk.length;
  if(value.nextOffset!==(end<value.totalLength?end:null)||(payload.expectedHeadDigest!==null&&value.observedHead.headDigest!==payload.expectedHeadDigest))throw Error('PROTOCOL_RESULT_INVALID');
  return value;
}
function proposalReadResult(value,command){
  const common=['schemaVersion','binding','observedHead','approvalState','executionAuthorized'];
  const fields=command==='read-proposal-brief'?['ledgerDigest','hasProposal','totalTasks','offset','nextOffset','tasks','projection']:command==='read-proposal-task'?['ledgerDigest','taskId','taskDigest','encoding','offset','totalLength','nextOffset','chunk']:['requestId','outcome','submitted','submittedMatchesObservedHead','registrationCurrent','registrationLeaseHeld'];
  if(!exact(value,[...common,...fields])||value.schemaVersion!==1||value.executionAuthorized!==false||value.approvalState!=='unapproved-proposal'||!exact(value.binding,['projectId','rootIdentity','censusDigest'])||typeof value.binding.projectId!=='string'||!digest(value.binding.rootIdentity)||!digest(value.binding.censusDigest)||!exact(value.observedHead,['hostRevision','headDigest'])||!Number.isSafeInteger(value.observedHead.hostRevision)||value.observedHead.hostRevision<0||(value.observedHead.hostRevision===0?value.observedHead.headDigest!=='GENESIS':!digest(value.observedHead.headDigest)))throw Error('PROTOCOL_RESULT_INVALID');
  if(command==='read-proposal-brief'&&(!Array.isArray(value.tasks)||value.tasks.length>10||value.tasks.some(t=>!exact(t,['id','title','owner','dependsOn','claimCount','archived'])||!['id','title','owner'].every(k=>typeof t[k]==='string')||!Array.isArray(t.dependsOn)||t.dependsOn.some(d=>typeof d!=='string')||!Number.isSafeInteger(t.claimCount)||typeof t.archived!=='boolean')))throw Error('PROTOCOL_RESULT_INVALID');
  if(command==='read-proposal-task'&&(typeof value.chunk!=='string'||value.chunk.length>2000||!digest(value.taskDigest)))throw Error('PROTOCOL_RESULT_INVALID');
  if(command==='read-proposal-request'&&(value.registrationCurrent!==true||value.registrationLeaseHeld!==false||(value.submitted!==null&&(!exact(value.submitted,['hostRevision','headDigest','ledgerDigest'])||!expected({hostRevision:value.submitted.hostRevision,headDigest:value.submitted.headDigest})||!digest(value.submitted.ledgerDigest)))))throw Error('PROTOCOL_RESULT_INVALID');
  if(Buffer.byteLength(JSON.stringify(value))>20000)throw Error('PROTOCOL_RESULT_INVALID');
  return value;
}
function taskResult(value,payload){
  if(!value||value.schemaVersion!==1||value.kind!=='NATIVE_TASK_RESULT_SUMMARY'||value.grantId!==payload.grantId||!token(value.projectId)||!digest(value.rootIdentity)||!token(value.runId)||!/^T\d{4,6}$/.test(value.taskId)||!['checkId','attemptId','workerId'].every(k=>token(value[k]))||!Number.isSafeInteger(value.attemptNumber)||value.attemptNumber<1||!digest(value.artifactDigest)||!digest(value.intentDigest)||value.cleanup!=='unknown'||value.authorityVerified!==false||value.executionAuthorized!==false||typeof value.journalLinked!=='boolean'||(value.journalLinked?!digest(value.observationLinkDigest):value.observationLinkDigest!==null))throw Error('PROTOCOL_RESULT_INVALID');
  const process=parseNativeTaskObservation({...value.process,stdout:'',stderr:''},{runId:value.runId,outputLimits:{stdoutBytes:1,stderrBytes:1,combinedBytes:2}});
  const reasons=[];if(process.exitCode!==null&&process.exitCode!==0)reasons.push('nonzero-exit');
  for(const [key,reason]of [['timedOut','time-limit'],['cancelObserved','cancellation-observed'],['outputTruncated','output-limit'],['cpuTimeExceeded','cpu-limit'],['cpuObservationFailed','cpu-observation-failed'],['ioFailed','output-read-failed']])if(process[key])reasons.push(reason);
  if(JSON.stringify(value.failureReasons)!==JSON.stringify(reasons)||value.state!==(reasons.length?'failure-observed':'result-unverified'))throw Error('PROTOCOL_RESULT_INVALID');
  return {schemaVersion:1,projectId:value.projectId,rootIdentity:value.rootIdentity,grantId:value.grantId,runId:value.runId,taskId:value.taskId,checkId:value.checkId,attemptId:value.attemptId,attemptNumber:value.attemptNumber,workerId:value.workerId,state:value.state,exitCode:process.exitCode,failureReasons:reasons,artifactDigest:value.artifactDigest,intentDigest:value.intentDigest,journalLinked:value.journalLinked,observationLinkDigest:value.observationLinkDigest,cleanup:'unknown',authorityVerified:false,executionAuthorized:false};
}
function executionResult(value,payload){
  if(value?.kind==='NATIVE_CHECK_NOT_STARTED_RECEIPT'){
   const keys=['schemaVersion','kind','requestId','originalDigest','proofDigest','state','cleanupComplete','executionAuthorized'];
   if(!exact(value,keys)||value.schemaVersion!==1||value.requestId!==payload.requestId||!digest(value.originalDigest)||!digest(value.proofDigest)||value.state!=='not-started'||value.cleanupComplete!==true||value.executionAuthorized!==false)throw Error('PROTOCOL_RESULT_INVALID');
   return Object.fromEntries(keys.map(k=>[k,value[k]]));
  }
  const keys=['schemaVersion','kind','requestId','originalDigest','grantId','runId','intentDigest','artifactDigest','state','cleanupComplete','executionAuthorized'];
  const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
  if(!exact(value,keys)||value.schemaVersion!==1||value.kind!=='NATIVE_CHECK_EXECUTION_RECEIPT'||value.requestId!==payload.requestId||!['originalDigest','intentDigest','artifactDigest'].every(k=>digest(value[k]))||!uuid(value.grantId)||!uuid(value.runId)||value.state!=='result-recorded'||value.cleanupComplete!==true||value.executionAuthorized!==false)throw Error('PROTOCOL_RESULT_INVALID');
  return Object.fromEntries(keys.map(k=>[k,value[k]]));
}
export function createNativeReviewHostProtocol({flow,submission,checkPreparation,proposalReads,taskResults,executionRequests}) {
  const methods=['inspectRecoveryState','reviewProposal','recoverFailedPresentation','recoverInterruptedRequest','cancelActiveReview'];
  if(!flow||methods.some(key=>typeof flow[key]!=='function'))throw Error('NATIVE_REVIEW_PROTOCOL_CONFIG_INVALID');
  // Capture dependencies so later mutation of a configuration object cannot
  // substitute the host implementation during a request.
  const host=Object.fromEntries(methods.map(key=>[key,flow[key].bind(flow)]));
  if(flow.recoverOriginalRequest!==undefined&&typeof flow.recoverOriginalRequest!=='function')throw Error('NATIVE_REVIEW_PROTOCOL_CONFIG_INVALID');
  const recoverOriginal=flow.recoverOriginalRequest?.bind(flow);
  if(executionRequests!==undefined&&(!executionRequests||['execute','recover'].some(k=>typeof executionRequests[k]!=='function')))throw Error('NATIVE_REVIEW_PROTOCOL_CONFIG_INVALID');
  const execution=executionRequests?Object.fromEntries(['execute','recover'].map(k=>[k,executionRequests[k].bind(executionRequests)])):null;
  if(submission!==undefined&&(!submission||typeof submission.inspectHead!=='function'||typeof submission.submitDraft!=='function'))throw Error('NATIVE_REVIEW_PROTOCOL_CONFIG_INVALID');
  const drafts=submission?{inspectHead:submission.inspectHead.bind(submission),submitDraft:submission.submitDraft.bind(submission)}:null;
  if(submission?.proposeTaskChange!==undefined&&typeof submission.proposeTaskChange!=='function')throw Error('NATIVE_REVIEW_PROTOCOL_CONFIG_INVALID');
  // This is an owner-only transport capability, not public agent permission.
  // The installed submission validates task fields and owns the existing CAS journal.
  const changeTask=submission?.proposeTaskChange?.bind(submission);
  if(checkPreparation!==undefined&&(!checkPreparation||typeof checkPreparation.prepareChecks!=='function'))throw Error('NATIVE_REVIEW_PROTOCOL_CONFIG_INVALID');
  const prepare=checkPreparation?.prepareChecks.bind(checkPreparation);
  if(checkPreparation?.inspectChecks!==undefined&&typeof checkPreparation.inspectChecks!=='function')throw Error('NATIVE_REVIEW_PROTOCOL_CONFIG_INVALID');
  const inspectChecks=checkPreparation?.inspectChecks?.bind(checkPreparation);
  if(proposalReads!==undefined&&typeof proposalReads?.read!=='function')throw Error('NATIVE_REVIEW_PROTOCOL_CONFIG_INVALID');
  const readProposal=proposalReads?.read.bind(proposalReads);
  if(taskResults!==undefined&&typeof taskResults?.readOwner!=='function')throw Error('NATIVE_REVIEW_PROTOCOL_CONFIG_INVALID');
  const readResult=taskResults?.readOwner.bind(taskResults);
  if(taskResults?.listOwner!==undefined&&typeof taskResults.listOwner!=='function')throw Error('NATIVE_REVIEW_PROTOCOL_CONFIG_INVALID');
  const listResult=taskResults?.listOwner?.bind(taskResults);
  if(taskResults?.readPageOwner!==undefined&&typeof taskResults.readPageOwner!=='function')throw Error('NATIVE_REVIEW_PROTOCOL_CONFIG_INVALID');
  const readPage=taskResults?.readPageOwner?.bind(taskResults);
  const lineBytes=drafts?1024*1024+4096:LINE_BYTES;
  const seen=new Set();let busy=false,cancelBusy=false,activeReview=null;
  return Object.freeze({
    limits:Object.freeze({lineBytes,responseBytes:RESPONSE_BYTES,snapshotResponseBytes:3*1024*1024,requests:MAX_REQUESTS}),
    async dispatchLine(line) {
      let requestId=null,request;
      if(typeof line!=='string'||Buffer.byteLength(line)>lineBytes)return response(null,false,'PROTOCOL_INPUT_LIMIT');
      const text=line.replace(/\r?\n$/,'');
      if(/[\r\n]/.test(text))return response(null,false,'PROTOCOL_INVALID_REQUEST');
      try{request=JSON.parse(text);if(!uniqueKeys(text))return response(null,false,'PROTOCOL_INVALID_REQUEST');}catch{return response(null,false,'PROTOCOL_INVALID_REQUEST');}
      if(token(request?.requestId))requestId=request.requestId;
      if(!exact(request,['version','requestId','command','payload'])||request.version!==1||!token(requestId))return response(requestId,false,'PROTOCOL_INVALID_REQUEST');
      const {command,payload}=request;
      const executing=execution&&['execute-check','recover-check-execution'].includes(command);
      let executionValid=false;if(executing){try{validateNativeExecutionRequest(payload);executionValid=true;}catch{}}
      const cancelling=command==='cancel-review';
      const submitting=command==='submit-draft'&&drafts;
      const changing=command==='propose-task-change'&&changeTask;
      const preparing=command==='prepare-checks'&&prepare;
      const inspectingChecks=command==='inspect-checks'&&inspectChecks;
      const resultRead=command==='inspect-task-result'&&readResult;
      const resultIndex=command==='list-task-results'&&listResult;
      const resultPage=command==='read-task-result-page'&&readPage;
      let indexValid=false;if(resultIndex||resultPage){try{validateNativeTaskIndexRequest(payload);indexValid=true;}catch{}}
      const resultValid=resultRead&&exact(payload,['grantId'])&&typeof payload.grantId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(payload.grantId);
      const snapshot=readProposal&&command==='read-proposal-snapshot';
      const snapshotValid=snapshot&&exact(payload,['offset','expectedHeadDigest'])&&Number.isSafeInteger(payload.offset)&&payload.offset>=0&&payload.offset<1024*1024&&(digest(payload.expectedHeadDigest)||payload.expectedHeadDigest==='GENESIS'||(payload.offset===0&&payload.expectedHeadDigest===null));
      const reading=readProposal&&['read-proposal-brief','read-proposal-task','read-proposal-request'].includes(command);
      const readValid=reading&&(command==='read-proposal-request'?exact(payload,['requestId'])&&token(payload.requestId):command==='read-proposal-task'?exact(payload,['taskId','offset','expectedHeadDigest'])&&typeof payload.taskId==='string'&&/^T\d{4,6}$/.test(payload.taskId)&&Number.isSafeInteger(payload.offset)&&payload.offset>=0&&digest(payload.expectedHeadDigest):exact(payload,['offset','expectedHeadDigest'])&&Number.isSafeInteger(payload.offset)&&payload.offset>=0&&payload.offset<=500&&(digest(payload.expectedHeadDigest)||payload.expectedHeadDigest==='GENESIS'||(payload.offset===0&&payload.expectedHeadDigest===null)));
      const originalReview=command==='review-original-request',originalRecovery=command==='recover-original-request'&&recoverOriginal;
      const originalValid=(originalReview||originalRecovery)&&exact(payload,['expected','originalDigest'])&&expected(payload.expected)&&digest(payload.originalDigest);
      const valid=preparing?exact(payload,['expected','request'])&&expected(payload.expected)&&exact(payload.request,['requestId','expectedRevision','expectedHeadDigest'])&&token(payload.request.requestId)&&Number.isSafeInteger(payload.request.expectedRevision)&&payload.request.expectedRevision>=0&&(payload.request.expectedRevision===0?payload.request.expectedHeadDigest==='GENESIS':digest(payload.request.expectedHeadDigest)):submitting?exact(payload,['ledger','request'])&&exact(payload.request,['requestId','expectedRevision','expectedHeadDigest'])&&token(payload.request.requestId)&&Number.isSafeInteger(payload.request.expectedRevision)&&payload.request.expectedRevision>=0&&(payload.request.expectedHeadDigest==='GENESIS'||digest(payload.request.expectedHeadDigest)):command==='inspect-proposal'&&drafts?exact(payload,[]):cancelling?exact(payload,['reviewRequestId'])&&token(payload.reviewRequestId):(command==='inspect-recovery'||command==='recover-presentation')?exact(payload,[]):command==='review-proposal'?exact(payload,['expected'])&&expected(payload.expected):command==='recover-interrupted-request'?exact(payload,['expected','confirmationId'])&&expected(payload.expected)&&token(payload.confirmationId):false;
      const inspectValid=inspectingChecks&&exact(payload,['requestId'])&&(payload.requestId===null||token(payload.requestId));
      if(!executionValid&&!originalValid&&!valid&&!readValid&&!snapshotValid&&!inspectValid&&!resultValid&&!indexValid&&!(changing&&taskChange(payload)))return response(requestId,false,'PROTOCOL_INVALID_REQUEST');
      if(cancelBusy||(!cancelling&&busy))return response(requestId,false,'NATIVE_REVIEW_BUSY');
      if(cancelling&&(!activeReview||payload.reviewRequestId!==activeReview))return response(requestId,false,'PROTOCOL_CANCEL_TARGET_MISMATCH');
      if(seen.has(requestId))return response(requestId,false,'PROTOCOL_DUPLICATE_REQUEST');
      // Reserve one request slot for cancellation before accepting a review.
      if(seen.size>=MAX_REQUESTS-(command==='review-proposal'||originalReview?1:0))return response(requestId,false,'PROTOCOL_SESSION_LIMIT');
      seen.add(requestId);if(cancelling)cancelBusy=true;else{busy=true;if(command==='review-proposal'||originalReview)activeReview=requestId;}
      try {
        freeze(payload);let result;
        if(executing)result=executionResult(await execution[command==='execute-check'?'execute':'recover'](payload),payload);
        else if(resultPage)result=validateNativeTaskOutcomePage(await readPage(payload),payload,undefined,(v,grantId)=>taskResult(v,{grantId}));
        else if(resultIndex)result=validateNativeTaskResultIndex(await listResult(payload),payload);
        else if(resultRead)result=taskResult(await readResult(payload),payload);
        else if(snapshot)result=snapshotResult(await readProposal(command,payload),payload);
        else if(reading){
          result=proposalReadResult(await readProposal(command,payload),command);
        }
        else if(changing)result=proposalResult(await changeTask(payload),true);
        else if(preparing)result=preparationResult(await prepare(payload),payload.request);
        else if(inspectingChecks)result=checkInspectionResult(await inspectChecks(payload),payload);
        else if(submitting)result=proposalResult(await drafts.submitDraft(payload),true);
        else if(command==='inspect-proposal')result=proposalResult(await drafts.inspectHead());
        else if(cancelling){
          const value=await host.cancelActiveReview();
          if(typeof value?.cancelRequested!=='boolean'||typeof value.presenterSettled!=='boolean')throw Error('PROTOCOL_RESULT_INVALID');
          result={cancelRequested:value.cancelRequested,presenterSettled:value.presenterSettled,dialogClosed:null,...(value.confirmation?{confirmation:confirmation(value.confirmation)}:{})};
        }
        else if(command==='inspect-recovery')result=recovery(await host.inspectRecoveryState());
        else if(originalReview)result={confirmation:confirmation((await host.reviewProposal(payload.expected,payload.originalDigest))?.confirmation)};
        else if(originalRecovery)result={confirmation:confirmation((await recoverOriginal(payload.expected,payload.originalDigest))?.confirmation)};
        else if(command==='review-proposal')result={confirmation:confirmation((await host.reviewProposal(payload.expected))?.confirmation)};
        else if(command==='recover-interrupted-request')result={confirmation:confirmation((await host.recoverInterruptedRequest(payload.expected,payload.confirmationId))?.confirmation)};
        else {
          const value=await host.recoverFailedPresentation();
          if(typeof value?.recovered!=='boolean'||(value.recovered&&!token(value.requestId)))throw Error('PROTOCOL_RESULT_INVALID');
          result=value.recovered?{recovered:true,requestId:value.requestId}:{recovered:false};
        }
        const encoded=response(requestId,true,result);
        // Full owner snapshots are at most 1 MiB before JSON string escaping.
        // Keep the larger envelope private to this read-only command.
        if(Buffer.byteLength(encoded)>(command==='read-proposal-snapshot'?3*1024*1024:RESPONSE_BYTES))return response(requestId,false,'PROTOCOL_RESPONSE_LIMIT');
        return encoded;
      }catch(error){
        // Cancellation is an exact-target, state-reconciling operation. A failed
        // attempt must not exhaust the reserved slot while that review is live.
        if(cancelling)seen.delete(requestId);
        if(executing)return response(requestId,false,['NATIVE_EXECUTION_REQUEST_UNRESOLVED','NATIVE_EXECUTION_REQUEST_CONFLICT','NATIVE_EXECUTION_REQUEST_SELECTION_CHANGED'].includes(error?.message)?error.message:'NATIVE_EXECUTION_REQUEST_UNAVAILABLE');
        const taskError=changing&&['DRAFT_TASK_CHANGE_INVALID','DRAFT_TASK_CHANGE_CONFLICT','AGENT_TASK_INTENT_REQUEST_CONFLICT','AGENT_TASK_INTENT_QUOTA'].includes(error?.message);
        return response(requestId,false,error?.cleanupComplete===false?'NATIVE_REVIEW_CLEANUP_UNCERTAIN':(resultIndex||resultPage)?(error?.message==='NATIVE_TASK_INDEX_STALE'?'NATIVE_TASK_INDEX_STALE':'NATIVE_TASK_RESULT_UNAVAILABLE'):resultRead?'NATIVE_TASK_RESULT_UNAVAILABLE':errors.has(error?.message)||taskError?error.message:'NATIVE_REVIEW_HOST_FAILURE');
      }
      finally{if(cancelling)cancelBusy=false;else{busy=false;if(command==='review-proposal'||originalReview)activeReview=null;}}
    },
  });
}

