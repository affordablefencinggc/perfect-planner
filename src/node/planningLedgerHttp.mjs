import {randomBytes,timingSafeEqual} from 'node:crypto';
import {createPlanningLedgerCustody} from './planningLedgerCustody.mjs';
import {TASK_DRAFT_BYTES} from '../project/taskDraftLedger.js';
import {validateTaskDraftBinding} from '../project/taskDraftLedger.js';
import {createPlanApprovalStore} from './planApprovalStore.mjs';
import {PLAN_REVIEW_BYTES} from '../project/planApprovalDraft.js';
import {isSameOriginLoopbackRequest} from './loopbackRequestHttp.mjs';

const prefix='/api/planning-ledger/';
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const reply=(res,status,value)=>{res.statusCode=status;res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');res.end(JSON.stringify(value));};
const sameOrigin=isSameOriginLoopbackRequest;
const sameToken=(value,token)=>{if(typeof value!=='string')return false;const supplied=Buffer.from(value),expected=Buffer.from(token);return supplied.length===expected.length&&timingSafeEqual(supplied,expected);};

// Reject ambiguous duplicate members rather than silently choosing one task
// description, scope or identity. This scanner runs only after JSON.parse.
function uniqueMembers(wire){
 const stack=[];
 for(const [token] of wire.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]/g)){
  if(token==='{'||token==='['){stack.push({object:token==='{',keys:new Set(),key:true});if(stack.length>32)return false;}
  else if(token==='}'||token===']')stack.pop();
  else if(token===','){if(stack.at(-1)?.object)stack.at(-1).key=true;}
  else if(token.startsWith('"')&&stack.at(-1)?.object&&stack.at(-1).key){const frame=stack.at(-1),key=JSON.parse(token);if(frame.keys.has(key))return false;frame.keys.add(key);frame.key=false;}
 }
 return true;
}
async function body(req,limit){
 const chunks=[];let size=0;
 for await(const chunk of req.iterator({destroyOnReturn:false})){size+=chunk.length;if(size>limit){req.resume();throw Error('INPUT_LIMIT');}chunks.push(chunk);}
 const wire=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)),value=JSON.parse(wire);
 if(!uniqueMembers(wire))throw Error('INVALID_JSON');
 return value;
}

// Transport capability only: neither the session token nor a retained browser
// declaration authenticates a person, verifies folder access or approves work.
export function createPlanningLedgerMiddleware({root,token=randomBytes(32).toString('hex')}={}){
 if(typeof token!=='string'||token.length<32)throw Error('PLANNING_LEDGER_HTTP_CONFIG_INVALID');
 const custody=createPlanningLedgerCustody({root});
 return async(req,res,next=()=>reply(res,404,{error:'Not found.'}))=>{
  let url;try{url=new URL(req.url,`http://${req.headers.host??'localhost'}`);}catch{return reply(res,400,{error:'Invalid request URL.'});}
  if(!url.pathname.startsWith(prefix))return next();
  if(!sameOrigin(req))return reply(res,403,{error:'Exact same-origin request required.'});
  if(req.method!=='POST'||String(req.headers['content-type']??'').split(';')[0].trim().toLowerCase()!=='application/json')return reply(res,415,{error:'JSON POST required.'});
  if(url.search||!['session','inspect','submit','resolve','approval-inspect','approval-publish','approval-current','approval-resolve'].some(name=>url.pathname===prefix+name))return reply(res,404,{error:'Unknown planning ledger operation.'});
  const session=url.pathname===prefix+'session';
  if(!session&&!sameToken(req.headers['x-pp-planning-ledger-token'],token))return reply(res,403,{error:'Planning ledger transport capability refused.'});
  try{
   const input=await body(req,['approval-publish','approval-resolve'].some(name=>url.pathname===prefix+name)?PLAN_REVIEW_BYTES+4096:['submit','resolve'].some(name=>url.pathname===prefix+name)?TASK_DRAFT_BYTES+4096:2048);
   if(session){if(!exact(input,[]))throw Error('INVALID_REQUEST');return reply(res,200,{schemaVersion:1,token,approvalAuthorized:false,executionAuthorized:false});}
   if(url.pathname===prefix+'inspect'){if(!exact(input,['binding']))throw Error('INVALID_REQUEST');return reply(res,200,await custody.inspect(input));}
   if(url.pathname===prefix+'resolve'){
    if(!exact(input,['original','confirmation']))throw Error('INVALID_REQUEST');
    // The complete original determines its binding. No caller-selected host
    // location or separate, potentially contradictory identity is accepted.
    return reply(res,200,await custody.resolveOriginal(input));
   }
   if(['approval-inspect','approval-publish','approval-current','approval-resolve'].some(name=>url.pathname===prefix+name)){
    const publishing=url.pathname===prefix+'approval-publish',current=url.pathname===prefix+'approval-current',resolving=url.pathname===prefix+'approval-resolve';
    if(!exact(input,resolving?['binding','original','confirmation']:publishing?['binding','proposal','expectedProposalHead','request','confirmation']:current?['binding','expectedApprovalHead']:['binding']))throw Error('INVALID_REQUEST');
    const binding=validateTaskDraftBinding(input.binding);
    // Fixed host paths and honest actor/source. Browser confirmation is declared
    // intent, not authenticated identity or a native trusted-gesture receipt.
    const approvals=createPlanApprovalStore({root,projectId:binding.projectId,rootIdentity:binding.rootIdentity,actor:'local-browser-user',source:'browser-declared-local-development'});
    if(resolving){
     if(!exact(input.original?.proposal?.binding,['projectId','rootIdentity','censusDigest'])||Object.keys(binding).some(key=>input.original.proposal.binding[key]!==binding[key]))throw Error('INVALID_REQUEST');
     return reply(res,200,await approvals.resolveOriginal({original:input.original,confirmation:input.confirmation}));
    }
    if(current){
     const result=await approvals.inspectCurrent({expectedApprovalHead:input.expectedApprovalHead});
     if(Object.keys(binding).some(key=>result.record.proposal.binding[key]!==binding[key]))throw Error('INVALID_REQUEST');
     return reply(res,200,result);
    }
    if(!publishing)return reply(res,200,await approvals.inspect());
    if(!exact(input.proposal?.binding,['projectId','rootIdentity','censusDigest'])||Object.keys(binding).some(key=>input.proposal.binding[key]!==binding[key]))throw Error('INVALID_REQUEST');
    const {proposal,expectedProposalHead,request,confirmation}=input;
    return reply(res,200,await approvals.publish({proposal,expectedProposalHead,request,confirmation}));
   }
   if(!exact(input,['ledger','request','expectedCensusDigest']))throw Error('INVALID_REQUEST');
   return reply(res,200,await custody.submit(input));
  }catch(error){
   // Never return filesystem locations or arbitrary host exception text.
   const code=/^(?:PLANNING_LEDGER|TASK_LEDGER|PLAN_APPROVAL|CURRENT_PLANNING)_[A-Z_]{1,80}$/.test(error.message)?error.message:'PLANNING_LEDGER_REQUEST_REFUSED';
   return reply(res,/STALE|CONFLICT|CENSUS/.test(code)?409:400,{error:'Planning ledger request refused. Refresh saved state before retrying.',code});
  }
 };
}
