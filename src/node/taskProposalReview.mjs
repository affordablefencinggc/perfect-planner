import {createTaskLedgerAuthorityStore} from './taskLedgerAuthorityStore.mjs';
import {createTaskCheckContractStore} from './taskCheckContractStore.mjs';
import {verifyTaskCheckContract} from './taskCheckContract.mjs';
import {inspectTaskCheckFiles} from './taskCheckFileEvidence.mjs';
import {withAuthenticatedSession,authenticateSession} from './sessionRegistry.mjs';
import {candidateSnapshot} from './mergedStateRunner.mjs';
import {createTaskEnrollmentStore} from './taskEnrollmentStore.mjs';
import {createTaskExecutionGrantStore} from './taskExecutionGrantStore.mjs';
import {createHash} from 'node:crypto';
import {acceptanceSetDigest} from './taskOutcomeContract.mjs';
import {bindTaskAttemptToLedger} from './taskOutcomeBinding.mjs';
import {parseTaskDraftImport} from '../project/taskDraftLedger.js';
import {requestConfirmation,decideConfirmation,inspectConfirmations,withRecordedApproval,recoverPendingConfirmation} from './confirmationStore.mjs';

const reviewSubject=(proposal,contract)=>{
  const active=proposal.ledger.tasks.filter(task=>!task.archived).map(task=>task.id).sort();
  const covered=contract.tasks.map(task=>task.taskId).sort();
  if(contract.projectId!==proposal.ledger.binding.projectId||contract.rootIdentity!==proposal.ledger.binding.rootIdentity||JSON.stringify(active)!==JSON.stringify(covered))throw Error('TASK_PROPOSAL_CHECK_COVERAGE_MISMATCH');
  return {kind:'TASK_EXECUTION_REVIEW',projectId:contract.projectId,rootIdentity:contract.rootIdentity,hostRevision:proposal.hostRevision,proposalDigest:proposal.recordHash,ledgerDigest:proposal.ledgerDigest,checkContractDigest:contract.contractDigest};
};
const matches=(left,right)=>left&&Object.keys(left).length===Object.keys(right).length&&Object.keys(right).every(key=>left[key]===right[key]);

