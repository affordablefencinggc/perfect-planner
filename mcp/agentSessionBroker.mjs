import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {validateAgentSessionBinding,acceptAgentSessionObservation,agentSessionPresentation} from '../src/runtime/agentSessionProtocol.js';
import {projectAgentWriteReceipt} from './agentWriteReceipt.mjs';

const fingerprint=value=>createHash('sha256').update(value).digest();
const matches=(value,digest)=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(fingerprint(value),digest);
const same=(a,b)=>['projectId','workspaceId','rootIdentity','registryRevision'].every(k=>a[k]===b[k]);

// Host-side core, NOT an MCP tool or public endpoint. issuePairing/revoke belong
// exclusively to a future authenticated native owner channel. Returned secrets
// must travel through owner-only IPC, never LLM tool results, URLs or logs.
// Restart loses all capabilities, requiring new pairing; no persisted grant exists.
export function createAgentSessionBroker({resolveBinding,now=Date.now,maxSessions=32}={}) {
  if(typeof resolveBinding!=='function'||!Number.isSafeInteger(maxSessions)||maxSessions<1||maxSessions>128)throw Error('AGENT_BROKER_CONFIG');
  const pairs=new Map(),sessions=new Map(),writes=new Set();
  let disposed=false;
  function clock(){const value=now();if(!Number.isSafeInteger(value)||value<0||value>Number.MAX_SAFE_INTEGER-60000)throw Error('AGENT_BROKER_CLOCK');return value;}
  function active(){if(disposed)throw Error('AGENT_BROKER_CLOSED');}
  function invalidate(session){session.invalidated=true;session.digest=null;}
  function invalidateBinding(binding){
    for(const [id,pair]of pairs)if(same(pair.binding,binding))pairs.delete(id);
    for(const session of sessions.values())if(same(session.observation.binding,binding))invalidate(session);
  }
  async function current(binding){
    validateAgentSessionBinding(binding);
    try{
      const verified=await resolveBinding(binding.workspaceId);
      validateAgentSessionBinding(verified);
      if(!same(binding,verified))throw Error('AGENT_BROKER_BINDING_CHANGED');
    }catch(error){invalidateBinding(binding);throw error;}
    active();
  }
  function expirePairs(t){for(const [id,pair]of pairs)if(t<pair.issuedAt||t>=pair.expiresAt)pairs.delete(id);}
  function observation(previous,binding,sessionId,kind,t){return acceptAgentSessionObservation(previous,{schemaVersion:1,binding,sessionId,sequence:previous?previous.sequence+1:1,kind,observedAt:t,expiresAt:kind==='close'?t:t+30000},binding,t);}
  async function issuePair(binding,proposalWriteAllowed){
    active();binding=Object.freeze({...validateAgentSessionBinding(binding)});await current(binding);
    const t=clock();expirePairs(t);
    if(pairs.size+sessions.size>=maxSessions)throw Error('AGENT_BROKER_CAPACITY');
    const pairingId=randomBytes(16).toString('hex'),secret=randomBytes(32).toString('hex');
    pairs.set(pairingId,{binding,issuedAt:t,expiresAt:t+60000,digest:fingerprint(secret),proposalWriteAllowed});
    return Object.freeze({pairingId,secret,expiresAt:t+60000});
  }
  // Host-provided read callback only. Recheck after asynchronous reads so a
  // revoked, expired or rebound session cannot receive late task content.
  async function readWithSession(credentials,expectedBinding,reader){
    if(typeof reader!=='function'||!expectedBinding)throw Error('AGENT_BROKER_READ_CONFIG');
    const receipt=await api.heartbeat(credentials,expectedBinding);
    const session=sessions.get(credentials.sessionId);
    let data,readError;
    try{data=await reader(Object.freeze({...receipt.binding}));}catch{data=null;readError='AGENT_LEDGER_READ_REFUSED';}
    await current(receipt.binding);
    const t=clock();
    if(!session||sessions.get(credentials.sessionId)!==session||session.invalidated||session.observation!==receipt||agentSessionPresentation(receipt,t).state!=='reachable'){
      if(session&&sessions.get(credentials.sessionId)===session)invalidate(session);
      throw Error('AGENT_BROKER_SESSION_REFUSED');
    }
    return Object.freeze({observation:receipt,data,...(readError?{readError}:{}),executionAuthorized:false});
  }
  const api=Object.freeze({
    readWithSession,
    async reportExchange(credentials,expectedBinding,input,writer){
      if(typeof writer!=='function'||sessions.get(credentials.sessionId)?.proposalWriteAllowed!==true)throw Error('AGENT_EXCHANGE_WRITE_NOT_ALLOWED');
      if(writes.has(credentials.sessionId))throw Error('AGENT_BROKER_WRITE_BUSY');
      writes.add(credentials.sessionId);
      try{
        const observation=await api.heartbeat(credentials,expectedBinding),session=sessions.get(credentials.sessionId);
        if(!session||session.invalidated||session.observation!==observation||agentSessionPresentation(observation,clock()).state!=='reachable')throw Error('AGENT_BROKER_SESSION_REFUSED');
        let receipt=null;
        try{receipt=await writer(input,Object.freeze({binding:observation.binding,sessionId:credentials.sessionId,sequence:observation.sequence}));}catch{}
        let sessionCurrent=false;
        try{await current(expectedBinding);sessionCurrent=!disposed&&sessions.get(credentials.sessionId)===session&&!session.invalidated&&session.observation===observation&&agentSessionPresentation(observation,clock()).state==='reachable';}catch{}
        return {observation,exchangeId:input.exchangeId,receipt,writeState:receipt?'recorded-exchange':'outcome-unknown',sessionCurrent,executionAuthorized:false};
      }finally{writes.delete(credentials.sessionId);}
    },
    // Owner-composed write callback only. The caller must separately establish
    // proposal-write consent. The private router exposes it only when an owner
    // installed a proposal writer; session permission is still checked here.
    // Admission precedes invoking the writer; revocation blocks later writes,
    // but cannot assert that already-admitted asynchronous I/O was cancelled.
    async runAdmittedProposal(credentials,expectedBinding,requestId,writer){
      if(typeof writer!=='function'||typeof requestId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId))throw Error('AGENT_BROKER_WRITE_CONFIG');
      credentials=structuredClone(credentials);expectedBinding=Object.freeze({...validateAgentSessionBinding(expectedBinding)});
      active();
      if(sessions.get(credentials.sessionId)?.proposalWriteAllowed!==true)throw Error('AGENT_PROPOSAL_WRITE_NOT_ALLOWED');
      if(writes.has(credentials.sessionId))throw Error('AGENT_BROKER_WRITE_BUSY');
      writes.add(credentials.sessionId);
      try{
        const observation=await api.heartbeat(credentials,expectedBinding),session=sessions.get(credentials.sessionId);
        if(disposed||!session||session.proposalWriteAllowed!==true||session.invalidated||session.observation!==observation||agentSessionPresentation(observation,clock()).state!=='reachable')throw Error('AGENT_BROKER_SESSION_REFUSED');
        let receipt=null;
        try{receipt=projectAgentWriteReceipt(await writer(Object.freeze({binding:observation.binding,requestId})));}catch{/* A failed reply is not evidence that no append occurred. */}
        let sessionCurrent=false;
        try{await current(expectedBinding);sessionCurrent=!disposed&&sessions.get(credentials.sessionId)===session&&!session.invalidated&&session.observation===observation&&agentSessionPresentation(observation,clock()).state==='reachable';}catch{}
        return Object.freeze({observation,requestId,writeState:receipt?'recorded-proposal':'outcome-unknown',receipt,
          requestMayHaveCommitted:true,reconciliationRequired:receipt===null,sessionCurrent,executionAuthorized:false});
      }finally{writes.delete(credentials.sessionId);}
    },
    issuePairing:binding=>issuePair(binding,false),
    // Owner-only: call after native proposal-write consent. Ordinary pairing,
    // including plan-read pairing, never upgrades an existing session.
    issueProposalPairing:binding=>issuePair(binding,true),
    async connect({pairingId,secret},expectedBinding){
      active();const t=clock();expirePairs(t);const pair=pairs.get(pairingId);
      if(expectedBinding){validateAgentSessionBinding(expectedBinding);if(!pair||!same(pair.binding,expectedBinding))throw Error('AGENT_BROKER_FOREIGN_PROJECT');}
      if(!pair||t<pair.issuedAt||t>=pair.expiresAt||!matches(secret,pair.digest))throw Error('AGENT_BROKER_PAIRING_REFUSED');
      await current(pair.binding);
      const acceptedAt=clock();
      if(pairs.get(pairingId)!==pair||acceptedAt<pair.issuedAt||acceptedAt>=pair.expiresAt)throw Error('AGENT_BROKER_PAIRING_REFUSED');
      pairs.delete(pairingId); // Atomic consumption after async binding validation.
      const sessionId=randomBytes(16).toString('hex'),sessionSecret=randomBytes(32).toString('hex');
      const value=observation(null,pair.binding,sessionId,'open',acceptedAt);
      sessions.set(sessionId,{digest:fingerprint(sessionSecret),observation:value,proposalWriteAllowed:pair.proposalWriteAllowed===true});
      return Object.freeze({sessionId,secret:sessionSecret,observation:value});
    },
    async heartbeat({sessionId,secret,expectedSequence},expectedBinding){
      active();const session=sessions.get(sessionId),t=clock();
      if(expectedBinding){validateAgentSessionBinding(expectedBinding);if(!session||!same(session.observation.binding,expectedBinding))throw Error('AGENT_BROKER_FOREIGN_PROJECT');}
      if(session&&agentSessionPresentation(session.observation,t).state!=='reachable')invalidate(session);
      if(!session||session.invalidated||!matches(secret,session.digest)||session.observation.sequence!==expectedSequence)throw Error('AGENT_BROKER_SESSION_REFUSED');
      const previous=session.observation;
      await current(previous.binding);
      const acceptedAt=clock();
      if(agentSessionPresentation(previous,acceptedAt).state!=='reachable')invalidate(session);
      if(sessions.get(sessionId)!==session||session.invalidated||session.observation!==previous)throw Error('AGENT_BROKER_SESSION_REFUSED');
      session.observation=observation(previous,previous.binding,sessionId,'heartbeat',acceptedAt);
      return session.observation;
    },
    revoke(sessionId){
      active();const session=sessions.get(sessionId);if(!session)return false;
      sessions.delete(sessionId);return true;
    },
    cancelPairing(pairingId){active();return pairs.delete(pairingId);},
    async inspect(binding){
      active();binding={...validateAgentSessionBinding(binding)};await current(binding);const t=clock();
      return Object.freeze([...sessions.values()].filter(s=>same(s.observation.binding,binding)).map(s=>{
        const presentation=agentSessionPresentation(s.observation,t);
        if(presentation.state!=='reachable')invalidate(s);
        return Object.freeze({observation:s.observation,...presentation,...(s.invalidated?{state:'stale',pairingRequired:true}:{pairingRequired:false})});
      }));
    },
    dispose(){disposed=true;pairs.clear();sessions.clear();},
  });
  return api;
}
