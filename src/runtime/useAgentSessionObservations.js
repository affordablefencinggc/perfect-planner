import {useCallback,useEffect,useRef,useState} from 'react';
import {parseAgentWorkerObservations} from './agentWorkerObservations.js';

export function agentRequest(project){const r=project?.registration;return {schemaVersion:1,projectId:project?.projectId,generation:project?.generation,workspaceId:r?.workspaceId,registryRevision:r?.registryRevision,rootIdentity:r?.rootIdentity};}
export function useAgentSessionObservations(project){
  const request=agentRequest(project),key=JSON.stringify(request),current=useRef({key,epoch:0});
  if(current.current.key!==key)current.current={key,epoch:current.current.epoch+1};
  const epoch=current.current.epoch;
  const [snapshot,setSnapshot]=useState(null),[now,setNow]=useState(Date.now());
  const state=snapshot?.key===key&&snapshot?.epoch===epoch?snapshot:null;
  useEffect(()=>{if(!state?.sessions?.length)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[state?.sessions]);
  const publish=useCallback(result=>{
    if(current.current.key!==key||current.current.epoch!==epoch)return;
    try{
      if(!result)throw Error('check failed');
      for(const field of Object.keys(request))if(result[field]!==request[field])throw Error('binding');
      if(result.executionAuthorized!==false||typeof result.stopped!=='boolean'||!Array.isArray(result.sessions)||result.sessions.length>32)throw Error('response');
      const ids=new Set();
      const sessions=result.sessions.map(s=>{
        if(typeof s.sessionId!=='string'||!/^[a-f0-9]{32}$/.test(s.sessionId)||ids.has(s.sessionId)||s.workVerified!==false||!['reachable','stale','closed'].includes(s.state)||!Number.isSafeInteger(s.observedAt)||!Number.isSafeInteger(s.expiresAt)||s.observedAt<0||s.expiresAt-s.observedAt!==30000)throw Error('session');
        ids.add(s.sessionId);return {sessionId:s.sessionId,state:s.state,observedAt:s.observedAt,expiresAt:s.expiresAt};
      });
      if(result.stopped&&sessions.length)throw Error('stopped');
      const workers=parseAgentWorkerObservations(result.workers);
      setNow(Date.now());setSnapshot({key,epoch,sessions,stopped:result.stopped,workers});
    }catch{setSnapshot({key,epoch,error:true});}
  },[key,epoch]);
  const count=state?.sessions?.filter(s=>s.state==='reachable'&&s.observedAt<=now&&now<s.expiresAt).length??0;
  let label='Agent connection · unverified';
  if(state?.error)label='Agent connection · check failed';
  else if(state?.stopped)label='Agents disconnected';
  else if(state?.workers?.failures.length)label=`${count?`${count} reachable · `:'Agent connection · '}${state.workers.failures.length} recorded failure${state.workers.failures.length===1?'':'s'}`;
  else if(count)label=`${count} agent${count===1?'':'s'} reachable`;
  else if(state?.sessions?.length)label='No live agent observations';
  else if(state?.sessions)label='No paired agents';
  return {label,publish,reachableCount:count};
}
