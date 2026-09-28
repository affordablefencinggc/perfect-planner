import {getRuntimeEventSession} from './runtimeEventSession.js';

const allowed=new Set([
  'AGENT_REQUEST_INVALID','AGENT_REGISTRY_UNAVAILABLE','AGENT_PACKAGE_UNAVAILABLE',
  'AGENT_BROKER_BUSY','AGENT_BROKER_CAPACITY','AGENT_PROJECT_STOPPING','AGENT_BROKER_CHANGED',
  'AGENT_INSPECTION_FAILED','AGENT_OBSERVATION_INVALID','AGENT_INSPECTION_INTERRUPTED',
  'AGENT_STOP_INTERRUPTED','AGENT_BROKER_POISONED','AGENT_REGISTRY_POISONED',
  'AGENT_CHANNEL_CLEANUP_UNCONFIRMED','AGENT_CHANNEL_BROKER_STOPPED','AGENT_WORKER_PANICKED',
  'AGENT_WORKER_OBSERVATION_INVALID',
]);

// Capture the request's scope, never the currently selected project after await.
// Appending is not a durable-write receipt: Operations owns saving/unsaved state.
export function recordAgentConnectionFailure(error,request,stop=false,events=getRuntimeEventSession()){
  let candidate;
  try{candidate=typeof error==='string'?error:error?.code??error?.message;}catch{}
  const code=allowed.has(candidate)?candidate:'AGENT_CONNECTION_CHECK_FAILED';
  try{
    return events.append({
      projectId:request.projectId,generation:request.generation,adapter:'native',source:'agent-connection',
      severity:'error',message:code,runId:null,taskId:null,
      payload:{operation:stop?'stop-project-agents':'inspect-agent-sessions',workspaceId:request.workspaceId,
        registryRevision:request.registryRevision,connectionVerified:false},
    });
  }catch{return null;}
}

export function recordAgentWorkerFailure(worker,poolId,request,events=getRuntimeEventSession()){
 if(worker?.state!=='failed'||worker.workVerified!==false||!Number.isSafeInteger(worker.workerId)||worker.workerId<1||typeof worker.code!=='string'||!/^[A-Z][A-Z0-9_]{0,95}$/.test(worker.code)||typeof poolId!=='string'||!/^[a-f0-9]{64}$/.test(poolId))return null;
 try{return events.append({projectId:request.projectId,generation:request.generation,adapter:'native',source:'agent-connection',severity:'error',message:'AGENT_WORKER_FAILED',runId:null,taskId:null,payload:{operation:'agent-worker',workspaceId:request.workspaceId,registryRevision:request.registryRevision,poolId,workerId:worker.workerId,workerCode:worker.code,connectionVerified:false}});}catch{return null;}
}
