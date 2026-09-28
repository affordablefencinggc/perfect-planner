import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeReviewHostProtocol} from '../src/node/nativeReviewHostProtocol.mjs';

const head={hostRevision:1,headDigest:'a'.repeat(64)};
const encode=(command,payload={},requestId='request-1')=>JSON.stringify({version:1,requestId,command,payload})+'\n';
const make=(overrides={})=>({inspectRecoveryState:async()=>({unresolvedPresentation:null}),reviewProposal:async()=>({confirmation:{id:'confirmation-1',status:'approved'}}),recoverFailedPresentation:async()=>({recovered:false}),recoverInterruptedRequest:async()=>({confirmation:{id:'confirmation-1',status:'cancelled'}}),cancelActiveReview:async()=>({cancelRequested:false,presenterSettled:true,dialogClosed:null}),...overrides});

test('preparation transports known profiles and rejects unknown profiles or added authority',async()=>{
 const request={requestId:'prepare-profile-1',expectedRevision:0,expectedHeadDigest:'GENESIS'};
 const value={schemaVersion:1,profileId:'npm-project-checks-v1',originalRequestId:request.requestId,contractDigest:'b'.repeat(64),policyDigest:'c'.repeat(64),contractHead:{revision:1,headDigest:'d'.repeat(64)},idempotent:false,matchesObservedContractHead:true,preparationPersisted:true,observationEvidencePersisted:true,reviewEnabled:false,toolchainVerified:false,candidateVerified:false,executionAuthorized:false,registrationLeaseHeld:false};
 const dispatch=async result=>JSON.parse(await createNativeReviewHostProtocol({flow:make(),checkPreparation:{prepareChecks:async()=>result,inspectChecks:async()=>{throw Error('not used');}}}).dispatchLine(encode('prepare-checks',{expected:head,request})));
 for(const profileId of ['perfect-planner-checks-v1','npm-project-checks-v1']){const reply=await dispatch({...value,profileId});assert.equal(reply.ok,true);assert.equal(reply.result.profileId,profileId);assert.equal(reply.executionAuthorized,false);}
 for(const patch of [{profileId:'arbitrary-shell'},{profileId:null},{executionAuthorized:true},{command:'injected'}])assert.equal((await dispatch({...value,...patch})).ok,false);
});

test('check inspection projects exact historical metadata without granting review or execution',async()=>{
 const binding={projectId:'pp_checks',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)},contractHead={revision:1,headDigest:'c'.repeat(64)};
 const original={binding,request:{requestId:'prepare-1',expectedRevision:0,expectedHeadDigest:'GENESIS'},contractHead,contractDigest:'d'.repeat(64),policyDigest:'e'.repeat(64),proposalHead:head,matchesObservedContractHead:true,observationEvidenceVerified:false};
 const good={schemaVersion:1,binding,contractHead,requestedOriginalId:'prepare-1',original,registrationLeaseHeld:false,executionAuthorized:false};
 const host=value=>createNativeReviewHostProtocol({flow:make(),checkPreparation:{prepareChecks:async()=>{throw Error('not called');},inspectChecks:async()=>value}});
 const result=JSON.parse(await host(good).dispatchLine(encode('inspect-checks',{requestId:'prepare-1'})));assert.equal(result.ok,true);assert.deepEqual(result.result,good);assert.equal(result.executionAuthorized,false);
 for(const value of [{...good,privatePath:'secret'},{...good,executionAuthorized:true},{...good,original:{...original,observationEvidenceVerified:true}},{...good,original:{...original,request:{...original.request,requestId:'different'}}},{...good,original:{...original,contractHead:{...contractHead,revision:2}}}])assert.equal(JSON.parse(await host(value).dispatchLine(encode('inspect-checks',{requestId:'prepare-1'}))).ok,false);
 const empty={...good,contractHead:{revision:0,headDigest:'GENESIS'},requestedOriginalId:null,original:null};assert.equal(JSON.parse(await host(empty).dispatchLine(encode('inspect-checks',{requestId:null}))).ok,true);
 assert.equal(JSON.parse(await host(good).dispatchLine(encode('inspect-checks',{requestId:'prepare-1',command:'run'}))).ok,false);
 assert.equal(JSON.parse(await createNativeReviewHostProtocol({flow:make()}).dispatchLine(encode('inspect-checks',{requestId:null}))).ok,false);
});

