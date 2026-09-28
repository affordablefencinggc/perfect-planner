import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rename,cp,lstat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createTaskNativeDispatch} from '../src/node/taskNativeDispatch.mjs';
import {createNativeTaskExecutionAdapter} from '../src/node/nativeTaskExecutionAdapter.mjs';
import {createInstalledTaskExecutionCustody} from '../src/node/installedTaskExecutionCustody.mjs';
import {createNativeTaskExecutionRequests} from '../src/node/nativeTaskExecutionRequests.mjs';
import {createNativeReviewHostComposition} from '../src/node/nativeReviewHostComposition.mjs';
import {createTaskNativeObservationStore} from '../src/node/taskNativeObservationStore.mjs';
import {createTaskNativeResultReads} from '../src/node/taskNativeResultReads.mjs';
import {createTaskNativeResultCustody} from '../src/node/taskNativeResultCustody.mjs';
import {createTaskProposalReview} from '../src/node/taskProposalReview.mjs';
import {createTaskLedgerAuthorityStore} from '../src/node/taskLedgerAuthorityStore.mjs';
import {createTaskCheckContract} from '../src/node/taskCheckContract.mjs';
import {createTaskEnrollmentStore} from '../src/node/taskEnrollmentStore.mjs';
import {createTaskExecutionGrantStore} from '../src/node/taskExecutionGrantStore.mjs';
import {createSession,releaseSession} from '../src/node/sessionRegistry.mjs';
import {candidateSnapshot} from '../src/node/mergedStateRunner.mjs';
import {emptyTaskDraftLedger,updateTaskDraft} from '../src/project/taskDraftLedger.js';
import {createTrustedUserGestureProducer} from '../src/node/confirmationStore.mjs';
const enabled=Boolean(process.env.PP_NATIVE_DISPATCH_FIXTURE), proof=[];
async function fixture(mode, taskCount=1){
  assert.equal(process.env.COMPUTERNAME.toLowerCase(),'dans1');
  const executable=path.normalize(process.env.PP_NATIVE_DISPATCH_FIXTURE);
  const executableDigest=createHash('sha256').update(await readFile(executable)).digest('hex');
  assert.equal(executableDigest,process.env.PP_NATIVE_DISPATCH_FIXTURE_SHA256);
  const root=await mkdtemp(path.join(os.tmpdir(),'pp-native-dispatch-')),candidate=path.join(root,'candidate');await mkdir(candidate);
  const init=spawnSync('C:\\Program Files\\Git\\cmd\\git.exe',['init','--quiet'],{cwd:candidate,windowsHide:true,encoding:'utf8',timeout:10000});assert.equal(init.status,0,init.stderr);
  await writeFile(path.join(candidate,'input.txt'),'controlled candidate');
  const binding={projectId:'pp_native_dispatch_fixture',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)};
  const observationDirectory=path.join(root,'observations');await mkdir(observationDirectory);
  const observationStore=createTaskNativeObservationStore({directory:observationDirectory,projectId:binding.projectId,rootIdentity:binding.rootIdentity});
  const proposalConfig={journalPath:path.join(root,'proposal.jsonl'),projectId:binding.projectId,rootIdentity:binding.rootIdentity};
  let ledger=emptyTaskDraftLedger(binding);for(let index=0;index<taskCount;index++)ledger=updateTaskDraft(ledger,{title:`Native fixture ${index+1}`,description:'Bounded controlled native check',owner:'Worker',acceptance:'Observed output',recovery:'Retain original intent',claims:[],dependsOn:[],archived:false});
  const proposal=await createTaskLedgerAuthorityStore(proposalConfig).propose(ledger,{requestId:'proposal',expectedRevision:0,expectedHeadDigest:'GENESIS'});
  const expected={hostRevision:1,headDigest:proposal.proposal.recordHash};
  const checkContract=createTaskCheckContract({schemaVersion:1,kind:'TASK_CHECK_CONTRACT',projectId:binding.projectId,rootIdentity:binding.rootIdentity,policyVersion:1,policyDigest:'c'.repeat(64),tasks:ledger.tasks.map((task,index)=>({taskId:task.id,checks:[{checkId:'native',executablePath:executable,executableDigest,args:['fixture',taskCount>1&&index===taskCount-1?'fail':mode],cwd:'.',timeoutMs:5000,outputLimits:{stdoutBytes:1000,stderrBytes:1000,combinedBytes:2000}}]}))});
  const sessionRegistryPath=path.join(root,'sessions.json'),credentials=await createSession(sessionRegistryPath,{actor:'controlled-worker',claim:'native fixture'});
  const enrollmentConfig={journalPath:path.join(root,'enrollment.jsonl'),projectId:binding.projectId,rootIdentity:binding.rootIdentity};
  const enrollments=createTaskEnrollmentStore(enrollmentConfig);
  await enrollments.publish({hostRevision:1,proposalDigest:expected.headDigest,checkContractDigest:checkContract.contractDigest,policyVersion:1,policyDigest:checkContract.policyDigest,assignments:[{taskId:'T0001',workerId:'worker-1',sessionId:credentials.id,actor:credentials.actor}]},{expectedRevision:0,requestId:'enroll'});
  const enrollment=await enrollments.inspect(),enrollmentHead={revision:enrollment.revision,epoch:enrollment.epoch,headDigest:enrollment.headDigest};
  const grantConfig={journalPath:path.join(root,'grant.jsonl'),projectId:binding.projectId,rootIdentity:binding.rootIdentity},grants=createTaskExecutionGrantStore(grantConfig);
  const review=createTaskProposalReview({proposalConfig,confirmationPath:path.join(root,'confirmation.json'),checkContract,preflightConfig:{registeredRoot:candidate,sessionRegistryPath,enrollmentConfig,grantConfig}});
  const {confirmation}=await review.request(expected,{requestedBy:'controlled-host',question:'Approve inert native fixture'});
  const producer=createTrustedUserGestureProducer({source:'controlled-test-host'});
  await review.decide(expected,{id:confirmation.id,decision:'approved',decidedBy:'Danie',userGestureEvidence:producer.capture({isTrusted:true},'Danie',{request:confirmation,decision:'approved'})},{gestureBoundary:producer.boundary});
  const snapshot=await candidateSnapshot(candidate);assert.equal(snapshot.valid,true);
  const input={taskId:'T0001',checkId:'native',attemptId:'attempt-1',attemptNumber:1,workerId:'worker-1',credentials};
  const issued=await review.issueAssignedGrant(expected,confirmation.id,enrollmentHead,input,{requestId:'issue',expectedRevision:0,ttlMs:300000});
  assert.equal(issued.grant.binding.candidateDigest,snapshot.digest);assert.equal(issued.executionAuthorized,false);
  const consumed=await review.consumeAssignedGrant(expected,confirmation.id,enrollmentHead,input,{grantId:issued.grant.grantId,requestId:'consume',expectedRevision:1});
  let launches=0;
  const nativeAdapter=process.env.PP_NATIVE_TASK_HOST?createNativeTaskExecutionAdapter({executable:path.normalize(process.env.PP_NATIVE_TASK_HOST),executableDigest:process.env.PP_NATIVE_TASK_HOST_SHA256,cwd:root,compilationTempRoot:path.join(root,'native-task-compilation')}):null;
  async function executeNative(spec,options){
    assert.equal(Object.isFrozen(spec.args),true);assert.equal(spec.executablePath,executable);assert.deepEqual(spec.args,['fixture',mode]);
    assert.equal(spec.executableDigest,createHash('sha256').update(await readFile(executable)).digest('hex'));
    // Controlled fixture bridge, not the installed production transport or a filesystem lease.
    launches++;let result;
    if(nativeAdapter){result=await nativeAdapter(spec,options);}
    else{const child=spawnSync(executable,['host-run',spec.runId,mode],{cwd:spec.cwd,windowsHide:true,encoding:'utf8',timeout:15000,maxBuffer:16384});assert.equal(child.status,0,child.stderr);result=JSON.parse(child.stdout);}
    proof.push({mode,intentDigest:spec.intentDigest,executableDigest,result});
    await writeFile(process.env.PP_NATIVE_DISPATCH_RESULTS,JSON.stringify(proof,null,2));return result;
  }
  const resultCustody=createTaskNativeResultCustody({grants,observations:observationStore});
  return {composition:{root,binding,proposalConfig,checkContract,confirmationPath:path.join(root,'confirmation.json')},review,grants,input,executeNative,nativeAdapter,candidateRoot:candidate,observationStore,resultCustody,revoke:()=>releaseSession(sessionRegistryPath,credentials),recordObservation:resultCustody.record,launches:()=>launches,args:{expected,confirmationId:confirmation.id,enrollmentHead,input,consumptionReceipt:consumed.consumptionReceipt,request:{grantId:issued.grant.grantId,requestId:'intent',expectedRevision:2}}};
}
test('installed owner composes reviewed enrollment, grant, native run and owner result custody',{skip:!enabled||!process.env.PP_NATIVE_TASK_HOST},async()=>{
 const f=await fixture('pass'),c=f.composition,stateDirectory=path.join(c.root,'installed-state');await mkdir(stateDirectory);
 let observed={...c.binding};
 const custody=createInstalledTaskExecutionCustody({stateDirectory,binding:c.binding,observeBinding:async()=>observed});
 const config={...c,registeredRoot:f.candidateRoot,actor:'native-owner-fixture',nativeConfig:{executable:path.normalize(process.env.PP_NATIVE_TASK_HOST),executableDigest:process.env.PP_NATIVE_TASK_HOST_SHA256,cwd:c.root,compilationTempRoot:path.join(stateDirectory,'compilation')}};
 const owner=custody.createExecution(config);
 const credentials=await owner.createWorker('Assigned native check');
 const assignments=[{taskId:'T0001',workerId:'owner-worker',credentials}],request={expectedRevision:0,requestId:'owner-enroll'};
 await assert.rejects(owner.enroll(f.args.expected,'missing-approval',assignments,request),/APPROVAL_UNAVAILABLE/);
 await assert.rejects(owner.enroll(f.args.expected,f.args.confirmationId,[{...assignments[0],credentials:{...credentials,token:'forged'}}],request),/authentication refused/);
 const {enrollment}=await owner.enroll(f.args.expected,f.args.confirmationId,assignments,request);
 const head={revision:enrollment.revision,epoch:enrollment.epoch,headDigest:enrollment.recordHash};
 const input={...f.input,credentials,workerId:'owner-worker'};
 observed={...c.binding,censusDigest:'f'.repeat(64)};
 await assert.rejects(owner.issue(f.args.expected,f.args.confirmationId,head,input,{requestId:'owner-issue',expectedRevision:0,ttlMs:300000}),/BINDING_CHANGED/);observed={...c.binding};
 const issued=await owner.issue(f.args.expected,f.args.confirmationId,head,input,{requestId:'owner-issue',expectedRevision:0,ttlMs:300000});
 const consumed=await owner.consume(f.args.expected,f.args.confirmationId,head,input,{grantId:issued.grant.grantId,requestId:'owner-consume',expectedRevision:1});
 const args={expected:f.args.expected,confirmationId:f.args.confirmationId,enrollmentHead:head,input,consumptionReceipt:consumed.consumptionReceipt,request:{grantId:issued.grant.grantId,requestId:'owner-intent',expectedRevision:2}};
 const result=await owner.dispatch(args);assert.equal(result.observation.exitCode,0);assert.equal(result.dispatchObserved,true);
 assert.equal((await owner.dispatch(args)).dispatchObserved,false);
 const saved=await custody.results.readOwner({grantId:issued.grant.grantId});assert.equal(saved.process.exitCode,0);assert.equal(saved.journalLinked,true);
 const failedOwner=custody.createExecution({...config,nativeConfig:{...config.nativeConfig,executableDigest:'f'.repeat(64)}}),retryInput={...input,attemptId:'attempt-2',attemptNumber:2};
 const next=await failedOwner.issue(f.args.expected,f.args.confirmationId,head,retryInput,{requestId:'next-issue',expectedRevision:4,ttlMs:300000});
 const nextConsumed=await failedOwner.consume(f.args.expected,f.args.confirmationId,head,retryInput,{grantId:next.grant.grantId,requestId:'next-consume',expectedRevision:5});
 await assert.rejects(failedOwner.dispatch({...args,input:retryInput,consumptionReceipt:nextConsumed.consumptionReceipt,request:{grantId:next.grant.grantId,requestId:'next-intent',expectedRevision:6}}),/NATIVE_TASK_DISPATCH_UNRESOLVED/);
 assert.equal((await failedOwner.shutdown()).cleanupComplete,false);
 await owner.releaseWorker(credentials);await assert.rejects(owner.inspectOriginal({...input,grantId:issued.grant.grantId}),/authentication refused/);
 assert.equal((await owner.shutdown()).cleanupComplete,true);assert.throws(()=>owner.createWorker('after close'),/CLOSED/);
});

