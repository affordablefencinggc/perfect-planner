import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createNativeTaskReviewFlow} from '../src/node/nativeTaskReviewFlow.mjs';
import {createNativeReviewHostProtocol} from '../src/node/nativeReviewHostProtocol.mjs';
import {createTaskLedgerAuthorityStore} from '../src/node/taskLedgerAuthorityStore.mjs';
import {createTaskProposalReview} from '../src/node/taskProposalReview.mjs';
import {createWindowsDpapiRunner} from '../src/node/windowsDpapiSecretCustody.mjs';
import {createTaskCheckContract} from '../src/node/taskCheckContract.mjs';
import {prepareInstalledTaskCheckProfile} from '../src/node/installedTaskCheckProfile.mjs';
import {inspectConfirmations} from '../src/node/confirmationStore.mjs';
import {emptyTaskDraftLedger,updateTaskDraft} from '../src/project/taskDraftLedger.js';

async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'pp-native-review-flow-'));
  const binding={projectId:'pp_native_review_fixture',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)};
  const proposalConfig={journalPath:path.join(root,'proposal.jsonl'),projectId:binding.projectId,rootIdentity:binding.rootIdentity};
  const ledger=updateTaskDraft(emptyTaskDraftLedger(binding),{title:'Exact task',description:'Do not lose scope',owner:'Display owner',acceptance:'Check all outcomes',recovery:'Retain original work',claims:[],dependsOn:[],archived:false});
  const store=createTaskLedgerAuthorityStore(proposalConfig);
  const first=await store.propose(ledger,{requestId:'first',expectedRevision:0,expectedHeadDigest:'GENESIS'});
  const checkContract=createTaskCheckContract({schemaVersion:1,kind:'TASK_CHECK_CONTRACT',projectId:binding.projectId,rootIdentity:binding.rootIdentity,policyVersion:1,policyDigest:'c'.repeat(64),tasks:[{taskId:'T0001',checks:[{checkId:'unit',executablePath:process.execPath,executableDigest:'d'.repeat(64),args:['--version'],cwd:'.',timeoutMs:1000,outputLimits:{stdoutBytes:1000,stderrBytes:1000,combinedBytes:2000}}]}]});
  // Controlled closure fixture, never a physical-window or human-gesture proof.
  return {proposalConfig,checkContract,confirmationPath:path.join(root,'confirmations.json'),store,ledger,expected:{hostRevision:1,headDigest:first.proposal.recordHash},actor:'Danie',source:'controlled-host-test-not-native-proof',verifyPresentationClosed:async binding=>({requestId:binding.requestId,closed:true})};
}
const answer=decision=>({decision,rationale:'Reviewed exact task and checks',nativeEvent:{isTrusted:true}});

test('repository script evidence is required, policy-bound and captured in the exact native display',async()=>{
 const f=await fixture(),root=path.dirname(f.confirmationPath);
 const scripts={pretest:'node before-tests.cjs',test:'node custom-tests.cjs',posttest:'node after-tests.cjs',prebuild:'node check-boundaries.cjs',build:'npm run compile',compile:'node custom-build.cjs'};
 await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'other-repository',scripts}));
 await fs.writeFile(path.join(root,'package-lock.json'),'{"lockfileVersion":3}');
 const npm=path.join(root,'npm-cli.js');await fs.writeFile(npm,'// inert fixture');
 const prepared=await prepareInstalledTaskCheckProfile({profile:{profileId:'npm-project-checks-v1',registeredRoot:root,npmCli:{path:npm,sha256:createHash('sha256').update('// inert fixture').digest('hex')},assignments:[{taskId:'T0001',categories:['tests','build']}],expectedProposal:f.expected,request:{requestId:'prepare',expectedRevision:0,expectedHeadDigest:'GENESIS'}},installed:{manifestDigest:'a'.repeat(64),nodeExecutable:process.execPath,files:[{path:'runtime/node.exe',sha256:'b'.repeat(64)}]},proposal:{hostRevision:1,recordHash:f.expected.headDigest,ledger:f.ledger}});
 const config={...f,checkContract:prepared.contract,presentNativeReview:async()=>null};
 assert.throws(()=>createNativeTaskReviewFlow(config),/SCRIPT_EVIDENCE_REQUIRED/);
 const changed=structuredClone(prepared.evidence);changed.scriptDefinitions.compile='node substituted.cjs';
 assert.throws(()=>createNativeTaskReviewFlow({...config,checkProfileEvidence:changed}),/DIGEST_MISMATCH/);
 const evidence=structuredClone(prepared.evidence);let displayed=false;
 const flow=createNativeTaskReviewFlow({...config,checkProfileEvidence:evidence,presentNativeReview:async display=>{
  displayed=true;assert.deepEqual(display.checkProfileEvidence.scriptDefinitions,scripts);assert.deepEqual(display.repositoryScriptRuns.map(run=>run.lifecycle.map(item=>item.name)),[['pretest','test','posttest'],['prebuild','build']]);assert.equal(display.repositoryScriptRuns[1].lifecycle[0].command,scripts.prebuild);assert.ok(Object.isFrozen(display.repositoryScriptRuns));assert.ok(Object.isFrozen(display.checkProfileEvidence.scriptDefinitions));assert.equal(display.checkContract.policyDigest,prepared.contract.policyDigest);return null;
 }});
 evidence.scriptDefinitions.test='node changed-after-construction.cjs';
 const result=await flow.reviewProposal(f.expected);assert.equal(displayed,true);assert.equal(result.confirmation.status,'cancelled');assert.equal(result.executionAuthorized,false);
});