test('optional draft commands are bounded, host-installed and return only unapproved metadata',async()=>{
 const metadata={schemaVersion:1,observedHead:head,registrationCurrent:true,registrationLeaseHeld:false,approvalState:'unapproved-proposal',executionAuthorized:false};let calls=0;
 const submission={inspectHead:async()=>({...metadata,secret:'PRIVATE'}),submitDraft:async input=>{calls++;assert.ok(Object.isFrozen(input));return {...metadata,submitted:{...head,ledgerDigest:'b'.repeat(64)},submissionPersisted:true,idempotent:false,submittedMatchesObservedHead:true,secret:'PRIVATE'};}};
 const protocol=createNativeReviewHostProtocol({flow:make(),submission});
 assert.equal(protocol.limits.lineBytes,1024*1024+4096);
 const inspected=await protocol.dispatchLine(encode('inspect-proposal'));assert.equal(inspected.includes('PRIVATE'),false);assert.equal(JSON.parse(inspected).ok,true);
 const payload={ledger:{bounded:'x'.repeat(32768)},request:{requestId:'save-1',expectedRevision:0,expectedHeadDigest:'GENESIS'}};
 const result=JSON.parse(await protocol.dispatchLine(encode('submit-draft',payload,'submit-1')));assert.equal(result.ok,true);assert.equal(result.result.approvalState,'unapproved-proposal');assert.equal(result.executionAuthorized,false);assert.equal(calls,1);
 assert.equal(JSON.parse(await protocol.dispatchLine(encode('submit-draft',{...payload,actor:'injected'},'submit-2'))).ok,false);
 const absent=createNativeReviewHostProtocol({flow:make()});assert.equal(JSON.parse(await absent.dispatchLine(encode('inspect-proposal'))).ok,false);
 const malicious=createNativeReviewHostProtocol({flow:make(),submission:{...submission,inspectHead:async()=>({...metadata,executionAuthorized:true})}});assert.equal(JSON.parse(await malicious.dispatchLine(encode('inspect-proposal'))).ok,false);
});

test('failed cancellation retains its reserved slot for exact-target retry at session limit',async()=>{
 let release,entered,calls=0;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const protocol=createNativeReviewHostProtocol({flow:make({reviewProposal:async()=>{entered();await gate;return {confirmation:{id:'x',status:'cancelled'}};},cancelActiveReview:async()=>{if(++calls===1)throw Error('temporary');return {cancelRequested:true,presenterSettled:false,confirmation:{id:'x',status:'cancelled'}};}})});
 for(let i=0;i<126;i++)await protocol.dispatchLine(encode('inspect-recovery',{},`prefill-${i}`));
 const pending=protocol.dispatchLine(encode('review-proposal',{expected:head},'active'));await started;
 const cancel=encode('cancel-review',{reviewRequestId:'active'},'cancel');
 assert.equal(JSON.parse(await protocol.dispatchLine(cancel)).ok,false);
 assert.equal(JSON.parse(await protocol.dispatchLine(cancel)).ok,true);assert.equal(calls,2);
 release();await pending;
});

test('targeted cancellation reaches stalled review without allowing replacement or false closure',async()=>{
 let release,entered,cancels=0;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const protocol=createNativeReviewHostProtocol({flow:make({reviewProposal:async()=>{entered();await gate;return {confirmation:{id:'x',status:'cancelled'}};},cancelActiveReview:async()=>{cancels++;return {cancelRequested:true,presenterSettled:false,dialogClosed:true,confirmation:{id:'x',status:'cancelled'}};}})});
 const pending=protocol.dispatchLine(encode('review-proposal',{expected:head},'active'));await started;
 assert.equal(JSON.parse(await protocol.dispatchLine(encode('cancel-review',{reviewRequestId:'wrong'},'c1'))).error.code,'PROTOCOL_CANCEL_TARGET_MISMATCH');
 const result=JSON.parse(await protocol.dispatchLine(encode('cancel-review',{reviewRequestId:'active'},'c2')));
 assert.equal(result.result.cancelRequested,true);assert.equal(result.result.dialogClosed,null);assert.equal(result.result.presenterSettled,false);assert.equal(cancels,1);
 assert.equal(JSON.parse(await protocol.dispatchLine(encode('review-proposal',{expected:head},'new'))).error.code,'NATIVE_REVIEW_BUSY');
 release();await pending;
 assert.equal(JSON.parse(await protocol.dispatchLine(encode('cancel-review',{reviewRequestId:'active'},'c3'))).error.code,'PROTOCOL_CANCEL_TARGET_MISMATCH');
});