// Trusted host composition, not a renderer/MCP endpoint. This records a review
// decision, not execution permission. No enrollment, grant, candidate proof or
// native gesture is invented. Confirmation persistence limitations still apply.
export function createTaskProposalReview({proposalConfig,confirmationPath,checkContract,preflightConfig,contractCustody}) {
  proposalConfig=structuredClone(proposalConfig);
  const contract=verifyTaskCheckContract(checkContract);
  let custody,contractHead;
  if(contractCustody!==undefined){
    if(!contractCustody||Object.keys(contractCustody).sort().join('|')!=='expectedHead|storeConfig'||!contractCustody.storeConfig||typeof contractCustody.storeConfig.registeredBinding!=='function')throw Error('TASK_PROPOSAL_CUSTODY_INVALID');
    const {registeredBinding,...data}=contractCustody.storeConfig;
    const config=structuredClone(data);contractHead=structuredClone(contractCustody.expectedHead);
    if(!config.proposalConfig||Object.keys(proposalConfig).sort().join('|')!==Object.keys(config.proposalConfig).sort().join('|')||Object.keys(proposalConfig).some(key=>config.proposalConfig[key]!==proposalConfig[key]))throw Error('TASK_PROPOSAL_CUSTODY_INVALID');
    if(!contractHead||Object.keys(contractHead).sort().join('|')!=='headDigest|revision'||!Number.isSafeInteger(contractHead.revision)||contractHead.revision<1||typeof contractHead.headDigest!=='string'||!/^[a-f0-9]{64}$/.test(contractHead.headDigest))throw Error('TASK_PROPOSAL_CUSTODY_INVALID');
    custody=createTaskCheckContractStore({...config,registeredBinding});
  }
  const preflight=preflightConfig?structuredClone(preflightConfig):null;
  const enrollments=preflight?.enrollmentConfig?createTaskEnrollmentStore(preflight.enrollmentConfig):null;
  if(enrollments&&(preflight.enrollmentConfig.projectId!==contract.projectId||preflight.enrollmentConfig.rootIdentity!==contract.rootIdentity))throw Error('TASK_ENROLLMENT_PROJECT_MISMATCH');
  const grants=preflight?.grantConfig?createTaskExecutionGrantStore(preflight.grantConfig):null;
  if(grants&&(preflight.grantConfig.projectId!==contract.projectId||preflight.grantConfig.rootIdentity!==contract.rootIdentity))throw Error('TASK_GRANT_PROJECT_MISMATCH');
  const subjectOf=proposal=>reviewSubject(proposal,contract);
  const store=createTaskLedgerAuthorityStore(proposalConfig);
  // One lock owner: proposal -> saved contract -> confirmation. Never reenter
  // the proposal store from the custody callback or hold these across a dialog.
  const withCurrent=(expected,operation)=>custody
    ?custody.withCurrentContract(expected,contractHead,({record,proposal})=>{
      if(record.snapshot.contract.contractDigest!==contract.contractDigest)throw Error('TASK_PROPOSAL_CUSTODY_MISMATCH');
      return operation(proposal);
    })
    :store.withCurrentProposal(expected,operation);
  async function withAssignedCheck(expected,confirmationId,enrollmentHead,input,operation,sessionOptions={}) {
      if(typeof operation!=='function')throw Error('TASK_PREFLIGHT_CALLBACK_INVALID');
      input=structuredClone(input);enrollmentHead=structuredClone(enrollmentHead);
      sessionOptions={...sessionOptions,secretCustody:sessionOptions.secretCustody?{...sessionOptions.secretCustody}:undefined};
      if(!enrollments||!preflight.registeredRoot||!preflight.sessionRegistryPath)throw Error('TASK_ENROLLMENT_UNCONFIGURED');
      // Cooperative lock order: proposal -> confirmation -> enrollment ->
      // session. No worker execution occurs while holding these review locks.
      return withCurrent(expected,proposal=>withRecordedApproval(confirmationPath,confirmationId,confirmation=>{
        if(!matches(confirmation.subject,subjectOf(proposal)))throw Error('TASK_PROPOSAL_REVIEW_MISMATCH');
        return enrollments.withCurrentEnrollment(enrollmentHead,async enrollment=>{
          const mapping=enrollment.snapshot;
          if(enrollment.projectId!==contract.projectId||enrollment.rootIdentity!==contract.rootIdentity||mapping.hostRevision!==proposal.hostRevision||mapping.proposalDigest!==proposal.recordHash||mapping.checkContractDigest!==contract.contractDigest||mapping.policyVersion!==contract.policyVersion||mapping.policyDigest!==contract.policyDigest)throw Error('TASK_ENROLLMENT_BINDING_MISMATCH');
          const assignment=mapping.assignments.find(item=>item.taskId===input.taskId);
          if(!assignment||assignment.workerId!==input.workerId)throw Error('TASK_WORKER_NOT_ASSIGNED');
          return withAuthenticatedSession(preflight.sessionRegistryPath,input.credentials,{id:assignment.sessionId,actor:assignment.actor},async session=>{
            const files=await inspectTaskCheckFiles({checkContract:contract,taskId:input.taskId,checkId:input.checkId,registeredRoot:preflight.registeredRoot});
            // Host callback may commit an admission decision while authority
            // heads stay locked. It must not launch work or reenter these locks.
            return operation(Object.freeze({proposal,checkContract:contract,proposalDigest:proposal.recordHash,confirmationId:confirmation.id,enrollmentRevision:enrollment.revision,enrollmentEpoch:enrollment.epoch,workerId:assignment.workerId,session,files,assignmentVerified:true,candidateVerified:false,executionAuthorized:false}));
          },sessionOptions);
        });
      }));
    }
  return Object.freeze({
    withAssignedCheck,
    async enrollReviewedWorkers(expected,confirmationId,assignments,request,sessionOptions={}){
      assignments=structuredClone(assignments);request=structuredClone(request);
      if(!enrollments||!preflight.sessionRegistryPath)throw Error('TASK_ENROLLMENT_UNCONFIGURED');
      if(!Array.isArray(assignments)||assignments.length>256)throw Error('TASK_ENROLLMENT_INPUT_INVALID');
      const seen=new Set();
      for(const a of assignments){
        if(!a||Object.keys(a).sort().join('|')!=='credentials|taskId|workerId'||seen.has(a.taskId)||!contract.tasks.some(t=>t.taskId===a.taskId))throw Error('TASK_ENROLLMENT_INPUT_INVALID');
        seen.add(a.taskId);
      }
      return withCurrent(expected,proposal=>withRecordedApproval(confirmationPath,confirmationId,async confirmation=>{
        if(!matches(confirmation.subject,subjectOf(proposal)))throw Error('TASK_PROPOSAL_REVIEW_MISMATCH');
        const mapped=[];
        for(const a of assignments){
          const session=await authenticateSession(preflight.sessionRegistryPath,a.credentials,{id:a.credentials?.id,actor:a.credentials?.actor},{...sessionOptions,now:undefined});
          mapped.push({taskId:a.taskId,workerId:a.workerId,sessionId:session.id,actor:session.actor});
        }
        // Enrollment records an authenticated assignment observation. Admission
        // must authenticate again; publication is not a session or file lease.
        return enrollments.publish({hostRevision:proposal.hostRevision,proposalDigest:proposal.recordHash,checkContractDigest:contract.contractDigest,
          policyVersion:contract.policyVersion,policyDigest:contract.policyDigest,assignments:mapped},request);
      }));
    },
    async issueAssignedGrant(expected,confirmationId,enrollmentHead,input,request,sessionOptions={},captureOptions={}) {
      input=structuredClone(input);request=structuredClone(request);
      captureOptions={signal:captureOptions.signal,timeoutMs:captureOptions.timeoutMs};
      sessionOptions={...sessionOptions,now:undefined,secretCustody:sessionOptions.secretCustody?{...sessionOptions.secretCustody}:undefined};
      if(!grants)throw Error('TASK_GRANT_UNCONFIGURED');
      // Candidate and policy bindings come from the locked host context. A
      // caller chooses an attempt, never a digest, tool, path or launch flag.
      if(!input||Object.keys(input).sort().join('|')!=='attemptId|attemptNumber|checkId|credentials|taskId|workerId')throw Error('TASK_GRANT_ISSUE_INPUT_INVALID');
      return withAssignedCheck(expected,confirmationId,enrollmentHead,input,async context=>{
        const candidate=await candidateSnapshot(preflight.registeredRoot,undefined,captureOptions);
        if(candidate.cleanupComplete===false)throw Object.assign(Error('TASK_CANDIDATE_CLEANUP_UNCERTAIN'),{cleanupComplete:false,code:'GIT_PROCESS_UNCERTAIN'});
        if(candidate.valid!==true||candidate.snapshotSchemaVersion!==2)throw Error('TASK_CANDIDATE_UNVERIFIED');
        await authenticateSession(preflight.sessionRegistryPath,input.credentials,{id:context.session.id,actor:context.session.actor},{...sessionOptions,now:undefined});
        if(captureOptions.signal?.aborted)throw Error('TASK_CANDIDATE_CANCELLED');
        const binding={proposalRevision:context.proposal.hostRevision,proposalDigest:context.proposalDigest,checkContractDigest:contract.contractDigest,enrollmentEpoch:context.enrollmentEpoch,
          taskId:input.taskId,checkId:input.checkId,attemptId:input.attemptId,attemptNumber:input.attemptNumber,workerId:context.workerId,sessionId:context.session.id,
          candidateSchemaVersion:2,candidateDigest:candidate.digest,policyVersion:contract.policyVersion,policyDigest:contract.policyDigest};
        const issued=await grants.issue(binding,request);
        // Issuance does not consume a grant or authorize process creation.
        return Object.freeze({...issued,candidateVerified:false,executionAuthorized:false});
      },sessionOptions);
    },
    async inspectOwnGrantReceipt(input,sessionOptions={}) {
      input=structuredClone(input);
      if(!grants||!preflight.sessionRegistryPath)throw Error('TASK_GRANT_UNCONFIGURED');
      // Historical receipt access is not new admission. It deliberately does
      // not inspect current candidate bytes or require the old enrollment head.
      // Only the original, still-authenticated session may inspect its receipt.
      return withAuthenticatedSession(preflight.sessionRegistryPath,input.credentials,{id:input.credentials?.id,actor:input.credentials?.actor},async session=>{
        const state=await grants.inspect();
        const entry=state.grants.find(item=>item.grant.grantId===input.grantId);
        const binding=entry?.grant.binding;
        if(!binding||binding.sessionId!==session.id||binding.workerId!==input.workerId||binding.taskId!==input.taskId||binding.checkId!==input.checkId||binding.attemptId!==input.attemptId||binding.attemptNumber!==input.attemptNumber)throw Error('TASK_GRANT_RECEIPT_UNAVAILABLE');
        return Object.freeze({grant:entry.grant,state:entry.state,consumptionReceipt:entry.consumptionReceipt,intentReceipt:entry.intentReceipt,observationLink:entry.observationLink,alreadyConsumed:['consumed','intent-recorded','result-recorded'].includes(entry.state),launchAllowed:false,executionAuthorized:false});
      },{...sessionOptions,now:undefined});
    },
    async consumeAssignedGrant(expected,confirmationId,enrollmentHead,input,request,sessionOptions={},captureOptions={}) {
      captureOptions={signal:captureOptions.signal,timeoutMs:captureOptions.timeoutMs};
      input=structuredClone(input);request=structuredClone(request);
      sessionOptions={...sessionOptions,secretCustody:sessionOptions.secretCustody?{...sessionOptions.secretCustody}:undefined};
      if(!grants)throw Error('TASK_GRANT_UNCONFIGURED');
      // Direct host observation, never a digest supplied by the caller. This
      // still is not an exclusive candidate lease or permission to launch.
      return withAssignedCheck(expected,confirmationId,enrollmentHead,input,async context=>{
        const state=await grants.inspect();
        const entry=state.grants.find(item=>item.grant.grantId===request.grantId);
        if(!entry)throw Error('TASK_GRANT_NOT_FOUND');
        const binding={proposalRevision:context.proposal.hostRevision,proposalDigest:context.proposalDigest,checkContractDigest:contract.contractDigest,enrollmentEpoch:context.enrollmentEpoch,taskId:input.taskId,checkId:input.checkId,attemptId:input.attemptId,attemptNumber:input.attemptNumber,workerId:context.workerId,sessionId:context.session.id,candidateSchemaVersion:2,candidateDigest:entry.grant.binding.candidateDigest,policyVersion:contract.policyVersion,policyDigest:contract.policyDigest};
        if(!matches(entry.grant.binding,binding))throw Error('TASK_GRANT_CONTEXT_MISMATCH');
        const observedCandidate=await candidateSnapshot(preflight.registeredRoot,undefined,captureOptions);
        if(observedCandidate.cleanupComplete===false)throw Object.assign(Error('TASK_CANDIDATE_CLEANUP_UNCERTAIN'),{cleanupComplete:false,code:'GIT_PROCESS_UNCERTAIN'});
        if(observedCandidate.valid!==true||observedCandidate.snapshotSchemaVersion!==2)throw Error('TASK_CANDIDATE_UNVERIFIED');
        if(observedCandidate.digest!==binding.candidateDigest)throw Error('TASK_GRANT_CONTEXT_MISMATCH');
        // A start-of-request test/host timestamp cannot freeze freshness while
        // Git and file reads run. Final admission always checks the real clock.
        await authenticateSession(preflight.sessionRegistryPath,input.credentials,{id:context.session.id,actor:context.session.actor},{...sessionOptions,now:undefined});
        if(captureOptions.signal?.aborted)throw Error('TASK_CANDIDATE_CANCELLED');
        // Translate while the reviewed proposal/contract/session are locked.
        // Host proposal revision and draft ledger revision are distinct. The
        // complete acceptance set is retained even for this single-check grant.
        // This context is evidence binding only, not permission to execute.
        const ledger=parseTaskDraftImport(JSON.stringify(context.proposal.ledger));
        const task=ledger.tasks.find(task=>task.id===binding.taskId);
        const requiredCheckIds=contract.tasks.find(task=>task.taskId===binding.taskId)?.checks.map(check=>check.checkId);
        const outcomeContext=bindTaskAttemptToLedger(JSON.stringify({schemaVersion:1,kind:'TASK_ATTEMPT',binding:{
          projectId:ledger.binding.projectId,rootIdentity:ledger.binding.rootIdentity,
          ledgerRevision:ledger.revision,ledgerDigest:createHash('sha256').update(JSON.stringify(ledger)).digest('hex'),
          taskId:binding.taskId,taskDigest:createHash('sha256').update(JSON.stringify(task)).digest('hex'),
          candidateDigest:binding.candidateDigest,acceptanceDigest:acceptanceSetDigest(requiredCheckIds),
        },attemptId:binding.attemptId,attemptNumber:binding.attemptNumber,producerId:binding.workerId,
          sessionId:binding.sessionId,grantId:entry.grant.grantId,requiredCheckIds}),JSON.stringify(ledger),binding.checkId);
        const consumed=await grants.consume(binding,request);
        if(captureOptions.signal?.aborted)return Object.freeze({...consumed,launchAllowed:false,cancelledAfterConsumption:true,candidateVerified:false,executionAuthorized:false});
        return Object.freeze({...consumed,outcomeContext,candidateVerified:false,executionAuthorized:false});
      },sessionOptions);
    },
    async recordAssignedExecutionIntent(expected,confirmationId,enrollmentHead,input,consumptionReceipt,request,sessionOptions={},captureOptions={}) {
      input=structuredClone(input);consumptionReceipt=structuredClone(consumptionReceipt);request=structuredClone(request);
      captureOptions={signal:captureOptions.signal,timeoutMs:captureOptions.timeoutMs};
      sessionOptions={...sessionOptions,secretCustody:sessionOptions.secretCustody?{...sessionOptions.secretCustody}:undefined};
      if(!grants)throw Error('TASK_GRANT_UNCONFIGURED');
      // Recheck the complete current authority before recording launch intent.
      // Historical inspection remains the recovery path when those heads moved.
      return withAssignedCheck(expected,confirmationId,enrollmentHead,input,async context=>{
        const binding={proposalRevision:context.proposal.hostRevision,proposalDigest:context.proposalDigest,checkContractDigest:contract.contractDigest,enrollmentEpoch:context.enrollmentEpoch,
          taskId:input.taskId,checkId:input.checkId,attemptId:input.attemptId,attemptNumber:input.attemptNumber,workerId:context.workerId,sessionId:context.session.id,
          candidateSchemaVersion:2,candidateDigest:consumptionReceipt?.binding?.candidateDigest,policyVersion:contract.policyVersion,policyDigest:contract.policyDigest};
        if(!matches(consumptionReceipt?.binding,binding))throw Error('TASK_GRANT_CONTEXT_MISMATCH');
        const candidate=await candidateSnapshot(preflight.registeredRoot,undefined,captureOptions);
        if(candidate.cleanupComplete===false)throw Object.assign(Error('TASK_CANDIDATE_CLEANUP_UNCERTAIN'),{cleanupComplete:false,code:'GIT_PROCESS_UNCERTAIN'});
        if(candidate.valid!==true||candidate.snapshotSchemaVersion!==2)throw Error('TASK_CANDIDATE_UNVERIFIED');
        if(candidate.digest!==binding.candidateDigest)throw Error('TASK_GRANT_CONTEXT_MISMATCH');
        await authenticateSession(preflight.sessionRegistryPath,input.credentials,{id:context.session.id,actor:context.session.actor},{...sessionOptions,now:undefined});
        if(captureOptions.signal?.aborted)throw Error('TASK_CANDIDATE_CANCELLED');
        const recorded=await grants.recordExecutionIntent(consumptionReceipt,request);
        if(captureOptions.signal?.aborted)return Object.freeze({...recorded,firstIntent:false,cancelledAfterIntent:true,candidateVerified:false,executionAuthorized:false});
        // No process is launched while locks are held. Filesystem observations
        // are not a lease; native dispatch still needs its own final binding.
        const check=contract.tasks.find(task=>task.taskId===input.taskId).checks.find(check=>check.checkId===input.checkId);
        const executionSpec=recorded.firstIntent?Object.freeze({
          runId:recorded.intentReceipt.runId,intentDigest:recorded.intentReceipt.recordDigest,
          registeredRoot:preflight.registeredRoot,cwd:context.files.cwd,
          executablePath:context.files.executablePath,executableDigest:context.files.executableDigest,
          args:Object.freeze([...check.args]),timeoutMs:check.timeoutMs,outputLimits:Object.freeze({...check.outputLimits}),
          candidateDigest:binding.candidateDigest,checkContractDigest:contract.contractDigest,
        }):null;
        return Object.freeze({...recorded,executionSpec,candidateVerified:false,executionAuthorized:false});
      },sessionOptions);
    },
    inspectAssignedCheck(expected,confirmationId,enrollmentHead,input,sessionOptions={}) {
      return withAssignedCheck(expected,confirmationId,enrollmentHead,input,value=>value,sessionOptions);
    },
    async inspectApprovedCheck(expected,confirmationId,input,sessionOptions={}) {
      input=structuredClone(input);
      sessionOptions={...sessionOptions,secretCustody:sessionOptions.secretCustody?{...sessionOptions.secretCustody}:undefined};
      if(!preflight||!preflight.registeredRoot||!preflight.sessionRegistryPath||!preflight.expectedSession)throw Error('TASK_PREFLIGHT_UNCONFIGURED');
      // Fixed host paths/session expectation; request data cannot choose files,
      // commands or policy. Authentication is not assignment or a launch grant.
      return withCurrent(expected,proposal=>withRecordedApproval(confirmationPath,confirmationId,confirmation=>{
        if(!matches(confirmation.subject,subjectOf(proposal)))throw Error('TASK_PROPOSAL_REVIEW_MISMATCH');
        return withAuthenticatedSession(preflight.sessionRegistryPath,input.credentials,preflight.expectedSession,async session=>{
          const files=await inspectTaskCheckFiles({checkContract:contract,taskId:input.taskId,checkId:input.checkId,registeredRoot:preflight.registeredRoot});
          return Object.freeze({proposalDigest:proposal.recordHash,confirmationId:confirmation.id,session,files,assignmentVerified:false,candidateVerified:false,executionAuthorized:false});
        },sessionOptions);
      }));
    },
    async withApprovedProposal(expected,confirmationId,operation) {
      if(typeof operation!=='function')throw Error('TASK_PROPOSAL_REVIEW_INVALID');
      return withCurrent(expected,proposal=>withRecordedApproval(confirmationPath,confirmationId,confirmation=>{
        if(!matches(confirmation.subject,subjectOf(proposal)))throw Error('TASK_PROPOSAL_REVIEW_MISMATCH');
        return operation(Object.freeze({proposal,confirmation,checkContract:contract,executionAuthorized:false}));
      }));
    },
    async request(expected,input,options={}) {
      input=structuredClone(input);
      const timestamp=options.timestamp;
      return withCurrent(expected,async proposal=>{
        const confirmation=await requestConfirmation(confirmationPath,{planId:proposal.ledger.binding.projectId,itemId:`proposal-${proposal.hostRevision}`,question:input?.question,requestedBy:input?.requestedBy,subject:subjectOf(proposal)},{...options,timestamp});
        return {confirmation,executionAuthorized:false};
      });
    },
    async inspectRetainedRequest(expected,retainedRequestDigest){
      if(typeof retainedRequestDigest!=='string'||!/^[a-f0-9]{64}$/.test(retainedRequestDigest))throw Error('CONFIRMATION_ORIGINAL_INVALID');
      return store.withRetainedProposal(expected,async proposal=>{
        const matchesId=(await inspectConfirmations(confirmationPath)).filter(item=>item.id===`review-${retainedRequestDigest}`);
        if(matchesId.length!==1||!matches(matchesId[0].subject,subjectOf(proposal)))throw Error('TASK_PROPOSAL_RECOVERY_HISTORY_MISMATCH');
        return structuredClone(matchesId[0]);
      });
    },
    async recoverInterrupted(expected,input,options={}) {
      input=structuredClone(input);
      return store.withRetainedProposal(expected,async proposal=>{
        const request=(await inspectConfirmations(confirmationPath)).find(item=>item.id===input?.id);
        const subject=request?.subject;
        // Cancellation uses the original recorded check digest, not today's
        // changed contract. No checks are executed or approved by recovery.
        if(!subject||subject.kind!=='TASK_EXECUTION_REVIEW'||subject.projectId!==contract.projectId||subject.rootIdentity!==contract.rootIdentity||subject.hostRevision!==proposal.hostRevision||subject.proposalDigest!==proposal.recordHash||subject.ledgerDigest!==proposal.ledgerDigest||typeof subject.checkContractDigest!=='string'||!/^[a-f0-9]{64}$/.test(subject.checkContractDigest))throw Error('TASK_PROPOSAL_RECOVERY_HISTORY_MISMATCH');
        return {confirmation:await recoverPendingConfirmation(confirmationPath,{id:input?.id,requestedBy:input?.requestedBy,subject},options),executionAuthorized:false};
      });
    },
    async decide(expected,input,options={}) {
      input=structuredClone(input);
      const gestureBoundary=options.gestureBoundary,timestamp=options.timestamp;
      return withCurrent(expected,async proposal=>{
        const request=(await inspectConfirmations(confirmationPath)).find(item=>item.id===input?.id);
        if(!request||!matches(request.subject,subjectOf(proposal)))throw Error('TASK_PROPOSAL_REVIEW_MISMATCH');
        const confirmation=await decideConfirmation(confirmationPath,input,{gestureBoundary,timestamp});
        return {confirmation,executionAuthorized:false};
      });
    },
  });
}
