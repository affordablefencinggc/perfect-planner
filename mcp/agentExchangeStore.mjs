import {mkdir,lstat,realpath,open,readdir,readFile,link,unlink} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {validateAgentSessionBinding} from '../src/runtime/agentSessionProtocol.js';
import {validateExchangeReport,redactExchangeSummary} from '../src/runtime/agentExchangeReport.js';
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const bindingKey=b=>[b.projectId,b.workspaceId,b.registryRevision,b.rootIdentity];
const same=(a,b)=>JSON.stringify(bindingKey(a))===JSON.stringify(bindingKey(b));
// Owner-selected registry root only. Immutable published records; partial temp
// writes never become receipts. Does not grant task or execution authority.
export function createAgentExchangeStore(registryRoot){
  if(!path.isAbsolute(registryRoot))throw Error('EXCHANGE_ROOT_INVALID');
  async function directory(binding){
    validateAgentSessionBinding(binding);
    let current=await realpath(registryRoot);
    for(const part of ['agent-exchanges-v1',hash(bindingKey(binding))]){
      current=path.join(current,part);await mkdir(current).catch(e=>{if(e.code!=='EEXIST')throw e;});
      const stat=await lstat(current);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('EXCHANGE_DIRECTORY_INVALID');
    }
    return current;
  }
  async function record(file,binding){
    const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16000)throw Error('EXCHANGE_RECORD_INVALID');
    const value=JSON.parse(await readFile(file,'utf8'));
    if(value.schemaVersion!==1||!same(value.binding,binding)||!/^[a-f0-9]{32}$/.test(value.sessionId)||!/^[a-f0-9]{64}$/.test(value.digest)||!Number.isSafeInteger(value.sequence)||value.sequence<2||value.verification!=='not-verified'||value.origin!=='authenticated-agent-report'||!Number.isFinite(Date.parse(value.receivedAt)))throw Error('EXCHANGE_RECORD_INVALID');
    const report=validateExchangeReport({binding:value.binding,exchangeId:value.exchangeId,summary:value.summary},binding);
    if(hash(report)!==value.digest)throw Error('EXCHANGE_RECORD_INVALID');
    return value;
  }
  return Object.freeze({
    async append(input,admission){
      const original=validateExchangeReport(input,admission.binding);
      if(!/^[a-f0-9]{32}$/.test(admission.sessionId)||!Number.isSafeInteger(admission.sequence)||admission.sequence<2)throw Error('EXCHANGE_ADMISSION_INVALID');
      const report={...original,summary:redactExchangeSummary(original)},digest=hash(report),dir=await directory(report.binding);
      // Exchange IDs are project-bound, not caller-selected filesystem paths.
      const target=path.join(dir,hash(report.exchangeId)+'.json');
      const reconcile=async()=>{const previous=await record(target,report.binding);if(previous.digest!==digest||previous.sessionId!==admission.sessionId)throw Error('EXCHANGE_ID_CONFLICT');return {...previous,idempotent:true};};
      try{return await reconcile();}catch(e){if(e.code!=='ENOENT')throw e;}
      const entries=await readdir(dir);if(entries.length>=1000)throw Error('EXCHANGE_CAPACITY');
      const value={schemaVersion:1,...report,digest,sessionId:admission.sessionId,sequence:admission.sequence,receivedAt:new Date().toISOString(),origin:'authenticated-agent-report',verification:'not-verified'};
      const temporary=path.join(dir,randomBytes(16).toString('hex')+'.pending');let file;
      try{
        file=await open(temporary,'wx');await file.writeFile(JSON.stringify(value));await file.sync();await file.close();file=null;
        try{await link(temporary,target);}catch(e){if(e.code==='EEXIST')return await reconcile();throw e;}
        return {...await record(target,report.binding),idempotent:false};
      }finally{await file?.close();await unlink(temporary).catch(()=>{});}
    },
    async read(binding,offset=0){
      if(!Number.isSafeInteger(offset)||offset<0||offset>1000)throw Error('EXCHANGE_OFFSET_INVALID');
      const dir=await directory(binding),names=(await readdir(dir)).filter(n=>/^[a-f0-9]{64}\.json$/.test(n));
      if(names.length>1000)throw Error('EXCHANGE_CAPACITY');
      const rows=await Promise.all(names.map(n=>record(path.join(dir,n),binding)));
      rows.sort((a,b)=>b.receivedAt.localeCompare(a.receivedAt)||b.exchangeId.localeCompare(a.exchangeId));
      return {binding,records:rows.slice(offset,offset+1),total:rows.length,nextOffset:offset+1<rows.length?offset+1:null,coverage:'reported-exchanges-only',executionAuthorized:false};
    }
  });
}
