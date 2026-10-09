import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeCheckSetupHost} from '../src/native/checkSetupHost.js';
const binding={projectId:'pp_check_adapter',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)};
const project=()=>({projectId:binding.projectId,registration:{workspaceId:'workspace-1',registryRevision:1,rootIdentity:binding.rootIdentity},census:{digest:binding.censusDigest}});
const runtime={__TAURI_INTERNALS__:{}},setupReference='c'.repeat(64),assignments=[{taskId:'T0001',categories:['tests']}];
const state=()=>({setup:{setupReference,profileId:'perfect-planner-checks-v1',assignments},schemaVersion:1,binding,contractHead:{revision:0,headDigest:'GENESIS'},requestedOriginalId:null,original:null,registrationLeaseHeld:false,executionAuthorized:false,retainedOriginal:null,cleanupComplete:true});
const input=()=>({setupReference,expected:{hostRevision:1,headDigest:'d'.repeat(64)},originalRequest:{requestId:'original-1',expectedRevision:0,expectedHeadDigest:'GENESIS'}});
const receipt=()=>({schemaVersion:1,profileId:'perfect-planner-checks-v1',originalRequestId:'original-1',contractDigest:'e'.repeat(64),policyDigest:'f'.repeat(64),contractHead:{revision:1,headDigest:'1'.repeat(64)},idempotent:false,matchesObservedContractHead:true,preparationPersisted:true,observationEvidencePersisted:true,reviewEnabled:false,toolchainVerified:false,candidateVerified:false,executionAuthorized:false,registrationLeaseHeld:false,binding,setupReference,expectedProposal:input().expected,cleanupComplete:true});
test('repository profile selection must match its returned receipt',async()=>{
 const saved={schemaVersion:1,binding,selectionState:'saved',setupReference,setupPersisted:true,toolName:'npm-cli.js',toolDigest:'d'.repeat(64),profileId:'npm-project-checks-v1',assignments,toolchainVerified:false,executionAuthorized:false};let sent;
 const host=createNativeCheckSetupHost(project(),{runtime,invoke:async(command,args)=>{sent=args.request;return saved;}});
 assert.equal((await host.choose(assignments,'npm-project-checks-v1')).profileId,'npm-project-checks-v1');assert.equal(sent.profileId,'npm-project-checks-v1');
 await assert.rejects(host.choose(assignments));assert.throws(()=>host.choose(assignments,'unknown'));
 const generic=createNativeCheckSetupHost(project(),{runtime,invoke:async()=>({...receipt(),profileId:'npm-project-checks-v1'})});assert.equal((await generic.prepare(input())).profileId,'npm-project-checks-v1');
});
test('inspection refuses foreign, unknown or path-bearing setup metadata',async()=>{
 for(const setup of [{...state().setup,setupReference:'f'.repeat(64)},{...state().setup,profileId:'unknown'},{...state().setup,assignments:[]},{...state().setup,npmCli:'private'}]){const h=createNativeCheckSetupHost(project(),{runtime,invoke:async()=>({...state(),setup})});await assert.rejects(h.inspect(setupReference));}
 const setup={...state().setup,profileId:'npm-project-checks-v1'};const h=createNativeCheckSetupHost(project(),{runtime,invoke:async()=>({...state(),setup})});assert.deepEqual((await h.inspect(setupReference)).setup,setup);
});
test('web runtime refuses check commands without invoking native',async()=>{let calls=0;const host=createNativeCheckSetupHost(project(),{runtime:{},invoke:()=>calls++});assert.equal(host.available,false);await assert.rejects(host.inspect(setupReference));assert.equal(calls,0);});
test('picker uses captured identity and cancellation never looks saved',async()=>{const p=project();let sent;const host=createNativeCheckSetupHost(p,{runtime,invoke:async(command,args)=>{sent={command,args};return {schemaVersion:1,binding,selectionState:'cancelled',setupReference:null,setupPersisted:false,executionAuthorized:false};}});p.registration.workspaceId='changed';const result=await host.choose(assignments);assert.equal(sent.command,'choose_native_check_setup');assert.equal(sent.args.request.identity.workspaceId,'workspace-1');assert.equal(result.setupPersisted,false);assert.ok(Object.isFrozen(result));});
test('picker refuses unrelated assignments and private fields',async()=>{for(const extra of [{assignments:[{taskId:'T0002',categories:['tests']}]},{privatePath:'private'},{executionAuthorized:true}]){const host=createNativeCheckSetupHost(project(),{runtime,invoke:async()=>({schemaVersion:1,binding,selectionState:'saved',setupReference,setupPersisted:true,toolName:'npm-cli.js',toolDigest:'d'.repeat(64),profileId:'perfect-planner-checks-v1',assignments,toolchainVerified:false,executionAuthorized:false,...extra})});await assert.rejects(host.choose(assignments));}});
test('invalid configuration is rejected before dispatch',()=>{let calls=0;const h=createNativeCheckSetupHost(project(),{runtime,invoke:()=>calls++});for(const a of [[],[{taskId:'T0001',categories:['deploy']}],[{taskId:'T0001',categories:['tests'],path:'private'}]])assert.throws(()=>h.choose(a));assert.throws(()=>h.prepare({...input(),command:'run'}));assert.throws(()=>h.inspect('private/path'));assert.equal(calls,0);});
test('prepare preserves original and validates authority-free receipt',async()=>{let sent;const h=createNativeCheckSetupHost(project(),{runtime,invoke:async(command,args)=>{sent={command,args};return receipt();}});assert.equal((await h.prepare(input())).executionAuthorized,false);assert.equal(sent.command,'prepare_native_checks');assert.deepEqual(sent.args.request.originalRequest,input().originalRequest);});
test('prepare rejects wrong reference, unexpected authority, wrong revision and unsettled results',async()=>{for(const fields of [{setupReference:'0'.repeat(64)},{executionAuthorized:true},{cleanupComplete:false},{contractHead:{revision:2,headDigest:'1'.repeat(64)}},{privatePath:'secret'}]){const h=createNativeCheckSetupHost(project(),{runtime,invoke:async()=>({...receipt(),...fields})});await assert.rejects(h.prepare(input()));}});
test('inspection cannot fabricate pending or approved work',async()=>{const h=createNativeCheckSetupHost(project(),{runtime,invoke:async()=>state()});assert.equal((await h.inspect(setupReference)).retainedOriginal,null);for(const fields of [{requestedOriginalId:'not-retained'},{executionAuthorized:true},{original:{}},{binding:{...binding,projectId:'other'}},{cleanupComplete:false}]){const bad=createNativeCheckSetupHost(project(),{runtime,invoke:async()=>({...state(),...fields})});await assert.rejects(bad.inspect(setupReference));}});
test('inspection preserves a complete pending original for exact retry',async()=>{const i=input();const identity={schemaVersion:1,workspaceId:'workspace-1',registryRevision:1,rootIdentity:binding.rootIdentity,censusDigest:binding.censusDigest};const retainedOriginal={identity,...i};const h=createNativeCheckSetupHost(project(),{runtime,invoke:async()=>({...state(),requestedOriginalId:'original-1',retainedOriginal})});const result=await h.inspect(setupReference);assert.deepEqual(result.retainedOriginal,retainedOriginal);assert.ok(Object.isFrozen(result.retainedOriginal.originalRequest));});
test('native failures preserve recovery flags but never raw error text',async()=>{const h=createNativeCheckSetupHost(project(),{runtime,invoke:async()=>{throw {code:'NATIVE_DRAFT_OUTCOME_UNKNOWN',executionAuthorized:false,requiresRecovery:false,requestMayHaveCommitted:true,originalRequestId:'original-1',message:'secret path'};}});await assert.rejects(h.prepare(input()),e=>e.requestMayHaveCommitted===true&&e.originalRequestId==='original-1'&&!e.message.includes('secret'));});
test('inspection reconciles complete retained request and proposal, not only the ID',async()=>{
 const i=input(),identity={schemaVersion:1,workspaceId:'workspace-1',registryRevision:1,rootIdentity:binding.rootIdentity,censusDigest:binding.censusDigest};
 const value={...state(),contractHead:receipt().contractHead,requestedOriginalId:i.originalRequest.requestId,retainedOriginal:{identity,...i},original:{binding,request:i.originalRequest,contractHead:receipt().contractHead,contractDigest:receipt().contractDigest,policyDigest:receipt().policyDigest,proposalHead:i.expected,matchesObservedContractHead:true,observationEvidenceVerified:false}};
 const inspect=v=>createNativeCheckSetupHost(project(),{runtime,invoke:async()=>v}).inspect(setupReference);
 assert.deepEqual((await inspect(value)).original.request,i.originalRequest);
 for(const change of [v=>{v.original.proposalHead.headDigest='9'.repeat(64);},v=>{v.original.proposalHead.hostRevision=2;},v=>{v.original.binding.censusDigest='9'.repeat(64);},v=>{v.retainedOriginal.originalRequest={...i.originalRequest,expectedRevision:1,expectedHeadDigest:'8'.repeat(64)};}]){
  const altered=structuredClone(value);altered.original=structuredClone(altered.original);change(altered);await assert.rejects(inspect(altered));
 }
});

