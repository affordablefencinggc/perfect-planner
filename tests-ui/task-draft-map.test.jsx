import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
vi.mock('../src/project/taskFormRecovery.js',async importOriginal=>{const actual=await importOriginal(),{createMemoryTaskFormRecovery}=await import('./fixtures/memoryTaskFormRecovery.js');return {...actual,createTaskFormRecovery:()=>createMemoryTaskFormRecovery(actual.appendTaskFormHistory)};});
import {withMemoryTaskSaveIntents} from './fixtures/memoryTaskSaveIntents.js';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { TaskDraftMap } from '../src/components/TaskDraftMap.jsx';
import { TaskDraftLedger } from '../src/components/TaskDraftLedger.jsx';
import { emptyTaskDraftLedger, updateTaskDraft, taskDraftBinding } from '../src/project/taskDraftLedger.js';
import { taskDraftLink } from '../src/project/taskDraftMap.js';
const project={projectId:'pp_draft_map_ui',name:'My imported app',state:'observed',registration:{rootIdentity:'a'.repeat(64)},census:{digest:'b'.repeat(64)}};
const binding=taskDraftBinding(project);
const task={id:null,title:'Keep local changes',description:'Preserve every changed file before the merge.',owner:'Local owner',acceptance:'Compare exact files',recovery:'Retain both copies',claims:[],dependsOn:[],archived:false};
afterEach(()=>{cleanup();window.history.replaceState(null,'','/');});
test('map opens the exact Ledger record using a project and census bound link',async()=>{
 const ledger=updateTaskDraft(emptyTaskDraftLedger(binding),task),store={read:async()=>ledger};const navigate=vi.fn();
 const view=render(<TaskDraftMap project={project} store={withMemoryTaskSaveIntents(store)} onWorkspace={navigate}/>);
 const explanation=screen.getByText('How to read this map').closest('details');expect(explanation.open).toBe(false);
 expect(screen.getByRole('status').textContent).toContain('Reading the saved draft');
 fireEvent.click(await screen.findByRole('button',{name:'Open T0001: Keep local changes in Ledger'}));expect(navigate).toHaveBeenCalledWith('ledger');
 view.unmount();render(<TaskDraftLedger project={project} store={withMemoryTaskSaveIntents(store)}/>);
 await screen.findByRole('button',{name:'Edit T0001'});await waitFor(()=>expect(document.activeElement.id).toBe('draft-task-T0001'));
 expect(document.querySelector('#draft-task-T0001 details').open).toBe(true);expect(screen.getByText(task.description)).toBeTruthy();
});
test('save notification reloads the saved projection and failed refresh does not label old data current',async()=>{
 let ledger=emptyTaskDraftLedger(binding),notify;const store={read:vi.fn(async()=>ledger),subscribe:(_b,fn)=>{notify=fn;return()=>{notify=null;}}};
 render(<TaskDraftMap project={project} store={withMemoryTaskSaveIntents(store)}/>);await screen.findByText('No active task drafts yet.');
 ledger=updateTaskDraft(ledger,task);await act(async()=>notify());await screen.findByRole('button',{name:'Open T0001: Keep local changes in Ledger'});
 store.read.mockRejectedValueOnce(new Error('Storage unavailable'));fireEvent.click(screen.getByRole('button',{name:'Refresh map'}));
 await screen.findByRole('alert');expect(screen.getByRole('status').textContent).toContain('last loaded revision');
 expect(screen.getByRole('button',{name:'Open T0001: Keep local changes in Ledger'})).toBeTruthy();
});
test('wrong-census task links cannot select a task and saved forms are not replaced by navigation',async()=>{
 const ledger=updateTaskDraft(emptyTaskDraftLedger(binding),task),store={read:async()=>ledger};
 window.history.replaceState(null,'',taskDraftLink('/',{...binding,censusDigest:'c'.repeat(64)},'T0001'));
 render(<TaskDraftLedger project={project} store={withMemoryTaskSaveIntents(store)}/>);await screen.findByRole('button',{name:'Edit T0001'});expect(document.querySelector('[data-linked=true]')).toBeNull();
 fireEvent.change(screen.getByLabelText('Task title'),{target:{value:'Unsaved obligation'}});
 window.history.replaceState(null,'',taskDraftLink('/',binding,'T0001'));fireEvent(window,new Event('hashchange'));
 await waitFor(()=>expect(document.activeElement.id).toBe('draft-task-T0001'));expect(screen.getByLabelText('Task title').value).toBe('Unsaved obligation');
 fireEvent.click(screen.getByRole('button',{name:'Discard unsaved edits'}));
});
test('an earlier census form remains readable and exportable without rebinding it',async()=>{
 const ledger=emptyTaskDraftLedger(binding),store={read:async()=>ledger};
 const view=render(<TaskDraftLedger project={project} store={withMemoryTaskSaveIntents(store)}/>);await screen.findByText('No task drafts yet. Add the first task using the form.');
 fireEvent.change(screen.getByLabelText('Task title'),{target:{value:'Keep this earlier obligation'}});
 view.rerender(<TaskDraftLedger project={{...project,census:{digest:'c'.repeat(64)}}} store={withMemoryTaskSaveIntents(store)}/>);
 const recovery=await screen.findByRole('region',{name:'Recover earlier unsaved forms'});
 expect(recovery.textContent).toContain('Keep this earlier obligation');expect(recovery.textContent).toContain('not been rebound or discarded');
 expect(screen.getByLabelText('Task title').value).toBe('');expect(screen.getByRole('button',{name:'Export this unsaved form',hidden:true})).toBeTruthy();
 view.rerender(<TaskDraftLedger project={project} store={withMemoryTaskSaveIntents(store)}/>);await waitFor(()=>expect(screen.getByLabelText('Task title').value).toBe('Keep this earlier obligation'));
 fireEvent.click(screen.getByRole('button',{name:'Discard unsaved edits'}));
});
// Regression (screen tour, 9 Oct 2026): after approving on the Plan page the map still
// said every task was "Draft" and "Planning approval could not be checked" under an
// Approved banner, because it only read the native planning check.
test('map shows tasks approved on the Plan page as approved, and says when they changed',async()=>{
 const {recordPlanApproval}=await import('../src/project/planApproval.js');
 const {readSection}=await import('../src/project/projectWorkRecords.js');
 localStorage.clear();
 const ledger=updateTaskDraft(emptyTaskDraftLedger(binding),task),store={read:async()=>ledger};
 await recordPlanApproval(project.projectId,{tasks:ledger.tasks,censusDigest:project.census.digest});
 const records={sections:{planAuthority:readSection(project.projectId,'planAuthority')}};
 const context={planStatuses:{[project.projectId]:{state:'unavailable'}}};
 const {ProjectContext}=await import('../src/project/ProjectProvider.jsx');
 const view=render(<ProjectContext.Provider value={context}><TaskDraftMap project={project} records={records} store={withMemoryTaskSaveIntents(store)}/></ProjectContext.Provider>);
 const node=await screen.findByRole('button',{name:'Open T0001: Keep local changes in Ledger'});
 await waitFor(()=>expect(node.textContent).toContain('Approved'));
 expect(node.textContent).not.toContain('Draft');
 const approval=screen.getByLabelText('Map planning approval').textContent;
 expect(approval).toContain('Plan approved: 1 task approved on this device');
 expect(approval).not.toContain('could not be checked');
 expect(screen.getByRole('status').textContent).toContain('plan approved on this device');
 view.unmount();
 const edited=updateTaskDraft(ledger,{...ledger.tasks[0],title:'Keep local changes and notes'});
 render(<ProjectContext.Provider value={context}><TaskDraftMap project={project} records={records} store={withMemoryTaskSaveIntents({read:async()=>edited})}/></ProjectContext.Provider>);
 await waitFor(()=>expect(screen.getByLabelText('Map planning approval').textContent).toContain('Tasks changed since the plan was approved'));
 expect(screen.getByRole('button',{name:'Open T0001: Keep local changes and notes in Ledger'}).textContent).toContain('Draft');
 localStorage.clear();
});

