import {createInstalledNativeReviewHost} from '../src/node/installedNativeReviewHost.mjs';
import {validateAgentSessionBinding} from '../src/runtime/agentSessionProtocol.js';
import {createAgentClientRouter} from './agentClientRouter.mjs';
import {createAgentExchangeStore} from './agentExchangeStore.mjs';

const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
// Call only from the native owner's private pipe after explicit plan-read
// consent. Never register this factory or its configuration as an MCP tool.
// createHost is a trusted composition dependency, not a caller argument.
export async function createAgentPlanChannel({broker,binding,registryRoot,hostConfiguration},createHost=createInstalledNativeReviewHost){
  return createChannel({broker,binding,registryRoot,hostConfiguration},createHost,false);
}
// Separate owner-only entry point: never upgrade an existing read channel.
// The owner must obtain native proposal consent and issue a proposal pairing.
export async function createAgentProposalChannel(config,createHost=createInstalledNativeReviewHost){
  return createChannel(config,createHost,true);
}
async function createChannel({broker,binding,registryRoot,hostConfiguration},createHost,proposalAllowed){
  const scope=Object.freeze({...validateAgentSessionBinding(binding)});
  if(!exact(hostConfiguration,['packageConfig','metadataConfig','stateDirectory','actor','source']))throw Error('AGENT_PLAN_CONFIG_INVALID');
  const config=structuredClone(hostConfiguration),m=config.metadataConfig;
  if(!exact(m,['executable','executableDigest','registryRoot','workspaceId','registryRevision','rootIdentity'])||m.registryRoot!==registryRoot||m.workspaceId!==scope.workspaceId||m.registryRevision!==scope.registryRevision||m.rootIdentity!==scope.rootIdentity)throw Error('AGENT_PLAN_CONFIG_FOREIGN');
  const host=await createHost(config);
  let router;
  try{
    if(host?.binding?.projectId!==scope.projectId||host.binding.rootIdentity!==scope.rootIdentity||host.executionAuthorized!==false||typeof host.readPlan!=='function'||typeof host.shutdown!=='function')throw Error('AGENT_PLAN_HOST_FOREIGN');
    const read=host.readPlan.bind(host);
    if(proposalAllowed&&typeof host.proposeTaskChange!=='function')throw Error('AGENT_PLAN_WRITER_UNAVAILABLE');
    const write=proposalAllowed?host.proposeTaskChange.bind(host):null;
    const hostBinding=Object.freeze({...host.binding});
    const methods={'client.readBrief':'read-proposal-brief','client.readTask':'read-proposal-task','client.readRequestResult':'read-proposal-request'};
    router=createAgentClientRouter({broker,binding:scope,...(write?{exchangeReports:createAgentExchangeStore(registryRoot),proposalWrites:{propose:async(input,admission)=>{
      if(admission.projectId!==scope.projectId||admission.rootIdentity!==scope.rootIdentity||admission.registryRevision!==scope.registryRevision||admission.workspaceId!==scope.workspaceId||['projectId','rootIdentity','censusDigest'].some(key=>input.binding[key]!==hostBinding[key]))throw Error('AGENT_PLAN_WRITE_FOREIGN');
      return write(input);
    }}}:{}),ledgerReads:{read:async(method,input)=>{
      if(!Object.hasOwn(methods,method))throw Error('AGENT_PLAN_READ_REFUSED');
      return read(methods[method],input);
    }}});
  }catch(error){await host?.shutdown?.();throw error;}
  let stopped=false;
  return Object.freeze({
    request:input=>{if(stopped)throw Error('AGENT_PLAN_CHANNEL_CLOSED');return router.request(input);},
    close:async()=>{
      stopped=true;
      // Revoke and drain the scoped connection before releasing its host.
      // Cleanup failure remains a failure, not a successful closed receipt.
      const result=await router.close();
      const cleanup=await host.shutdown();
      if(cleanup?.cleanupComplete!==true)throw Error('AGENT_PLAN_CLEANUP_UNCONFIRMED');
      return result;
    },
  });
}
