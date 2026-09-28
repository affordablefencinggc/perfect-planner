// Private host composition: no renderer/MCP command or caller-selected executor.
// executeNative must perform final native executable/candidate binding itself.
// Intent first-use is not a security capability outside this trusted composition.
import {createHash} from 'node:crypto';
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const fail=(code,intentReceipt)=>{throw Object.assign(Error(code),{intentReceipt,executionAuthorized:false});};
export function parseNativeTaskObservation(value,spec){
  const keys=['schemaVersion','kind','runId','exitCode','timedOut','cancelObserved','outputTruncated','cpuTimeExceeded','cpuObservationFailed','processExited','jobEmptyObserved','ioSettled','ioFailed','stdout','stderr'];
  if(value?.schemaVersion===2)keys.push('descendantsSettled');
  if(!value||Object.keys(value).sort().join('|')!==keys.sort().join('|')||![1,2].includes(value.schemaVersion)||value.kind!=='NATIVE_TASK_OBSERVATION'||value.runId!==spec.runId)throw Error('NATIVE_TASK_OBSERVATION_MISMATCH');
  if(value.exitCode!==null&&(!Number.isInteger(value.exitCode)||value.exitCode<0||value.exitCode>0xffffffff))throw Error('NATIVE_TASK_OBSERVATION_INVALID');
  for(const key of ['timedOut','cancelObserved','outputTruncated','cpuTimeExceeded','cpuObservationFailed','processExited','jobEmptyObserved','ioSettled','ioFailed'])if(typeof value[key]!=='boolean')throw Error('NATIVE_TASK_OBSERVATION_INVALID');
  if(typeof value.stdout!=='string'||typeof value.stderr!=='string'||Buffer.byteLength(value.stdout)>spec.outputLimits.stdoutBytes||Buffer.byteLength(value.stderr)>spec.outputLimits.stderrBytes||Buffer.byteLength(value.stdout)+Buffer.byteLength(value.stderr)>spec.outputLimits.combinedBytes)throw Error('NATIVE_TASK_OUTPUT_INVALID');
  if((value.ioFailed&&value.ioSettled)||(!value.processExited&&value.exitCode!==null))throw Error('NATIVE_TASK_OBSERVATION_CONTRADICTORY');
  if(value.schemaVersion===2){
    if(typeof value.descendantsSettled!=='boolean')throw Error('NATIVE_TASK_OBSERVATION_INVALID');
    if(value.descendantsSettled&&(!value.processExited||!value.jobEmptyObserved))throw Error('NATIVE_TASK_OBSERVATION_CONTRADICTORY');
  }
  return freeze(structuredClone(value));
}
// Version-one records remain readable; they never acquire descendant evidence
// retroactively. This predicate is for new execution settlement and recovery.
export function nativeTaskSettlementObserved(value){
  return value?.schemaVersion===2&&value.processExited===true&&value.jobEmptyObserved===true
    &&value.descendantsSettled===true&&value.ioSettled===true&&value.ioFailed!==true;
}
export function createTaskNativeDispatch({review,executeNative,recordObservation,nativeCustody}){
  if(typeof review?.recordAssignedExecutionIntent!=='function'||typeof review?.inspectOwnGrantReceipt!=='function'||typeof executeNative!=='function')throw Error('NATIVE_TASK_DISPATCH_CONFIG_INVALID');
  if(recordObservation!==undefined&&typeof recordObservation!=='function')throw Error('NATIVE_TASK_DISPATCH_CONFIG_INVALID');
  if(nativeCustody&&(typeof nativeCustody.retainProvisional!=='function'||typeof nativeCustody.finalize!=='function'))throw Error('NATIVE_TASK_DISPATCH_CONFIG_INVALID');
  const record=review.recordAssignedExecutionIntent.bind(review),inspect=review.inspectOwnGrantReceipt.bind(review),execute=executeNative;
  const pending=new Map();
  async function perform({expected,confirmationId,enrollmentHead,input,consumptionReceipt,request},sessionOptions={},captureOptions={}){
      const args=structuredClone({expected,confirmationId,enrollmentHead,input,consumptionReceipt,request});
      const signal=captureOptions.signal;
      const admitted=await record(args.expected,args.confirmationId,args.enrollmentHead,args.input,args.consumptionReceipt,args.request,sessionOptions,captureOptions);
      if(!admitted.firstIntent)return freeze({intentReceipt:admitted.intentReceipt,dispatchObserved:false,state:'original-intent-retained',executionAuthorized:false});
      const intent=admitted.intentReceipt,spec=admitted.executionSpec;
      if(!intent||!spec||spec.runId!==intent.runId||spec.intentDigest!==intent.recordDigest)fail('NATIVE_TASK_HANDOFF_MISMATCH',intent);
      if(signal?.aborted)fail('NATIVE_TASK_CANCELLED_BEFORE_DISPATCH',intent);
      const expires=Date.parse(admitted.consumptionReceipt?.expiresAt);
      if(!Number.isFinite(expires)||Date.now()>=expires)fail('NATIVE_TASK_EXPIRED_BEFORE_DISPATCH',intent);
      try{
        const value=await execute(spec,{signal,expiresAt:admitted.consumptionReceipt.expiresAt,...(nativeCustody?{retainProvisional:observation=>nativeCustody.retainProvisional({intentReceipt:intent,executionSpec:spec,observation})}:{})});
        const result=parseNativeTaskObservation(nativeCustody?value.observation:value,spec);
        const stored=nativeCustody?await nativeCustody.finalize({intentReceipt:intent,finalization:value.finalization}):recordObservation?await recordObservation({intentReceipt:intent,executionSpec:spec,observation:result}):null;
        return freeze({intentReceipt:intent,dispatchObserved:true,state:'result-unverified',observation:result,observationReceipt:stored,executionAuthorized:false});
      }catch(error){
        // A lost/malformed reply cannot authorize a replay. Original intent stays
        // durable and unresolved; terminal/artifact custody must reconcile it.
        throw Object.assign(Error('NATIVE_TASK_DISPATCH_UNRESOLVED',{cause:error}),{intentReceipt:intent,executionAuthorized:false});
      }
  }
  return Object.freeze({
    async dispatch(input,sessionOptions={},captureOptions={}){
      const args=structuredClone(input);
      const key=createHash('sha256').update(JSON.stringify(canonical(args))).digest('hex');
      const previous=pending.get(key);
      if(previous){
        const first=await previous;
        if(captureOptions.signal?.aborted)fail('NATIVE_TASK_CANCELLED_BEFORE_DISPATCH',first.intentReceipt);
        // Coalescing identical in-flight requests only avoids duplicate heavy
        // preflight. Authenticate again before revealing the retained identity.
        const retained=await inspect({...args.input,grantId:args.request.grantId},sessionOptions);
        if(!retained.intentReceipt||retained.intentReceipt.recordDigest!==first.intentReceipt?.recordDigest)fail('NATIVE_TASK_HANDOFF_MISMATCH',first.intentReceipt);
        return freeze({intentReceipt:retained.intentReceipt,dispatchObserved:false,state:'original-intent-retained',executionAuthorized:false});
      }
      if(pending.size>=64)throw Error('NATIVE_TASK_DISPATCH_BUSY');
      const operation=perform(args,sessionOptions,captureOptions);pending.set(key,operation);
      try{return await operation;}finally{pending.delete(key);}
    },
    inspectOriginal:inspect,
  });
}
