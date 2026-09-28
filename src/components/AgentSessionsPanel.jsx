import {useEffect,useRef,useState} from 'react';
import {isTauriRuntime} from '../native/runtimeSnapshot.js';
import {recordAgentConnectionFailure,recordAgentWorkerFailure} from '../runtime/agentConnectionDiagnostics.js';
import {parseAgentWorkerObservations} from '../runtime/agentWorkerObservations.js';

export function AgentSessionsPanel({project,invoke:providedInvoke,recordFailure=recordAgentConnectionFailure,recordWorkerFailure=recordAgentWorkerFailure,onObservation,onOpenProjectSetup}){
  const r=project?.registration;
  const request={schemaVersion:1,projectId:project?.projectId,generation:project?.generation,workspaceId:r?.workspaceId,registryRevision:r?.registryRevision,rootIdentity:r?.rootIdentity};
  const censusDigest=project?.census?.digest;
  const key=JSON.stringify({...request,censusDigest}),current=useRef({key,epoch:0}),inFlight=useRef(false);
  if(current.current.key!==key)current.current={key,epoch:current.current.epoch+1};
  const [snapshot,setSnapshot]=useState(null);
  const loggedWorkers=useRef(new Set());
  const [accessChoice,setAccessChoice]=useState(null);
  const access=accessChoice?.key===key&&accessChoice?.epoch===current.current.epoch?accessChoice.value:'connection';
  const canReadPlan=typeof censusDigest==='string'&&/^[a-f0-9]{64}$/.test(censusDigest);
  const [pairing,setPairing]=useState(null),[clock,setClock]=useState(Date.now());
  const setup=pairing?.key===key&&pairing?.epoch===current.current.epoch?pairing:null;
  const state=snapshot?.key===key&&snapshot?.epoch===current.current.epoch?snapshot:null;
  const liveCount=state?.sessions?.filter(s=>s.state==='reachable'&&s.observedAt<=clock&&clock<s.expiresAt).length??0;
  useEffect(()=>{if(!setup?.expiresAt&&!state?.sessions?.length)return;const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[setup?.expiresAt,state?.sessions]);
  useEffect(()=>{
    if(!setup?.expiresAt)return;
    const timer=setInterval(()=>{if(Date.now()<setup.expiresAt)void run();},2000);
    return()=>clearInterval(timer);
  },[setup?.expiresAt,key]);
  const nativeRuntime=isTauriRuntime(globalThis);
  const available=nativeRuntime&&r?.adapter==='native'&&!['stale','unavailable'].includes(project?.state);
  const setupReason=!project
    ? 'Choose an app folder before connecting an agent.'
    : !nativeRuntime
      ? 'Open this project in the desktop app to connect an IDE agent.'
      : r?.adapter!=='native'
        ? 'Register this app folder in the desktop app before connecting an agent.'
        : 'This folder connection needs attention. Open app setup to restore it.';
  async function preparePairing(){
    if(!available||inFlight.current||(access!=='connection'&&!canReadPlan))return;
    const epoch=current.current.epoch;inFlight.current=true;setPairing({key,epoch,busy:true});
    try{
      const invoke=providedInvoke??(await import('@tauri-apps/api/core')).invoke;
      const command=access==='proposals'?'prepare_agent_proposal_pairing':access==='plan'?'prepare_agent_plan_pairing':'prepare_agent_pairing';
      const result=await invoke(command,{request:access!=='connection'?{identity:request,censusDigest}:request});
      if(current.current.key!==key||current.current.epoch!==epoch)return;
      for(const field of Object.keys(request))if(result?.[field]!==request[field])throw Error('binding');
      const server=result?.mcpConfig?.mcpServers?.['perfect-planner-agent'];
      if(access!=='connection'&&result?.planReadPermission!=='approved')throw Error('plan read permission');
      if(access==='proposals'?result?.proposalWritePermission!=='approved':result?.proposalWritePermission!==undefined)throw Error('proposal permission');
      if(result.executionAuthorized!==false||result.pairingState!=='waiting'||!Number.isSafeInteger(result.expiresAt)||result.expiresAt>Date.now()+31000||typeof server?.command!=='string'||!Array.isArray(server.args)||server.args.length!==2||server.args[0]!=='--connection-config'||typeof server.args[1]!=='string')throw Error('response');
      setClock(Date.now());setPairing({key,epoch,busy:false,access,expiresAt:result.expiresAt,config:JSON.stringify(result.mcpConfig,null,2)});
    }catch(error){
      const cancelled=String(error)==='AGENT_PAIRING_CANCELLED';
      if(!cancelled)try{recordFailure(error,request,false);}catch{}
      if(current.current.key===key&&current.current.epoch===epoch)setPairing({key,epoch,busy:false,error:!cancelled,cancelled});
    }finally{inFlight.current=false;}
  }
  async function run(stop=false){
    if(!available||inFlight.current)return;
    const epoch=current.current.epoch;inFlight.current=true;
    setSnapshot({key,epoch,busy:true});
    try{
      const invoke=providedInvoke??(await import('@tauri-apps/api/core')).invoke;
      const result=await invoke(stop?'stop_project_agent_broker':'inspect_agent_sessions',{request});
      if(current.current.key!==key||current.current.epoch!==epoch)return;
      for(const field of Object.keys(request))if(result?.[field]!==request[field])throw Error('binding');
      if(result.executionAuthorized!==false||result.externalEndpointAvailable!==false||result.stopped!==stop||!Array.isArray(result.sessions)||result.sessions.length>32)throw Error('response');
      const observed=Date.now();
      const ids=new Set();
      if(stop&&result.sessions.length)throw Error('stopped sessions');
      const workers=parseAgentWorkerObservations(result.workers);
      const sessions=result.sessions.map(s=>{
        if(typeof s.sessionId!=='string'||!/^[a-f0-9]{32}$/.test(s.sessionId)||!['reachable','stale','closed'].includes(s.state)||s.workVerified!==false||!Number.isSafeInteger(s.observedAt)||!Number.isSafeInteger(s.expiresAt)||s.observedAt<0||s.expiresAt<s.observedAt||s.expiresAt-s.observedAt>30000)throw Error('session');
        if(ids.has(s.sessionId)||s.expiresAt-s.observedAt!==30000)throw Error('session');
        ids.add(s.sessionId);
        return {sessionId:s.sessionId,state:s.state,observedAt:s.observedAt,expiresAt:s.expiresAt};
      });
      let captureFailed=false;
      for(const worker of workers?.failures??[]){
        const identity=`${key}:${workers.poolId}:${worker.workerId}`;
        if(loggedWorkers.current.has(identity))continue;
        let captured=null;try{captured=recordWorkerFailure(worker,workers.poolId,request);}catch{}
        if(captured){loggedWorkers.current.add(identity);if(loggedWorkers.current.size>128)loggedWorkers.current.delete(loggedWorkers.current.values().next().value);}else captureFailed=true;
      }
      setClock(observed);onObservation?.(result);
      if(sessions.some(s=>s.state==='reachable'&&s.observedAt<=observed&&observed<s.expiresAt))setPairing(previous=>previous?.key===key&&previous?.epoch===epoch?{...previous,paired:true}:previous);
      setSnapshot({key,epoch,busy:false,sessions,stopped:stop,workers,captureFailed});
      if(stop)setPairing(null);
    }catch(error){
      let captured=null;
      try{captured=recordFailure(error,request,stop);}catch{}
      if(current.current.key===key&&current.current.epoch===epoch){onObservation?.(null);setSnapshot({key,epoch,busy:false,error:true,captureFailed:!captured});}
    }
    finally{inFlight.current=false;if(current.current.epoch!==epoch)setSnapshot({...current.current,busy:false});}
  }
  const actionStyle={fontSize:14,minHeight:44,lineHeight:1.4};
  return <section className="runtime-capability-card" aria-label="Agent session observations">
    <strong>Agent session observations</strong>
    <p role="status">{!available?setupReason:state?.busy?'Checking the project broker…':state?.error?'Session inspection failed. No connection was verified. Your installed build may not include the broker package yet.':state?.stopped?'This project broker was stopped. Its sessions are no longer usable.':state?.sessions?.length?`${state.sessions.length} session observations returned.`:state?.sessions?'No paired sessions returned. This does not verify an external IDE connection.':'Not checked.'}</p>
    {!available&&onOpenProjectSetup&&(!project||nativeRuntime)&&<button type="button" className="runtime-action-button" style={actionStyle} onClick={onOpenProjectSetup}>{project?'Open app setup':'Choose an app folder'}</button>}
    <fieldset disabled={!available||state?.busy||setup?.busy} style={{margin:'16px 0',padding:'16px',display:'grid',gap:'12px',border:'1px solid var(--border-color, #aeb8b9)',borderRadius:'10px'}}>
      <legend>What may this agent access?</legend>
      <label><input type="radio" name="agent-plan-access" value="connection" checked={access==='connection'} onChange={()=>{setAccessChoice({key,epoch:current.current.epoch,value:'connection'});setPairing(null);}}/> Connection status only</label>
      <label><input type="radio" name="agent-plan-access" value="plan" disabled={!canReadPlan} checked={access==='plan'} onChange={()=>{setAccessChoice({key,epoch:current.current.epoch,value:'plan'});setPairing(null);}}/> Read my submitted plan</label>
      <label><input type="radio" name="agent-plan-access" value="proposals" disabled={!canReadPlan} checked={access==='proposals'} onChange={()=>{setAccessChoice({key,epoch:current.current.epoch,value:'proposals'});setPairing(null);}}/> Read, propose tasks and report exchanges</label>
      <small>{!available?'Agent access stays unavailable until project setup is ready.':canReadPlan?'Plan access includes submitted task summaries, details and receipts. Unsubmitted editor drafts stay private.':'Scan this project first to enable plan access. Connection status is still available.'}</small>
      {access==='proposals'&&<p>Allow this agent to create, edit or archive task proposals and save exchange summaries in Developer Notes. Original task requests are retained for recovery. Reports are agent claims, not verified proof. This does not edit your app’s source files or approve work.</p>}
    </fieldset>
    <button type="button" className="runtime-action-button" style={actionStyle} disabled={!available||state?.busy||setup?.busy} onClick={preparePairing}>Connect an IDE agent</button>{' '}
    <button type="button" className="runtime-action-button" style={actionStyle} disabled={!available||state?.busy||setup?.busy} onClick={()=>run()}>Check agent sessions</button>{' '}
    {state?.captureFailed&&<p role="alert">Operations could not capture this connection error. The connection is not verified; keep this message for troubleshooting.</p>}
    {state?.workers?.failures.length>0&&<div role="alert"><strong>{state.workers.failures.length} worker failure{state.workers.failures.length===1?'':'s'} recorded</strong><p>A connection worker stopped with an error. Check its code below; a reachable session does not erase this failure.</p><ul>{state.workers.failures.map(worker=><li key={worker.workerId}>Worker {worker.workerId} · <code>{worker.code}</code></li>)}</ul></div>}
    {state?.workers&&<p>{state.workers.activeWorkers} active connection worker{state.workers.activeWorkers===1?'':'s'} · {state.workers.omittedOutcomes} older outcomes omitted. Worker history is held in memory, not a durable work receipt.</p>}
    <button type="button" className="runtime-action-button" style={actionStyle} disabled={!available||state?.busy||setup?.busy} onClick={()=>run(true)}>Stop this project broker</button>
    <p>Pairing requires desktop approval for the access you choose. None of these options grants approvals, code execution or browser control. Browser tools use a separate permission path. Changing this selection does not change existing sessions; stop this project broker to revoke them.</p>
    {setup?.busy&&<p role="status">Waiting for desktop approval and pairing setup…</p>}
    {setup?.cancelled&&<p role="status">Pairing cancelled. No configuration was created.</p>}
    {setup?.error&&<p role="alert">Pairing setup failed. Check Operations; the installed app may not include the helper package.</p>}
    {setup?.config&&<div>
      <p>{setup.access==='proposals'?'Desktop permission: submitted-plan reading and task proposals approved. Work is not approved, and your IDE connection is not yet verified.':setup.access==='plan'?'Desktop permission: submitted-plan reading approved. This is not proof that your IDE has connected.':'Desktop permission: connection status only.'}</p>
      <p role="status">{liveCount?`${liveCount} reachable session observation${liveCount===1?'':'s'}. This does not verify work or grant browser control.`:setup.paired?'The paired session is no longer currently observed. Check sessions or create a new pairing.':clock>=setup.expiresAt?'Pairing window expired. If your IDE did not connect, create a new configuration.':`Waiting for your IDE to connect (${Math.max(0,Math.ceil((setup.expiresAt-clock)/1000))} seconds). Configuration is not connection proof.`}</p>
      <label>IDE MCP configuration<textarea aria-label="IDE MCP configuration" readOnly value={setup.config} rows={10} style={{width:'100%'}} onFocus={event=>event.target.select()}/></label>
      <p>Copy this entry into your IDE’s MCP settings without replacing other entries, reload its tools, then check agent sessions. This configuration is for the current app session.</p>
    </div>}
    {state?.sessions?.length>0&&<ul>{state.sessions.map(s=><li key={s.sessionId}>{s.sessionId.slice(0,8)} · {s.state==='reachable'&&(clock<s.observedAt||clock>=s.expiresAt)?'stale':s.state} observation · work not verified</li>)}</ul>}
  </section>;
}
