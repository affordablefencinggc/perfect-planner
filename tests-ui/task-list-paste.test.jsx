import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
vi.mock('../src/project/taskFormRecovery.js',async importOriginal=>{const actual=await importOriginal(),{createMemoryTaskFormRecovery}=await import('./fixtures/memoryTaskFormRecovery.js');return {...actual,createTaskFormRecovery:()=>createMemoryTaskFormRecovery(actual.appendTaskFormHistory)};});
import {withMemoryTaskSaveIntents} from './fixtures/memoryTaskSaveIntents.js';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TaskDraftLedger } from '../src/components/TaskDraftLedger.jsx';
import { emptyTaskDraftLedger, updateTaskDraft, taskDraftBinding } from '../src/project/taskDraftLedger.js';
afterEach(cleanup);

const project=id=>({projectId:`pp_paste_${id}`,state:'observed',registration:{rootIdentity:'a'.repeat(64)},census:{digest:'b'.repeat(64)}});
function memoryStore(p){
 let ledger=emptyTaskDraftLedger(taskDraftBinding(p));const revisions=[];
 return withMemoryTaskSaveIntents({read:async()=>ledger,saveTask:vi.fn(async(_b,expected,input)=>{if(expected!==ledger.revision)throw new Error('Another window saved a newer revision.');ledger=updateTaskDraft(ledger,input);revisions.push(ledger);return ledger;}),history:async()=>revisions.map(r=>({revision:r.revision,taskCount:r.tasks.length})),readRevision:async(_b,r)=>revisions[r-1]});
}
const openPaste=()=>{const box=screen.getByLabelText('Task list');const details=box.closest('details');if(!details.open)fireEvent.click(details.querySelector('summary'));return box;};
const paste=value=>fireEvent.change(openPaste(),{target:{value}});
const ready=async()=>{await screen.findByText('No task drafts yet. Add the first task using the form.');await waitFor(()=>expect(screen.getByLabelText('Task title').matches(':disabled')).toBe(false));};

const threeTasks=`- Add login page
  owner: Sam
  write: src/login.jsx
  done when: A user can sign in
- Fix crash on start
  read: src/main.js
- Write setup guide
  description: Explain install steps`;

test('pasting three Markdown tasks previews them and adds three drafts through the durable Save path',async()=>{
 const p=project('three'),store=memoryStore(p);render(<TaskDraftLedger project={p} store={store}/>);await ready();
 paste(threeTasks);
 fireEvent.click(screen.getByRole('button',{name:'Preview'}));
 const preview=await screen.findByRole('region',{name:'Paste preview'});
 expect(within(preview).getByText(/Add login page/)).toBeTruthy();
 expect(within(preview).getByText(/Fix crash on start/)).toBeTruthy();
 expect(within(preview).getByText(/Write setup guide/)).toBeTruthy();
 expect((await store.read()).revision).toBe(0);
 fireEvent.click(screen.getByRole('button',{name:'Add 3 tasks'}));
 await screen.findByRole('button',{name:'Edit T0003'});
 const saved=await store.read();
 expect(saved.tasks.map(t=>t.title)).toEqual(['Add login page','Fix crash on start','Write setup guide']);
 expect(saved.tasks[0]).toMatchObject({owner:'Sam',acceptance:'A user can sign in',claims:[{path:'src/login.jsx',access:'write'}]});
 expect(saved.tasks[1].claims).toEqual([{path:'src/main.js',access:'read'}]);
 expect(saved.tasks[2].description).toBe('Explain install steps');
 // Same durable route as the manual form: one prepared, committed and acknowledged original per task.
 expect(store.prepareSaveIntent).toHaveBeenCalledTimes(3);
 expect(store.commitSaveIntent).toHaveBeenCalledTimes(3);
 expect((await store.listSaveIntents(taskDraftBinding(p))).every(r=>r.outcome.kind==='committed'&&r.acknowledgment!==null)).toBe(true);
 const report=screen.getByRole('region',{name:'Paste result'});
 expect(report.textContent).toMatch(/Added 3 of 3/);
 expect(screen.getByRole('status',{name:'Draft editing status'}).textContent).toContain('No work was approved or executed');
 await waitFor(()=>expect(screen.getByLabelText('Task title').matches(':disabled')).toBe(false));
});

