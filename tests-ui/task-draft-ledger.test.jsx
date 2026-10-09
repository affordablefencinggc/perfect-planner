import React, { StrictMode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
vi.mock('../src/project/taskFormRecovery.js',async importOriginal=>{const actual=await importOriginal(),{createMemoryTaskFormRecovery}=await import('./fixtures/memoryTaskFormRecovery.js');return {...actual,createTaskFormRecovery:()=>createMemoryTaskFormRecovery(actual.appendTaskFormHistory)};});
import {withMemoryTaskSaveIntents} from './fixtures/memoryTaskSaveIntents.js';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TaskDraftLedger } from '../src/components/TaskDraftLedger.jsx';
import { emptyTaskDraftLedger, updateTaskDraft, taskDraftBinding, rebindTaskDraft, importTaskDraft } from '../src/project/taskDraftLedger.js';
afterEach(cleanup);
const project=id=>({projectId:`pp_draft_${id}`,state:'observed',registration:{rootIdentity:'a'.repeat(64)},census:{digest:'b'.repeat(64)}});
function memoryStore(p){
 let ledger=emptyTaskDraftLedger(taskDraftBinding(p));const revisions=[];
 return withMemoryTaskSaveIntents({read:async()=>ledger,importDraft:async(_b,expected,source)=>{if(expected!==ledger.revision)throw new Error('Another window saved a newer revision.');ledger=importTaskDraft(ledger,source).ledger;revisions.push(ledger);return ledger;},saveTask:async(_b,expected,input)=>{if(expected!==ledger.revision)throw new Error('Another window saved a newer revision.');ledger=updateTaskDraft(ledger,input);revisions.push(ledger);return ledger;},history:async()=>revisions.map(r=>({revision:r.revision,taskCount:r.tasks.length})),readRevision:async(_b,r)=>revisions[r-1]});
}
const fill=(name,value)=>fireEvent.change(screen.getByLabelText(name),{target:{value}});