test('four host commands accept only their exact payload and return no execution permission',async()=>{
  let observed;
  const protocol=createNativeReviewHostProtocol({flow:make({reviewProposal:async expected=>{observed=expected;assert.equal(Object.isFrozen(expected),true);return {confirmation:{id:'confirmation-1',status:'approved'}};}})});
  assert.equal(Object.isFrozen(protocol),true);
  for(const [command,payload] of [['inspect-recovery',{}],['review-proposal',{expected:head}],['recover-presentation',{}],['recover-interrupted-request',{expected:head,confirmationId:'confirmation-1'}]]) {
    const result=JSON.parse(await protocol.dispatchLine(encode(command,payload,command)));
    assert.equal(result.ok,true);assert.equal(result.executionAuthorized,false);assert.equal(result.nativeGestureVerified,false);
  }
  assert.deepEqual(observed,head);
});

test('request cannot select paths, actor, presenter, shell or grant authority',async()=>{
  let calls=0;const protocol=createNativeReviewHostProtocol({flow:make({reviewProposal:async()=>{calls++;}})});
  const invalid=[
    {expected:head,actor:'intruder'},{expected:head,confirmationPath:'C:/other'},
    {expected:head,presentNativeReview:'approve'},{expected:head,executable:'cmd.exe'},
    {expected:head,executionAuthorized:true},{expected:{...head,root:'C:/other'}},
    {expected:{hostRevision:0,headDigest:head.headDigest}},{expected:{hostRevision:1,headDigest:'GENESIS'}},
  ];
  for(const payload of invalid)assert.equal(JSON.parse(await protocol.dispatchLine(encode('review-proposal',payload))).error.code,'PROTOCOL_INVALID_REQUEST');
  assert.equal(calls,0);
  for(const command of ['execute','approve','grant','cancel-confirmation'])assert.equal(JSON.parse(await protocol.dispatchLine(encode(command))).ok,false);
});

test('bounded line framing rejects malformed and multiple requests before host calls',async()=>{
  let calls=0;const protocol=createNativeReviewHostProtocol({flow:make({inspectRecoveryState:async()=>{calls++;return {unresolvedPresentation:null};}})});
  for(const line of ['',null,'{',encode('inspect-recovery')+encode('inspect-recovery'),' '.repeat(16385),JSON.stringify({version:2,requestId:'x',command:'inspect-recovery',payload:{}}),JSON.stringify({version:1,requestId:'bad\nidentifier',command:'inspect-recovery',payload:{}})])assert.equal(JSON.parse(await protocol.dispatchLine(line)).ok,false);
  assert.equal(calls,0);
  assert.equal(JSON.parse(await protocol.dispatchLine('{"version":1,"requestId":"x","command":"execute","command":"inspect-recovery","payload":{}}')).ok,false);
  assert.equal(JSON.parse(await protocol.dispatchLine('{"version":1,"requestId":"x","command":"inspect-recovery","payload":{},"\\u0070ayload":{}}')).ok,false);
  assert.equal(JSON.parse(await protocol.dispatchLine(encode('inspect-recovery').replace(/\n$/,'\r\n'))).ok,true);
});

test('host result whitelist excludes arbitrary metadata and errors never echo secrets',async()=>{
  const secret='PRIVATE-WATCHER-CREDENTIAL';
  const protocol=createNativeReviewHostProtocol({flow:make({reviewProposal:async()=>({confirmation:{id:'confirmation-1',status:'approved',watcherToken:secret,watcherHandle:secret,rationale:secret},secret}),recoverFailedPresentation:async()=>{throw Error('C:/private/'+secret);}})});
  const success=await protocol.dispatchLine(encode('review-proposal',{expected:head}));assert.equal(success.includes(secret),false);
  const failed=await protocol.dispatchLine(encode('recover-presentation',{},'next'));assert.equal(failed.includes(secret),false);assert.equal(JSON.parse(failed).error.code,'NATIVE_REVIEW_HOST_FAILURE');
  const malformed=createNativeReviewHostProtocol({flow:make({reviewProposal:async()=>({confirmation:{id:'x',status:secret}})})});
  assert.equal((await malformed.dispatchLine(encode('review-proposal',{expected:head}))).includes(secret),false);
});

test('duplicate IDs and concurrent commands cannot replay an operation',async()=>{
  let release,entered,calls=0;const started=new Promise(resolve=>{entered=resolve;});const gate=new Promise(resolve=>{release=resolve;});
  const protocol=createNativeReviewHostProtocol({flow:make({reviewProposal:async()=>{calls++;entered();await gate;return {confirmation:{id:'x',status:'cancelled'}};}})});
  const pending=protocol.dispatchLine(encode('review-proposal',{expected:head}));await started;
  assert.equal(JSON.parse(await protocol.dispatchLine(encode('recover-presentation',{},'other'))).error.code,'NATIVE_REVIEW_BUSY');
  release();await pending;
  assert.equal(JSON.parse(await protocol.dispatchLine(encode('review-proposal',{expected:head}))).error.code,'PROTOCOL_DUPLICATE_REQUEST');assert.equal(calls,1);
});

