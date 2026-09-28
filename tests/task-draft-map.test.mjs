import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyTaskDraftLedger, updateTaskDraft } from '../src/project/taskDraftLedger.js';
import { projectTaskDraftMap, taskDraftLink, readTaskDraftLink, taskDraftConnectionPoints } from '../src/project/taskDraftMap.js';
const binding={projectId:'pp_map_test',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)};
const task=(extra={})=>({id:null,title:'Task',description:'Full obligation',owner:'Owner',acceptance:'Verify outcome',recovery:'Preserve original',claims:[],dependsOn:[],archived:false,...extra});
test('projection retains exact IDs, saved titles and dependencies without execution authority',()=>{
 let ledger=updateTaskDraft(emptyTaskDraftLedger(binding),task({title:'Preserve work'}));
 ledger=updateTaskDraft(ledger,task({title:'Review candidate',dependsOn:['T0001']}));
 ledger=updateTaskDraft(ledger,task({title:'Check candidate',dependsOn:['T0001']}));
 ledger=updateTaskDraft(ledger,task({title:'Review both checks',dependsOn:['T0002','T0003']}));
 const map=projectTaskDraftMap(ledger);assert.equal(map.revision,4);assert.equal(map.executionAuthorized,false);
 assert.deepEqual(map.nodes.map(n=>n.id),ledger.tasks.map(t=>t.id));assert.deepEqual(map.nodes.map(n=>n.rank),[0,1,1,2]);
 assert.deepEqual(map.edges.map(e=>[e.from,e.to]),[['T0001','T0002'],['T0001','T0003'],['T0002','T0004'],['T0003','T0004']]);
 assert.deepEqual(projectTaskDraftMap(ledger),map);assert.equal(map.nodes[0].title,'Preserve work');
});
test('all cards stay inside the canvas and do not overlap across widths',()=>{
 let ledger=emptyTaskDraftLedger(binding);for(let i=0;i<45;i++)ledger=updateTaskDraft(ledger,task());
 for(const width of [280,320,640,1100,3440]){const map=projectTaskDraftMap(ledger,width);assert.equal(map.nodes.length,45);
  for(const node of map.nodes){assert.ok(node.x>=0&&node.x+node.width<=map.width);assert.ok(node.y+node.height<=map.height);}
  for(let i=0;i<map.nodes.length;i++)for(let j=i+1;j<map.nodes.length;j++){const a=map.nodes[i],b=map.nodes[j];assert.ok(a.x+a.width<=b.x||b.x+b.width<=a.x||a.y+a.height<=b.y||b.y+b.height<=a.y);}
 }
});
test('cyclic order is flagged, archived tasks are counted rather than treated as completed',()=>{
 let ledger=updateTaskDraft(emptyTaskDraftLedger(binding),task());ledger=updateTaskDraft(ledger,task({dependsOn:['T0001']}));
 ledger=updateTaskDraft(ledger,task({id:'T0001',dependsOn:['T0002']}));ledger=updateTaskDraft(ledger,task({archived:true}));
 const map=projectTaskDraftMap(ledger);assert.equal(map.archived,1);assert.equal(map.nodes.length,2);assert.ok(map.nodes.every(n=>n.blocked));assert.ok(map.edges.every(e=>e.blocked));
});
test('empty drafts have no invented task nodes and links cannot target another project or census',()=>{
 assert.equal(projectTaskDraftMap(emptyTaskDraftLedger(binding)).nodes.length,0);
 const link=taskDraftLink('/?workspace=ledger&project=pp_map_test',binding,'T0001');assert.equal(readTaskDraftLink(link,binding),'T0001');
 assert.equal(readTaskDraftLink(link,{...binding,projectId:'pp_another_project'}),null);
 assert.equal(readTaskDraftLink(link,{...binding,censusDigest:'c'.repeat(64)}),null);
});
test('wrapped roots and distant dependencies route around unrelated card interiors',()=>{
 let ledger=emptyTaskDraftLedger(binding);for(let i=0;i<8;i++)ledger=updateTaskDraft(ledger,task());
 ledger=updateTaskDraft(ledger,task({dependsOn:['T0001','T0008']}));
 for(const width of [320,640,1100,3440]){const model=projectTaskDraftMap(ledger,width);
  const connections=[...model.nodes.filter(n=>!n.dependsOn.length).map(to=>({from:null,to})),...model.edges.map(e=>({from:model.nodes.find(n=>n.id===e.from),to:model.nodes.find(n=>n.id===e.to)}))];
  for(const {from,to} of connections){const points=taskDraftConnectionPoints(model,from,to);
   for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i];
    for(const node of model.nodes.filter(n=>n!==from&&n!==to)){
     const crosses=a.x===b.x?a.x>node.x&&a.x<node.x+node.width&&Math.max(a.y,b.y)>node.y&&Math.min(a.y,b.y)<node.y+node.height:a.y>node.y&&a.y<node.y+node.height&&Math.max(a.x,b.x)>node.x&&Math.min(a.x,b.x)<node.x+node.width;
     assert.equal(crosses,false,`Connector to ${to.id} crosses ${node.id}`);
    }
   }
  }
 }
});
