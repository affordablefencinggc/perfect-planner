import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {nativeStorageFailure} from '../src/native/storageFailure.js';
import {createNativeTaskResultHost} from '../src/native/taskResultHost.js';
import {createNativeTaskDraftHost} from '../src/native/taskDraftHost.js';
import {createNativeCheckSetupHost} from '../src/native/checkSetupHost.js';
const failure=code=>({code,executionAuthorized:false,requiresRecovery:false,requestMayHaveCommitted:false,originalRequestId:'retained-request',message:'private-path-and-token',path:'private-path-and-token'});
const project=()=>({projectId:'pp_result',state:'observed',registration:{workspaceId:'fixture',registryRevision:1,rootIdentity:'a'.repeat(64)},census:{digest:'b'.repeat(64)}});
const runtime={__TAURI_INTERNALS__:{invoke(){}}};
test('storage errors distinguish availability, limits and recovery without native text',()=>{
 assert.equal(os.hostname().toLowerCase(),'dans1');
 for(const [code,kind] of [['NATIVE_SESSION_STORE_UNAVAILABLE','unavailable'],['NATIVE_DRAFT_DIAGNOSTIC_LIMIT','limit'],['NATIVE_SESSION_STORE_LEGACY_CHANGED','recovery'],['NATIVE_SESSION_STORE_UNCERTAIN','recovery']]){
  const result=nativeStorageFailure(failure(code));assert.equal(result.storageReason,kind);assert.equal(result.executionAuthorized,false);assert.equal(result.originalRequestId,'retained-request');assert.equal(result.requiresRecovery,false);assert.ok(!result.message.includes('private-path'));assert.equal(result.path,undefined);
  const uncertain=nativeStorageFailure({...failure(code),requiresRecovery:true,requestMayHaveCommitted:true});assert.equal(uncertain.requiresRecovery,true);assert.equal(uncertain.requestMayHaveCommitted,true);
 }
});
test('unknown codes and incomplete or contradictory native envelopes remain unclassified',()=>{
 for(const input of [{...failure('OTHER_CODE')},{...failure('NATIVE_SESSION_STORE_UNAVAILABLE'),executionAuthorized:true},{...failure('NATIVE_SESSION_STORE_UNAVAILABLE'),requiresRecovery:undefined},{...failure('NATIVE_SESSION_STORE_UNAVAILABLE'),requestMayHaveCommitted:'no'},null])assert.equal(nativeStorageFailure(input),null);
 const result=nativeStorageFailure({...failure('NATIVE_SESSION_STORE_UNAVAILABLE'),originalRequestId:'private/path'});assert.equal(result.originalRequestId,undefined);
});
test('draft, check and result adapters preserve the same bounded storage failure',async()=>{
 for(const make of [options=>createNativeTaskDraftHost(project(),options).inspect(),options=>createNativeCheckSetupHost(project(),options).inspect('f'.repeat(64)),options=>createNativeTaskResultHost(project(),options).readPage()]){
  let calls=0;await assert.rejects(make({runtime,invoke:async()=>{calls++;throw failure('NATIVE_SESSION_STORE_UNAVAILABLE');}}),error=>error.storageReason==='unavailable'&&error.executionAuthorized===false&&error.message.includes('disk space and folder access'));
  assert.equal(calls,1);
 }
});
test('late storage failure cannot escape the result adapter after project change',async()=>{
 const p=project();let reject;const host=createNativeTaskResultHost(p,{runtime,invoke:()=>new Promise((_,fail)=>{reject=fail;})});
 const pending=host.readPage();p.registration.registryRevision=2;reject(failure('NATIVE_SESSION_STORE_UNCERTAIN'));
 await assert.rejects(pending,error=>error.message==='NATIVE_TASK_RESULT_UNAVAILABLE'&&error.storageReason===undefined);
});