test('each completed decision closes exact presentation before reply and survives restart',async()=>{
 for(const decision of ['approved','rejected','cancelled']){
  const f=await fixture();let verified=0;
  const config={...f,presentNativeReview:async()=>decision==='cancelled'?null:answer(decision),verifyPresentationClosed:async binding=>{
   verified++;assert.ok(Object.isFrozen(binding));const recorded=(await inspectConfirmations(f.confirmationPath)).find(item=>item.id===binding.requestId);assert.equal(recorded.status,decision);return {requestId:binding.requestId,closed:true};
  }};
  const result=await createNativeTaskReviewFlow(config).reviewProposal(f.expected);assert.equal(verified,1);assert.equal(result.confirmation.status,decision);assert.equal(result.nativeGestureVerified,false);assert.equal(result.executionAuthorized,false);
  const restarted=createNativeTaskReviewFlow(config);assert.equal((await restarted.inspectRecoveryState()).unresolvedPresentation,null);assert.equal((await restarted.recoverFailedPresentation()).recovered,false);
 }
});

test('missing, mismatched, throwing or refused closure preserves committed approval',async()=>{
 for(const mode of ['missing','wrong','refused','throw']){
  const f=await fixture(),verifyPresentationClosed=mode==='missing'?undefined:async binding=>{if(mode==='throw')throw Error('closure offline');return {requestId:mode==='wrong'?'other':binding.requestId,closed:mode!=='refused'};};
  const flow=createNativeTaskReviewFlow({...f,verifyPresentationClosed,presentNativeReview:async()=>answer('approved')});
  await assert.rejects(flow.reviewProposal(f.expected),/CLOSURE|closure offline/);assert.equal((await inspectConfirmations(f.confirmationPath))[0].status,'approved');assert.ok((await flow.inspectRecoveryState()).unresolvedPresentation);await assert.rejects(flow.reviewProposal(f.expected),/PRESENTATION_UNRESOLVED/);
 }
});

test('stalled closure keeps review busy and late cancellation preserves committed decision',async()=>{
 const f=await fixture();let entered,release;const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const flow=createNativeTaskReviewFlow({...f,presentNativeReview:async()=>answer('approved'),verifyPresentationClosed:async binding=>{entered();await gate;return {requestId:binding.requestId,closed:true};}});
 const pending=flow.reviewProposal(f.expected);await started;
 await assert.rejects(flow.reviewProposal(f.expected),/BUSY/);await assert.rejects(flow.recoverFailedPresentation(),/BUSY/);
 assert.equal((await flow.cancelActiveReview()).confirmation.status,'approved');assert.equal((await inspectConfirmations(f.confirmationPath))[0].status,'approved');
 release();const result=await pending;assert.equal(result.confirmation.status,'approved');assert.equal(result.nativeGestureVerified,false);assert.equal(result.executionAuthorized,false);assert.equal((await flow.inspectRecoveryState()).unresolvedPresentation,null);
});

test('closure append or sync failure does not turn a committed approval into success',async t=>{
 for(const failure of ['write','sync']){
  const f=await fixture(),actualOpen=fs.open;let writes=0;
  const mock=t.mock.method(fs,'open',async(...args)=>{
   const handle=await actualOpen(...args);
   if(args[0]===`${f.confirmationPath}.presentations.jsonl`&&(args[1]&1)&&++writes===2){
    if(failure==='write')handle.writeFile=async()=>{throw Error('closure append refused');};
    else handle.sync=async()=>{throw Error('closure sync uncertain');};
   }
   return handle;
  });syncBuiltinESMExports();
  try{
   const flow=createNativeTaskReviewFlow({...f,presentNativeReview:async()=>answer('approved')});await assert.rejects(flow.reviewProposal(f.expected),/closure/);assert.equal((await inspectConfirmations(f.confirmationPath))[0].status,'approved');assert.ok(flow.inspectPresentationState().unresolvedPresentation);
   const restarted=createNativeTaskReviewFlow({...f,presentNativeReview:async()=>null});const recovery=await restarted.inspectRecoveryState();
   // A failed sync can leave a complete close visible on a new read, but the
   // original call must still refuse success; no power-loss durability claim.
   assert.equal(Boolean(recovery.unresolvedPresentation),failure==='write');
  }finally{mock.mock.restore();syncBuiltinESMExports();}
 }
});

