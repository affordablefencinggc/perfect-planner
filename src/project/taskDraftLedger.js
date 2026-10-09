import { assertProjectId } from './projectIds.js';
import { CLAIM_PATTERN_HELP, claimPatternProblem, claimPatternsOverlap, isClaimPattern } from '../engine/claimPatterns.js';

const DIGEST = /^[a-f0-9]{64}$/;
const TASK_ID = /^T\d{4,6}$/;
const validTaskId = value => typeof value === 'string' && TASK_ID.test(value) && Number(value.slice(1)) > 0 && value === `T${String(Number(value.slice(1))).padStart(4,'0')}`;
export const TASK_DRAFT_LIMIT = 500;
export const TASK_DRAFT_BYTES = 1024 * 1024;
export const TASK_DRAFT_IMPORT_BYTES = TASK_DRAFT_BYTES * 8;
// `field` names the editor field a refusal belongs to, so the form can show it inline.
const fail = (message, field) => { const error = new Error(message); if (field) error.field = field; throw error; };
const text = (value, label, max, required = false, field) => {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || (required && !value.trim())) fail(`${label} is missing or too long.`, field);
  return value.trim();
};
const exact = (value, fields) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('|') !== [...fields].sort().join('|')) fail('Draft has an unsupported shape. Existing data was not changed.');
};
const frozen = value => { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; };

export function taskDraftBinding(project) {
  const binding = {projectId:project?.projectId, rootIdentity:project?.registration?.rootIdentity, censusDigest:project?.census?.digest};
  validateTaskDraftBinding(binding);
  return frozen(binding);
}

export function validateTaskDraftBinding(binding) {
  exact(binding, ['projectId','rootIdentity','censusDigest']);
  assertProjectId(binding.projectId);
  if (![binding.rootIdentity,binding.censusDigest].every(v=>typeof v==='string' && DIGEST.test(v))) fail('A registered project and folder census are required before planning.');
  return binding;
}

export function sameTaskDraftBinding(left, right) {
  return ['projectId','rootIdentity','censusDigest'].every(key=>left?.[key]===right?.[key]);
}

export function validateDraftTask(input) {
  exact(input, ['id','title','description','owner','acceptance','recovery','claims','dependsOn','archived']);
  if (!validTaskId(input.id) || typeof input.archived!=='boolean') fail('Task identity is invalid.');
  if (!Array.isArray(input.claims) || input.claims.length>64) fail('A task can list at most 64 file scope lines.', 'claims');
  if (!Array.isArray(input.dependsOn) || input.dependsOn.length>64) fail('A task can depend on at most 64 tasks.', 'dependsOn');
  const claims=input.claims.map(claim=>{
    exact(claim,['path','access']);
    const value=text(claim.path,'Relative file claim',240,true,'claims');
    if (!['read','write'].includes(claim.access)) fail('Each file scope must start with read or write.', 'claims');
    const problem=claimPatternProblem(value);
    if (problem) fail(`Claims must be relative paths using /. "${value}": ${problem} ${CLAIM_PATTERN_HELP}`, 'claims');
    return {path:value,access:claim.access};
  });
  if (new Set(claims.map(c=>c.path.toLowerCase())).size!==claims.length) fail('Each path may be claimed only once per task.', 'claims');
  const dependsOn=input.dependsOn.map(id=>{if(!validTaskId(id))fail('Dependency references must use task IDs.', 'dependsOn');return id;});
  if (new Set(dependsOn).size!==dependsOn.length || dependsOn.includes(input.id)) fail('A task cannot depend on itself or repeat a dependency.', 'dependsOn');
  return frozen({id:input.id,title:text(input.title,'Task title',160,true,'title'),description:text(input.description,'Description',8000,false,'description'),owner:text(input.owner,'Owner',120,false,'owner'),acceptance:text(input.acceptance,'Acceptance criteria',8000,false,'acceptance'),recovery:text(input.recovery,'Recovery plan',8000,false,'recovery'),claims,dependsOn,archived:input.archived});
}

export function validateTaskDraftLedger(value) {
  exact(value,['schemaVersion','kind','binding','revision','nextTaskNumber','updatedAt','tasks']);
  if(value.schemaVersion!==1 || value.kind!=='LOCAL_DRAFT' || !Number.isSafeInteger(value.revision) || value.revision<0 || value.revision>5000 || !Number.isSafeInteger(value.nextTaskNumber) || value.nextTaskNumber<1 || value.nextTaskNumber>999999 || typeof value.updatedAt!=='string' || !Number.isFinite(Date.parse(value.updatedAt))) fail('Draft revision is invalid. Existing data was not changed.');
  validateTaskDraftBinding(value.binding);
  if(!Array.isArray(value.tasks)||value.tasks.length>TASK_DRAFT_LIMIT)fail('Draft task limit reached.');
  const tasks=value.tasks.map(validateDraftTask), ids=new Set(tasks.map(t=>t.id));
  if(ids.size!==tasks.length || tasks.some(t=>Number(t.id.slice(1))>=value.nextTaskNumber))fail('Draft task identities are inconsistent.');
  if(tasks.some(t=>t.dependsOn.some(id=>!ids.has(id))))fail('A dependency refers to a task outside this ledger.', 'dependsOn');
  const snapshot={...value,binding:{...value.binding},tasks};
  if(new TextEncoder().encode(JSON.stringify(snapshot)).length>TASK_DRAFT_BYTES)fail('Draft size limit reached. Existing revisions were not changed.');
  return frozen(snapshot);
}

