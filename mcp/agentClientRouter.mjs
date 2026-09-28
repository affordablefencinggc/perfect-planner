// Private authenticated-transport adapter, NOT an MCP tool or authentication proof.
// Its caller must authenticate the channel before forwarding credentials here.
// Never return connect credentials to a renderer, LLM tool result, URL or log.
import {validateAgentSessionBinding} from '../src/runtime/agentSessionProtocol.js';
import {validateAgentTaskOriginal} from '../src/node/agentTaskIntentStore.mjs';
import {validateExchangeReport} from '../src/runtime/agentExchangeReport.js';
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('|')===[...keys].sort().join('|');
const hex=(value,length)=>typeof value==='string'&&value.length===length&&/^[a-f0-9]+$/.test(value);
export function createAgentClientRouter({broker,binding,ledgerReads,proposalWrites,exchangeReports}){
  if(typeof broker?.connect!=='function'||typeof broker?.heartbeat!=='function'||typeof broker?.revoke!=='function')throw Error('AGENT_CLIENT_CONFIG');
  const expected=Object.freeze({...validateAgentSessionBinding(binding)});
  if(proposalWrites!==undefined&&(typeof proposalWrites?.propose!=='function'||typeof broker.runAdmittedProposal!=='function'))throw Error('AGENT_CLIENT_CONFIG');
  const propose=proposalWrites?.propose.bind(proposalWrites);
  if(exchangeReports&&(typeof exchangeReports.append!=='function'||typeof broker.reportExchange!=='function'||!propose))throw Error('AGENT_CLIENT_CONFIG');
  let lastId=0,busy=false,closed=false,drain=null;
  const owned=new Set();
  function revokeOwned(){
    for(const sessionId of owned){
      try{if(typeof broker.revoke(sessionId)!=='boolean')throw Error('invalid receipt');owned.delete(sessionId);}
      catch{throw Error('AGENT_CLIENT_REVOCATION_UNCONFIRMED');}
    }
  }
  return Object.freeze({
    async close(){
      closed=true;
      // Revoke delivered sessions now; retry after any in-flight mint settles.
      try{revokeOwned();}catch{/* Retry after in-flight work; never report success before that retry. */}
      if(drain)await drain;
      revokeOwned();
      return {closed:true,revocationComplete:owned.size===0};
    },
    async request(input){
      // Serialize each connection; a rejected concurrent attempt cannot consume an ID.
      if(closed||busy)throw Error('AGENT_CLIENT_UNAVAILABLE');
      if(!exact(input,['version','id','method','params'])||input.version!==1||!Number.isSafeInteger(input.id)||input.id!==lastId+1)throw Error('AGENT_CLIENT_FRAME_REFUSED');
      const {id,method}=input;let params;
      if(method==='client.connect'&&exact(input.params,['pairingId','secret'])&&hex(input.params.pairingId,32)&&hex(input.params.secret,64)){
        params={pairingId:input.params.pairingId,secret:input.params.secret};
      }else if(method==='client.heartbeat'&&exact(input.params,['sessionId','secret','expectedSequence'])&&hex(input.params.sessionId,32)&&hex(input.params.secret,64)&&Number.isSafeInteger(input.params.expectedSequence)&&input.params.expectedSequence>0){
        params={sessionId:input.params.sessionId,secret:input.params.secret,expectedSequence:input.params.expectedSequence};
      }else if(['client.readBrief','client.readTask','client.readRequestResult'].includes(method)&&typeof ledgerReads?.read==='function'&&typeof broker.readWithSession==='function'&&exact(input.params,['sessionId','secret','expectedSequence','input'])&&owned.has(input.params.sessionId)&&hex(input.params.secret,64)&&Number.isSafeInteger(input.params.expectedSequence)&&input.params.expectedSequence>0){
        params=structuredClone(input.params);
      }else if(method==='client.reportExchange'&&exchangeReports&&exact(input.params,['sessionId','secret','expectedSequence','input'])&&owned.has(input.params.sessionId)&&hex(input.params.secret,64)&&Number.isSafeInteger(input.params.expectedSequence)&&input.params.expectedSequence>0){
        params=structuredClone(input.params);validateExchangeReport(params.input,expected);
      }else if(method==='client.proposeTask'&&propose&&exact(input.params,['sessionId','secret','expectedSequence','input'])&&owned.has(input.params.sessionId)&&hex(input.params.secret,64)&&Number.isSafeInteger(input.params.expectedSequence)&&input.params.expectedSequence>0){
        params=structuredClone(input.params);validateAgentTaskOriginal(params.input);
        if(params.input.binding.projectId!==expected.projectId||params.input.binding.rootIdentity!==expected.rootIdentity)throw Error('AGENT_CLIENT_FOREIGN_PROPOSAL');
      }else throw Error('AGENT_CLIENT_METHOD_REFUSED');
      busy=true;lastId=id;let settled;
      drain=new Promise(resolve=>{settled=resolve;});
      try{
        const result=await (method==='client.connect'?broker.connect(params,expected):method==='client.heartbeat'?broker.heartbeat(params,expected):method==='client.reportExchange'?broker.reportExchange({sessionId:params.sessionId,secret:params.secret,expectedSequence:params.expectedSequence},expected,params.input,(report,admission)=>exchangeReports.append(report,admission)):method==='client.proposeTask'?broker.runAdmittedProposal({sessionId:params.sessionId,secret:params.secret,expectedSequence:params.expectedSequence},expected,params.input.request.requestId,async admission=>propose(params.input,admission.binding)):broker.readWithSession({sessionId:params.sessionId,secret:params.secret,expectedSequence:params.expectedSequence},expected,async b=>{
          const data=await ledgerReads.read(method,params.input,b);
          // Fail inside the guarded read so its updated session receipt survives.
          // Reserve space for observation metadata and the outer transport frame.
          if(new TextEncoder().encode(JSON.stringify(data)).length>20000)throw Error('AGENT_CLIENT_RESULT_LIMIT');
          return data;
        }));
        if(method.startsWith('client.read')&&new TextEncoder().encode(JSON.stringify(result)).length>24000)throw Error('AGENT_CLIENT_RESULT_LIMIT');
        if(method==='client.connect'){
          if(!hex(result?.sessionId,32))throw Error('AGENT_CLIENT_RESULT_INVALID');
          owned.add(result.sessionId);
        }
        // A stopped connection must not deliver late credentials or observations.
        if(closed){revokeOwned();throw Error('AGENT_CLIENT_UNAVAILABLE');}
        return {version:1,id,ok:true,result};
      }catch{return {version:1,id,ok:false,error:'AGENT_CLIENT_REQUEST_REFUSED'};}
      finally{busy=false;settled();drain=null;}
    },
  });
}