test('actual native output with a mismatched retention binding preserves unresolved intent without relaunch',{skip:!enabled||!process.env.PP_NATIVE_TASK_HOST},async()=>{
 for(const key of ['candidateDigest','checkContractDigest']){
  const f=await fixture('pass');let captured;
  const dispatch=createTaskNativeDispatch({review:f.review,executeNative:f.executeNative,recordObservation:async input=>{
   captured=structuredClone(input);
   assert.notEqual(input.executionSpec[key],'f'.repeat(64));
   return f.recordObservation({...input,executionSpec:{...input.executionSpec,[key]:'f'.repeat(64)}});
  }});
  await assert.rejects(dispatch.dispatch(f.args),error=>error.message==='NATIVE_TASK_DISPATCH_UNRESOLVED'&&error.cause?.message==='NATIVE_TASK_OBSERVATION_CUSTODY_UNRESOLVED');
  assert.equal(f.launches(),1);assert.equal(captured.observation.exitCode,0);
  await assert.rejects(lstat(path.join(f.composition.root,'observations',captured.intentReceipt.runId+'.json')),{code:'ENOENT'});
  const before=await readFile(path.join(f.composition.root,'grant.jsonl'));
  const state=await f.grants.inspect();assert.equal(state.revision,3);assert.equal(state.history.some(row=>row.event==='result-recorded'),false);
  const replay=await dispatch.dispatch(f.args);assert.equal(replay.dispatchObserved,false);assert.equal(replay.state,'original-intent-retained');assert.equal(f.launches(),1);
  assert.deepEqual(await readFile(path.join(f.composition.root,'grant.jsonl')),before);
  // Explicitly retain the authentic in-memory control observation; never rerun
  // the native process to repair missing custody or forge completion authority.
  const controlReceipt=await f.recordObservation(captured);
  const reopened=createTaskNativeObservationStore({directory:path.join(f.composition.root,'observations'),projectId:f.composition.binding.projectId,rootIdentity:f.composition.binding.rootIdentity});
  const saved=await reopened.inspect(captured.intentReceipt);assert.equal(saved.observation.exitCode,0);assert.equal(saved.receipt.state,'result-unverified');assert.equal(saved.receipt.executionAuthorized,false);
  assert.deepEqual(saved.observation,captured.observation);assert.deepEqual(saved.receipt,controlReceipt);
  assert.equal(saved.receipt.intentDigest,captured.intentReceipt.recordDigest);assert.equal(saved.receipt.runId,captured.intentReceipt.runId);
  assert.equal((await f.grants.inspect()).revision,4);assert.equal(f.launches(),1);
 }
});
test('durable installed execution request retains failed native result without retrying the run',{skip:!enabled||!process.env.PP_NATIVE_TASK_HOST},async()=>{
 const f=await fixture('fail'),c=f.composition,stateDirectory=path.join(c.root,'request-state');await mkdir(stateDirectory);
 const custody=createInstalledTaskExecutionCustody({stateDirectory,binding:c.binding,observeBinding:async()=>c.binding});
 const ownerConfig={...c,registeredRoot:f.candidateRoot,actor:'request-owner-fixture',nativeConfig:{executable:path.normalize(process.env.PP_NATIVE_TASK_HOST),executableDigest:process.env.PP_NATIVE_TASK_HOST_SHA256,cwd:c.root,compilationTempRoot:path.join(stateDirectory,'compilation')}};
 const selection={expected:f.args.expected,contractHead:{revision:1,headDigest:'a'.repeat(64)}};
 const config={directory:path.join(stateDirectory,'requests'),binding:c.binding,selection,owner:custody.createExecution(ownerConfig)},requests=createNativeTaskExecutionRequests(config);
 const request={requestId:'saved-native-request',...selection,confirmationId:f.args.confirmationId,taskId:'T0001',checkId:'native',attemptId:'request-attempt',attemptNumber:1};
 const composed=executionRequests=>createNativeReviewHostComposition({...c,registeredBinding:async()=>c.binding,actor:'fixture-owner',source:'controlled-fixture',presenterConfig:{executable:path.join(c.root,'unused-presenter.exe'),executableDigest:'f'.repeat(64),cwd:c.root},executionRequests,taskResults:custody.results});
 const host=composed(requests),call=async(h,command,id)=>{const reply=JSON.parse(await h.dispatchLine(JSON.stringify({version:1,requestId:id,command,payload:request})));assert.equal(reply.ok,true,JSON.stringify(reply));return reply.result;};
 const first=await call(host,'execute-check','transport-1');assert.equal(first.state,'result-recorded');assert.equal(first.executionAuthorized,false);
 const saved=await custody.results.readOwner({grantId:first.grantId});assert.equal(saved.process.exitCode,7);assert.equal(saved.state,'failure-observed');
 assert.equal((await host.shutdown()).cleanupComplete,true);assert.equal((await config.owner.shutdown()).cleanupComplete,true);
 // Simulate interruption after durable observation/session release but before
 // publishing the request's terminal receipt. Preserve the removed artifact.
 const requestKey=createHash('sha256').update(request.requestId).digest('hex');
 const terminalFile=path.join(config.directory,`${requestKey}.result.json`);
 await rename(terminalFile,terminalFile+'.interrupted-fixture');
 const refused=createNativeTaskExecutionRequests({...config,owner:custody.createExecution(ownerConfig)});
 await assert.rejects(refused.execute(request),/UNRESOLVED/);
 assert.equal((await refused.shutdown()).cleanupComplete,false);
 const reopened=createNativeTaskExecutionRequests({...config,owner:custody.createExecution(ownerConfig)});
 assert.deepEqual(await reopened.recover(request),first);
 const reopenedHost=composed(reopened);
 assert.deepEqual(await call(reopenedHost,'execute-check','transport-2'),first);assert.deepEqual(await call(reopenedHost,'recover-check-execution','transport-3'),first);assert.equal((await custody.grants.inspect()).revision,4);assert.equal((await reopenedHost.shutdown()).cleanupComplete,true);
});
test('production bridge refuses expired grants and changed candidates before native launch',{skip:!enabled||!process.env.PP_NATIVE_TASK_HOST},async()=>{
 const f=await fixture('pass');
 const spec={timeoutMs:1000,intentDigest:'a'.repeat(64),registeredRoot:f.candidateRoot,candidateDigest:'f'.repeat(64)};
 await assert.rejects(f.nativeAdapter(spec,{expiresAt:'2000-01-01T00:00:00.000Z'}),/NATIVE_TASK_GRANT_EXPIRED/);
 await assert.rejects(f.nativeAdapter(spec,{expiresAt:new Date(Date.now()+60000).toISOString()}),/NATIVE_TASK_CANDIDATE_CHANGED/);
 assert.equal(f.launches(),0);
});
test('real native check follows reviewed intent once despite concurrent replay',{skip:!enabled},async()=>{
  const f=await fixture('pass'),dispatch=createTaskNativeDispatch(f);
  await assert.rejects(dispatch.dispatch({...f.args,input:{...f.input,workerId:'foreign'}}),/NOT_ASSIGNED/);assert.equal(f.launches(),0);
  const replies=await Promise.all([dispatch.dispatch(f.args),dispatch.dispatch(f.args)]);
  assert.equal(f.launches(),1);assert.equal(replies.filter(reply=>reply.dispatchObserved).length,1);
  const completed=replies.find(reply=>reply.dispatchObserved);assert.equal(completed.observation.exitCode,0);
  assert.equal(completed.observation.processExited,true);assert.equal(completed.observation.ioSettled,true);
  assert.match(completed.observation.stdout,/native fixture executed/);assert.equal(completed.state,'result-unverified');
  assert.equal(completed.executionAuthorized,false);assert.equal((await f.grants.inspect()).revision,4);
  assert.deepEqual((await f.observationStore.inspect(completed.intentReceipt)).receipt,completed.observationReceipt);
});
test('lost custody reply after native execution recovers saved failure without a second launch',{skip:!enabled},async()=>{
 const f=await fixture('fail'),dispatch=createTaskNativeDispatch({...f,recordObservation:async input=>{await f.recordObservation(input);throw Error('controlled lost custody reply');}});
 await assert.rejects(dispatch.dispatch(f.args),/NATIVE_TASK_DISPATCH_UNRESOLVED/);assert.equal(f.launches(),1);
 const retry=await createTaskNativeDispatch(f).dispatch(f.args);assert.equal(retry.dispatchObserved,false);assert.equal(f.launches(),1);
 const saved=await f.observationStore.inspect(retry.intentReceipt);assert.equal(saved.observation.exitCode,7);assert.equal(saved.receipt.state,'result-unverified');
 const reader=createTaskNativeResultReads({review:f.review,observations:f.observationStore}),query={...f.input,grantId:f.args.request.grantId};
 const summary=await reader.readOwn(query);assert.equal(summary.state,'failure-observed');assert.deepEqual(summary.failureReasons,['nonzero-exit']);assert.equal(summary.process.exitCode,7);assert.equal(summary.runId,retry.intentReceipt.runId);
 assert.equal(summary.journalLinked,true);assert.equal(summary.observationLinkDigest,(await f.grants.inspect()).history[3].recordHash);
 const reconciled=await f.resultCustody.reconcile(retry.intentReceipt);assert.equal(reconciled.observationLink.recordDigest,summary.observationLinkDigest);assert.equal((await f.grants.inspect()).revision,4);assert.equal(f.launches(),1);
 await assert.rejects(reader.readOwn({...query,workerId:'foreign'}),/UNAVAILABLE/);await f.revoke();await assert.rejects(reader.readOwn(query));assert.equal(f.launches(),1);
});
test('lost reply after actual failed native execution cannot cause a relaunch',{skip:!enabled},async()=>{
  const f=await fixture('fail');const dispatch=createTaskNativeDispatch({review:f.review,executeNative:async (spec,options)=>{const result=await f.executeNative(spec,options);assert.equal(result.exitCode,7);throw Error('controlled lost reply after native exit');}});
  await assert.rejects(dispatch.dispatch(f.args),/NATIVE_TASK_DISPATCH_UNRESOLVED/);assert.equal(f.launches(),1);
  const reopened=createTaskNativeDispatch(f),retry=await reopened.dispatch(f.args);assert.equal(retry.dispatchObserved,false);assert.equal(f.launches(),1);
  const recovered=await reopened.inspectOriginal({...f.input,grantId:f.args.request.grantId});
  assert.equal(recovered.intentReceipt.runId,retry.intentReceipt.runId);assert.equal(recovered.intentReceipt.state,'launch-unresolved');assert.equal(recovered.launchAllowed,false);
});

