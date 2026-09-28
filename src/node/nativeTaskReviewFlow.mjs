import {createTaskProposalReview} from './taskProposalReview.mjs';
import {createTaskLedgerAuthorityStore} from './taskLedgerAuthorityStore.mjs';
import {verifyTaskCheckContract} from './taskCheckContract.mjs';
import {createNativeReviewPresentationStore} from './nativeReviewPresentationStore.mjs';
import {createHash} from 'node:crypto';
import {validateInstalledTaskCheckProfileEvidence} from './installedTaskCheckProfileEvidence.mjs';
import {repositoryScriptRuns} from './installedTaskCheckProfile.mjs';
import {cancelConfirmation,createTrustedUserGestureProducer,createTrustedUserGestureBoundary,inspectConfirmations} from './confirmationStore.mjs';

const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const named=value=>typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=256;

// Host-only orchestration. The presenter MUST be installed by the trusted host,
// never supplied in renderer/MCP request data. This is not authentic native IPC:
// a presenter/nativeEvent fixture alone cannot establish a real human gesture.
// No execution, enrollment or grant is created by this module.
export function createNativeTaskReviewFlow({proposalConfig,confirmationPath,checkContract,checkProfileEvidence,presentNativeReview,verifyPresentationClosed,verifyNativeDecision,actor,source,secretCustody,contractCustody}) {
  if(typeof presentNativeReview!=='function'||!named(actor)||!named(source))throw Error('NATIVE_REVIEW_HOST_CONFIG_INVALID');
  proposalConfig=structuredClone(proposalConfig);
  secretCustody=secretCustody?Object.freeze({...secretCustody}):undefined;
  const contract=verifyTaskCheckContract(checkContract);
  const profileEvidence=checkProfileEvidence===undefined?undefined:validateInstalledTaskCheckProfileEvidence(checkProfileEvidence,contract.policyDigest);
  if(contract.tasks.some(task=>task.checks.some(check=>check.checkId.startsWith('npm-')))&&profileEvidence?.profileId!=='npm-project-checks-v1')throw Error('NATIVE_REVIEW_SCRIPT_EVIDENCE_REQUIRED');
  const review=createTaskProposalReview({proposalConfig,confirmationPath,checkContract:contract,contractCustody});
  const store=createTaskLedgerAuthorityStore(proposalConfig);
  const producer=createTrustedUserGestureProducer({source});
  const presentations=createNativeReviewPresentationStore({journalPath:`${confirmationPath}.presentations.jsonl`,projectId:contract.projectId,rootIdentity:contract.rootIdentity});
  if(verifyPresentationClosed!==undefined&&typeof verifyPresentationClosed!=='function')throw Error('NATIVE_REVIEW_HOST_CONFIG_INVALID');
  if(verifyNativeDecision!==undefined&&typeof verifyNativeDecision!=='function')throw Error('NATIVE_REVIEW_HOST_CONFIG_INVALID');
  let busy=false,active=null,unresolvedPresentation=null;
  async function closeExactPresentation(state) {
    const binding=state.unresolved?.binding;
    if(!binding)throw Error('NATIVE_REVIEW_CLOSURE_UNVERIFIED');
    if(!verifyPresentationClosed)throw Error('NATIVE_REVIEW_CLOSURE_UNAVAILABLE');
    const result=await verifyPresentationClosed(binding);
    if(result?.requestId!==binding.requestId||result?.closed!==true)throw Error('NATIVE_REVIEW_CLOSURE_UNVERIFIED');
    const evidence=createHash('sha256').update(JSON.stringify({binding,closed:true,source})).digest('hex');
    const closed=await presentations.close(binding,{expectedRevision:state.revision,operationId:`close:${binding.requestId}`,closureEvidenceDigest:evidence});
    if(closed.presentation?.status!=='closed'||closed.presentation.closed?.recordHash!==closed.record?.recordHash||Object.entries(binding).some(([key,value])=>closed.presentation.binding?.[key]!==value))throw Error('NATIVE_REVIEW_CLOSURE_UNVERIFIED');
    unresolvedPresentation=null;
  }
  async function completeReview(result) {
    // A committed decision is not a closed dialog. Never return success until
    // the same host verifies closure and its exact record is durably retained.
    if(unresolvedPresentation){
      const state=await presentations.inspect();
      if(!state.unresolved||Object.entries(unresolvedPresentation).some(([key,value])=>state.unresolved.binding?.[key]!==value))throw Error('NATIVE_REVIEW_CLOSURE_UNVERIFIED');
      await closeExactPresentation(state);
    }
    return freeze({...result,executionAuthorized:false,nativeGestureVerified:false});
  }
  async function cancelActive(run) {
    run.controller.abort();
    if(!run.cancellation)run.cancellation=(async()=>{
      const watcher=await run.ready;
      if(!watcher)return null;
      const read=async()=>(await inspectConfirmations(confirmationPath)).find(item=>item.id===watcher.id);
      const current=await read();
      if(current?.status!=='pending')return current;
      try{return await cancelConfirmation(confirmationPath,watcher,{cancelledBy:actor,reason:'Host cancelled the native review.',secretCustody});}
      catch(error){const after=await read();if(after&&after.status!=='pending')return after;throw error;}
    })();
    const attempt=run.cancellation;
    try{return await attempt;}
    catch(error){if(error?.cleanupComplete!==false&&run.cancellation===attempt)run.cancellation=null;throw error;}
  }
  return Object.freeze({
    async recoverOriginalRequest(expected,retainedRequestDigest){
      if(busy)throw Error('NATIVE_REVIEW_BUSY');busy=true;
      try{
        const original=await review.inspectRetainedRequest(expected,retainedRequestDigest);
        const state=await presentations.inspect();
        if(state.unresolved){
          const binding=state.unresolved.binding;
          if(binding.requestId!==original.id||binding.proposalRevision!==expected.hostRevision||binding.proposalDigest!==expected.headDigest||binding.checkContractDigest!==contract.contractDigest)throw Error('NATIVE_REVIEW_BINDING_MISMATCH');
          await closeExactPresentation(state);
        }
        // A terminal decision remains immutable. Pending recovery cancels the
        // original watcher through its native custody; it never approves it.
        const result=original.status==='pending'
          ?await review.recoverInterrupted(expected,{id:original.id,requestedBy:actor},{secretCustody})
          :{confirmation:original};
        return freeze({...result,executionAuthorized:false,nativeGestureVerified:false});
      }finally{busy=false;}
    },
    async recoverInterruptedRequest(expected,requestId){
      if(busy)throw Error('NATIVE_REVIEW_BUSY');busy=true;
      try{
        const state=await presentations.inspect();
        if(state.unresolved)throw Error('NATIVE_REVIEW_PRESENTATION_UNRESOLVED');
        return await review.recoverInterrupted(expected,{id:requestId,requestedBy:actor},{secretCustody});
      }finally{busy=false;}
    },
    async inspectRecoveryState(){const state=await presentations.inspect();return freeze({unresolvedPresentation:state.unresolved?.binding??null,executionAuthorized:false,nativeGestureVerified:false});},
    inspectPresentationState(){return freeze({busy,unresolvedPresentation,executionAuthorized:false,nativeGestureVerified:false});},
    async recoverFailedPresentation(){
      if(busy)throw Error('NATIVE_REVIEW_BUSY');
      busy=true;
      try{
        const state=await presentations.inspect();unresolvedPresentation=state.unresolved?.binding??null;
        if(!unresolvedPresentation)return freeze({recovered:false,executionAuthorized:false});
        const requestId=unresolvedPresentation.requestId;
        await closeExactPresentation(state);
        return freeze({recovered:true,requestId,executionAuthorized:false,nativeGestureVerified:false});
      }finally{busy=false;}
    },
    async cancelActiveReview() {
      const run=active;
      if(!run)return freeze({cancelRequested:false,presenterSettled:true,dialogClosed:null,executionAuthorized:false});
      const confirmation=await cancelActive(run);
      return freeze({cancelRequested:true,presenterSettled:run.closed,dialogClosed:null,confirmation,executionAuthorized:false});
    },
    async reviewProposal(expected,retainedRequestDigest) {
      if(retainedRequestDigest!==undefined&&(typeof retainedRequestDigest!=='string'||!/^[a-f0-9]{64}$/.test(retainedRequestDigest)))throw Error('CONFIRMATION_ORIGINAL_INVALID');
      if(busy)throw Error('NATIVE_REVIEW_BUSY');
      if(unresolvedPresentation)throw Error('NATIVE_REVIEW_PRESENTATION_UNRESOLVED');
      expected=structuredClone(expected);busy=true;
      let ready;const run={controller:new AbortController(),ready:new Promise(resolve=>{ready=resolve;}),closed:false,cancellation:null};active=run;
      let watcher;
      try {
        const recovery=await presentations.inspect();
        if(recovery.unresolved){unresolvedPresentation=recovery.unresolved.binding;throw Error('NATIVE_REVIEW_PRESENTATION_UNRESOLVED');}
        const requested=await review.request(expected,{requestedBy:actor,question:'Review these exact planning tasks and fixed checks. Approval does not authorize execution.'},{secretCustody,retainedRequestDigest});
        watcher=requested.confirmation;
        ready(watcher);
        if(run.controller.signal.aborted)return await completeReview({confirmation:await cancelActive(run)});
        const display=await store.withCurrentProposal(expected,proposal=>{
          if(watcher.subject.proposalDigest!==proposal.recordHash||watcher.subject.checkContractDigest!==contract.contractDigest)throw Error('NATIVE_REVIEW_BINDING_MISMATCH');
          const value={schemaVersion:1,kind:'TASK_EXECUTION_REVIEW',requestId:watcher.id,question:watcher.question,subject:watcher.subject,ledger:proposal.ledger,checkContract:contract,executionAuthorized:false,nativeGestureVerified:false};
          if(profileEvidence)value.checkProfileEvidence=profileEvidence;
          if(profileEvidence?.profileId==='npm-project-checks-v1'){
            value.repositoryScriptRuns=repositoryScriptRuns(profileEvidence.scriptDefinitions,profileEvidence.assignments);
            value.repositoryScriptNotice='Declared npm lifecycle scripts in order. npm configuration may suppress hooks; nested commands and transitive tools are not expanded or verified.';
          }
          if(Buffer.byteLength(JSON.stringify(value))>2*1024*1024)throw Error('NATIVE_REVIEW_DISPLAY_TOO_LARGE');
          return freeze(structuredClone(value));
        });
        // Never hold the proposal lock across a user dialog. decide() validates
        // the exact head again after the dialog returns.
        if(run.controller.signal.aborted)return await completeReview({confirmation:await cancelActive(run)});
        const binding={projectId:contract.projectId,rootIdentity:contract.rootIdentity,requestId:watcher.id,proposalRevision:expected.hostRevision,proposalDigest:watcher.subject.proposalDigest,checkContractDigest:contract.contractDigest,source};
        const currentPresentation=await presentations.inspect();
        const begun=await presentations.begin(binding,{expectedRevision:currentPresentation.revision,operationId:`begin:${watcher.id}`});
        unresolvedPresentation=freeze(binding);
        // An acknowledged historical begin is recovery evidence, never a new
        // permission to display. Only the fresh exact unresolved record qualifies.
        if(begun.idempotent!==false||begun.presentation?.status!=='unresolved'||
          begun.presentation.begun?.recordHash!==begun.record?.recordHash||
          Object.entries(binding).some(([key,value])=>begun.presentation.binding?.[key]!==value))throw Error('NATIVE_REVIEW_BEGIN_NOT_FRESH');
        if(run.controller.signal.aborted)return await completeReview({confirmation:await cancelActive(run)});
        run.started=true;
        const answer=await presentNativeReview(display,{signal:run.controller.signal});
        run.closed=true;
        if(run.controller.signal.aborted)return await completeReview({confirmation:await cancelActive(run)});
        if(answer===null||answer?.decision==='cancelled') {
          const confirmation=await cancelConfirmation(confirmationPath,watcher,{cancelledBy:actor,reason:'Native review dismissed without approval.',secretCustody});
          return await completeReview({confirmation});
        }
        if(!answer||!['approved','rejected'].includes(answer.decision)||typeof answer.rationale!=='string'||answer.rationale.length>4096)throw Error('NATIVE_REVIEW_RESPONSE_INVALID');
        const decision=answer.decision,rationale=answer.rationale;
        let evidence,gestureBoundary;
        if(verifyNativeDecision){
          // The installed private host verifies its owned window record. Page
          // isTrusted flags and answer fields cannot attest their own origin.
          // Hash the exact displayed bytes, not a renderer reconstruction.
          const displayDigest=createHash('sha256').update(JSON.stringify(display)).digest('hex');
          if(typeof answer.decisionEvidence!=='string'||! /^[A-Za-z0-9._:-]{1,128}$/.test(answer.decisionEvidence))throw Error('NATIVE_REVIEW_RESPONSE_INVALID');
          evidence=answer.decisionEvidence;
          const requestId=watcher.id;
          gestureBoundary=createTrustedUserGestureBoundary(async(received,binding)=>{
            if(run.controller.signal.aborted||received!==evidence||binding.requestId!==requestId||binding.decision!==decision)return {trusted:false};
            // This callback runs under decision locks: it must verify only the
            // native-owned record, never reenter proposal/confirmation stores.
            const record=await verifyNativeDecision(freeze({evidence,requestId,displayDigest,decision}));
            if(run.controller.signal.aborted||record?.trusted!==true||record.requestId!==requestId||record.displayDigest!==displayDigest||record.decision!==decision||!named(record.eventId)||typeof record.occurredAt!=='string'||!Number.isFinite(Date.parse(record.occurredAt)))return {trusted:false};
            return {trusted:true,source,actor,eventId:record.eventId,occurredAt:record.occurredAt,binding};
          });
        }else{
          // Legacy controlled-presenter seam; never enables native proof.
          evidence=producer.capture(answer.nativeEvent,actor,{request:watcher,decision});gestureBoundary=producer.boundary;
        }
        const result=await review.decide(expected,{id:watcher.id,decision,decidedBy:actor,rationale,userGestureEvidence:evidence},{gestureBoundary});
        return await completeReview(result);
      } catch(error) {
        // Do not automatically invoke credential custody again while its prior
        // process cleanup is explicitly uncertain. Leave durable recovery open.
        if(error?.cleanupComplete===false)throw error;
        // Durable begin remains unresolved until an exact host closure check,
        // even if the presenter resolves or the process subsequently restarts.
        // Preserve a possibly committed decision on lost acknowledgement; never
        // overwrite it with cancellation or retry an approval automatically.
        if(watcher)try {
          const recorded=(await inspectConfirmations(confirmationPath)).find(item=>item.id===watcher.id);
          if(recorded?.status==='pending')await cancelConfirmation(confirmationPath,watcher,{cancelledBy:actor,reason:'Native review did not complete; a new review is required.',secretCustody});
        } catch(cleanupError) {throw new AggregateError([error,cleanupError],'NATIVE_REVIEW_FAILED_WITH_UNRESOLVED_REQUEST');}
        throw error;
      } finally {ready(null);run.closed=true;active=null;busy=false;}
    },
  });
}
