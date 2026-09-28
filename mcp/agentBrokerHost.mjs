// PRIVATE native-owner child protocol, not MCP. Never configure this executable
// as an IDE MCP server: owner operations may issue credentials. A native parent
// must keep these inherited pipes private and expose only client routes elsewhere.
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {createAgentSessionBroker} from './agentSessionBroker.mjs';
import {createAgentClientRouter} from './agentClientRouter.mjs';
import {createAgentPlanChannel,createAgentProposalChannel} from './agentPlanChannel.mjs';
import {resolveRegisteredWorkspace} from './perfectPlannerMcpCore.mjs';
import {createImportedProjectId} from '../src/project/projectIds.js';
import {createAgentExchangeStore} from './agentExchangeStore.mjs';

const exact=(value,keys)=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('|')!==[...keys].sort().join('|'))throw Error('BROKER_FRAME_INVALID');
};
const schemas={
  'owner.readExchanges':['binding','offset'],
  'owner.pair':['binding'], 'owner.inspect':['binding'], 'owner.revoke':['sessionId'],
  'owner.cancel':['pairingId'], 'client.connect':['pairingId','secret'],
  'client.heartbeat':['sessionId','secret','expectedSequence'],
  'owner.openClient':['binding'], 'owner.closeClient':['channelId'],
  'owner.openPlanClient':['binding','hostConfiguration'],
  'owner.openProposalClient':['binding','hostConfiguration'],
  'owner.pairProposal':['channelId'],
  'client.request':['channelId','request'],
};
const registryRoot=process.env.PERFECT_PLANNER_REGISTRY_ROOT;
if(process.argv.length!==3||process.argv[2]!=='--owner-stdio'||!registryRoot||process.stdin.isTTY||process.stdout.isTTY){
  process.stderr.write('BROKER_PRIVATE_PIPE_REQUIRED\n');process.exit(1);
}
const broker=createAgentSessionBroker({resolveBinding:async workspaceId=>{
  const registration=await resolveRegisteredWorkspace(registryRoot,workspaceId);
  return {workspaceId:registration.workspaceId,registryRevision:registration.registryRevision,rootIdentity:registration.rootIdentity,projectId:createImportedProjectId(registration.rootIdentity)};
}});
let sequence=0;
const channels=new Map();
// A proposal grant can only be issued for an already-open, verified writer
// channel. Ordinary pairings and read channels never acquire this capability.
const proposalBindings=new Map();
const channelIdValid=id=>typeof id==='string'&&/^[a-f0-9]{32}$/.test(id);
async function reply(value){
  const frame=JSON.stringify(value)+'\n';
  if(Buffer.byteLength(frame)>32768)throw Error('BROKER_RESPONSE_LIMIT');
  if(!process.stdout.write(frame))await once(process.stdout,'drain');
}
async function dispatch(frame){
  const request=JSON.parse(frame);
  exact(request,['version','id','method','params']);
  if(request.version!==1||!Number.isSafeInteger(request.id)||request.id!==sequence+1||!Object.hasOwn(schemas,request.method))throw Error('BROKER_FRAME_INVALID');
  exact(request.params,schemas[request.method]);sequence=request.id;
  const proposalFrame=request.method==='client.request'&&request.params.request?.method==='client.proposeTask';
  if(Buffer.byteLength(frame)>16384&&!proposalFrame)throw Error('BROKER_FRAME_LIMIT');
  const p=request.params;
  try{
    let result;
    switch(request.method){
      case 'owner.pair':result=await broker.issuePairing(p.binding);break;
      case 'owner.inspect':result=await broker.inspect(p.binding);break;
      case 'owner.readExchanges':await broker.inspect(p.binding);result=await createAgentExchangeStore(registryRoot).read(p.binding,p.offset);await broker.inspect(p.binding);break;
      case 'owner.revoke':result=broker.revoke(p.sessionId);break;
      case 'owner.cancel':result=broker.cancelPairing(p.pairingId);break;
      case 'owner.pairProposal':{
        if(!channelIdValid(p.channelId)||!channels.has(p.channelId)||!proposalBindings.has(p.channelId))throw Error('BROKER_PROPOSAL_CHANNEL_REQUIRED');
        result=await broker.issueProposalPairing(proposalBindings.get(p.channelId));break;
      }
      case 'client.connect':result=await broker.connect(p);break;
      case 'client.heartbeat':result=await broker.heartbeat(p);break;
      case 'owner.openClient':{
        if(channels.size>=32)throw Error('BROKER_CHANNEL_CAPACITY');
        await broker.inspect(p.binding); // Revalidate registration before allocating a scoped router.
        const channelId=randomBytes(16).toString('hex');
        channels.set(channelId,createAgentClientRouter({broker,binding:p.binding}));
        result={channelId,executionAuthorized:false};break;
      }
      case 'owner.openPlanClient':
      case 'owner.openProposalClient':{
        if(channels.size>=32)throw Error('BROKER_CHANNEL_CAPACITY');
        await broker.inspect(p.binding);
        const proposal=request.method==='owner.openProposalClient';
        const router=await (proposal?createAgentProposalChannel:createAgentPlanChannel)({broker,binding:p.binding,registryRoot,hostConfiguration:p.hostConfiguration});
        try{await broker.inspect(p.binding);}catch(error){await router.close();throw error;}
        const channelId=randomBytes(16).toString('hex');
        channels.set(channelId,router);
        if(proposal)proposalBindings.set(channelId,Object.freeze({...p.binding}));
        result={channelId,planReadEnabled:true,...(proposal?{proposalWriteEnabled:true}:{}),executionAuthorized:false};break;
      }
      case 'owner.closeClient':{
        if(!channelIdValid(p.channelId))throw Error('BROKER_CHANNEL_INVALID');
        const router=channels.get(p.channelId);
        if(router){result=await router.close();channels.delete(p.channelId);proposalBindings.delete(p.channelId);}
        else result={closed:true,revocationComplete:true};
        break;
      }
      case 'client.request':{
        if(!channelIdValid(p.channelId)||!channels.has(p.channelId))throw Error('BROKER_CHANNEL_INVALID');
        result=await channels.get(p.channelId).request(p.request);break;
      }
    }
    await reply({version:1,id:request.id,ok:true,result});
  }catch{
    // Do not leak registry paths, source contents, parser messages or credentials.
    await reply({version:1,id:request.id,ok:false,error:'BROKER_OPERATION_REFUSED'});
  }
}
try{
  let buffer=Buffer.alloc(0);
  for await(const chunk of process.stdin){
    buffer=Buffer.concat([buffer,chunk]);
    if(buffer.length>131072)throw Error('BROKER_INPUT_LIMIT');
    let end;
    while((end=buffer.indexOf(10))>=0){
      // Original task requests are capped at 64 KiB; allow only their bounded
      // credential/channel envelope above the ordinary 16 KiB frame budget.
      if(end>70000)throw Error('BROKER_FRAME_LIMIT');
      const frame=buffer.subarray(0,end);buffer=buffer.subarray(end+1);
      const timer=setTimeout(()=>{broker.dispose();process.stderr.write('BROKER_DEADLINE\n');process.exit(1);},10000);
      try{await dispatch(new TextDecoder('utf-8',{fatal:true}).decode(frame));}finally{clearTimeout(timer);}
    }
    if(buffer.length>70000)throw Error('BROKER_FRAME_LIMIT');
  }
  if(buffer.length)throw Error('BROKER_FRAME_INCOMPLETE');
}catch{
  process.stderr.write('BROKER_CHANNEL_CLOSED\n');process.exitCode=1;
}finally{
  // Close scoped channels while revocation is still available. Disposing the
  // broker first makes every live channel's cleanup fail before host shutdown.
  for(const channel of channels.values()){try{await channel.close();}catch{process.exitCode=1;}}
  broker.dispose();channels.clear();proposalBindings.clear();process.stdin.destroy();
}