test('preview shows unreadable lines and validator refusals; Add reports them and keeps the pasted text',async()=>{
 const p=project('mixed'),store=memoryStore(p);render(<TaskDraftLedger project={p} store={store}/>);await ready();
 const text=`Intro line\n- Good task\n  write: src/ok.js\n- Bad scope\n  write: ../outside.js\n- Two claims same file\n  write: src/a.js\n  read: src/a.js`;
 paste(text);
 fireEvent.click(screen.getByRole('button',{name:'Preview'}));
 const preview=await screen.findByRole('region',{name:'Paste preview'});
 expect(preview.textContent).toMatch(/Line 1/);
 expect(preview.textContent).toMatch(/before the first task/);
 expect(preview.textContent).toMatch(/Bad scope/);
 expect(preview.textContent).toMatch(/Claims must be relative paths/);
 expect(preview.textContent).toMatch(/claimed only once/);
 fireEvent.click(screen.getByRole('button',{name:'Add 1 task'}));
 await screen.findByRole('button',{name:'Edit T0001'});
 const report=screen.getByRole('region',{name:'Paste result'});
 expect(report.textContent).toMatch(/Added 1 of 3/);
 expect(report.textContent).toMatch(/T0001 · Good task/);
 expect(report.textContent).toMatch(/Bad scope.*Claims must be relative paths/);
 expect((await store.read()).tasks.map(t=>t.title)).toEqual(['Good task']);
 expect(screen.getByLabelText('Task list').value).toBe(text);
 expect(store.prepareSaveIntent).toHaveBeenCalledTimes(1);
});

test('a save refused by the store stops the batch, explains why and keeps the pasted text',async()=>{
 const p=project('race'),store=memoryStore(p);render(<TaskDraftLedger project={p} store={store}/>);await ready();
 paste(threeTasks);fireEvent.click(screen.getByRole('button',{name:'Preview'}));await screen.findByRole('region',{name:'Paste preview'});
 await store.saveTask(null,0,{id:null,title:'Other window',description:'',owner:'',acceptance:'',recovery:'',claims:[],dependsOn:[],archived:false});
 fireEvent.click(screen.getByRole('button',{name:'Add 3 tasks'}));
 const report=await screen.findByRole('region',{name:'Paste result'});
 await waitFor(()=>expect(report.textContent).toMatch(/Added 0 of 3/));
 expect(report.textContent).toMatch(/Add login page.*Another window saved a newer revision/);
 expect(report.textContent).toMatch(/Not tried/);
 expect(screen.getByLabelText('Task list').value).toBe(threeTasks);
 expect((await store.read()).tasks.map(t=>t.title)).toEqual(['Other window']);
 // No unreconciled Save is left blocking the editor.
 expect((await store.listSaveIntents(taskDraftBinding(p))).filter(r=>r.acknowledgment===null)).toEqual([]);
});

test('an unsaved form blocks Add with a reason next to the control and keeps both texts',async()=>{
 const p=project('dirty'),store=memoryStore(p);render(<TaskDraftLedger project={p} store={store}/>);await ready();
 fireEvent.change(screen.getByLabelText('Task title'),{target:{value:'Half typed'}});
 paste(threeTasks);fireEvent.click(screen.getByRole('button',{name:'Preview'}));await screen.findByRole('region',{name:'Paste preview'});
 expect(screen.getByRole('button',{name:'Add 3 tasks'}).disabled).toBe(true);
 expect(screen.getByText(/Save or discard the task you are typing in the form before adding pasted tasks/)).toBeTruthy();
 expect(screen.getByLabelText('Task list').value).toBe(threeTasks);
 expect(screen.getByLabelText('Task title').value).toBe('Half typed');
 expect(store.prepareSaveIntent).not.toHaveBeenCalled();
});

test('editing the pasted text clears an old preview so Add never uses stale text',async()=>{
 const p=project('stale'),store=memoryStore(p);render(<TaskDraftLedger project={p} store={store}/>);await ready();
 paste(threeTasks);fireEvent.click(screen.getByRole('button',{name:'Preview'}));await screen.findByRole('button',{name:'Add 3 tasks'});
 paste('- Only one');
 expect(screen.queryByRole('region',{name:'Paste preview'})).toBeNull();
 expect(screen.queryByRole('button',{name:/^Add \d+ tasks?$/})).toBeNull();
});