test('private host decision verifier binds exact display without fabricating a native event',async()=>{
 const f=await fixture();let displayed,calls=0;
 const flow=createNativeTaskReviewFlow({...f,presentNativeReview:async display=>{displayed=display;return {decision:'approved',rationale:'Exact private record',decisionEvidence:'window-event-1'};},verifyNativeDecision:async query=>{
  calls++;assert.ok(Object.isFrozen(query));assert.equal(query.requestId,displayed.requestId);
  assert.equal(query.displayDigest,createHash('sha256').update(JSON.stringify(displayed)).digest('hex'));
  assert.equal(query.evidence,'window-event-1');
  return {...query,trusted:true,eventId:'host-event-1',occurredAt:new Date().toISOString()};
 }});
 const result=await flow.reviewProposal(f.expected);assert.equal(result.confirmation.status,'approved');assert.equal(calls,1);
 assert.equal(result.nativeGestureVerified,false);assert.equal(result.executionAuthorized,false);
 assert.equal((await flow.inspectRecoveryState()).unresolvedPresentation,null);
});

test('cancel while private decision verification is stalled refuses late approval',async()=>{
 const f=await fixture();let entered,release;
 const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 const flow=createNativeTaskReviewFlow({...f,presentNativeReview:async()=>({decision:'approved',rationale:'Review',decisionEvidence:'native-record'}),verifyNativeDecision:async query=>{
  entered();await gate;return {...query,trusted:true,eventId:'event',occurredAt:new Date().toISOString()};
 }});
 const pending=flow.reviewProposal(f.expected);const rejected=assert.rejects(pending);await started;
 const cancelled=flow.cancelActiveReview();release();await rejected;await cancelled;
 assert.equal((await inspectConfirmations(f.confirmationPath))[0].status,'cancelled');
 assert.ok((await flow.inspectRecoveryState()).unresolvedPresentation);
});

test('private host mode refuses self-attested events and mismatched decision records',async()=>{
 for(const failure of ['missing-evidence','request','digest','decision','untrusted']){
  const f=await fixture();let calls=0;
  const flow=createNativeTaskReviewFlow({...f,presentNativeReview:async()=>({...answer('approved'),...(failure==='missing-evidence'?{}:{decisionEvidence:'event'})}),verifyNativeDecision:async query=>{
   calls++;return {...query,trusted:failure!=='untrusted',eventId:'host-event',occurredAt:new Date().toISOString(),...(failure==='request'?{requestId:'wrong'}:{}),...(failure==='digest'?{displayDigest:'0'.repeat(64)}:{}),...(failure==='decision'?{decision:'rejected'}:{})};
  }});
  await assert.rejects(flow.reviewProposal(f.expected));assert.equal(calls,failure==='missing-evidence'?0:1);
  assert.equal((await inspectConfirmations(f.confirmationPath))[0].status,'cancelled');
  assert.ok((await flow.inspectRecoveryState()).unresolvedPresentation);
 }
});

test('protocol cancellation reaches actual persisted review and late answer cannot approve',async()=>{
 const f=await fixture();let entered,release;
 const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const flow=createNativeTaskReviewFlow({...f,presentNativeReview:async()=>{entered();await gate;return answer('approved');}});
 const protocol=createNativeReviewHostProtocol({flow});
 const send=(requestId,command,payload)=>protocol.dispatchLine(JSON.stringify({version:1,requestId,command,payload})+'\n');
 const pending=send('review-actual','review-proposal',{expected:f.expected});await started;
 const result=JSON.parse(await send('cancel-actual','cancel-review',{reviewRequestId:'review-actual'}));
 assert.equal(result.ok,true);assert.equal(result.result.confirmation.status,'cancelled');assert.equal(result.result.dialogClosed,null);assert.equal(result.result.presenterSettled,false);
 assert.equal((await inspectConfirmations(f.confirmationPath))[0].status,'cancelled');
 assert.equal(JSON.parse(await send('replacement','review-proposal',{expected:f.expected})).error.code,'NATIVE_REVIEW_BUSY');
 release();const completed=JSON.parse(await pending);assert.equal(completed.result.confirmation.status,'cancelled');assert.equal(completed.executionAuthorized,false);
 assert.equal(JSON.parse(await send('inspect','inspect-recovery',{})).result.unresolvedPresentation,null);
});

