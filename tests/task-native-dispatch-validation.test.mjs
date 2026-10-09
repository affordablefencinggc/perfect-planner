import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskNativeDispatch,createRetainedTaskNativeDispatch,parseNativeTaskObservation,nativeTaskSettlementObserved} from '../src/node/taskNativeDispatch.mjs';
const admitted=()=>({firstIntent:true,intentReceipt:{runId:'run-fixture',recordDigest:'a'.repeat(64)},executionSpec:{runId:'run-fixture',intentDigest:'a'.repeat(64),outputLimits:{stdoutBytes:10,stderrBytes:10,combinedBytes:15}},consumptionReceipt:{expiresAt:new Date(Date.now()+60000).toISOString()}});
const result=()=>({schemaVersion:1,kind:'NATIVE_TASK_OBSERVATION',runId:'run-fixture',exitCode:0,timedOut:false,cancelObserved:false,outputTruncated:false,cpuTimeExceeded:false,cpuObservationFailed:false,processExited:true,jobEmptyObserved:true,ioSettled:true,ioFailed:false,stdout:'ok',stderr:''});
test('retained dispatch exposes only retained writers and refuses a legacy finalization',async()=>{
 for(const legacy of [false,true]){
  const intent=admitted(),seen=[];
  const nativeCustody={retainCandidate:async()=>{},retainProvisional:async()=>{throw Error('legacy writer invoked');},retainInputs:async input=>{seen.push(input.artifactDigest);},retainIsolatedProvisional:async input=>{seen.push(input.retainedInputsDigest);},finalize:async()=>{seen.push('finalized');return {};}};
  const dispatch=createRetainedTaskNativeDispatch({review:{recordAssignedExecutionIntent:async()=>intent,inspectOwnGrantReceipt:async()=>intent},nativeCustody,executeNative:async(spec,callbacks)=>{
   assert.equal(Object.hasOwn(callbacks,'retainProvisional'),false);await callbacks.retainInputs(Buffer.from('fixture'),'b'.repeat(64));await callbacks.retainIsolatedProvisional(result(),'c'.repeat(64),'b'.repeat(64));
   return {observation:result(),finalization:legacy?{schemaVersion:2}:{schemaVersion:3,retainedInputsDigest:'b'.repeat(64)}};
  }});
  if(legacy)await assert.rejects(dispatch.dispatch({}),/NATIVE_TASK_DISPATCH_UNRESOLVED/);else await dispatch.dispatch({});
  assert.deepEqual(seen,legacy?['b'.repeat(64),'b'.repeat(64)]:['b'.repeat(64),'b'.repeat(64),'finalized']);
 }
});
// These are host-boundary validation tests, not native process execution proof.
test('missing candidate retention capability is refused before admission',()=>{
 let admittedCalls=0;
 const review={recordAssignedExecutionIntent:async()=>{admittedCalls++;return admitted();},inspectOwnGrantReceipt:async()=>admitted()};
 assert.throws(()=>createTaskNativeDispatch({review,executeNative:async()=>result(),nativeCustody:{retainProvisional:async()=>{},finalize:async()=>{}}}),/NATIVE_TASK_DISPATCH_CONFIG_INVALID/);
 assert.equal(admittedCalls,0);
});
test('malformed, foreign and contradictory native replies retain unresolved intent',async()=>{
  for(const change of [{runId:'other'},{exitCode:-1},{exitCode:2**32},{ioFailed:true},{processExited:false},{timedOut:'false'},{stdout:'x'.repeat(11)},{stdout:'x'.repeat(8),stderr:'x'.repeat(8)},{cleanupComplete:true}]){
    const intent=admitted();const dispatch=createTaskNativeDispatch({review:{recordAssignedExecutionIntent:async()=>intent,inspectOwnGrantReceipt:async()=>intent},executeNative:async()=>({...result(),...change})});
    await assert.rejects(dispatch.dispatch({}),error=>{assert.equal(error.message,'NATIVE_TASK_DISPATCH_UNRESOLVED');assert.deepEqual(error.intentReceipt,intent.intentReceipt);return true;});
  }
});
test('expired, missing or cancelled handoff never invokes native capability',async()=>{
  for(const mode of ['expired','invalid-expiry','missing-spec','cancelled','retry']){
    const intent=admitted(),cancel=new AbortController();let calls=0;
    if(mode==='expired')intent.consumptionReceipt.expiresAt='2000-01-01T00:00:00.000Z';
    if(mode==='invalid-expiry')intent.consumptionReceipt.expiresAt='invalid';
    if(mode==='missing-spec')intent.executionSpec=null;
    if(mode==='cancelled')cancel.abort();
    if(mode==='retry')intent.firstIntent=false;
    const dispatch=createTaskNativeDispatch({review:{recordAssignedExecutionIntent:async()=>intent,inspectOwnGrantReceipt:async()=>intent},executeNative:async()=>{calls++;return result();}});
    if(mode==='retry'){assert.equal((await dispatch.dispatch({})).dispatchObserved,false);}
    else await assert.rejects(dispatch.dispatch({}, {},{signal:cancel.signal}),/NATIVE_TASK_/);
    assert.equal(calls,0);
  }
});

test('versioned descendant evidence cannot be inferred for historical or incomplete observations',()=>{
 const spec=admitted().executionSpec,legacy=parseNativeTaskObservation(result(),spec);
 assert.equal(Object.hasOwn(legacy,'descendantsSettled'),false);assert.equal(nativeTaskSettlementObserved(legacy),false);
 const current={...result(),schemaVersion:2,descendantsSettled:true};
 assert.equal(nativeTaskSettlementObserved(parseNativeTaskObservation(current,spec)),true);
 const unresolved=parseNativeTaskObservation({...current,descendantsSettled:false},spec);
 assert.equal(nativeTaskSettlementObserved(unresolved),false);
 for(const patch of [{schemaVersion:1},{schemaVersion:3},{descendantsSettled:'true'},{jobEmptyObserved:false},{processExited:false,exitCode:null}]){
  assert.throws(()=>parseNativeTaskObservation({...current,...patch},spec),/NATIVE_TASK_OBSERVATION_/);
 }
 const missing={...current};delete missing.descendantsSettled;assert.throws(()=>parseNativeTaskObservation(missing,spec));
 const failed=parseNativeTaskObservation({...current,exitCode:7},spec);assert.equal(nativeTaskSettlementObserved(failed),true);assert.equal(failed.exitCode,7);
});