test('review forwards exact prepared heads without an approval decision',async()=>{
 const request={setupReference,expected:input().expected,contractHead:receipt().contractHead,requestId:'review-1'};let sent;
 const result={schemaVersion:1,binding,requestId:request.requestId,expected:request.expected,contractHead:request.contractHead,confirmation:{id:'confirmation-1',status:'approved'},retainedResult:false,recoveredSession:false,executionAuthorized:false,cleanupComplete:true};
 const host=createNativeCheckSetupHost(project(),{runtime,invoke:async(command,args)=>{sent={command,args};return result;}});
 assert.equal((await host.review(request)).executionAuthorized,false);assert.equal(sent.command,'review_native_checks');assert.equal(Object.hasOwn(sent.args.request,'decision'),false);
 assert.throws(()=>host.review({...request,decision:'approved'}));
 for(const fields of [{executionAuthorized:true},{cleanupComplete:false},{requestId:'foreign'},{expected:{...request.expected,hostRevision:2}},{contractHead:{...request.contractHead,revision:2}},{confirmation:{id:'confirmation-1',status:'pending'}}]){
  const bad=createNativeCheckSetupHost(project(),{runtime,invoke:async()=>({...result,...fields})});await assert.rejects(bad.review(request));
 }
});

test('recovery requires exact original and a retained authority-free decision',async()=>{
 const request={setupReference,expected:input().expected,contractHead:receipt().contractHead,requestId:'review-1'};let command;
 const value={schemaVersion:1,binding,requestId:request.requestId,expected:request.expected,contractHead:request.contractHead,confirmation:{id:'confirmation-1',status:'approved'},retainedResult:true,recoveredSession:true,executionAuthorized:false,cleanupComplete:true};
 const h=createNativeCheckSetupHost(project(),{runtime,invoke:async(c)=>{command=c;return value;}});assert.equal((await h.recoverReview(request)).recoveredSession,true);assert.equal(command,'recover_native_check_review');
 for(const fields of [{retainedResult:false},{recoveredSession:null},{executionAuthorized:true},{cleanupComplete:false},{requestId:'other'}]){const bad=createNativeCheckSetupHost(project(),{runtime,invoke:async()=>({...value,...fields})});await assert.rejects(bad.recoverReview(request));}
});