test('session admission is bounded and installed host methods cannot be replaced afterward',async()=>{
  const flow=make();const protocol=createNativeReviewHostProtocol({flow});flow.inspectRecoveryState=async()=>{throw Error('replacement');};
  for(let i=0;i<128;i++)assert.equal(JSON.parse(await protocol.dispatchLine(encode('inspect-recovery',{},`r${i}`))).ok,true);
  assert.equal(JSON.parse(await protocol.dispatchLine(encode('inspect-recovery',{},'excess'))).error.code,'PROTOCOL_SESSION_LIMIT');
});

test('recovery output contains only exact retained presentation identity',async()=>{
  const binding={requestId:'x',proposalRevision:3,proposalDigest:'b'.repeat(64),checkContractDigest:'c'.repeat(64),source:'PRIVATE-SOURCE',watcherToken:'PRIVATE-TOKEN'};
  const protocol=createNativeReviewHostProtocol({flow:make({inspectRecoveryState:async()=>({unresolvedPresentation:binding})})});
  const encoded=await protocol.dispatchLine(encode('inspect-recovery'));assert.equal(encoded.includes('PRIVATE'),false);assert.equal(JSON.parse(encoded).result.unresolvedPresentation.proposalRevision,3);
});

test('cleanup uncertainty remains explicit without exposing host exception details',async()=>{
  const protocol=createNativeReviewHostProtocol({flow:make({recoverFailedPresentation:async()=>{throw Object.assign(Error('PRIVATE-CREDENTIAL'),{cleanupComplete:false});}})});
  const encoded=await protocol.dispatchLine(encode('recover-presentation'));
  assert.equal(encoded.includes('PRIVATE-CREDENTIAL'),false);
  const result=JSON.parse(encoded);assert.equal(result.error.code,'NATIVE_REVIEW_CLEANUP_UNCERTAIN');assert.equal(result.cleanupComplete,false);assert.equal(result.executionAuthorized,false);
});

test('private execution commands validate originals and project only terminal receipts',async()=>{
 const payload={requestId:'run-1',expected:head,contractHead:{revision:1,headDigest:'b'.repeat(64)},confirmationId:'approved-1',taskId:'T0001',checkId:'unit',attemptId:'attempt-1',attemptNumber:1};
 const receipt={schemaVersion:1,kind:'NATIVE_CHECK_EXECUTION_RECEIPT',requestId:payload.requestId,originalDigest:'c'.repeat(64),grantId:'11111111-1111-4111-8111-111111111111',runId:'22222222-2222-4222-8222-222222222222',intentDigest:'d'.repeat(64),artifactDigest:'e'.repeat(64),state:'result-recorded',cleanupComplete:true,executionAuthorized:false};
 let calls=0;const execute=async request=>{calls++;assert.deepEqual(request,payload);assert.ok(Object.isFrozen(request.expected));return receipt;};
 const capability={execute,recover:execute};const protocol=createNativeReviewHostProtocol({flow:make(),executionRequests:capability});capability.execute=async()=>{throw Error('mutated');};
 for(const command of ['execute-check','recover-check-execution']){const result=JSON.parse(await protocol.dispatchLine(encode(command,payload,command)));assert.equal(result.ok,true);assert.deepEqual(result.result,receipt);assert.equal(result.executionAuthorized,false);}
 for(const extra of [{credentials:'secret'},{executable:'C:/foreign.exe'},{policyDigest:'f'.repeat(64)}])assert.equal(JSON.parse(await protocol.dispatchLine(encode('execute-check',{...payload,...extra},'bad-'+Object.keys(extra)[0]))).error.code,'PROTOCOL_INVALID_REQUEST');
 assert.equal(calls,2);
 assert.equal(JSON.parse(await createNativeReviewHostProtocol({flow:make()}).dispatchLine(encode('execute-check',payload))).ok,false);
 for(const value of [{...receipt,secret:'PRIVATE'},{...receipt,requestId:'foreign'},{...receipt,cleanupComplete:false},{...receipt,executionAuthorized:true}]){
  const p=createNativeReviewHostProtocol({flow:make(),executionRequests:{execute:async()=>value,recover:execute}});const result=await p.dispatchLine(encode('execute-check',payload));assert.equal(JSON.parse(result).ok,false);assert.equal(result.includes('PRIVATE'),false);
 }
 const failed=createNativeReviewHostProtocol({flow:make(),executionRequests:{execute:async()=>{throw Error('C:/private/secret');},recover:async()=>{throw Error('NATIVE_EXECUTION_REQUEST_UNRESOLVED');}}});
 assert.equal(JSON.parse(await failed.dispatchLine(encode('execute-check',payload,'failure'))).error.code,'NATIVE_EXECUTION_REQUEST_UNAVAILABLE');
 assert.equal(JSON.parse(await failed.dispatchLine(encode('recover-check-execution',payload,'recover'))).error.code,'NATIVE_EXECUTION_REQUEST_UNRESOLVED');
});

