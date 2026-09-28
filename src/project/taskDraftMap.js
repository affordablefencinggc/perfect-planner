import { inspectTaskDraft, sameTaskDraftBinding, validateTaskDraftLedger } from './taskDraftLedger.js';

// A projection of saved draft obligations, never a second task store or approval.
export function projectTaskDraftMap(input, availableWidth=1100) {
  const ledger=validateTaskDraftLedger(input), review=inspectTaskDraft(ledger);
  const active=ledger.tasks.filter(task=>!task.archived), ids=new Set(active.map(task=>task.id));
  const pending=new Map(active.map(task=>[task.id,task])), ranks=new Map();
  let changed=true;
  while(changed){changed=false;for(const [id,task] of pending){
    if(task.dependsOn.every(dep=>!ids.has(dep)||ranks.has(dep))){
      ranks.set(id,Math.max(-1,...task.dependsOn.filter(dep=>ids.has(dep)).map(dep=>ranks.get(dep)))+1);
      pending.delete(id);changed=true;
    }
  }}
  // Cycles and tasks behind cycles cannot be represented as a valid order.
  const blockedRank=Math.max(-1,...ranks.values())+1;
  for(const id of pending.keys())ranks.set(id,blockedRank);
  const width=Math.max(320,Number.isFinite(availableWidth)?availableWidth:1100);
  const columns=Math.max(1,Math.min(4,Math.floor((width-48)/340)));
  const cardWidth=Math.min(330,(width-48-40*(columns-1))/columns), cardHeight=184, rowGap=88;
  const rankGroups=new Map();for(const task of active){const rank=ranks.get(task.id);if(!rankGroups.has(rank))rankGroups.set(rank,[]);rankGroups.get(rank).push(task);}
  const findings=new Map(active.map(task=>[task.id,[]]));
  for(const finding of review.findings)for(const id of finding.taskIds)findings.get(id)?.push(finding);
  const nodes=[];let row=0;
  for(const [rank,tasks] of [...rankGroups].sort((a,b)=>a[0]-b[0])){
    for(let offset=0;offset<tasks.length;offset+=columns){const group=tasks.slice(offset,offset+columns), total=group.length*cardWidth+(group.length-1)*40;
      group.forEach((task,index)=>nodes.push({id:task.id,title:task.title,owner:task.owner,dependsOn:[...task.dependsOn],rank,blocked:pending.has(task.id),findings:findings.get(task.id),x:(width-total)/2+index*(cardWidth+40),y:112+row*(cardHeight+rowGap),width:cardWidth,height:cardHeight}));row++;
    }
  }
  const byId=new Map(nodes.map(node=>[node.id,node]));
  const edges=nodes.flatMap(node=>node.dependsOn.filter(id=>byId.has(id)).map(id=>({from:id,to:node.id,blocked:node.blocked||byId.get(id).blocked})));
  return {binding:ledger.binding,revision:ledger.revision,nodes,edges,width,height:Math.max(360,112+row*(cardHeight+rowGap)),archived:review.archivedTasks,reviewCount:review.findings.length,executionAuthorized:false};
}

export function taskDraftLink(urlLike,binding,taskId){
  if(!/^T\d{4,6}$/.test(taskId))throw new Error('Invalid draft task link.');
  const url=new URL(urlLike,'http://planner.local');
  url.hash=new URLSearchParams({draftProject:binding.projectId,draftRoot:binding.rootIdentity,draftCensus:binding.censusDigest,draftTask:taskId}).toString();
  return `${url.pathname}${url.search}${url.hash}`;
}

export function readTaskDraftLink(urlLike,binding){
  const url=new URL(urlLike,'http://planner.local'), hash=new URLSearchParams(url.hash.slice(1));
  const target={projectId:hash.get('draftProject'),rootIdentity:hash.get('draftRoot'),censusDigest:hash.get('draftCensus')};
  const id=hash.get('draftTask');
  return sameTaskDraftBinding(binding,target)&&/^T\d{4,6}$/.test(id??'')?id:null;
}

// Horizontal segments stay in row gaps; long vertical segments use a side gutter.
// This prevents wrapped rows from visually inventing a link through another card.
export function taskDraftConnectionPoints(model,from,to){
  const start={x:from?from.x+from.width/2:model.width/2,y:from?from.y+from.height:80};
  const end={x:to.x+to.width/2,y:to.y};
  const departure=start.y+14,arrival=end.y-14;
  if(end.y>=start.y&&end.y-start.y<=88)return [start,{x:start.x,y:departure},{x:end.x,y:departure},end];
  const gutter=(start.x+end.x)/2>model.width/2?model.width-12:12;
  return [start,{x:start.x,y:departure},{x:gutter,y:departure},{x:gutter,y:arrival},{x:end.x,y:arrival},end];
}
