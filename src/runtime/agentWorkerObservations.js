// Bounded, project-scoped native worker history. Missing data is unavailable,
// never evidence of zero failures. No paths or arbitrary messages pass through.
export function parseAgentWorkerObservations(value){
 if(value===undefined)return null;
 const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
 const uint=n=>Number.isSafeInteger(n)&&n>=0;
 if(!exact(value,['poolId','activeWorkers','outcomes','omittedOutcomes','durable','workVerified'])||!/^[a-f0-9]{64}$/.test(value.poolId)||!uint(value.activeWorkers)||value.activeWorkers>8||!uint(value.omittedOutcomes)||value.durable!==false||value.workVerified!==false||!Array.isArray(value.outcomes)||value.outcomes.length>32)throw Error('AGENT_WORKER_OBSERVATION_INVALID');
 const ids=new Set();
 const outcomes=value.outcomes.map(row=>{
  if(!exact(row,['workerId','state','code','workVerified'])||!uint(row.workerId)||row.workerId<1||ids.has(row.workerId)||!['stopped','failed'].includes(row.state)||row.workVerified!==false||(row.state==='stopped'?row.code!==null:typeof row.code!=='string'||!/^[A-Z][A-Z0-9_]{0,95}$/.test(row.code)))throw Error('AGENT_WORKER_OBSERVATION_INVALID');
  ids.add(row.workerId);return {...row};
 });
 return {...value,outcomes,failures:outcomes.filter(row=>row.state==='failed')};
}