test('private recovery projects a distinct not-started receipt and refuses false execution fields',async()=>{
 const payload={requestId:'not-started',expected:head,contractHead:{revision:1,headDigest:'b'.repeat(64)},confirmationId:'approved-1',taskId:'T0001',checkId:'unit',attemptId:'attempt-1',attemptNumber:1};
 const receipt={schemaVersion:1,kind:'NATIVE_CHECK_NOT_STARTED_RECEIPT',requestId:payload.requestId,originalDigest:'c'.repeat(64),proofDigest:'d'.repeat(64),state:'not-started',cleanupComplete:true,executionAuthorized:false};
 for(const patch of [null,{grantId:'fake'},{proofDigest:'bad'},{state:'result-recorded'},{executionAuthorized:true}]){
  const value=patch?{...receipt,...patch}:receipt,recover=async()=>value;
  const protocol=createNativeReviewHostProtocol({flow:make(),executionRequests:{execute:recover,recover}});
  const result=JSON.parse(await protocol.dispatchLine(encode('recover-check-execution',payload)));assert.equal(result.ok,patch===null);if(!patch)assert.deepEqual(result.result,receipt);
 }
});

test('full-task commands freeze input and expose only bounded batch receipts',async()=>{
 const payload={requestId:'batch-1',expected:head,contractHead:{revision:1,headDigest:'b'.repeat(64)},confirmationId:'confirmation-1',taskId:'T0001',attemptId:'attempt-1',attemptNumber:1};
 const receipt={schemaVersion:1,kind:'NATIVE_TASK_EXECUTION_RECEIPT',requestId:payload.requestId,originalDigest:'c'.repeat(64),anchorGrantId:'11111111-1111-4111-8111-111111111111',checkCount:3,checkSetDigest:'d'.repeat(64),checksDigest:'e'.repeat(64),state:'results-recorded',cleanupComplete:true,authorityVerified:false,executionAuthorized:false};
 let calls=0;const run=async input=>{calls++;assert.ok(Object.isFrozen(input.expected));assert.deepEqual(input,payload);return receipt;};
 const capabilities={execute:async()=>{throw Error('single called');},recover:async()=>{throw Error('single called');},executeTask:run,recoverTask:run};
 const protocol=createNativeReviewHostProtocol({flow:make(),executionRequests:capabilities});capabilities.executeTask=async()=>{throw Error('mutated');};
 for(const command of ['execute-task','recover-task-execution']){const result=JSON.parse(await protocol.dispatchLine(encode(command,payload,command)));assert.equal(result.ok,true);assert.deepEqual(result.result,receipt);}
 assert.equal(calls,2);
 for(const patch of [{checkId:'injected'},{checks:['injected']},{credentials:{token:'PRIVATE'}},{attemptNumber:0}])assert.equal(JSON.parse(await protocol.dispatchLine(encode('execute-task',{...payload,...patch},`invalid-${calls++}`))).ok,false);
 for(const patch of [{checkCount:0},{checkCount:257},{authorityVerified:true},{executionAuthorized:true},{cleanupComplete:false},{requestId:'foreign'},{secret:'PRIVATE'},{anchorGrantId:'bad'},{checksDigest:'bad'}]){
  const p=createNativeReviewHostProtocol({flow:make(),executionRequests:{...capabilities,executeTask:async()=>({...receipt,...patch})}});
  const reply=await p.dispatchLine(encode('execute-task',payload));assert.equal(JSON.parse(reply).ok,false);assert.equal(reply.includes('PRIVATE'),false);
 }
 const absent=createNativeReviewHostProtocol({flow:make(),executionRequests:{execute:run,recover:run}});
 assert.equal(JSON.parse(await absent.dispatchLine(encode('execute-task',payload))).ok,false);
});
