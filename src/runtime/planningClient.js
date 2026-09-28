import {readComponentContext} from './componentClient.js';
import {checkedPlanningBinding,planningExact,checkLedgerReceipt,checkApprovalReceipt,checkResolutionReceipt,checkLedgerResolutionReceipt} from '../project/planningApprovalReceipt.js';

// A transport session is never an approval or a filesystem capability.
export function createPlanningClient({fetchImpl=globalThis.fetch}={}) {
  let token=null, opening=null;
  async function post(route,input,sessionToken=null) {
    const controller=new AbortController();
    let reader;
    let expire;
    const deadline=new Promise((_,reject)=>{expire=()=>reject(Error('Planning response timed out.'));});
    const timer=setTimeout(()=>{expire();controller.abort();reader?.cancel().catch(()=>{});},15000);
    try {
      const response=await Promise.race([deadline,fetchImpl(`/api/planning-ledger/${route}`,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json',...(sessionToken?{'x-pp-planning-ledger-token':sessionToken}:{})},body:JSON.stringify(input),signal:controller.signal})]);
      if(response.status===403)token=null;
      const limit=route==='session'?2048:33*1024*1024;
      if(Number(response.headers?.get('content-length'))>limit)throw Error('Planning response exceeds its safe size.');
      if(!response.body?.getReader)throw Error('A bounded planning response stream is required.');
      reader=response.body.getReader();let size=0;const chunks=[];
      while(true){const result=await Promise.race([deadline,reader.read()]);if(controller.signal.aborted)throw Error('Planning response timed out.');if(result.done)break;size+=result.value.byteLength;if(size>limit)throw Error('Planning response exceeds its safe size.');chunks.push(result.value);}
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),value=JSON.parse(text);
      const stack=[];
      for(const [part] of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]/g)){
        if(part==='{'||part==='['){stack.push({object:part==='{',keys:new Set(),key:true});if(stack.length>40)throw Error('Planning response nesting limit.');}
        else if(part==='}'||part===']')stack.pop();
        else if(part===','){if(stack.at(-1)?.object)stack.at(-1).key=true;}
        else if(part.startsWith('"')&&stack.at(-1)?.object&&stack.at(-1).key){const frame=stack.at(-1),key=JSON.parse(part);if(frame.keys.has(key))throw Error('Ambiguous planning response.');frame.keys.add(key);frame.key=false;}
      }
      if(!response.ok)throw Error(typeof value.code==='string'&&/^[A-Z][A-Z0-9_]{0,100}$/.test(value.code)?value.code:'Planning request was refused.');
      return value;
    } finally {clearTimeout(timer);reader?.cancel().catch(()=>{});}
  }
  async function session(){
    if(token)return token;
    if(!opening)opening=(async()=>{const value=await post('session',{});planningExact(value,['schemaVersion','token','approvalAuthorized','executionAuthorized']);if(value.schemaVersion!==1||typeof value.token!=='string'||!/^[a-f0-9]{64}$/.test(value.token)||value.approvalAuthorized!==false||value.executionAuthorized!==false)throw Error('Invalid planning session.');token=value.token;return token;})().finally(()=>{opening=null;});
    return opening;
  }
  async function request(route,input){return post(route,input,await session());}
  return {
    async inspectLedger(binding){binding=structuredClone(binding);checkedPlanningBinding(binding);return checkLedgerReceipt(await request('inspect',{binding}),binding);},
    async submitLedger(input){input=structuredClone(input);const binding=checkedPlanningBinding(input.ledger.binding);return checkLedgerReceipt(await request('submit',input),binding,input);},
    async inspectApprovals(binding){binding=structuredClone(binding);checkedPlanningBinding(binding);return checkApprovalReceipt(await request('approval-inspect',{binding}),binding,'inspect');},
    async publishApproval(input){input=structuredClone(input);checkedPlanningBinding(input.binding);return checkApprovalReceipt(await request('approval-publish',input),input.binding,'publish',input);},
    async resolveApproval(input){input=structuredClone(input);checkedPlanningBinding(input.binding);return checkResolutionReceipt(await request('approval-resolve',input),input.binding,input);},
    async resolveLedger(input){input=structuredClone(input);const binding=checkedPlanningBinding(input.original.ledger.binding);return checkLedgerResolutionReceipt(await request('resolve',input),binding,input);},
    async inspectCurrent(binding,expectedApprovalHead){binding=structuredClone(binding);expectedApprovalHead=structuredClone(expectedApprovalHead);checkedPlanningBinding(binding);return checkApprovalReceipt(await request('approval-current',{binding,expectedApprovalHead}),binding,'current',expectedApprovalHead);},
    readContext:readComponentContext,
  };
}
