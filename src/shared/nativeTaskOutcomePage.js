import {validateNativeTaskResultIndex} from './nativeTaskResultIndex.js';
const fail=()=>{throw Error('NATIVE_TASK_RESULT_UNAVAILABLE');};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
// Shared envelope checks; each boundary must also validate/project every ready
// summary. Unknown outcomes carry no arbitrary error text or hidden payload.
export function validateNativeTaskOutcomePage(value,input,binding,project){
 if(!exact(value,['page','outcomes'])||typeof project!=='function')fail();
 const page=validateNativeTaskResultIndex(value.page,input,binding),rows=page.entries.filter(r=>r.runId!==null);
 if(!Array.isArray(value.outcomes)||value.outcomes.length!==rows.length)fail();
 const outcomes=value.outcomes.map((o,i)=>{
  const row=rows[i];if(!exact(o,['grantId','phase','value'])||o.grantId!==row.grantId)fail();
  if(o.phase==='unavailable'){if(o.value!==null)fail();return Object.freeze({grantId:o.grantId,phase:o.phase,value:null});}
  if(o.phase!=='ready')fail();const v=project(o.value,row.grantId);
  if(v.projectId!==page.projectId||v.rootIdentity!==page.rootIdentity||['grantId','runId','taskId','checkId','attemptId','attemptNumber','workerId','intentDigest'].some(k=>v[k]!==row[k])||(row.artifactDigest!==null&&v.artifactDigest!==row.artifactDigest))fail();
  return Object.freeze({grantId:o.grantId,phase:o.phase,value:v});
 });
 return Object.freeze({page,outcomes:Object.freeze(outcomes)});
}