test('map says the approval check failed, not "approved by you", when the task digest cannot be computed',async()=>{
 const {recordPlanApproval}=await import('../src/project/planApproval.js');
 const {readSection}=await import('../src/project/projectWorkRecords.js');
 localStorage.clear();
 const ledger=updateTaskDraft(emptyTaskDraftLedger(binding),task),store={read:async()=>ledger};
 await recordPlanApproval(project.projectId,{tasks:ledger.tasks,censusDigest:project.census.digest});
 const records={sections:{planAuthority:readSection(project.projectId,'planAuthority')}};
 const context={planStatuses:{[project.projectId]:{state:'unavailable'}}};
 const {ProjectContext}=await import('../src/project/ProjectProvider.jsx');
 const digest=vi.spyOn(globalThis.crypto.subtle,'digest').mockRejectedValue(new Error('digest unavailable'));
 try{
  render(<ProjectContext.Provider value={context}><TaskDraftMap project={project} records={records} store={withMemoryTaskSaveIntents(store)}/></ProjectContext.Provider>);
  await screen.findByRole('button',{name:'Open T0001: Keep local changes in Ledger'});
  await waitFor(()=>expect(screen.getByLabelText('Map planning approval').textContent).toContain('could not check that the approved plan matches the current tasks'));
  expect(screen.getByRole('status').textContent).toContain('approval check failed');
  expect(screen.getByRole('status').textContent).not.toContain('approved by you');
 }finally{digest.mockRestore();localStorage.clear();}
});
test('map does not crash when the plan was approved in Deep planning and this device has no saved approval record',async()=>{
 localStorage.clear();
 const ledger=updateTaskDraft(emptyTaskDraftLedger(binding),task);
 const records={sections:{},corePlan:{approved:true,tasks:[],latest:{plan:'P-1',entry:'L-000010',at:'2026-10-17T09:00:00.000Z',by:'owner',source:'planning'}}};
 const {ProjectContext}=await import('../src/project/ProjectProvider.jsx');
 render(<ProjectContext.Provider value={{planStatuses:{[project.projectId]:{state:'unavailable'}}}}><TaskDraftMap project={project} records={records} store={withMemoryTaskSaveIntents({read:async()=>ledger})}/></ProjectContext.Provider>);
 expect(await screen.findByRole('button',{name:'Open T0001: Keep local changes in Ledger'})).toBeTruthy();
 await act(async()=>{await new Promise(r=>setTimeout(r,300));});
 expect(screen.getByLabelText('Map planning approval')).toBeTruthy();
});
