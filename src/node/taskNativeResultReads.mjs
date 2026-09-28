import {parseNativeTaskObservation} from './taskNativeDispatch.mjs';

// Private host composition. No caller-selected paths, executors or result
// receipts. This is historical observation access, never permission to run.
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const wire=v=>JSON.stringify(canonical(v));
const fail=()=>{throw Error('NATIVE_TASK_RESULT_UNAVAILABLE');};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
export function createTaskNativeResultReads({review,observations}){
 if(typeof review?.inspectOwnGrantReceipt!=='function'||typeof observations?.inspect!=='function')fail();
 const authenticate=review.inspectOwnGrantReceipt.bind(review),read=observations.inspect.bind(observations);
 return Object.freeze({async readOwn(input,sessionOptions={}){
  input=structuredClone(input);
  const original=await authenticate(input,sessionOptions),intent=original.intentReceipt;
  if(!intent||intent.kind!=='TASK_EXECUTION_INTENT_RECEIPT'||intent.executionAuthorized!==false)fail();
  const saved=await read(intent),receipt=saved?.receipt;
  if(!exact(saved,['receipt','observation'])||!exact(receipt,['schemaVersion','kind','projectId','rootIdentity','runId','intentDigest','artifactDigest','state','executionAuthorized'])||receipt.schemaVersion!==1||receipt.kind!=='NATIVE_TASK_OBSERVATION_RECEIPT'||receipt.state!=='result-unverified'||receipt.executionAuthorized!==false||receipt.projectId!==intent.projectId||receipt.rootIdentity!==intent.rootIdentity||receipt.runId!==intent.runId||receipt.intentDigest!==intent.recordDigest||!/^[a-f0-9]{64}$/.test(receipt.artifactDigest))fail();
  const observed=parseNativeTaskObservation(saved.observation,{runId:intent.runId,outputLimits:{stdoutBytes:1048576,stderrBytes:1048576,combinedBytes:2097152}});
  // Disk access is asynchronous: revoke/expiry during read must not reveal a
  // stale authorized response. This does not hold a cross-process read lease.
  const current=await authenticate(input,sessionOptions);
  if(wire(current.intentReceipt)!==wire(intent))fail();
  const link=current.observationLink;
  if(link&&(link.kind!=='TASK_EXECUTION_OBSERVATION_LINK'||link.projectId!==intent.projectId||link.rootIdentity!==intent.rootIdentity||link.grantId!==intent.grantId||link.runId!==intent.runId||link.intentDigest!==intent.recordDigest||link.artifactDigest!==receipt.artifactDigest||link.state!=='result-unverified'||link.executionAuthorized!==false))fail();
  const reasons=[];
  if(observed.exitCode!==null&&observed.exitCode!==0)reasons.push('nonzero-exit');
  for(const [key,reason]of [['timedOut','time-limit'],['cancelObserved','cancellation-observed'],['outputTruncated','output-limit'],['cpuTimeExceeded','cpu-limit'],['cpuObservationFailed','cpu-observation-failed'],['ioFailed','output-read-failed']])if(observed[key])reasons.push(reason);
  const {stdout,stderr,...process}=observed;
  // Raw captured output can contain secrets. Summary access does not publish it.
  return freeze({schemaVersion:1,kind:'NATIVE_TASK_RESULT_SUMMARY',projectId:intent.projectId,rootIdentity:intent.rootIdentity,
   taskId:intent.binding.taskId,attemptId:intent.binding.attemptId,attemptNumber:intent.binding.attemptNumber,checkId:intent.binding.checkId,workerId:intent.binding.workerId,
   grantId:intent.grantId,runId:intent.runId,intentDigest:intent.recordDigest,artifactDigest:receipt.artifactDigest,
   state:reasons.length?'failure-observed':'result-unverified',failureReasons:reasons,cause:'unknown',process,
   nextAction:reasons.length?'Review the retained check failure before deciding whether to create a new attempt.':'Verify the full acceptance set and cleanup evidence before marking the task complete.',
   journalLinked:Boolean(link),observationLinkDigest:link?.recordDigest??null,
   cleanup:'unknown',authorityVerified:false,executionAuthorized:false});
 }});
}