test('execution adapter sends only exact approved selection and validates retained receipt',async()=>{
 const request={setupReference,expected:input().expected,contractHead:receipt().contractHead,requestId:'execute-1',confirmationId:'approved-1',taskId:'T0001',checkId:'tests',attemptId:'attempt-1',attemptNumber:1};
 const terminal={schemaVersion:1,kind:'NATIVE_CHECK_EXECUTION_RECEIPT',requestId:request.requestId,originalDigest:'a'.repeat(64),grantId:'11111111-1111-4111-8111-111111111111',runId:'22222222-2222-4222-8222-222222222222',intentDigest:'b'.repeat(64),artifactDigest:'c'.repeat(64),state:'result-recorded',cleanupComplete:true,executionAuthorized:false};
 const result={schemaVersion:1,binding,requestId:request.requestId,expected:request.expected,contractHead:request.contractHead,receipt:terminal,retainedResult:false,recoveredSession:false,executionAuthorized:false,cleanupComplete:true};
 let sent;const host=createNativeCheckSetupHost(project(),{runtime,invoke:async(command,args)=>{sent={command,args};return result;}});
 assert.equal((await host.execute(request)).receipt.grantId,terminal.grantId);assert.equal(sent.command,'execute_native_check');assert.deepEqual(sent.args.request,{identity:{schemaVersion:1,workspaceId:'workspace-1',registryRevision:1,rootIdentity:binding.rootIdentity,censusDigest:binding.censusDigest},...request});
 for(const patch of [{credentials:{}},{executable:'C:/foreign'},{attemptNumber:0},{taskId:'T00001'}])assert.throws(()=>host.execute({...request,...patch}));
 for(const patch of [{requestId:'wrong'},{receipt:{...terminal,originalDigest:'bad'}},{receipt:{...terminal,cleanupComplete:false}},{receipt:{...terminal,executionAuthorized:true}},{binding:{...binding,projectId:'other'}},{privatePath:'hidden'}]){const bad=createNativeCheckSetupHost(project(),{runtime,invoke:async()=>({...result,...patch})});await assert.rejects(bad.execute(request));}
 await assert.rejects(host.recoverExecution(request));
 const recover=createNativeCheckSetupHost(project(),{runtime,invoke:async(command)=>{assert.equal(command,'recover_native_check_execution');return {...result,retainedResult:true,recoveredSession:true};}});assert.equal((await recover.recoverExecution(request)).retainedResult,true);
});

