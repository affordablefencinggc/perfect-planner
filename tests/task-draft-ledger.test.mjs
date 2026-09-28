import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyTaskDraftLedger, updateTaskDraft, inspectTaskDraft, validateDraftTask, validateTaskDraftLedger, sameTaskDraftBinding, rebindTaskDraft, importTaskDraft, parseTaskDraftImport } from '../src/project/taskDraftLedger.js';
const binding={projectId:'pp_draft_test',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)};
const task=(extra={})=>({id:null,title:'Preserve local work',description:'Retain every changed file before integration.',owner:'Planner owner',acceptance:'Compare the retained bytes against the source.',recovery:'Keep both candidates when verification fails.',claims:[{path:'src/app.js',access:'write'}],dependsOn:[],archived:false,...extra});
test('draft revisions preserve prior records and never confer execution authority',()=>{
 const first=updateTaskDraft(emptyTaskDraftLedger(binding),task());
 const second=updateTaskDraft(first,task({id:'T0001',title:'Review local work'}));
 assert.equal(first.tasks[0].title,'Preserve local work');assert.equal(second.revision,2);
 assert.equal(second.tasks[0].id,'T0001');assert.ok(Object.isFrozen(second.tasks[0]));
 assert.equal(inspectTaskDraft(second).executionAuthorized,false);
});
test('overlapping writes include ancestors and Windows case, not unrelated prefixes',()=>{
 let ledger=updateTaskDraft(emptyTaskDraftLedger(binding),task({claims:[{path:'src',access:'write'}]}));
 ledger=updateTaskDraft(ledger,task({claims:[{path:'SRC/app.js',access:'read'}]}));
 ledger=updateTaskDraft(ledger,task({claims:[{path:'src-other/app.js',access:'write'}]}));
 assert.deepEqual(inspectTaskDraft(ledger).findings.filter(f=>f.kind==='file-overlap').map(f=>f.taskIds),[['T0001','T0002']]);
});
test('read/read scopes do not conflict, and declared order alone does not clear writes',()=>{
 let ledger=updateTaskDraft(emptyTaskDraftLedger(binding),task({claims:[{path:'src',access:'read'}]}));
 ledger=updateTaskDraft(ledger,task({claims:[{path:'src/app.js',access:'read'}],dependsOn:['T0001']}));
 assert.equal(inspectTaskDraft(ledger).findings.length,0);
 ledger=updateTaskDraft(ledger,task({id:'T0001',claims:[{path:'src',access:'write'}]}));
 assert.equal(inspectTaskDraft(ledger).findings[0].kind,'file-overlap');
});
test('cycles and archived dependencies remain explicit review findings',()=>{
 let ledger=updateTaskDraft(emptyTaskDraftLedger(binding),task());
 ledger=updateTaskDraft(ledger,task({dependsOn:['T0001']}));
 ledger=updateTaskDraft(ledger,task({id:'T0001',dependsOn:['T0002']}));
 assert.ok(inspectTaskDraft(ledger).findings.some(f=>f.kind==='dependency-cycle'));
 ledger=updateTaskDraft(ledger,task({id:'T0001',archived:true}));
 const review=inspectTaskDraft(ledger);assert.equal(review.archivedTasks,1);assert.ok(review.findings.some(f=>f.kind==='archived-dependency'));
 assert.equal(ledger.tasks.length,2);
});
test('task IDs are canonical and unknown references or authority fields are rejected',()=>{
 for(const id of ['T0000','T00001','T01','T1000000'])assert.throws(()=>validateDraftTask(task({id})),/identity/);
 assert.throws(()=>updateTaskDraft(emptyTaskDraftLedger(binding),task({dependsOn:['T0002']})),/outside/);
 assert.throws(()=>updateTaskDraft(emptyTaskDraftLedger(binding),task({approved:true})),/shape/);
});
test('file scopes reject traversal, drive paths, wildcard and duplicate paths',()=>{
 for(const path of ['../secret','/root','C:/root','src//app','src\\app','src/*'])assert.throws(()=>validateDraftTask(task({id:'T0001',claims:[{path,access:'write'}]})),/relative paths/);
 assert.throws(()=>validateDraftTask(task({id:'T0001',claims:[{path:'src',access:'read'},{path:'SRC',access:'write'}]})),/once/);
});
test('missing details remain visible and malformed saved data is not accepted',()=>{
 const ledger=updateTaskDraft(emptyTaskDraftLedger(binding),task({description:'',owner:'',acceptance:'',recovery:'',claims:[]}));
 assert.equal(inspectTaskDraft(ledger).findings.length,5);
 assert.throws(()=>validateTaskDraftLedger({...ledger,tasks:[...ledger.tasks,...ledger.tasks]}),/identities/);
 assert.throws(()=>validateTaskDraftLedger({...ledger,revision:5001}),/revision/);
 assert.equal(sameTaskDraftBinding(binding,{...binding,censusDigest:'c'.repeat(64)}),false);
});