const importTask={id:null,title:'Recovered task',description:'Retain full obligations',owner:'Owner',acceptance:'Compare retained bytes',recovery:'Keep originals',claims:[{path:'src',access:'write'}],dependsOn:[],archived:false};
const chooseImport=source=>{const input=screen.getByLabelText('Draft JSON file');if(!input.closest('details').open)fireEvent.click(input.closest('details').querySelector('summary'));fireEvent.change(input,{target:{files:[{size:100,text:async()=>JSON.stringify(source)}]}});};
test('import previews references and requires confirmation without replacing saved tasks',async()=>{
 const p=project('import_preview'),store=memoryStore(p);
 await store.saveTask(null,0,{...importTask,title:'Existing task'});
 const source=updateTaskDraft(emptyTaskDraftLedger(taskDraftBinding(p)),importTask);
 render(<TaskDraftLedger project={p} store={withMemoryTaskSaveIntents(store)}/>);await screen.findByRole('heading',{name:'Existing task'});
 chooseImport(source);await screen.findByText('T0001 → T0002 · Recovered task');
 expect((await store.read()).revision).toBe(1);expect(screen.getByRole('button',{name:'Import reviewed task copies'}).disabled).toBe(true);
 fireEvent.click(screen.getByLabelText('I reviewed the task copies and number mapping; keep them unapproved'));
 fireEvent.click(screen.getByRole('button',{name:'Import reviewed task copies'}));await screen.findByRole('button',{name:'Edit T0002'});
 expect((await store.read()).tasks.map(t=>t.title)).toEqual(['Existing task','Recovered task']);
 expect((await store.readRevision(null,1)).tasks.length).toBe(1);
 expect(screen.getByRole('status',{name:'Draft editing status'}).textContent).toContain('No work was approved or executed');
});
test('import refuses another inventory and a concurrent save, keeping existing tasks',async()=>{
 const p=project('import_race'),store=memoryStore(p);render(<TaskDraftLedger project={p} store={withMemoryTaskSaveIntents(store)}/>);
 await screen.findByText('No task drafts yet. Add the first task using the form.');
 const source=updateTaskDraft(emptyTaskDraftLedger(taskDraftBinding(p)),importTask);
 chooseImport({...source,binding:{...source.binding,censusDigest:'c'.repeat(64)}});
 await screen.findByText('The import belongs to another project, folder root or inventory. Nothing was imported.');
 expect((await store.read()).revision).toBe(0);chooseImport(source);await screen.findByText('T0001 → T0001 · Recovered task');
 await store.saveTask(null,0,{...importTask,title:'Other window work'});
 fireEvent.click(screen.getByLabelText('I reviewed the task copies and number mapping; keep them unapproved'));
 fireEvent.click(screen.getByRole('button',{name:'Import reviewed task copies'}));await screen.findByText('Another window saved a newer revision.');
 expect(screen.queryByRole('button',{name:'Import reviewed task copies'})).toBeNull();expect((await store.read()).tasks.map(t=>t.title)).toEqual(['Other window work']);
});
test('unsaved text prevents import and oversize files are rejected before reading',async()=>{
 const p=project('import_bounds'),store=memoryStore(p);render(<TaskDraftLedger project={p} store={withMemoryTaskSaveIntents(store)}/>);
 await screen.findByText('No task drafts yet. Add the first task using the form.');fill('Task title','Keep unsaved text');
 expect(screen.getByLabelText('Draft JSON file').disabled).toBe(true);expect(screen.getByLabelText('Task title').value).toBe('Keep unsaved text');
 fireEvent.click(screen.getByRole('button',{name:'Discard unsaved edits'}));await waitFor(()=>expect(screen.getByLabelText('Draft JSON file').disabled).toBe(false));let read=false;
 fireEvent.change(screen.getByLabelText('Draft JSON file'),{target:{files:[{size:8*1024*1024+1,text:async()=>{read=true;return '{}';}}]}});
 await screen.findByText('Choose a draft JSON file no larger than 8 MiB.');expect(read).toBe(false);expect((await store.read()).revision).toBe(0);
});
test('add, edit, archive and inspect previous revision without implying approval',async()=>{
 const p=project('edit'),store=memoryStore(p);render(<StrictMode><TaskDraftLedger project={p} store={withMemoryTaskSaveIntents(store)}/></StrictMode>);
 await screen.findByText('No task drafts yet. Add the first task using the form.');
 fill('Task title','Preserve work');fill('Full description','Keep the changed files safe.');
 fireEvent.click(screen.getByRole('button',{name:'Save task draft'}));
 await screen.findByRole('button',{name:'Edit T0001'});
 await waitFor(()=>expect(screen.getByRole('status',{name:'Draft editing status'}).textContent).toContain('No work was approved or executed'));
 fireEvent.click(screen.getByRole('button',{name:'Edit T0001'}));fill('Task title','Preserve all work');
 fireEvent.click(screen.getByLabelText('Archive task (keep history)'));fireEvent.click(screen.getByRole('button',{name:'Save task draft'}));
 await waitFor(()=>expect(screen.queryByRole('button',{name:'Edit T0001'})).toBeNull());
 fireEvent.click(screen.getByLabelText('Show archived tasks'));await screen.findByRole('heading',{name:'Preserve all work'});
 fireEvent.click(screen.getByRole('button',{name:'Revision history'}));fireEvent.click(await screen.findByRole('button',{name:'Revision 1 · 1 task'}));
 await screen.findByRole('heading',{name:'Read-only revision 1'});
 expect(screen.getByRole('region',{name:'Historical draft'}).querySelector('pre').tabIndex).toBe(0);
 expect((await store.read()).revision).toBe(2);
});
test('stale pre-preparation check keeps form and requires explicit reviewed reapplication',async()=>{
 const p=project('race'),store=memoryStore(p);render(<TaskDraftLedger project={p} store={withMemoryTaskSaveIntents(store)}/>);
 await screen.findByText('No task drafts yet. Add the first task using the form.');fill('Task title','My pending task');
 await store.saveTask(null,0,{id:null,title:'Other window',description:'',owner:'',acceptance:'',recovery:'',claims:[],dependsOn:[],archived:false});
 // Exercise a failure before an original request is prepared. Once an original
 // exists, durable-save tests require its explicit withdrawal, not this legacy
 // operation-only review path.
 store.listSaveIntents.mockRejectedValueOnce(new Error('Another window saved a newer revision.'));
 fireEvent.click(screen.getByRole('button',{name:'Save task draft'}));expect((await screen.findByText(/^Another window saved a newer revision\./)).getAttribute('role')).toBe('alert');
 expect(store.prepareSaveIntent).not.toHaveBeenCalled();
 expect(screen.getByLabelText('Task title').value).toBe('My pending task');
 const review=await screen.findByRole('button',{name:'Review editor operation outcome'});await waitFor(()=>expect(review.matches(':disabled')).toBe(false));fireEvent.click(review);await screen.findByText(/Operation reviewed/);
 fireEvent.click(screen.getByRole('button',{name:'Refresh draft'}));await screen.findByRole('heading',{name:'Other window'});
 fireEvent.click(screen.getByRole('button',{name:'I reviewed the latest revision — reapply my form'}));
 await screen.findByText('Your form is now based on the displayed revision. Review it, then save explicitly.');
 await waitFor(()=>expect(screen.getByRole('button',{name:'Save task draft'}).matches(':disabled')).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Save task draft'}));await screen.findByRole('button',{name:'Edit T0002'});
 expect((await store.read()).tasks.map(t=>t.title)).toEqual(['Other window','My pending task']);
});
test('unsaved forms survive project switches but are not rebound to a new census',async()=>{
 const p=project('switch'),store=memoryStore(p),other=project('other'),otherStore=memoryStore(other);
 const view=render(<TaskDraftLedger project={p} store={withMemoryTaskSaveIntents(store)}/>);await screen.findByText('No task drafts yet. Add the first task using the form.');fill('Task title','Unfinished');
 view.rerender(<TaskDraftLedger project={other} store={otherStore}/>);await waitFor(()=>expect(screen.getByLabelText('Task title').value).toBe(''));
 view.rerender(<TaskDraftLedger project={{...p,census:{digest:'c'.repeat(64)}}} store={withMemoryTaskSaveIntents(store)}/>);await waitFor(()=>expect(screen.getByLabelText('Task title').value).toBe(''));
 view.rerender(<TaskDraftLedger project={p} store={withMemoryTaskSaveIntents(store)}/>);await waitFor(()=>expect(screen.getByLabelText('Task title').value).toBe('Unfinished'));
 fireEvent.click(screen.getByRole('button',{name:'Discard unsaved edits'}));
});

test('changed inventory requires each saved task review and retains old tasks on explicit continuation',async()=>{
 const p=project('rebind'),old=taskDraftBinding(p),currentProject={...p,census:{digest:'c'.repeat(64)}};
 let saved=updateTaskDraft(emptyTaskDraftLedger(old),{id:null,title:'Review current paths',description:'Compare with the new inventory.',owner:'Owner',acceptance:'Recorded result',recovery:'Keep originals',claims:[],dependsOn:[],archived:false});
 const previous=saved;let calls=0;
 const store=withMemoryTaskSaveIntents({read:async()=>saved,rebind:async(binding,review)=>{calls++;saved=rebindTaskDraft(saved,binding,review);return saved;}});
 render(<TaskDraftLedger project={currentProject} store={withMemoryTaskSaveIntents(store)}/>);
 await screen.findByRole('region',{name:'Review changed folder inventory'});
 const proceed=screen.getByRole('button',{name:'Continue drafts with current inventory'});
 expect(proceed.disabled).toBe(true);expect(screen.getByRole('button',{name:'Edit T0001'}).disabled).toBe(true);
 fireEvent.click(screen.getByText('T0001 · Review current paths'));
 fireEvent.click(screen.getByLabelText('I reviewed T0001 for continued draft planning'));expect(proceed.disabled).toBe(true);
 fireEvent.click(screen.getByLabelText('Keep these tasks as unapproved drafts for the current inventory'));
 fireEvent.click(proceed);await waitFor(()=>expect(screen.getByRole('button',{name:'Edit T0001'}).disabled).toBe(false));
 expect(calls).toBe(1);expect(saved.revision).toBe(2);expect(saved.tasks).toEqual(previous.tasks);
 expect(previous.binding.censusDigest).toBe(old.censusDigest);expect(screen.getByRole('status',{name:'Draft editing status'}).textContent).toContain('No work was approved or executed');
});

test('concurrent review failure clears acknowledgments and never enables stale draft editing',async()=>{
 const p=project('rebind_race'),old=taskDraftBinding(p);
 const saved=emptyTaskDraftLedger(old),store={read:async()=>saved,rebind:async()=>{throw new Error('The saved draft changed during review. Refresh and review the current revision again.');}};
 render(<TaskDraftLedger project={{...p,census:{digest:'c'.repeat(64)}}} store={withMemoryTaskSaveIntents(store)}/>);
 await screen.findByRole('region',{name:'Review changed folder inventory'});
 fireEvent.click(screen.getByLabelText('Keep these tasks as unapproved drafts for the current inventory'));
 fireEvent.click(screen.getByRole('button',{name:'Continue drafts with current inventory'}));
 await screen.findByText('The saved draft changed during review. Refresh and review the current revision again.');
 expect(screen.getByRole('button',{name:'Continue drafts with current inventory'}).disabled).toBe(true);
 expect(screen.getByLabelText('Keep these tasks as unapproved drafts for the current inventory').checked).toBe(false);
 expect(screen.getByRole('button',{name:'Save task draft'}).matches(':disabled')).toBe(true);
});
test('a refused file scope keeps the form editable with every value and shows the error beside File scope',async()=>{
 const p=project('refused_scope'),store=memoryStore(p);render(<TaskDraftLedger project={p} store={withMemoryTaskSaveIntents(store)}/>);
 await screen.findByText('No task drafts yet. Add the first task using the form.');
 fill('Task title','Area claim');fill('Full description','Touch the core area.');fill('Proposed owner','Agent: core');
 const scope=screen.getByLabelText(/^File scope/);fireEvent.change(scope,{target:{value:'write ../x'}});
 fireEvent.click(screen.getByRole('button',{name:'Save task draft'}));
 const inline=await screen.findByTestId('task-draft-claims-error');
 expect(inline.textContent).toMatch(/relative paths/);
 expect(screen.getAllByRole('alert').some(node=>/relative paths/.test(node.textContent))).toBe(true);
 expect(scope.getAttribute('aria-invalid')).toBe('true');expect(scope.getAttribute('aria-describedby')).toBe(inline.id);
 expect(scope.closest('fieldset').disabled).toBe(false);
 expect(screen.queryByText('Editor operation finished or was interrupted. Review its retained outcome before continuing.')).toBeNull();
 expect(screen.getByLabelText('Task title').value).toBe('Area claim');expect(screen.getByLabelText('Full description').value).toBe('Touch the core area.');
 expect(screen.getByLabelText('Proposed owner').value).toBe('Agent: core');expect(scope.value).toBe('write ../x');
 expect((await store.read()).revision).toBe(0);
 fireEvent.change(scope,{target:{value:'write src/core/**\nread tests/core-*.test.mjs'}});
 expect(screen.queryByTestId('task-draft-claims-error')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Save task draft'}));
 await screen.findByRole('button',{name:'Edit T0001'});
 expect((await store.read()).tasks[0].claims).toEqual([{path:'src/core/**',access:'write'},{path:'tests/core-*.test.mjs',access:'read'}]);
});
test('a file scope line without read or write is refused inline without locking the form',async()=>{
 const p=project('refused_access'),store=memoryStore(p);render(<TaskDraftLedger project={p} store={withMemoryTaskSaveIntents(store)}/>);
 await screen.findByText('No task drafts yet. Add the first task using the form.');
 fill('Task title','Bad line');const scope=screen.getByLabelText(/^File scope/);fireEvent.change(scope,{target:{value:'src/app.js'}});
 fireEvent.click(screen.getByRole('button',{name:'Save task draft'}));
 expect((await screen.findByTestId('task-draft-claims-error')).textContent).toMatch(/read or write/);
 expect(scope.closest('fieldset').disabled).toBe(false);expect(scope.value).toBe('src/app.js');expect(screen.getByLabelText('Task title').value).toBe('Bad line');
});
