import {createNativeTaskDraftSubmission} from './nativeTaskDraftSubmission.mjs';
import {createAgentLedgerReads} from './proposalLedgerReads.mjs';
import {createTaskLedgerAuthorityStore} from './taskLedgerAuthorityStore.mjs';
import {createNativeTaskReviewFlow} from './nativeTaskReviewFlow.mjs';
import {createNativeReviewPresenterAdapter} from './nativeReviewPresenterAdapter.mjs';
import {createNativeReviewPresentationStore} from './nativeReviewPresentationStore.mjs';
import {createNativeReviewHostProtocol} from './nativeReviewHostProtocol.mjs';
import {createNativeReviewHostStream} from './nativeReviewHostStream.mjs';
import {validateTaskDraftBinding,sameTaskDraftBinding} from '../project/taskDraftLedger.js';
import path from 'node:path';

// Private installed-host composition. Nothing here authenticates an IPC peer or
// grants a renderer permission to select storage, executables, actors or policy.
export function createNativeReviewHostComposition({proposalConfig,confirmationPath,registeredBinding,checkContract,checkProfileEvidence,contractCustody,presenterConfig,actor,source,secretCustody,checkPreparation,taskResults,executionRequests}) {
  if(contractCustody!==undefined&&!checkContract)throw Error('NATIVE_COMPOSITION_CUSTODY_WITHOUT_CONTRACT');
  if(typeof registeredBinding!=='function'||typeof actor!=='string'||!actor.trim()||actor.length>256||typeof source!=='string'||!source.trim()||source.length>256)throw Error('NATIVE_COMPOSITION_CONFIG_INVALID');
  if(typeof confirmationPath!=='string'||!path.isAbsolute(confirmationPath)||path.normalize(confirmationPath)!==confirmationPath)throw Error('NATIVE_COMPOSITION_CONFIG_INVALID');
  if(!presenterConfig||Object.keys(presenterConfig).some(key=>!['executable','executableDigest','cwd','timeoutMs'].includes(key)))throw Error('NATIVE_COMPOSITION_PRESENTER_INVALID');
  const config=structuredClone(proposalConfig),observe=registeredBinding;
  const presenter=createNativeReviewPresenterAdapter({...structuredClone(presenterConfig),compilationTempRoot:path.join(path.dirname(confirmationPath),'presenter-compilation-temp'),closureDirectory:path.join(path.dirname(confirmationPath),'native-review-closures')});
  if(typeof presenter.verifyNativeDecision!=='function')throw Error('NATIVE_COMPOSITION_DECISION_VERIFIER_REQUIRED');
  const store=createTaskLedgerAuthorityStore(config);
  const submission=createNativeTaskDraftSubmission({proposalConfig:config,registeredBinding:observe});
  const recordedBindings=new Map();let stopped=false,attached=false;
  async function observed(){const binding=structuredClone(await observe());if(!binding)throw Error('NATIVE_REGISTRATION_UNAVAILABLE');validateTaskDraftBinding(binding);if(binding.projectId!==config.projectId||binding.rootIdentity!==config.rootIdentity)throw Error('NATIVE_REGISTRATION_FOREIGN');return binding;}
  async function current(expected){return store.withCurrentProposal(expected,async proposal=>{const binding=await observed();if(!sameTaskDraftBinding(binding,proposal.ledger.binding))throw Error('NATIVE_REGISTRATION_CENSUS_MISMATCH');return structuredClone(binding);});}
  const unavailable=async()=>{throw Error('CHECKS_NOT_CONFIGURED');};
  let flow;
  if(checkContract){
    // Host-owned custody is validated and captured by the review layer. Its
    // proposal -> contract -> confirmation lock order must survive composition.
    const native=createNativeTaskReviewFlow({proposalConfig:config,confirmationPath,checkContract:structuredClone(checkContract),checkProfileEvidence,contractCustody,actor,source,secretCustody,
      presentNativeReview:async(display,options)=>{
        if(stopped)throw Error('NATIVE_COMPOSITION_STOPPED');
        const binding=await current({hostRevision:display.subject.hostRevision,headDigest:display.subject.proposalDigest});
        if(stopped)throw Error('NATIVE_COMPOSITION_STOPPED');
        if(recordedBindings.size>=128)throw Error('NATIVE_COMPOSITION_SESSION_LIMIT');
        recordedBindings.set(display.requestId,binding);
        return presenter.presentNativeReview(display,options);
      },
      verifyPresentationClosed:presenter.verifyPresentationClosed,
      verifyNativeDecision:async query=>{
        // Called while the flow holds its proposal lock: do not reacquire it.
        // The registered binding is re-observed; this is still not a native lease.
        if(stopped)return {trusted:false};
        const binding=recordedBindings.get(query.requestId);
        const registration=await observed();
        if(stopped||!binding||!sameTaskDraftBinding(binding,registration))return {trusted:false};
        return presenter.verifyNativeDecision(query);
      },
    });
    flow=Object.freeze({...native,reviewProposal:async(expected,retainedRequestDigest)=>{if(stopped)throw Error('NATIVE_COMPOSITION_STOPPED');expected=structuredClone(expected);await current(expected);if(stopped)throw Error('NATIVE_COMPOSITION_STOPPED');return native.reviewProposal(expected,retainedRequestDigest);}});
  }else{
    const presentations=createNativeReviewPresentationStore({journalPath:`${confirmationPath}.presentations.jsonl`,projectId:config.projectId,rootIdentity:config.rootIdentity});
    flow=Object.freeze({reviewProposal:unavailable,recoverFailedPresentation:unavailable,recoverInterruptedRequest:unavailable,
      inspectRecoveryState:async()=>{const state=await presentations.inspect();return {unresolvedPresentation:state.unresolved?.binding??null,executionAuthorized:false,nativeGestureVerified:false};},
      cancelActiveReview:async()=>({cancelRequested:false,presenterSettled:true,dialogClosed:null,executionAuthorized:false}),
    });
  }
  if(checkPreparation!==undefined&&(!checkPreparation||typeof checkPreparation.prepareChecks!=='function'))throw Error('NATIVE_COMPOSITION_CONFIG_INVALID');
  const prepare=checkPreparation?.prepareChecks.bind(checkPreparation);
  if(checkPreparation?.inspectChecks!==undefined&&typeof checkPreparation.inspectChecks!=='function')throw Error('NATIVE_COMPOSITION_CONFIG_INVALID');
  const inspect=checkPreparation?.inspectChecks?.bind(checkPreparation);
  let preparing=null;
  const preparation=prepare?{prepareChecks:async payload=>{
    if(stopped)throw Error('NATIVE_COMPOSITION_STOPPED');
    const pending=Promise.resolve().then(()=>{if(stopped)throw Error('NATIVE_COMPOSITION_STOPPED');return prepare(payload);});
    preparing=pending;
    try{return await pending;}finally{if(preparing===pending)preparing=null;}
  }}:undefined;
  if(inspect)preparation.inspectChecks=async payload=>{
    if(stopped)throw Error('NATIVE_COMPOSITION_STOPPED');
    const result=await inspect(payload);
    if(stopped)throw Error('NATIVE_COMPOSITION_STOPPED');
    return result;
  };
  // Private supervisor reads reuse exact submission custody and census checks.
  // This does not grant a renderer or an MCP connection access to plan content.
  const ledgerReads=createAgentLedgerReads({submission});
  const proposalReads={read:async(command,payload)=>{
    if(stopped)throw Error('NATIVE_COMPOSITION_STOPPED');
    const methods={'read-proposal-snapshot':'owner.readLedgerSnapshot','read-proposal-brief':'client.readBrief','read-proposal-task':'client.readTask','read-proposal-request':'client.readRequestResult'};
    const value=await ledgerReads.read(methods[command],payload,config);
    if(stopped)throw Error('NATIVE_COMPOSITION_STOPPED');
    return value;
  }};
  const pendingWrites=new Set();
  const trackedWrite=method=>payload=>{
    if(stopped)throw Error('NATIVE_COMPOSITION_STOPPED');
    // Reserve the write before yielding. Shutdown prevents new admissions but
    // cannot promise to cancel I/O already admitted to proposal custody.
    const pending=Promise.resolve().then(()=>submission[method](payload));
    pendingWrites.add(pending);
    return pending.finally(()=>pendingWrites.delete(pending));
  };
  const ownedSubmission={
    inspectHead:submission.inspectHead,
    submitDraft:trackedWrite('submitDraft'),
    proposeTaskChange:trackedWrite('proposeTaskChange'),
  };
  if(taskResults!==undefined&&typeof taskResults?.readOwner!=='function')throw Error('NATIVE_COMPOSITION_CONFIG_INVALID');
  const readResult=taskResults?.readOwner.bind(taskResults);
  if(taskResults?.listOwner!==undefined&&typeof taskResults.listOwner!=='function')throw Error('NATIVE_COMPOSITION_CONFIG_INVALID');
  const listResult=taskResults?.listOwner?.bind(taskResults);
  if(taskResults?.readPageOwner!==undefined&&typeof taskResults.readPageOwner!=='function')throw Error('NATIVE_COMPOSITION_CONFIG_INVALID');
  const readPage=taskResults?.readPageOwner?.bind(taskResults);
  const scopedResults=readResult?{readOwner:async payload=>{
    if(stopped)throw Error('NATIVE_COMPOSITION_STOPPED');
    const result=await readResult(payload),binding=await observed();
    if(stopped||result.projectId!==binding.projectId||result.rootIdentity!==binding.rootIdentity)throw Error('NATIVE_TASK_RESULT_UNAVAILABLE');
    return result;
  }}:undefined;
  if(scopedResults&&listResult)scopedResults.listOwner=async payload=>{
    if(stopped)throw Error('NATIVE_COMPOSITION_STOPPED');
    const result=await listResult(payload),binding=await observed();
    if(stopped||result.projectId!==binding.projectId||result.rootIdentity!==binding.rootIdentity)throw Error('NATIVE_TASK_RESULT_UNAVAILABLE');
    return result;
  };
  if(scopedResults&&readPage)scopedResults.readPageOwner=async payload=>{
    if(stopped)throw Error('NATIVE_COMPOSITION_STOPPED');
    const result=await readPage(payload),binding=await observed();
    if(stopped||result.page?.projectId!==binding.projectId||result.page?.rootIdentity!==binding.rootIdentity)throw Error('NATIVE_TASK_RESULT_UNAVAILABLE');
    return result;
  };
  if(executionRequests!==undefined&&(!executionRequests||['execute','recover','shutdown'].some(k=>typeof executionRequests[k]!=='function')))throw Error('NATIVE_COMPOSITION_CONFIG_INVALID');
  const pendingExecutions=new Set();
  const closeExecution=executionRequests?.shutdown.bind(executionRequests);
  if(executionRequests&&['executeTask','recoverTask'].some(k=>executionRequests[k]!==undefined)&&['executeTask','recoverTask'].some(k=>typeof executionRequests[k]!=='function'))throw Error('NATIVE_COMPOSITION_CONFIG_INVALID');
  const scopedExecution=executionRequests?Object.fromEntries(['execute','recover','executeTask','recoverTask'].filter(k=>typeof executionRequests[k]==='function').map(method=>{
    const invoke=executionRequests[method].bind(executionRequests);
    return [method,payload=>{
      if(stopped)throw Error('NATIVE_COMPOSITION_STOPPED');
      const pending=Promise.resolve().then(()=>invoke(payload));pendingExecutions.add(pending);
      return pending.finally(()=>pendingExecutions.delete(pending));
    }];
  })):undefined;
  const protocol=createNativeReviewHostProtocol({flow,submission:ownedSubmission,checkPreparation:preparation,proposalReads,taskResults:scopedResults,executionRequests:scopedExecution});
  let shutdownPromise;
  const shutdown=()=>{
    stopped=true;
    if(!shutdownPromise)shutdownPromise=Promise.resolve().then(async()=>{
      // Stopped admission means this snapshot cannot gain new proposal writes.
      // Rejection is not rollback: the original request remains reconcilable.
      await Promise.allSettled([...pendingWrites]);
      await Promise.allSettled([...pendingExecutions]);
      let executionClean=!closeExecution;
      if(closeExecution){try{executionClean=(await closeExecution()).cleanupComplete===true;}catch{executionClean=false;}}
      // Do not report clean shutdown while a preparation write can still settle.
      if(preparing){try{await preparing;}catch{}}
      let result,recovery;
      try{result=await flow.cancelActiveReview();recovery=await flow.inspectRecoveryState();}catch{}
      return Object.freeze({cancelRequested:result?.cancelRequested??false,presenterSettled:result?.presenterSettled??false,cleanupComplete:executionClean&&result?.presenterSettled===true&&recovery?.unresolvedPresentation===null,dialogClosed:null,executionAuthorized:false});
    });
    return shutdownPromise;
  };
  const dispatchLine=line=>stopped?Promise.resolve(JSON.stringify({version:1,requestId:null,ok:false,error:{code:'NATIVE_COMPOSITION_STOPPED'},executionAuthorized:false})+'\n'):protocol.dispatchLine(line);
  return Object.freeze({
    limits:protocol.limits,
    // Native-owner composition only; public transports must authenticate scope.
    readPlan:proposalReads.read,
    // Native-owner capability only. External callers still require explicit
    // proposal permission through the scoped broker; this is not an MCP tool.
    proposeTaskChange:ownedSubmission.proposeTaskChange,
    dispatchLine,
    attach({input,output}){if(attached||stopped)throw Error('NATIVE_COMPOSITION_STREAM_UNAVAILABLE');attached=true;return createNativeReviewHostStream({input,output,protocol:{limits:protocol.limits,dispatchLine},shutdown});},
    shutdown,
  });
}