test('155 actual native checks preserve one failure and every result across owner restart', {skip:!enabled||!process.env.PP_NATIVE_TASK_HOST||process.env.PP_NATIVE_POPULATION!=='155',timeout:900000},async()=>{
  const file=process.env.PP_NATIVE_DISPATCH_RESULTS;
 let prior;try{prior=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 const f=prior?prior.fixture:await fixture('pass',155),c=f.composition,stateDirectory=path.join(c.root,'population-state');
 if(!prior)await mkdir(stateDirectory);
 const custodyConfig={stateDirectory,binding:c.binding,observeBinding:async()=>c.binding};
 const custody=createInstalledTaskExecutionCustody(custodyConfig);
 const ownerConfig={...c,registeredRoot:f.candidateRoot,actor:'population-owner-fixture',nativeConfig:{executable:path.normalize(process.env.PP_NATIVE_TASK_HOST),executableDigest:process.env.PP_NATIVE_TASK_HOST_SHA256,cwd:c.root,compilationTempRoot:path.join(stateDirectory,'compilation')}};
 const selection={expected:f.args.expected,contractHead:{revision:1,headDigest:'a'.repeat(64)}};
 const owner=custody.createExecution(ownerConfig),directory=path.join(stateDirectory,'requests');
 const requests=createNativeTaskExecutionRequests({directory,binding:c.binding,selection,owner});
 const receipts=prior?.receipts??[],outcomes=prior?.outcomes??[];
 assert.equal(receipts.length,outcomes.length,"Interrupted batch needs explicit original recovery");
 const evidence={scope:'Private controlled approval; actual native executions, not verified task completion',fixture:{composition:c,candidateRoot:f.candidateRoot,args:{expected:f.args.expected,confirmationId:f.args.confirmationId}},root:c.root,selection,receipts,outcomes,batches:prior?.batches??[],notStarted:prior?.notStarted??[]};
 const save=()=>writeFile(process.env.PP_NATIVE_DISPATCH_RESULTS,JSON.stringify(evidence,null,2));
 await save();
 const start=outcomes.length+1,end=Math.min(155,start+9);
 for(let index=start;index<=end;index++){
  const taskId=`T${String(index).padStart(4,'0')}`;
  let request={requestId:`population-${index}`,...selection,confirmationId:f.args.confirmationId,taskId,checkId:'native',attemptId:`population-attempt-${index}`,attemptNumber:1};
  if(index===128&&process.env.PP_NATIVE_POPULATION_RECOVERY==='population-128'){
   const disposition=await requests.recover(request);assert.equal(disposition.state,'not-started');
   evidence.notStarted.push({request,receipt:disposition});await save();
   request={...request,requestId:'population-128-repair',attemptId:'population-attempt-128-repair',attemptNumber:2};
  }
  const receipt=await requests.execute(request);receipts.push({request,receipt});await save();
  const result=await custody.results.readOwner({grantId:receipt.grantId});outcomes.push(result);await save();
  assert.equal(result.taskId,taskId);assert.equal(result.process.exitCode,index===155?7:0);
  assert.equal(result.process.processExited,true);assert.equal(result.process.jobEmptyObserved,true);assert.equal(result.process.ioSettled,true);
  assert.equal(result.journalLinked,true);assert.equal(result.authorityVerified,false);
  assert.equal(result.state,index===155?'failure-observed':'result-unverified');
  assert.deepEqual(result.failureReasons,index===155?['nonzero-exit']:[]);
  if(index%10===0||index===155)console.log(`Native population: ${index}/155 retained`);
 }
 assert.equal(new Set(outcomes.map(v=>v.runId)).size,end);
 assert.equal(new Set(outcomes.map(v=>v.taskId)).size,end);
 assert.equal((await requests.shutdown()).cleanupComplete,true);assert.equal((await owner.shutdown()).cleanupComplete,true);
 const reopened=createInstalledTaskExecutionCustody(custodyConfig),reopenedOwner=reopened.createExecution(ownerConfig);
 const reopenedRequests=createNativeTaskExecutionRequests({directory,binding:c.binding,selection,owner:reopenedOwner});
 const before=await reopened.grants.inspect();assert.equal(before.revision,end*4);
 let offset=0,head=null,pages=0;const restored=[];
 do{
  const result=await reopened.results.readPageOwner({offset,expectedHeadDigest:head});
  head??=result.page.journalHead.headDigest;assert.equal(result.page.totalGrants,end);
  for(const outcome of result.outcomes){assert.equal(outcome.phase,'ready');restored.push(outcome.value);}
  offset=result.page.nextOffset;pages++;
 }while(offset!==null);
 assert.equal(pages,Math.ceil(end/20));assert.equal(restored.length,end);
 const order=values=>[...values].sort((a,b)=>a.taskId.localeCompare(b.taskId));
 assert.deepEqual(order(restored),order(outcomes));
 for(const index of [0,end-1])assert.deepEqual(await reopenedRequests.execute(receipts[index].request),receipts[index].receipt);
 assert.deepEqual(await reopened.grants.inspect(),before);
 evidence.reopened={pages,outcomes:restored.length,journalRevision:before.revision,headDigest:head,replayedWithoutJournalMutation:true};
 assert.equal((await reopenedRequests.shutdown()).cleanupComplete,true);assert.equal((await reopenedOwner.shutdown()).cleanupComplete,true);
 evidence.batches.push({start,end,reopened:evidence.reopened});evidence.verdict=end===155?'PASS':'PARTIAL';await save();
});

test('owner proves exact released pre-grant enrollment without starting or discarding an original', {skip:!enabled||!process.env.PP_NATIVE_TASK_HOST},async()=>{
 const f=await fixture('pass'),c=f.composition,stateDirectory=path.join(c.root,'not-started-state');await mkdir(stateDirectory);
 let observed={...c.binding};
 const custody=createInstalledTaskExecutionCustody({stateDirectory,binding:c.binding,observeBinding:async()=>observed});
 const config={...c,registeredRoot:f.candidateRoot,actor:'not-started-owner',nativeConfig:{executable:path.normalize(process.env.PP_NATIVE_TASK_HOST),executableDigest:process.env.PP_NATIVE_TASK_HOST_SHA256,cwd:c.root,compilationTempRoot:path.join(stateDirectory,'compilation')}};
 const owner=custody.createExecution(config),selection={expected:f.args.expected,contractHead:{revision:1,headDigest:'a'.repeat(64)}};
 const request={requestId:'refused-before-grant',...selection,confirmationId:f.args.confirmationId,taskId:'T0001',checkId:'native',attemptId:'not-started-attempt',attemptNumber:1};
 const key=createHash('sha256').update(request.requestId).digest('hex'),workerId=`native-${key.slice(0,32)}`;
 const credentials=await owner.createWorker('Exact refused request');
 await owner.enroll(request.expected,request.confirmationId,[{taskId:request.taskId,workerId,credentials}],{expectedRevision:0,requestId:`enroll-${key}`});
 await assert.rejects(owner.inspectNotStarted(request),/UNRESOLVED/); // live worker is not settled
 await owner.releaseWorker(credentials);
 const before=await custody.grants.inspect(),proof=await owner.inspectNotStarted(request);
 assert.equal(proof.kind,'NATIVE_CHECK_NOT_STARTED_PROOF');assert.equal(proof.sessionReleased,true);assert.equal(proof.grantAbsent,true);assert.equal(proof.launchObserved,false);assert.equal(proof.executionAuthorized,false);
 assert.equal(Object.isFrozen(proof),true);assert.equal(JSON.stringify(proof).includes(credentials.token),false);
 assert.deepEqual(await custody.grants.inspect(),before);assert.equal(f.launches(),0);
 const reopened=custody.createExecution(config);assert.deepEqual(await reopened.inspectNotStarted(request),proof);
 for(const patch of [{requestId:'other'},{taskId:'T0002'},{checkId:'foreign'},{confirmationId:'foreign'}])await assert.rejects(reopened.inspectNotStarted({...request,...patch}));
 observed={...c.binding,censusDigest:'e'.repeat(64)};await assert.rejects(reopened.inspectNotStarted(request),/BINDING_CHANGED/);observed={...c.binding};
 assert.equal((await reopened.shutdown()).cleanupComplete,true);
 assert.equal((await owner.shutdown()).cleanupComplete,true);
});

test('owner refuses not-started proof once any exact worker grant exists', {skip:!enabled||!process.env.PP_NATIVE_TASK_HOST},async()=>{
 const f=await fixture('pass'),c=f.composition,stateDirectory=path.join(c.root,'issued-no-proof');await mkdir(stateDirectory);
 const custody=createInstalledTaskExecutionCustody({stateDirectory,binding:c.binding,observeBinding:async()=>c.binding});
 const owner=custody.createExecution({...c,registeredRoot:f.candidateRoot,actor:'issued-owner',nativeConfig:{executable:path.normalize(process.env.PP_NATIVE_TASK_HOST),executableDigest:process.env.PP_NATIVE_TASK_HOST_SHA256,cwd:c.root,compilationTempRoot:path.join(stateDirectory,'compilation')}});
 const request={requestId:'issued-original',expected:f.args.expected,contractHead:{revision:1,headDigest:'a'.repeat(64)},confirmationId:f.args.confirmationId,taskId:'T0001',checkId:'native',attemptId:'issued-attempt',attemptNumber:1};
 const key=createHash('sha256').update(request.requestId).digest('hex'),workerId=`native-${key.slice(0,32)}`,credentials=await owner.createWorker('Issued original');
 const {enrollment:e}=await owner.enroll(request.expected,request.confirmationId,[{taskId:request.taskId,workerId,credentials}],{expectedRevision:0,requestId:`enroll-${key}`});
 const issued=await owner.issue(request.expected,request.confirmationId,{revision:e.revision,epoch:e.epoch,headDigest:e.recordHash},{taskId:request.taskId,checkId:request.checkId,attemptId:request.attemptId,attemptNumber:1,workerId,credentials},{requestId:`issue-${key}`,expectedRevision:0,ttlMs:300000});
 await owner.releaseWorker(credentials);await assert.rejects(owner.inspectNotStarted(request),/UNRESOLVED/);
 assert.equal((await custody.grants.inspect()).grants[0].grant.grantId,issued.grant.grantId);assert.equal(f.launches(),0);assert.equal((await owner.shutdown()).cleanupComplete,true);
});

test('large candidate native execution retains complete identity across owner reopen',{skip:!enabled||!process.env.PP_NATIVE_TASK_HOST||!process.env.PP_NATIVE_LARGE_CANDIDATE},async()=>{
 const source=path.resolve(process.env.PP_NATIVE_LARGE_CANDIDATE);
 assert.equal(source,path.resolve('C:/Users/danie/Documents/perfect-planner-tests/boundaries-copy-20260927-51/boundary-viewer'));
 assert.equal((await lstat(source)).isSymbolicLink(),false);
 const f=await fixture('pass'),c=f.composition;
 const evidence={host:os.hostname(),scope:'Disposable content copy, inert native check and scripted private approval. Not Boundaries code execution or human approval.',candidateRoot:f.candidateRoot,source,steps:[]};
 const save=()=>writeFile(process.env.PP_NATIVE_LARGE_EVIDENCE,JSON.stringify(evidence,null,2));await save();
 await cp(source,path.join(f.candidateRoot,'boundaries-content'),{recursive:true,errorOnExist:true,force:false});
 evidence.steps.push({name:'copy-complete',at:new Date().toISOString()});await save();
 const snapshot=await candidateSnapshot(f.candidateRoot);assert.equal(snapshot.valid,true,JSON.stringify(snapshot));assert.ok(snapshot.files>50000);assert.ok(snapshot.bytes>512*1024*1024);evidence.snapshot=snapshot;await save();
 const stateDirectory=path.join(c.root,'large-request-state');await mkdir(stateDirectory);
 const custody=createInstalledTaskExecutionCustody({stateDirectory,binding:c.binding,observeBinding:async()=>c.binding});
 const ownerConfig={...c,registeredRoot:f.candidateRoot,actor:'large-candidate-fixture',nativeConfig:{executable:path.normalize(process.env.PP_NATIVE_TASK_HOST),executableDigest:process.env.PP_NATIVE_TASK_HOST_SHA256,cwd:c.root,compilationTempRoot:path.join(stateDirectory,'compilation')}};
 const selection={expected:f.args.expected,contractHead:{revision:1,headDigest:'a'.repeat(64)}};
 const owner=custody.createExecution(ownerConfig),config={directory:path.join(stateDirectory,'requests'),binding:c.binding,selection,owner};
 const requests=createNativeTaskExecutionRequests(config);
 const request={requestId:'large-native-request',...selection,confirmationId:f.args.confirmationId,taskId:'T0001',checkId:'native',attemptId:'large-attempt',attemptNumber:1};
 evidence.executionStartedAt=new Date().toISOString();await save();
 const receipt=await requests.execute(request);evidence.receipt=receipt;await save();
 const result=await custody.results.readOwner({grantId:receipt.grantId});assert.equal(result.process.exitCode,0);assert.equal(result.journalLinked,true);
 const journal=await custody.grants.inspect();assert.equal(journal.revision,4);assert.equal(journal.grants[0].grant.binding.candidateDigest,snapshot.digest);
 assert.equal((await requests.shutdown()).cleanupComplete,true);assert.equal((await owner.shutdown()).cleanupComplete,true);
 const reopenedOwner=custody.createExecution(ownerConfig),reopened=createNativeTaskExecutionRequests({...config,owner:reopenedOwner});
 assert.deepEqual(await reopened.execute(request),receipt);assert.deepEqual(await reopened.recover(request),receipt);
 assert.deepEqual(await custody.grants.inspect(),journal);
 assert.equal((await reopened.shutdown()).cleanupComplete,true);assert.equal((await reopenedOwner.shutdown()).cleanupComplete,true);
 evidence.result=result;evidence.grantRevision=journal.revision;evidence.replayUnchanged=true;evidence.finishedAt=new Date().toISOString();evidence.verdict='PASS';await save();
});