test('real flow retries transient cancellation but does not repeat uncertain credential cleanup',async()=>{
 for(const uncertain of [false,true]){
  const f=await fixture();let entered,release,calls=0;
  const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  const failure=uncertain?Object.assign(Error('cleanup uncertain'),{cleanupComplete:false}):Error('temporary provider failure');
  const secretCustody={root:path.join(path.dirname(f.confirmationPath),'retry-custody'),dpapi:{protect:async bytes=>Buffer.from(bytes),unprotect:async bytes=>{if(++calls===1)throw failure;return Buffer.from(bytes);}}};
  const flow=createNativeTaskReviewFlow({...f,secretCustody,presentNativeReview:async()=>{entered();await gate;return answer('approved');}});
  const pending=flow.reviewProposal(f.expected);await started;
  await assert.rejects(flow.cancelActiveReview());assert.equal((await inspectConfirmations(f.confirmationPath))[0].status,'pending');
  if(uncertain){
   await assert.rejects(flow.cancelActiveReview(),error=>error===failure);assert.equal(calls,1);
   release();await assert.rejects(pending,error=>error===failure);assert.equal(calls,1);
   assert.equal((await inspectConfirmations(f.confirmationPath))[0].status,'pending');
   assert.ok((await flow.inspectRecoveryState()).unresolvedPresentation);
  }else{
   assert.equal((await flow.cancelActiveReview()).confirmation.status,'cancelled');assert.equal(calls,2);
   release();assert.equal((await pending).confirmation.status,'cancelled');
  }
 }
});

test('process exit during presentation retains both obligations and requires ordered recovery',async()=>{
 const f=await fixture(),custodyRoot=path.join(path.dirname(f.confirmationPath),'presentation-crash-custody');
 const script=`import {readFileSync} from 'node:fs';
 import {createNativeTaskReviewFlow} from ${JSON.stringify(new URL('../src/node/nativeTaskReviewFlow.mjs',import.meta.url).href)};
 import {createWindowsDpapiRunner} from ${JSON.stringify(new URL('../src/node/windowsDpapiSecretCustody.mjs',import.meta.url).href)};
 const input=JSON.parse(readFileSync(0,'utf8'));
 const flow=createNativeTaskReviewFlow({...input,secretCustody:{root:input.custodyRoot,dpapi:createWindowsDpapiRunner({compilationTempRoot:input.custodyRoot+'-compilation'})},presentNativeReview:async()=>process.exit(28)});
 await flow.reviewProposal(input.expected);`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{input:JSON.stringify({proposalConfig:f.proposalConfig,confirmationPath:f.confirmationPath,checkContract:f.checkContract,expected:f.expected,actor:f.actor,source:f.source,custodyRoot}),encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:65536});
 assert.equal(child.error,undefined);assert.equal(child.status,28);assert.equal(child.stdout,'');
 const pending=(await inspectConfirmations(f.confirmationPath))[0];assert.equal(pending.status,'pending');
 let verified=0,freshRequestId;
 const flow=createNativeTaskReviewFlow({...f,secretCustody:{root:custodyRoot,dpapi:createWindowsDpapiRunner({compilationTempRoot:path.join(path.dirname(f.confirmationPath),'dpapi-compilation')})},presentNativeReview:async display=>{freshRequestId=display.requestId;assert.notEqual(freshRequestId,pending.id);return null;},verifyPresentationClosed:async binding=>{verified++;assert.equal(binding.requestId,verified===1?pending.id:freshRequestId);assert.ok(verified<=2);return {requestId:binding.requestId,closed:true};}});
 assert.equal((await flow.inspectRecoveryState()).unresolvedPresentation.requestId,pending.id);
 await assert.rejects(flow.recoverInterruptedRequest(f.expected,pending.id),/PRESENTATION_UNRESOLVED/);
 assert.equal((await flow.recoverFailedPresentation()).recovered,true);assert.equal(verified,1);
 assert.equal((await inspectConfirmations(f.confirmationPath))[0].status,'pending');
 assert.equal((await flow.recoverInterruptedRequest(f.expected,pending.id)).confirmation.status,'cancelled');
 assert.equal((await flow.reviewProposal(f.expected)).confirmation.status,'cancelled');
 assert.equal(verified,2);assert.equal((await flow.inspectRecoveryState()).unresolvedPresentation,null);
 const history=await inspectConfirmations(f.confirmationPath);assert.equal(history.length,2);for(const id of [pending.id,freshRequestId])assert.equal(history.find(record=>record.id===id)?.status,'cancelled');
 // Controlled presenter exited before creating any OS window. This proves
 // durable ordering, not physical native-window closure or power-loss safety.
});