export function emptyTaskDraftLedger(binding) {
  return validateTaskDraftLedger({schemaVersion:1,kind:'LOCAL_DRAFT',binding:{...binding},revision:0,nextTaskNumber:1,updatedAt:new Date(0).toISOString(),tasks:[]});
}

export function updateTaskDraft(ledger, taskInput, now=new Date().toISOString()) {
  const current=validateTaskDraftLedger(ledger);
  const adding=taskInput.id==null;
  const id=adding ? `T${String(current.nextTaskNumber).padStart(4,'0')}` : taskInput.id;
  if(!adding && !current.tasks.some(t=>t.id===id))fail('The task is no longer in this ledger.');
  const task=validateDraftTask({...taskInput,id});
  return validateTaskDraftLedger({...current,revision:current.revision+1,nextTaskNumber:current.nextTaskNumber+(adding?1:0),updatedAt:now,tasks:adding?[...current.tasks,task]:current.tasks.map(t=>t.id===id?task:t)});
}

export function parseTaskDraftImport(raw) {
  // Pretty-printed exports need more room than their validated canonical record.
  if(typeof raw!=='string'||new TextEncoder().encode(raw).length>TASK_DRAFT_IMPORT_BYTES)fail('Choose a draft JSON file no larger than 8 MiB.');
  let value;try{value=JSON.parse(raw);}catch{fail('The selected file is not valid draft JSON. Nothing was imported.');}
  return validateTaskDraftLedger(value);
}

// Import creates draft copies, never replaces tasks or adopts a foreign revision.
// IDs survive recovery into an empty store; existing ledgers get explicit new IDs.
export function importTaskDraft(ledger, incoming, now=new Date().toISOString()) {
  const current=validateTaskDraftLedger(ledger),source=validateTaskDraftLedger(incoming);
  if(!sameTaskDraftBinding(current.binding,source.binding))fail('The import belongs to another project, folder root or inventory. Nothing was imported.');
  if(!source.tasks.length)fail('The selected draft has no tasks to import.');
  if(current.tasks.length+source.tasks.length>TASK_DRAFT_LIMIT)fail('Import would exceed the 500-task draft limit. Existing tasks were kept.');
  const empty=current.revision===0&&current.tasks.length===0;
  const references=source.tasks.map((task,index)=>({sourceId:task.id,taskId:empty?task.id:`T${String(current.nextTaskNumber+index).padStart(4,'0')}`}));
  const ids=new Map(references.map(item=>[item.sourceId,item.taskId]));
  const tasks=source.tasks.map(task=>({...task,id:ids.get(task.id),dependsOn:task.dependsOn.map(id=>ids.get(id))}));
  const next=validateTaskDraftLedger({...current,revision:current.revision+1,updatedAt:now,
    nextTaskNumber:empty?source.nextTaskNumber:current.nextTaskNumber+tasks.length,tasks:[...current.tasks,...tasks]});
  return frozen({ledger:next,references,sourceRevision:source.revision});
}

// Explicit draft-only review. A matching inventory is not filesystem access,
// collision clearance, plan freeze or execution authority.
export function rebindTaskDraft(ledger, binding, review, now=new Date().toISOString()) {
  const current=validateTaskDraftLedger(ledger);
  validateTaskDraftBinding(binding);
  exact(review,['fromBinding','expectedRevision','reviewedTaskIds']);
  validateTaskDraftBinding(review.fromBinding);
  if(current.binding.projectId!==binding.projectId||current.binding.rootIdentity!==binding.rootIdentity)fail('Drafts cannot be rebound to another project or folder root. Export the original draft for recovery.');
  if(!sameTaskDraftBinding(current.binding,review.fromBinding)||current.revision!==review.expectedRevision)fail('The saved draft changed during review. Refresh and review the current revision again.');
  if(sameTaskDraftBinding(current.binding,binding))fail('This draft already uses the current folder inventory.');
  if(!Array.isArray(review.reviewedTaskIds)||review.reviewedTaskIds.length!==current.tasks.length||new Set(review.reviewedTaskIds).size!==current.tasks.length||current.tasks.some(task=>!review.reviewedTaskIds.includes(task.id)))fail('Review every saved task, including archived tasks, before continuing with this inventory.');
  return validateTaskDraftLedger({...current,binding:{...binding},revision:current.revision+1,updatedAt:now});
}