test('not-started review gives retry guidance only with definitive native flags',async()=>{
 const request={setupReference,expected:input().expected,contractHead:receipt().contractHead,requestId:'review-1'};
 for(const flags of [{requiresRecovery:false,requestMayHaveCommitted:false},{requiresRecovery:true,requestMayHaveCommitted:false},{requiresRecovery:false,requestMayHaveCommitted:true}]){
  let calls=0;const host=createNativeCheckSetupHost(project(),{runtime,invoke:async()=>{calls++;throw {code:'NATIVE_CHECK_REVIEW_NOT_STARTED',executionAuthorized:false,...flags};}});
  await assert.rejects(host.recoverReview(request),e=>{assert.equal(e.message.includes('You can retry'),!flags.requiresRecovery&&!flags.requestMayHaveCommitted);assert.equal(e.requiresRecovery,flags.requiresRecovery);return true;});
  assert.equal(calls,1);
 }
});

test('not-started recovery receipt never invents a grant or execution',async()=>{
 const request={setupReference,expected:input().expected,contractHead:receipt().contractHead,requestId:'not-started',confirmationId:'approved-1',taskId:'T0001',checkId:'tests',attemptId:'attempt-1',attemptNumber:1};
 const terminal={schemaVersion:1,kind:'NATIVE_CHECK_NOT_STARTED_RECEIPT',requestId:request.requestId,originalDigest:'a'.repeat(64),proofDigest:'b'.repeat(64),state:'not-started',cleanupComplete:true,executionAuthorized:false};
 const value={schemaVersion:1,binding,requestId:request.requestId,expected:request.expected,contractHead:request.contractHead,receipt:terminal,retainedResult:true,recoveredSession:true,executionAuthorized:false,cleanupComplete:true};
 const host=createNativeCheckSetupHost(project(),{runtime,invoke:async()=>value});assert.equal((await host.recoverExecution(request)).receipt.state,'not-started');
 for(const patch of [{grantId:'11111111-1111-4111-8111-111111111111'},{state:'result-recorded'},{proofDigest:'bad'},{cleanupComplete:false},{executionAuthorized:true}]){const bad=createNativeCheckSetupHost(project(),{runtime,invoke:async()=>({...value,receipt:{...terminal,...patch}})});await assert.rejects(bad.recoverExecution(request));}
});

test('full-task adapter preserves batch scope and rejects false batch authority',async()=>{
 const request={setupReference,expected:input().expected,contractHead:receipt().contractHead,requestId:'task-1',confirmationId:'approved-1',taskId:'T0001',attemptId:'attempt-1',attemptNumber:1};
 const terminal={schemaVersion:1,kind:'NATIVE_TASK_EXECUTION_RECEIPT',requestId:request.requestId,originalDigest:'a'.repeat(64),anchorGrantId:'11111111-1111-4111-8111-111111111111',checkCount:3,checkSetDigest:'b'.repeat(64),checksDigest:'c'.repeat(64),state:'results-recorded',cleanupComplete:true,authorityVerified:false,executionAuthorized:false};
 const result={schemaVersion:1,binding,requestId:request.requestId,expected:request.expected,contractHead:request.contractHead,receipt:terminal,retainedResult:false,recoveredSession:false,executionAuthorized:false,cleanupComplete:true};
 const host=createNativeCheckSetupHost(project(),{runtime,invoke:async(command,args)=>{assert.equal(command,'execute_native_task');assert.equal(Object.hasOwn(args.request,'checkId'),false);return result;}});
 assert.deepEqual((await host.executeTask(request)).receipt,terminal);
 for(const patch of [{checkId:'tests'},{checks:['tests']},{credentials:{}}])assert.throws(()=>host.executeTask({...request,...patch}));
 for(const patch of [{authorityVerified:true},{checkCount:257},{checksDigest:'bad'},{cleanupComplete:false},{kind:'NATIVE_CHECK_EXECUTION_RECEIPT'},{privatePath:'hidden'}]){
  const bad=createNativeCheckSetupHost(project(),{runtime,invoke:async()=>({...result,receipt:{...terminal,...patch}})});await assert.rejects(bad.executeTask(request));
 }
 const recovered=createNativeCheckSetupHost(project(),{runtime,invoke:async command=>{assert.equal(command,'recover_native_task_execution');return {...result,retainedResult:true,recoveredSession:true};}});
 assert.deepEqual((await recovered.recoverTaskExecution(request)).receipt,terminal);
 await assert.rejects(host.recoverTaskExecution(request));
});