test('historical recovery cancels old request after proposal and check policy change without stale approval',async()=>{
 const f=await fixture(),secretCustody={root:path.join(path.dirname(f.confirmationPath),'history-custody'),dpapi:createWindowsDpapiRunner({compilationTempRoot:path.join(path.dirname(f.confirmationPath),'dpapi-compilation')})};
 const original=createTaskProposalReview(f);
 const requested=await original.request(f.expected,{requestedBy:f.actor,question:'Old exact review'},{secretCustody});
 const second=await f.store.propose(f.ledger,{requestId:'second-history',expectedRevision:1,expectedHeadDigest:f.expected.headDigest});
 const {contractDigest,executionAuthorized,authorityVerified,...body}=f.checkContract;
 const raw={...body,policyVersion:2,policyDigest:'e'.repeat(64)};
 const changed=createTaskCheckContract(raw);
 const flow=createNativeTaskReviewFlow({...f,checkContract:changed,secretCustody,presentNativeReview:async()=>null});
 await assert.rejects(flow.recoverInterruptedRequest({hostRevision:1,headDigest:'f'.repeat(64)},requested.confirmation.id),/HISTORY_MISMATCH/);
 await assert.rejects(flow.recoverInterruptedRequest({hostRevision:2,headDigest:second.proposal.recordHash},requested.confirmation.id),/HISTORY_MISMATCH/);
 assert.equal((await flow.recoverInterruptedRequest(f.expected,requested.confirmation.id)).confirmation.status,'cancelled');
 await assert.rejects(original.request(f.expected,{requestedBy:f.actor,question:'Stale approval'}),/STALE_HEAD/);
 assert.equal((await f.store.inspect()).headDigest,second.proposal.recordHash);
});

test('pending opaque request is recoverable after requesting process exits without returning its watcher',async()=>{
 const f=await fixture(),custodyRoot=path.join(path.dirname(f.confirmationPath),'crash-custody');
 const script=`import {readFileSync} from 'node:fs';
 import {createTaskProposalReview} from ${JSON.stringify(new URL('../src/node/taskProposalReview.mjs',import.meta.url).href)};
 import {createWindowsDpapiRunner} from ${JSON.stringify(new URL('../src/node/windowsDpapiSecretCustody.mjs',import.meta.url).href)};
 const input=JSON.parse(readFileSync(0,'utf8'));
 await createTaskProposalReview(input).request(input.expected,{requestedBy:input.actor,question:'Interrupted process review'},{secretCustody:{root:input.custodyRoot,dpapi:createWindowsDpapiRunner({compilationTempRoot:input.custodyRoot+'-compilation'})}});
 process.exit(27);`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{input:JSON.stringify({proposalConfig:f.proposalConfig,confirmationPath:f.confirmationPath,checkContract:f.checkContract,expected:f.expected,actor:f.actor,custodyRoot}),encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:65536});
 assert.equal(child.error,undefined);assert.equal(child.status,27);assert.equal(child.stdout,'');
 const pending=(await inspectConfirmations(f.confirmationPath))[0];assert.equal(pending.status,'pending');assert.equal(pending.watcherHandle,undefined);
 const flow=createNativeTaskReviewFlow({...f,secretCustody:{root:custodyRoot,dpapi:createWindowsDpapiRunner({compilationTempRoot:path.join(path.dirname(f.confirmationPath),'dpapi-compilation')})},presentNativeReview:async()=>null});
 const recovered=await flow.recoverInterruptedRequest(f.expected,pending.id);
 assert.equal(recovered.confirmation.status,'cancelled');assert.equal(recovered.executionAuthorized,false);
});

