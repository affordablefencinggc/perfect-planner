import { boundedFetch } from './boundedFetch.js';
import { verifyComponentPlans } from '../engine/componentPlanEngine.js';
async function request(operation,body,token){
 const response=await boundedFetch(`/api/component-plans/${operation}`,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json',...(token?{'x-pp-component-token':token}:{})},body:JSON.stringify(body)});
 const result=await response.json();if(!response.ok)throw Error('Component service refused the request. Refresh saved planning before retrying.');return result;
}
async function session(){const identity=await request('session',{});if(typeof identity.actor!=='string'||!identity.actor.trim()||typeof identity.token!=='string'||!identity.token)throw Error('Component session unavailable.');return identity;}
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const head=value=>value&&Number.isSafeInteger(value.revision)&&value.revision>0&&digest(value.contractDigest);
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
async function checked(value,planId,actor){
 if(value?.schemaVersion!==1||value.planId!==planId||!['ready','architecture-missing','folder-missing','folder-stale'].includes(value.state)||value.ready!==(value.state==='ready')||!['missing','current','stale'].includes(value.catalogState)||value.publicationAuthorized!==false||value.executionAuthorized!==false||!Array.isArray(value.folderNodes))throw Error('Invalid component authoring receipt.');
 if((value.architectureHead!==null&&!head(value.architectureHead))||(value.folderHead!==null&&!head(value.folderHead))||(value.catalogHead!==null&&!head(value.catalogHead)))throw Error('Invalid saved head.');
 if((value.catalogHead===null)!==(value.catalog===null)||(value.catalogState==='missing')!==(value.catalog===null))throw Error('Saved catalog presence is inconsistent.');
 if(value.state==='ready'&&(!head(value.architectureHead)||!head(value.folderHead)||value.folderHead.architectureContractDigest!==value.architectureHead.contractDigest||value.folderHead.architectureRevision!==value.architectureHead.revision))throw Error('Saved folder parent does not match architecture.');
 if(value.folderNodes.some(node=>!node||typeof node.id!=='string'||typeof node.path!=='string'||!['folder','file'].includes(node.kind)))throw Error('Invalid saved folder nodes.');
 if(value.catalog!==null&&(value.catalog?.planId!==planId||value.catalog?.digest!==value.catalogHead?.contractDigest||['architectureDigest','architectureRevision','folderDigest','folderRevision'].some(key=>value.catalog[key]!==value.catalogHead[key])||!(await verifyComponentPlans(value.catalog)).valid))throw Error('Invalid saved component payload.');
 if(value.catalogState==='current'&&(value.state!=='ready'||value.catalog.architectureDigest!==value.architectureHead.contractDigest||value.catalog.architectureRevision!==value.architectureHead.revision||value.catalog.folderDigest!==value.folderHead.contractDigest||value.catalog.folderRevision!==value.folderHead.revision))throw Error('Saved catalog parents are not current.');
 return {...value,actor};
}
export async function readComponentContext(planId){const identity=await session();return checked(await request('authoring-context',{planId},identity.token),planId,identity.actor);}
export async function publishComponentDraft(planId,input,{expectedRevision,expectedHeadDigest,actor}){
 input=structuredClone(input);if(input.planId!==planId)throw Error('Component project changed.');
 const identity=await session();if(identity.actor!==actor)throw Error('Approver changed. Review again.');
 const published=await request('publish',{input,expectedRevision,expectedHeadDigest},identity.token);
 const observed=await checked(await request('authoring-context',{planId},identity.token),planId,identity.actor);
 if(!published.head?.contractDigest||published.revision!==expectedRevision+1||observed.state!=='ready'||observed.catalogState!=='current'||observed.catalogHead?.contractDigest!==published.head.contractDigest||observed.catalogHead?.revision!==published.revision||observed.catalog?.digest!==published.head.contractDigest||observed.catalog.approvedBy!==actor||!(await verifyComponentPlans(observed.catalog)).valid||['architectureDigest','architectureRevision','folderDigest','folderRevision'].some(key=>observed.catalog[key]!==input[key])||!equal(observed.catalog.components,input.components)||!equal(observed.catalog.inventory,input.inventory))throw Error('Publication outcome needs reconciliation. Refresh saved planning before retrying.');
 return observed;
}