// Advisory only: compares file scopes with the paths seen in the last folder
// scan. A claim may name a file the task will create, so this never refuses a
// save. Returns one entry per claim: null (found, or no scan list to compare
// against) or {kind,message}. Letter case is ignored, like overlap checks.
export const CLAIM_SCAN_MESSAGES = Object.freeze({'new-file':'New file (not in the last scan)','no-match':'Matches no scanned file yet'});
export function claimScanMarkers(claims, scannedPaths) {
  const list=Array.isArray(claims)?claims:[];
  if(!Array.isArray(scannedPaths))return list.map(()=>null);
  const known=new Set();
  for(const raw of scannedPaths){
    if(typeof raw!=='string')continue;
    const parts=raw.replaceAll('\\','/').toLowerCase().split('/').filter(Boolean);
    // A plain claim may name a file or any folder that holds a scanned file.
    for(let i=1;i<=parts.length;i++)known.add(parts.slice(0,i).join('/'));
  }
  const files=scannedPaths.filter(path=>typeof path==='string');
  return list.map(claim=>{
    const path=typeof claim?.path==='string'?claim.path:'';
    if(!path)return null;
    if(isClaimPattern(path))return files.some(file=>claimPatternsOverlap(path,file))?null:{kind:'no-match',message:CLAIM_SCAN_MESSAGES['no-match']};
    return known.has(path.toLowerCase())?null:{kind:'new-file',message:CLAIM_SCAN_MESSAGES['new-file']};
  });
}

// Review findings only. Dependency order is not proof of completed work, a
// collision clearance, an exclusive lease, or permission to execute either task.
export function inspectTaskDraft(ledger) {
  const {tasks}=validateTaskDraftLedger(ledger);
  const active=tasks.filter(t=>!t.archived), byId=new Map(tasks.map(t=>[t.id,t])), findings=[];
  for(const task of active){
    for(const field of ['description','owner','acceptance','recovery'])if(!task[field])findings.push({kind:'missing-detail',taskIds:[task.id],detail:`${task.id}: ${field} is unanswered.`});
    if(!task.claims.length)findings.push({kind:'missing-scope',taskIds:[task.id],detail:`${task.id}: no file scope is recorded.`});
    for(const id of task.dependsOn)if(byId.get(id).archived)findings.push({kind:'archived-dependency',taskIds:[task.id,id],detail:`${task.id} depends on archived ${id}.`});
  }
  // Iterative topological pass avoids recursion limits on long imported plans.
  const remaining=new Set(active.map(t=>t.id));let changed=true;
  while(changed){changed=false;for(const id of remaining)if(byId.get(id).dependsOn.every(dep=>!remaining.has(dep))){remaining.delete(id);changed=true;}}
  if(remaining.size)findings.push({kind:'dependency-cycle',taskIds:[...remaining],detail:`Dependency cycle or tasks blocked by one: ${[...remaining].join(', ')}.`});
  const byPath=new Map(), patterns=[], all=[], pairs=new Set();
  for(const task of active)for(const claim of task.claims){
    const entry={id:task.id,access:claim.access,path:claim.path};all.push(entry);
    // Plain paths use an exact/ancestor index; glob claims are compared by pattern intersection.
    if(isClaimPattern(claim.path)){patterns.push(entry);continue;}
    const key=claim.path.toLowerCase();if(!byPath.has(key))byPath.set(key,[]);byPath.get(key).push(entry);
  }
  const key=(a,b)=>[a.id,b.id].sort().join('|');
  const pair=(a,b)=>{if(a.id!==b.id&&(a.access==='write'||b.access==='write'))pairs.add(key(a,b));};
  for(const [path,claims] of byPath){
    for(let i=0;i<claims.length;i++)for(let j=i+1;j<claims.length;j++)pair(claims[i],claims[j]);
    const parts=path.split('/');parts.pop();
    while(parts.length){const ancestors=byPath.get(parts.join('/'))??[];for(const a of claims)for(const b of ancestors)pair(a,b);parts.pop();}
  }
  for(const glob of patterns)for(const other of all){
    if(other===glob||other.id===glob.id||(glob.access==='read'&&other.access==='read')||pairs.has(key(glob,other)))continue;
    if(claimPatternsOverlap(glob.path,other.path))pair(glob,other);
  }
  for(const value of [...pairs].sort()){const [left,right]=value.split('|');findings.push({kind:'file-overlap',taskIds:[left,right],detail:`${left} and ${right} overlap a planned file scope. Review isolation or execution order.`});}
  return frozen({findings,activeTasks:active.length,archivedTasks:tasks.length-active.length,executionAuthorized:false});
}