test('new host recovers opaque pending request without original watcher and never approves',async()=>{
 const f=await fixture(),secretCustody={root:path.join(path.dirname(f.confirmationPath),'private-custody'),dpapi:createWindowsDpapiRunner({compilationTempRoot:path.join(path.dirname(f.confirmationPath),'dpapi-compilation')})};
 const requested=await createTaskProposalReview(f).request(f.expected,{requestedBy:f.actor,question:'Exact interrupted review'},{secretCustody});
 const requestId=requested.confirmation.id;
 const visible=(await inspectConfirmations(f.confirmationPath))[0];
 assert.equal(visible.watcherHandle,undefined);assert.equal(visible.watcherToken,undefined);
 const config={...f,secretCustody,presentNativeReview:async()=>null};
 const uncertain=Object.assign(Error('DPAPI process cleanup uncertain.'),{code:'DPAPI_PROCESS_UNCERTAIN',cleanupComplete:false});
 await assert.rejects(createNativeTaskReviewFlow({...config,secretCustody:{...secretCustody,dpapi:{unprotect:async()=>{throw uncertain;}}}}).recoverInterruptedRequest(f.expected,requestId),error=>error===uncertain&&error.cleanupComplete===false);
 await assert.rejects(createNativeTaskReviewFlow({...config,actor:'Other owner'}).recoverInterruptedRequest(f.expected,requestId),/BINDING_REFUSED/);
 await assert.rejects(createNativeTaskReviewFlow({...config,secretCustody:undefined}).recoverInterruptedRequest(f.expected,requestId),/AUTHORITY_REQUIRED/);
 await assert.rejects(createNativeTaskReviewFlow({...config,secretCustody:{...secretCustody,dpapi:{unprotect:async()=>Buffer.from('incorrect-token')}}}).recoverInterruptedRequest(f.expected,requestId),/CUSTODY_REFUSED/);
 assert.equal((await inspectConfirmations(f.confirmationPath))[0].status,'pending');
 const restarted=createNativeTaskReviewFlow(config),result=await restarted.recoverInterruptedRequest(f.expected,requestId);
 assert.equal(result.confirmation.status,'cancelled');assert.equal(result.executionAuthorized,false);
 assert.equal(result.confirmation.watcherHandle,undefined);
 assert.deepEqual(await restarted.recoverInterruptedRequest(f.expected,requestId),result);
 assert.equal((await restarted.reviewProposal(f.expected)).confirmation.status,'cancelled');
});

test('cancellation during durable begin never opens the presenter',async t=>{
 const f=await fixture();let entered,release,displays=0;
 const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const actualOpen=fs.open;
 const mock=t.mock.method(fs,'open',async(...args)=>{
  const handle=await actualOpen(...args);
  if(args[0]===`${f.confirmationPath}.presentations.jsonl`&&(args[1]&1)){
   const sync=handle.sync.bind(handle);handle.sync=async()=>{entered();await gate;return sync();};
  }
  return handle;
 });syncBuiltinESMExports();
 try{
  const flow=createNativeTaskReviewFlow({...f,verifyPresentationClosed:async binding=>({requestId:binding.requestId,closed:false}),presentNativeReview:async()=>{displays++;return answer('approved');}});
  const pending=flow.reviewProposal(f.expected);await started;
  assert.equal((await flow.cancelActiveReview()).confirmation.status,'cancelled');
  release();await assert.rejects(pending,/CLOSURE_UNVERIFIED/);assert.equal(displays,0);
  assert.ok((await flow.inspectRecoveryState()).unresolvedPresentation);
  await assert.rejects(flow.reviewProposal(f.expected),/PRESENTATION_UNRESOLVED/);
 }finally{release();mock.mock.restore();syncBuiltinESMExports();}
});

test('new flow discovers persisted presentation and blocks display until closure recovery',async()=>{
 const f=await fixture();let displays=0;
 const config={...f,presentNativeReview:async()=>{displays++;return null;},verifyPresentationClosed:async state=>({requestId:state.requestId,closed:true})};
 const first=createNativeTaskReviewFlow({...config,verifyPresentationClosed:undefined});await assert.rejects(first.reviewProposal(f.expected),/CLOSURE_UNAVAILABLE/);
 const retained=(await first.inspectRecoveryState()).unresolvedPresentation;assert.ok(retained);
 const restarted=createNativeTaskReviewFlow(config);
 assert.deepEqual((await restarted.inspectRecoveryState()).unresolvedPresentation,retained);
 await assert.rejects(restarted.reviewProposal(f.expected),/PRESENTATION_UNRESOLVED/);assert.equal(displays,1);
 assert.equal((await restarted.recoverFailedPresentation()).recovered,true);
 await restarted.reviewProposal(f.expected);assert.equal(displays,2);
});

test('throwing and stalled closure verifiers retain unresolved state and block replacement',async()=>{
 const f=await fixture();let mode='throw',entered,release;
 const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const flow=createNativeTaskReviewFlow({...f,presentNativeReview:async()=>{throw Error('Presenter failed');},verifyPresentationClosed:async()=>{
  if(mode==='throw')throw Error('Verifier unavailable');entered();await gate;return {closed:false};
 }});
 await assert.rejects(flow.reviewProposal(f.expected),/Presenter failed/);
 const retained=flow.inspectPresentationState().unresolvedPresentation;
 await assert.rejects(flow.recoverFailedPresentation(),/Verifier unavailable/);
 assert.deepEqual(flow.inspectPresentationState().unresolvedPresentation,retained);
 assert.equal(flow.inspectPresentationState().busy,false);
 mode='stall';const recovering=flow.recoverFailedPresentation();await started;
 await assert.rejects(flow.reviewProposal(f.expected),/BUSY/);
 await assert.rejects(flow.recoverFailedPresentation(),/BUSY/);
 release();await assert.rejects(recovering,/CLOSURE_UNVERIFIED/);
 assert.deepEqual(flow.inspectPresentationState().unresolvedPresentation,retained);
});

