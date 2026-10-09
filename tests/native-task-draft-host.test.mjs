import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeTaskDraftHost} from '../src/native/taskDraftHost.js';
import {emptyTaskDraftLedger,updateTaskDraft} from '../src/project/taskDraftLedger.js';
const binding={projectId:'pp_native_host_test',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)};
const project=()=>({projectId:binding.projectId,registration:{workspaceId:'workspace-1',registryRevision:1,rootIdentity:binding.rootIdentity},census:{digest:binding.censusDigest}});
const base=()=>({schemaVersion:1,binding:{...binding},observedHead:{hostRevision:0,headDigest:'GENESIS'},submission:null,registrationCurrent:true,registrationLeaseHeld:false,approvalState:'unapproved-proposal',executionAuthorized:false,cleanupComplete:true});
const runtime={__TAURI_INTERNALS__:{}};
test('diagnostic failures preserve recovery and original identity without leaking private data',async()=>{
  for(const code of ['NATIVE_DRAFT_DIAGNOSTIC_INVALID','NATIVE_DRAFT_DIAGNOSTIC_LIMIT','NATIVE_DRAFT_DIAGNOSTIC_UNAVAILABLE']){
    for(const requiresRecovery of [false,true]){
      const host=createNativeTaskDraftHost(project(),{runtime,invoke:async()=>{throw {code,requiresRecovery,requestMayHaveCommitted:requiresRecovery,originalRequestId:'original-kept-1',executionAuthorized:false,message:'private filesystem path',payload:'secret'};}});
      await assert.rejects(host.inspect(),error=>error.code===code&&error.requiresRecovery===requiresRecovery&&error.requestMayHaveCommitted===requiresRecovery&&error.originalRequestId==='original-kept-1'&&!error.message.includes('private')&&!Object.hasOwn(error,'payload'));
    }
  }
});
test('native outstanding original ID is retained only when structurally valid',async()=>{
  for(const id of ['older-original-1','private/path',null,{}]){
    const host=createNativeTaskDraftHost(project(),{runtime,invoke:async()=>{throw {code:'NATIVE_DRAFT_OUTCOME_UNKNOWN',requiresRecovery:false,requestMayHaveCommitted:true,originalRequestId:id,executionAuthorized:false};}});
    await assert.rejects(host.inspect(),e=>e.requiresRecovery===false&&e.originalRequestId===(id==='older-original-1'?id:undefined));
  }
});
function payload(){return {ledger:updateTaskDraft(emptyTaskDraftLedger(binding),{title:'Saved draft',description:'',owner:'',acceptance:'',recovery:'',claims:[],dependsOn:[],archived:false}),request:{requestId:'original-native-1',expectedRevision:0,expectedHeadDigest:'GENESIS'}};}
test('web runtime is explicitly unavailable and never invokes native commands',async()=>{let calls=0;const host=createNativeTaskDraftHost(project(),{runtime:{},invoke:()=>{calls++;}});assert.equal(host.available,false);await assert.rejects(host.inspect());assert.equal(calls,0);});
test('inspection freezes registration and exposes no private wrapper fields',async()=>{const p=project();let sent;const host=createNativeTaskDraftHost(p,{runtime,invoke:async(command,args)=>{sent={command,args};return base();}});p.registration.workspaceId='changed';const result=await host.inspect();assert.equal(sent.command,'inspect_native_draft_proposal');assert.equal(sent.args.request.workspaceId,'workspace-1');assert.equal(result.observedHead.hostRevision,0);assert.equal(Object.hasOwn(result,'binding'),false);});
test('submission preserves original request and validates projected receipt',async()=>{const data=payload();let sent;const host=createNativeTaskDraftHost(project(),{runtime,invoke:async(command,args)=>{sent={command,args};return {...base(),observedHead:{hostRevision:1,headDigest:'c'.repeat(64)},submission:{record:{hostRevision:1,headDigest:'c'.repeat(64),ledgerDigest:'d'.repeat(64)},submissionPersisted:true,idempotent:false,submittedMatchesObservedHead:true}};}});const result=await host.submit(data);assert.equal(sent.command,'submit_native_draft_proposal');assert.deepEqual(sent.args.request.originalRequest,data.request);assert.deepEqual(sent.args.request.ledger,data.ledger);assert.equal(result.submissionPersisted,true);assert.equal(result.executionAuthorized,false);});
test('foreign, unexpected and unsettled native responses are refused',async()=>{for(const mutate of [v=>{v.binding.projectId='pp_foreign';},v=>{v.secret='private';},v=>{v.cleanupComplete=false;},v=>{v.executionAuthorized=true;},v=>{v.submission={};}]){const value=base();mutate(value);const host=createNativeTaskDraftHost(project(),{runtime,invoke:async()=>value});await assert.rejects(host.inspect());}});
test('foreign ledger is rejected before IPC and host errors never leak details',async()=>{let count=0;const host=createNativeTaskDraftHost(project(),{runtime,invoke:async()=>{count++;throw Error('private native filesystem secret');}});const data=payload();data.ledger={...data.ledger,binding:{...binding,projectId:'pp_foreign'}};assert.throws(()=>host.submit(data));assert.equal(count,0);await assert.rejects(host.inspect(),e=>!e.message.includes('filesystem secret'));});
test('native recovery requirement survives without exposing native error content',async()=>{const host=createNativeTaskDraftHost(project(),{runtime,invoke:async()=>{throw {code:'NATIVE_DRAFT_SESSION_UNRESOLVED',requiresRecovery:true,requestMayHaveCommitted:true,originalRequestId:'original-1',executionAuthorized:false,message:'private path'};}});await assert.rejects(host.inspect(),e=>e.requiresRecovery===true&&e.code==='NATIVE_DRAFT_SESSION_UNRESOLVED'&&!e.message.includes('private path'));});