test('reviewed inventory changes keep all tasks and old binding without granting authority',()=>{
 let ledger=updateTaskDraft(emptyTaskDraftLedger(binding),task());
 ledger=updateTaskDraft(ledger,task({archived:true,dependsOn:['T0001']}));
 const target={...binding,censusDigest:'c'.repeat(64)};
 const next=rebindTaskDraft(ledger,target,{fromBinding:binding,expectedRevision:2,reviewedTaskIds:['T0001','T0002']});
 assert.deepEqual(next.tasks,ledger.tasks);assert.equal(next.nextTaskNumber,ledger.nextTaskNumber);
 assert.equal(next.revision,3);assert.equal(next.binding.censusDigest,target.censusDigest);
 assert.equal(ledger.binding.censusDigest,binding.censusDigest);assert.equal(ledger.revision,2);
 assert.equal(next.kind,'LOCAL_DRAFT');assert.equal(inspectTaskDraft(next).executionAuthorized,false);
});

test('import into an empty store preserves task references but starts its own local revision',()=>{
 let source=updateTaskDraft(emptyTaskDraftLedger(binding),task());
 source=updateTaskDraft(source,task({dependsOn:['T0001'],archived:true}));
 const result=importTaskDraft(emptyTaskDraftLedger(binding),parseTaskDraftImport(JSON.stringify(source,null,2)));
 assert.deepEqual(result.ledger.tasks,source.tasks);assert.equal(result.ledger.revision,1);assert.equal(result.sourceRevision,2);
 assert.equal(result.ledger.nextTaskNumber,3);assert.equal(inspectTaskDraft(result.ledger).executionAuthorized,false);
});

test('import appends copies and remaps only incoming references without replacing existing work',()=>{
 const current=updateTaskDraft(emptyTaskDraftLedger(binding),task({title:'Existing work'}));
 let source=updateTaskDraft(emptyTaskDraftLedger(binding),task({title:'Imported first'}));
 source=updateTaskDraft(source,task({title:'Imported second',dependsOn:['T0001'],archived:true}));
 const result=importTaskDraft(current,source);
 assert.deepEqual(result.references,[{sourceId:'T0001',taskId:'T0002'},{sourceId:'T0002',taskId:'T0003'}]);
 assert.deepEqual(result.ledger.tasks[0],current.tasks[0]);assert.deepEqual(result.ledger.tasks[2].dependsOn,['T0002']);
 assert.equal(result.ledger.tasks[2].archived,true);assert.equal(current.tasks.length,1);assert.equal(source.tasks[1].id,'T0002');
 assert.ok(inspectTaskDraft(result.ledger).findings.some(f=>f.kind==='file-overlap'));
});

test('import refuses wrong bindings, malformed/oversized content, authority fields and exhausted revisions',()=>{
 const empty=emptyTaskDraftLedger(binding),source=updateTaskDraft(empty,task());
 for(const field of ['projectId','rootIdentity','censusDigest'])assert.throws(()=>importTaskDraft(empty,{...source,binding:{...binding,[field]:field==='projectId'?'pp_another_project':'d'.repeat(64)}}),/another project/);
 assert.throws(()=>parseTaskDraftImport('{secret invalid JSON'),/not valid draft JSON/);
 assert.throws(()=>parseTaskDraftImport(' '.repeat(8*1024*1024+1)),/8 MiB/);
 assert.throws(()=>parseTaskDraftImport(JSON.stringify({...source,approved:true})),/shape/);
 assert.throws(()=>importTaskDraft(empty,empty),/no tasks/);
 assert.throws(()=>importTaskDraft({...source,revision:5000},source),/revision/);
 const full={...source,nextTaskNumber:501,tasks:Array.from({length:500},(_,i)=>({...source.tasks[0],id:`T${String(i+1).padStart(4,'0')}`}))};
 assert.throws(()=>importTaskDraft(full,source),/500-task/);
});

test('large valid pretty-printed app exports round-trip through the bounded import parser',()=>{
 const tasks=Array.from({length:480},(_,index)=>({id:`T${String(index+1).padStart(4,'0')}`,title:'x',description:'',owner:'',acceptance:'',recovery:'',dependsOn:[],archived:false,claims:Array.from({length:64},(_,i)=>({path:`f${String(i).padStart(2,'0')}`,access:'read'}))}));
 const source=validateTaskDraftLedger({...emptyTaskDraftLedger(binding),revision:1,nextTaskNumber:481,tasks});
 const pretty=JSON.stringify(source,null,2);assert.ok(new TextEncoder().encode(pretty).length>2*1024*1024);
 assert.deepEqual(parseTaskDraftImport(pretty),source);
});

test('inventory review refuses other roots, projects, stale review, missing tasks and authority fields',()=>{
 const ledger=updateTaskDraft(emptyTaskDraftLedger(binding),task()),target={...binding,censusDigest:'c'.repeat(64)};
 const review={fromBinding:binding,expectedRevision:1,reviewedTaskIds:['T0001']};
 for(const other of [{...target,projectId:'pp_other_project'},{...target,rootIdentity:'d'.repeat(64)}])assert.throws(()=>rebindTaskDraft(ledger,other,review),/another project or folder root/);
 for(const change of [{expectedRevision:0},{fromBinding:target}])assert.throws(()=>rebindTaskDraft(ledger,target,{...review,...change}),/changed during review/);
 for(const reviewedTaskIds of [[],['T0001','T0001'],['T0002'],null])assert.throws(()=>rebindTaskDraft(ledger,target,{...review,reviewedTaskIds}),/every saved task/);
 assert.throws(()=>rebindTaskDraft(ledger,binding,review),/already uses/);
 assert.throws(()=>rebindTaskDraft(ledger,target,{...review,approved:true}),/shape/);
 assert.throws(()=>rebindTaskDraft({...ledger,revision:5000},target,{...review,expectedRevision:5000}),/revision/);
});