test('failed presentation blocks replacement until exact host closure confirmation',async()=>{
 const f=await fixture();let calls=0,mode='unknown';
 const flow=createNativeTaskReviewFlow({...f,presentNativeReview:async()=>{calls++;if(calls===1)throw Error('Presenter disconnected');return null;},verifyPresentationClosed:async state=>({requestId:mode==='wrong'?'other':state.requestId,closed:mode!=='unknown'})});
 await assert.rejects(flow.reviewProposal(f.expected),/Presenter disconnected/);
 const state=flow.inspectPresentationState();assert.ok(state.unresolvedPresentation);assert.equal(state.busy,false);
 assert.equal((await inspectConfirmations(f.confirmationPath))[0].status,'cancelled');
 await assert.rejects(flow.reviewProposal(f.expected),/PRESENTATION_UNRESOLVED/);assert.equal(calls,1);
 for(mode of ['unknown','wrong'])await assert.rejects(flow.recoverFailedPresentation(),/CLOSURE_UNVERIFIED/);
 mode='confirmed';assert.equal((await flow.recoverFailedPresentation()).recovered,true);
 assert.equal(flow.inspectPresentationState().unresolvedPresentation,null);
 assert.equal((await flow.reviewProposal(f.expected)).confirmation.status,'cancelled');
});

test('host cancellation persists while presenter stalls and late approval cannot overwrite it',async()=>{
 const f=await fixture();let entered,finish,signal;
 const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{finish=resolve;});
 const flow=createNativeTaskReviewFlow({...f,presentNativeReview:async(_display,options)=>{signal=options.signal;entered();await gate;return answer('approved');}});
 const pending=flow.reviewProposal(f.expected);await started;
 const cancelled=await flow.cancelActiveReview();
 assert.equal(cancelled.confirmation.status,'cancelled');assert.equal(cancelled.presenterSettled,false);assert.equal(cancelled.dialogClosed,null);assert.equal(signal.aborted,true);
 assert.equal((await inspectConfirmations(f.confirmationPath))[0].status,'cancelled');
 await assert.rejects(flow.reviewProposal(f.expected),/BUSY/);
 finish();assert.equal((await pending).confirmation.status,'cancelled');
 assert.equal((await flow.cancelActiveReview()).presenterSettled,true);assert.equal((await flow.cancelActiveReview()).dialogClosed,null);
});

test('host review persists pending first and presents exact immutable ledger/checks without watcher secrets',async()=>{
  const f=await fixture();
  const flow=createNativeTaskReviewFlow({...f,presentNativeReview:async display=>{
    const requests=await inspectConfirmations(f.confirmationPath);
    assert.equal(requests.length,1);assert.equal(requests[0].status,'pending');assert.equal(requests[0].id,display.requestId);
    assert.deepEqual(display.ledger,f.ledger);assert.deepEqual(display.checkContract,f.checkContract);
    assert.equal(display.subject.proposalDigest,f.expected.headDigest);
    assert.equal(display.subject.checkContractDigest,f.checkContract.contractDigest);
    assert.equal(JSON.stringify(display).includes('watcherToken'),false);
    assert.throws(()=>{display.ledger.tasks[0].title='Substitute';},TypeError);
    assert.throws(()=>{display.checkContract.tasks[0].checks[0].args.push('--eval');},TypeError);
    return answer('approved');
  }});
  const result=await flow.reviewProposal(f.expected);
  assert.equal(result.confirmation.status,'approved');assert.equal(result.confirmation.decidedBy,'Danie');
  assert.equal(result.executionAuthorized,false);assert.equal(result.nativeGestureVerified,false);
});

test('dismissal and rejection remain distinct and neither invents approval',async()=>{
  for(const decision of ['cancelled','rejected']) {
    const f=await fixture();const flow=createNativeTaskReviewFlow({...f,presentNativeReview:async()=>decision==='cancelled'?null:answer(decision)});
    const result=await flow.reviewProposal(f.expected);
    assert.equal(result.confirmation.status,decision);assert.equal(result.executionAuthorized,false);
    const [record]=await inspectConfirmations(f.confirmationPath);
    assert.equal(record.status,decision);if(decision==='cancelled')assert.equal(record.gesture,null);
  }
});

test('changed proposal while dialog is open refuses decision and retains cancelled request',async()=>{
  const f=await fixture();const flow=createNativeTaskReviewFlow({...f,presentNativeReview:async()=>{
    await f.store.propose(f.ledger,{requestId:'second',expectedRevision:1,expectedHeadDigest:f.expected.headDigest});
    return answer('approved');
  }});
  await assert.rejects(flow.reviewProposal(f.expected),/STALE_HEAD/);
  assert.equal((await inspectConfirmations(f.confirmationPath))[0].status,'cancelled');
});

