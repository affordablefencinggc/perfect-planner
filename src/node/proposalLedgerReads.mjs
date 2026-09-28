// Trusted host composition over the existing native proposal journal.
// A brief is a projection, never a replacement for task obligations or approval.
import {createHash} from 'node:crypto';
export function createAgentLedgerReads({submission}){
  if(typeof submission?.readProposal!=='function'||typeof submission?.readRequestResult!=='function')throw Error('AGENT_LEDGER_CONFIG');
  const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
  const check=(value,binding)=>{if(value?.binding?.projectId!==binding.projectId||value.binding.rootIdentity!==binding.rootIdentity||value.registrationCurrent!==true||value.executionAuthorized!==false||value.approvalState!=='unapproved-proposal')throw Error('AGENT_LEDGER_BINDING');};
  return Object.freeze({async read(method,input,binding){
    if(method==='owner.readLedgerSnapshot'){
      if(!exact(input,['offset','expectedHeadDigest'])||!Number.isSafeInteger(input.offset)||input.offset<0||!(input.expectedHeadDigest===null||input.expectedHeadDigest==='GENESIS'||typeof input.expectedHeadDigest==='string'&&/^[a-f0-9]{64}$/.test(input.expectedHeadDigest))||(input.offset>0&&input.expectedHeadDigest===null))throw Error('AGENT_LEDGER_INPUT');
      const value=await submission.readProposal();check(value,binding);
      if(input.expectedHeadDigest!==null&&input.expectedHeadDigest!==value.observedHead.headDigest)throw Error('AGENT_LEDGER_STALE_HEAD');
      // Full authoritative proposal, including archived tasks and ledger
      // identity. A UI can collect this separately without touching its draft.
      const wire=JSON.stringify(value.ledger);
      if(Buffer.byteLength(wire)>1024*1024||input.offset>=wire.length)throw Error('AGENT_LEDGER_OFFSET');
      // The private owner read returns one bounded ledger, avoiding hundreds
      // of native process/diagnostic sessions for a single 1 MiB plan.
      if(input.offset>0&&wire.charCodeAt(input.offset)>=0xdc00&&wire.charCodeAt(input.offset)<=0xdfff&&wire.charCodeAt(input.offset-1)>=0xd800&&wire.charCodeAt(input.offset-1)<=0xdbff)throw Error('AGENT_LEDGER_OFFSET');
      let end=wire.length;
      // Native JSON decoders reject lone surrogates. Keep Unicode pairs in
      // one chunk while retaining UTF-16 offsets for the browser assembler.
      if(end<wire.length&&wire.charCodeAt(end-1)>=0xd800&&wire.charCodeAt(end-1)<=0xdbff)end--;
      return {schemaVersion:1,binding:value.binding,observedHead:value.observedHead,ledgerDigest:value.ledgerDigest,snapshotDigest:createHash('sha256').update(wire).digest('hex'),encoding:'json; offsets in UTF-16 code units; concatenate all chunks before parsing',offset:input.offset,totalLength:wire.length,nextOffset:end<wire.length?end:null,chunk:wire.slice(input.offset,end),approvalState:'unapproved-proposal',executionAuthorized:false};
    }
    if(method==='client.readRequestResult'){
      if(!exact(input,['requestId']))throw Error('AGENT_LEDGER_INPUT');
      const value=await submission.readRequestResult(input.requestId);check(value,binding);return value;
    }
    if(method==='client.readTask'){
      if(!exact(input,['taskId','offset','expectedHeadDigest'])||typeof input.taskId!=='string'||!/^T\d{4,6}$/.test(input.taskId)||!Number.isSafeInteger(input.offset)||input.offset<0||typeof input.expectedHeadDigest!=='string'||!/^[a-f0-9]{64}$/.test(input.expectedHeadDigest))throw Error('AGENT_LEDGER_INPUT');
      const value=await submission.readProposal();check(value,binding);
      if(input.expectedHeadDigest!==value.observedHead.headDigest)throw Error('AGENT_LEDGER_STALE_HEAD');
      const task=value.ledger?.tasks.find(t=>t.id===input.taskId);
      if(!task)throw Error('AGENT_LEDGER_TASK_MISSING');
      // Transport chunks preserve every field; concatenate before parsing JSON.
      // UTF-16 offsets match JS slicing, including split surrogate pairs.
      const wire=JSON.stringify(task);
      if(input.offset>=wire.length)throw Error('AGENT_LEDGER_OFFSET');
      const end=Math.min(input.offset+2000,wire.length);
      return {schemaVersion:1,binding:value.binding,observedHead:value.observedHead,ledgerDigest:value.ledgerDigest,taskId:task.id,taskDigest:createHash('sha256').update(wire).digest('hex'),encoding:'json; offsets in UTF-16 code units; concatenate all chunks before parsing',offset:input.offset,totalLength:wire.length,nextOffset:end<wire.length?end:null,chunk:wire.slice(input.offset,end),approvalState:'unapproved-proposal',executionAuthorized:false};
    }
    if(method!=='client.readBrief'||!exact(input,['offset','expectedHeadDigest'])||!Number.isSafeInteger(input.offset)||input.offset<0||input.offset>500||!(input.expectedHeadDigest===null||input.expectedHeadDigest==='GENESIS'||/^[a-f0-9]{64}$/.test(input.expectedHeadDigest))||(input.offset>0&&input.expectedHeadDigest===null))throw Error('AGENT_LEDGER_INPUT');
    const value=await submission.readProposal();check(value,binding);
    if(input.expectedHeadDigest!==null&&input.expectedHeadDigest!==value.observedHead.headDigest)throw Error('AGENT_LEDGER_STALE_HEAD');
    const tasks=value.ledger?.tasks??[];
    if(input.offset>tasks.length)throw Error('AGENT_LEDGER_OFFSET');
    const page=tasks.slice(input.offset,input.offset+10).map(t=>({id:t.id,title:t.title,owner:t.owner,dependsOn:t.dependsOn,claimCount:t.claims.length,archived:t.archived}));
    return {schemaVersion:1,binding:value.binding,observedHead:value.observedHead,ledgerDigest:value.ledgerDigest,hasProposal:value.ledger!==null,totalTasks:tasks.length,offset:input.offset,nextOffset:input.offset+page.length<tasks.length?input.offset+page.length:null,tasks:page,projection:'summary-only; full task obligations and evidence are not included',approvalState:'unapproved-proposal',executionAuthorized:false};
  }});
}
