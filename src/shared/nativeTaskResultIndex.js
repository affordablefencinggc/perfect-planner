// Bounded historical journal page. References are not task outcomes or live
// execution permissions. Continuations must keep the exact observed head.
export const NATIVE_TASK_INDEX_PAGE_SIZE=20;
const fail=()=>{throw Error('NATIVE_TASK_INDEX_INVALID');};
const exact=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join('|')!==[...keys].sort().join('|'))fail();};
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const token=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const frozen=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(frozen);Object.freeze(v);}return v;};
export function validateNativeTaskIndexRequest(input){
 exact(input,['offset','expectedHeadDigest']);
 if(!integer(input.offset,0,2048)||!(digest(input.expectedHeadDigest)||input.expectedHeadDigest==='GENESIS'||(input.offset===0&&input.expectedHeadDigest===null)))fail();
 return input;
}
export function validateNativeTaskResultIndex(value,input,binding){
 validateNativeTaskIndexRequest(input);
 exact(value,['schemaVersion','kind','projectId','rootIdentity','journalHead','offset','totalGrants','nextOffset','entries','authorityVerified','executionAuthorized']);
 exact(value.journalHead,['revision','headDigest']);const head=value.journalHead;
 if(value.schemaVersion!==1||value.kind!=='NATIVE_TASK_RESULT_INDEX'||!token(value.projectId)||!digest(value.rootIdentity)
  ||(binding&&(value.projectId!==binding.projectId||value.rootIdentity!==binding.rootIdentity))
  ||!integer(head.revision,0,2048)||(head.revision===0?head.headDigest!=='GENESIS':!digest(head.headDigest))
  ||(input.expectedHeadDigest!==null&&head.headDigest!==input.expectedHeadDigest)||value.offset!==input.offset
  ||!integer(value.totalGrants,0,head.revision)||value.offset>value.totalGrants||!Array.isArray(value.entries)
  ||value.entries.length!==Math.min(NATIVE_TASK_INDEX_PAGE_SIZE,value.totalGrants-value.offset)
  ||value.nextOffset!==(value.offset+value.entries.length<value.totalGrants?value.offset+value.entries.length:null)
  ||value.authorityVerified!==false||value.executionAuthorized!==false)fail();
 let last=head.revision+1;const ids=new Set();
 for(const row of value.entries){
  exact(row,['grantId','taskId','checkId','attemptId','attemptNumber','workerId','lifecycleState','journalRevision','recordedAt','runId','intentDigest','artifactDigest']);
  if(!uuid(row.grantId)||ids.has(row.grantId)||typeof row.taskId!=='string'||!/^T\d{4,6}$/.test(row.taskId)||!['checkId','attemptId','workerId'].every(k=>token(row[k]))
   ||!integer(row.attemptNumber,1,Number.MAX_SAFE_INTEGER)||!integer(row.journalRevision,1,head.revision)||row.journalRevision>=last
   ||typeof row.recordedAt!=='string'||!Number.isFinite(Date.parse(row.recordedAt))||new Date(row.recordedAt).toISOString()!==row.recordedAt
   ||!['issued','consumed','intent-recorded','result-recorded','revoked'].includes(row.lifecycleState))fail();
  ids.add(row.grantId);last=row.journalRevision;
  const hasIntent=['intent-recorded','result-recorded'].includes(row.lifecycleState);
  if(hasIntent?(!uuid(row.runId)||!digest(row.intentDigest)):(row.runId!==null||row.intentDigest!==null))fail();
  if(row.lifecycleState==='result-recorded'?!digest(row.artifactDigest):row.artifactDigest!==null)fail();
 }
 return frozen(value);
}