test('invalid host response, untrusted event, and presenter error never persist approval',async()=>{
  for(const presentNativeReview of [async()=>({decision:'approved',rationale:'x',nativeEvent:{isTrusted:false}}),async()=>({decision:'approved',rationale:'x'.repeat(4097),nativeEvent:{isTrusted:true}}),async()=>{throw Error('Dialog unavailable');}]) {
    const f=await fixture();const flow=createNativeTaskReviewFlow({...f,presentNativeReview});
    await assert.rejects(flow.reviewProposal(f.expected));
    const [record]=await inspectConfirmations(f.confirmationPath);assert.equal(record.status,'cancelled');assert.equal(record.gesture,null);
  }
});

test('stale request is refused before display and overlapping dialogs are refused',async()=>{
  const f=await fixture();let calls=0,release,entered;
  const waiting=new Promise(resolve=>{entered=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  const flow=createNativeTaskReviewFlow({...f,presentNativeReview:async()=>{calls++;entered();await gate;return null;}});
  await assert.rejects(flow.reviewProposal({...f.expected,headDigest:'f'.repeat(64)}),/STALE_HEAD/);assert.equal(calls,0);
  const first=flow.reviewProposal(f.expected);await waiting;
  await assert.rejects(flow.reviewProposal(f.expected),/NATIVE_REVIEW_BUSY/);
  release();await first;assert.equal(calls,1);
});

test('host dependencies are required and cannot arrive in serialized review request',async()=>{
  const f=await fixture();assert.throws(()=>createNativeTaskReviewFlow({...f,presentNativeReview:'renderer callback'}),/HOST_CONFIG_INVALID/);
  let called=false;const flow=createNativeTaskReviewFlow({...f,presentNativeReview:async()=>{called=true;return null;}});
  await assert.rejects(flow.reviewProposal({...f.expected,decision:'approved'}));assert.equal(called,false);
});

test('stable review original survives lost reply and cannot display twice',async()=>{
 const f=await fixture(),digest='7'.repeat(64);let displays=0;
 const config={...f,presentNativeReview:async()=>{displays++;return answer('approved');}};
 const first=await createNativeTaskReviewFlow(config).reviewProposal(f.expected,digest);assert.equal(first.confirmation.id,`review-${digest}`);
 const restarted=createNativeTaskReviewFlow(config);
 await assert.rejects(restarted.reviewProposal(f.expected,digest),/ORIGINAL_ALREADY_EXISTS/);assert.equal(displays,1);
 const recovered=await restarted.recoverOriginalRequest(f.expected,digest);assert.equal(recovered.confirmation.id,first.confirmation.id);assert.equal(recovered.confirmation.status,'approved');assert.equal(recovered.executionAuthorized,false);assert.equal(displays,1);
 await assert.rejects(restarted.recoverOriginalRequest(f.expected,'8'.repeat(64)),/RECOVERY_HISTORY_MISMATCH/);
});

test('original recovery verifies exact open presentation closure before returning approval',async()=>{
 const f=await fixture(),digest='6'.repeat(64);let closed=false;
 const config={...f,presentNativeReview:async()=>answer('approved'),verifyPresentationClosed:async binding=>({requestId:binding.requestId,closed})};
 await assert.rejects(createNativeTaskReviewFlow(config).reviewProposal(f.expected,digest),/CLOSURE/);
 const restarted=createNativeTaskReviewFlow({...config,presentNativeReview:async()=>{throw Error('Recovery must not display');}});
 await assert.rejects(restarted.recoverOriginalRequest(f.expected,digest),/CLOSURE/);
 closed=true;assert.equal((await restarted.recoverOriginalRequest(f.expected,digest)).confirmation.status,'approved');assert.equal((await restarted.inspectRecoveryState()).unresolvedPresentation,null);
});

test('owner protocol reconciles only the exact original digest and redacts custody',async()=>{
 const f=await fixture(),digest='5'.repeat(64),config={...f,presentNativeReview:async()=>null};
 const protocol=createNativeReviewHostProtocol({flow:createNativeTaskReviewFlow(config)});
 const call=(command,payload,requestId)=>protocol.dispatchLine(JSON.stringify({version:1,requestId,command,payload})+'\n').then(JSON.parse);
 const payload={expected:f.expected,originalDigest:digest};
 const original=await call('review-original-request',payload,'transport-1');assert.equal(original.ok,true);
 const recovered=await call('recover-original-request',payload,'transport-2');assert.deepEqual(recovered.result,{confirmation:{id:`review-${digest}`,status:'cancelled'}});
 assert.equal((await call('recover-original-request',{...payload,confirmationId:'foreign'},'transport-3')).ok,false);
});

