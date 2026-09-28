import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { isProjectId } from '../project/projectIds.js';
import { validateTaskDraftLedger } from '../project/taskDraftLedger.js';
import { readTaskRunObservations } from './taskRunObservations.mjs';

const PREFIX='/api/task-run-observations';
const json=(res,status,value)=>{ if(res.destroyed||res.writableEnded)return;res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.end(JSON.stringify(value)); };
const error=code=>({error:code});
function readBody(req) {
  return new Promise((resolve,reject)=>{
    let length=0;const chunks=[];
    const cleanup=()=>{clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',failed);req.off('aborted',failed);};
    const failed=()=>{cleanup();req.resume();reject(new Error('BODY_REFUSED'));};
    const data=chunk=>{length+=chunk.length;if(length>2*1024*1024)return failed();chunks.push(chunk);};
    const end=()=>{cleanup();try{resolve(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));}catch{reject(new Error('BODY_REFUSED'));}};
    const timer=setTimeout(failed,2000);
    req.on('data',data);req.on('end',end);req.on('error',failed);req.on('aborted',failed);
  });
}

// Construct only in the host lifetime. No request may register/rebind a source.
// This token restricts read transport; it is never execution approval.
export function createTaskRunObservationMiddleware({origin,bindings=[]}={}) {
  const address=new URL(origin);
  if(address.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(address.hostname)||address.origin!==origin)throw new Error('A fixed loopback origin is required.');
  if(!Array.isArray(bindings)||bindings.length>100)throw new Error('Invalid observation bindings.');
  const sources=new Map();
  for(const item of bindings){
    if(!item||Object.keys(item).sort().join('|')!=='journalPath|projectId|rootIdentity'||!isProjectId(item.projectId)||typeof item.rootIdentity!=='string'||!/^[a-f0-9]{64}$/.test(item.rootIdentity)||typeof item.journalPath!=='string'||!path.isAbsolute(item.journalPath)||sources.has(item.projectId))throw new Error('Invalid observation binding.');
    sources.set(item.projectId,Object.freeze({...item}));
  }
  const token=randomBytes(32).toString('hex');let pending=0,disposed=false;
  const middleware=async(req,res,next=()=>json(res,404,error('NOT_FOUND')))=>{
    if(!String(req.url).startsWith(PREFIX))return next();
    if(disposed)return json(res,503,error('READER_CLOSED'));
    if(req.headers.origin!==origin||req.headers.host!==address.host||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))return json(res,403,error('ORIGIN_REFUSED'));
    if(req.url===`${PREFIX}/session`&&req.method==='POST')return json(res,200,{schemaVersion:1,token,executionAuthorized:false});
    if(req.url!==`${PREFIX}/read`)return json(res,404,error('NOT_FOUND'));
    if(req.method!=='POST'||!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type']??''))return json(res,415,error('JSON_POST_REQUIRED'));
    const supplied=req.headers['x-pp-observation-token'];
    if(typeof supplied!=='string'||!/^[a-f0-9]{64}$/.test(supplied)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(token)))return json(res,403,error('TOKEN_REFUSED'));
    if(pending>=4)return json(res,503,error('READER_BUSY'));
    pending++;
    const work=(async()=>{
      const request=await readBody(req);
      if(!request||Object.keys(request).join('|')!=='ledger')return {status:400,body:error('REQUEST_REFUSED')};
      const ledger=validateTaskDraftLedger(request.ledger),source=sources.get(ledger.binding.projectId);
      if(!source)return {status:503,body:error('OBSERVATIONS_NOT_CONFIGURED')};
      if(source.rootIdentity!==ledger.binding.rootIdentity)return {status:409,body:error('PROJECT_BINDING_CHANGED')};
      const observations=await readTaskRunObservations({journalPath:source.journalPath,ledgerWire:JSON.stringify(ledger)});
      if(disposed||sources.get(ledger.binding.projectId)!==source)return {status:409,body:error('PROJECT_BINDING_REVOKED')};
      return {status:200,body:{...observations,ledgerSource:'renderer-supplied-draft',currentHostLedgerVerified:false}};
    })().catch(()=>({status:503,body:error('OBSERVATIONS_UNAVAILABLE')})).finally(()=>{pending--;});
    let timer;
    try{
      const reply=await Promise.race([work,new Promise(resolve=>{timer=setTimeout(()=>resolve({status:504,body:error('READ_DEADLINE_EXCEEDED')}),5000);})]);
      json(res,reply.status,reply.body);
    }finally{clearTimeout(timer);}
  };
  middleware.revoke=projectId=>sources.delete(projectId);
  middleware.dispose=()=>{disposed=true;sources.clear();};
  return Object.freeze(middleware);
}
