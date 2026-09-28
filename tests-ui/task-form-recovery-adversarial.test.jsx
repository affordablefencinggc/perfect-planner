import React from 'react';
import {afterEach,test,expect,vi} from 'vitest';
import {render,screen,fireEvent,waitFor,act,cleanup} from '@testing-library/react';
import {TaskDraftLedger} from '../src/components/TaskDraftLedger.jsx';
import {appendTaskFormHistory} from '../src/project/taskFormRecovery.js';
import {createTaskFormSession} from '../src/project/taskFormSession.js';
import {emptyTaskDraftLedger,taskDraftBinding,updateTaskDraft} from '../src/project/taskDraftLedger.js';
import {withMemoryTaskSaveIntents} from './fixtures/memoryTaskSaveIntents.js';
vi.mock('../src/components/TaskDraftDeliveryPanel.jsx',()=>({TaskDraftDeliveryPanel:()=>null}));
vi.mock('../src/components/PlanApprovalPanel.jsx',()=>({PlanApprovalPanel:props=><output data-testid="approval-blocked">{String(props.dirty||props.disabled)}</output>}));
afterEach(cleanup);
let sequence=0;
const raw={id:null,title:'Recovered obligation',description:'  unfinished text  ',owner:'',acceptance:'',recovery:'',claims:'',dependsOn:'',archived:false};
function fixture(){
 const project={projectId:`pp_adversarial_${++sequence}`,state:'observed',registration:{rootIdentity:'a'.repeat(64)},census:{digest:'b'.repeat(64)}},binding=taskDraftBinding(project);let rows=[],ledger=emptyTaskDraftLedger(binding);const listeners=new Set();
 const recovery={list:vi.fn(async()=>{const heads=new Map();rows.forEach(row=>heads.set(row.editorId,row));return structuredClone({records:[...heads.values()],history:rows});}),read:vi.fn(async(_binding,id)=>structuredClone(rows.filter(row=>row.editorId===id).at(-1)??null)),put:vi.fn(async input=>{rows=appendTaskFormHistory(rows,input,'put');return structuredClone(rows.at(-1));}),resolve:vi.fn(async input=>{rows=appendTaskFormHistory(rows,input,'resolve');return structuredClone(rows.at(-1));}),subscribe:(_binding,listener)=>{listeners.add(listener);return()=>listeners.delete(listener);},close:async()=>{}};
 const store={read:vi.fn(async()=>ledger),saveTask:vi.fn(async(_binding,expected,input)=>{if(expected!==ledger.revision)throw Error('Ledger revision conflict');ledger=updateTaskDraft(ledger,input);return ledger;})};
 withMemoryTaskSaveIntents(store);return {project,binding,recovery,store,rows:()=>rows,notify:()=>listeners.forEach(listener=>listener()),seed:async(extra={})=>recovery.put({binding,editorId:'retained-editor',expectedRevision:0,baseLedgerRevision:0,form:raw,...extra})};
}
async function show(f){render(<TaskDraftLedger project={f.project} store={f.store} recovery={f.recovery}/>);await screen.findByText('No task drafts yet. Add the first task using the form.');await waitFor(()=>expect(f.recovery.list).toHaveBeenCalled());if(f.rows().length)fireEvent.click(await screen.findByText(/Recovered obligation · base Ledger/));}
test('unreadable recovery blocks approval without checkpointing an initial blank',async()=>{const f=fixture();f.recovery.list.mockRejectedValue(Error('Recovery unreadable'));await show(f);await screen.findByText(/Recovery unreadable/);expect(screen.getByTestId('approval-blocked').textContent).toBe('true');expect(f.recovery.put).not.toHaveBeenCalled();});
test('fork write failure keeps source unfinished and never supersedes it',async()=>{const f=fixture();await f.seed();f.recovery.put.mockRejectedValue(Error('Fork storage failed'));await show(f);fireEvent.click(await screen.findByRole('button',{name:'Restore as separate editor'}));await screen.findByText(/Fork storage failed/);expect(f.recovery.resolve).not.toHaveBeenCalled();expect(f.rows()).toHaveLength(1);expect(screen.getByLabelText('Task title').value).toBe('');});
test('restoration copies without terminalizing another editor session',async()=>{const f=fixture();await f.seed();await show(f);fireEvent.click(await screen.findByRole('button',{name:'Restore as separate editor'}));await waitFor(()=>expect(screen.getByLabelText('Task title').value).toBe(raw.title));expect(f.rows().filter(row=>row.status==='unfinished')).toHaveLength(2);expect(f.rows()[0].form).toEqual(raw);expect(f.recovery.resolve).not.toHaveBeenCalled();expect(screen.getByTestId('approval-blocked').textContent).toBe('true');});
test('old census remains exportable but cannot be silently restored',async()=>{const f=fixture();await f.seed({binding:{...f.binding,censusDigest:'c'.repeat(64)}});await show(f);expect((await screen.findByRole('button',{name:'Restore as separate editor'})).disabled).toBe(true);expect(screen.getByRole('button',{name:'Export retained editor'}).disabled).toBe(false);expect(screen.getByTestId('approval-blocked').textContent).toBe('true');});
test('Ledger commit followed by resolution failure keeps task and blocks duplicate submission',async()=>{const f=fixture();f.recovery.resolve.mockRejectedValue(Error('Resolution failed'));await show(f);fireEvent.change(screen.getByLabelText('Task title'),{target:{value:'Committed once'}});fireEvent.click(screen.getByRole('button',{name:'Save task draft'}));await screen.findByText(/Ledger revision 1 was saved, but editor recovery is unresolved/);expect((await f.store.read()).tasks).toHaveLength(1);expect(screen.getByLabelText('Task title').value).toBe('Committed once');expect(screen.getByRole('button',{name:'Save task draft'}).closest('fieldset').disabled).toBe(true);expect(f.store.saveTask).toHaveBeenCalledTimes(1);expect(screen.getByRole('button',{name:'Reconcile saved editor'})).toBeTruthy();});
test('older checkpoint completion does not acknowledge newer unflushed text',async()=>{const f=fixture(),original=f.recovery.put.getMockImplementation();let resolve;
 f.recovery.put.mockImplementationOnce(input=>new Promise(done=>{resolve=async()=>done(await original(input));}));await show(f);
 fireEvent.change(screen.getByLabelText('Task title'),{target:{value:'First text'}});await waitFor(()=>expect(f.recovery.put).toHaveBeenCalledTimes(1));
 fireEvent.change(screen.getByLabelText('Task title'),{target:{value:'Newer text'}});await act(async()=>resolve());
 expect(screen.getByLabelText('Task title').value).toBe('Newer text');expect(screen.getByText(/Checkpointing current text/)).toBeTruthy();
 await waitFor(()=>expect(f.recovery.put).toHaveBeenCalledTimes(2));expect(f.rows().at(-1).form.title).toBe('Newer text');
});

test('uncertain checkpoint readback reconciles its original before appending newer text',async()=>{const f=fixture(),put=f.recovery.put.getMockImplementation(),session=createTaskFormSession(f.recovery,f.binding);
 f.recovery.put.mockImplementationOnce(async input=>{await put(input);throw Error('Readback lost');});session.update(raw,0);
 await expect(session.flush()).rejects.toThrow('Readback lost');session.update({...raw,title:'Newer retained text'},0);await session.flush();
 expect(f.rows().map(row=>row.revision)).toEqual([1,2]);expect(f.rows()[0].form).toEqual(raw);expect(f.rows()[1].form.title).toBe('Newer retained text');
});
test('uncertain terminal resolution reconciles the exact retained outcome without appending again',async()=>{const f=fixture(),resolve=f.recovery.resolve.getMockImplementation(),session=createTaskFormSession(f.recovery,f.binding);session.update(raw,0);const checkpoint=await session.flush();
 f.recovery.resolve.mockImplementationOnce(async input=>{await resolve(input);throw Error('Resolution readback lost');});await expect(session.resolve('saved',checkpoint)).rejects.toThrow('Resolution readback lost');await session.resolve('saved',checkpoint);
 expect(f.recovery.resolve).toHaveBeenCalledTimes(1);expect(f.rows()).toHaveLength(2);expect(f.rows()[1].resolution).toBe('saved');expect(f.rows()[1].form).toEqual(raw);
});

async function closeVisibleSession(f){
 fireEvent.change(screen.getByLabelText('Task title'),{target:{value:'Peer-preserved text'}});
 await waitFor(()=>expect(f.rows()).toHaveLength(1));const prior=f.rows()[0];
 await act(async()=>{await f.recovery.resolve({binding:f.binding,editorId:prior.editorId,expectedRevision:prior.revision,reason:'discarded'});f.notify();});
 await screen.findByText(/This editor session was closed/);return prior;
}
test('peer closure is visible immediately and explicit continuation keeps original base and text',async()=>{const f=fixture();await show(f);const prior=await closeVisibleSession(f);
 expect(screen.getByRole('button',{name:'Save task draft'}).closest('fieldset').disabled).toBe(true);expect(screen.getByLabelText('Task title').value).toBe('Peer-preserved text');expect(screen.getByTestId('approval-blocked').textContent).toBe('true');
 await act(async()=>{await f.store.saveTask(f.binding,0,{...raw,title:'Peer saved task',claims:[],dependsOn:[]});});fireEvent.click(screen.getByRole('button',{name:'Refresh draft'}));await screen.findByText('Peer saved task');
 fireEvent.click(screen.getByRole('button',{name:'Continue in a new editor'}));await screen.findByText(/Continued in a new editor at the same Ledger base revision/);
 const fork=f.rows().at(-1);expect(fork.editorId).not.toBe(prior.editorId);expect(fork.baseLedgerRevision).toBe(0);expect(fork.form.title).toBe('Peer-preserved text');expect(f.rows()[1].status).toBe('resolved');expect(f.store.saveTask).toHaveBeenCalledTimes(1);expect(screen.getByLabelText('Task title').value).toBe('Peer-preserved text');expect(screen.getByRole('button',{name:'I reviewed the latest revision — reapply my form'})).toBeTruthy();
});
test('failed continuation preserves visible text and original terminal history',async()=>{const f=fixture();await show(f);await closeVisibleSession(f);f.recovery.put.mockRejectedValue(Error('Separate checkpoint failed'));
 fireEvent.click(screen.getByRole('button',{name:'Continue in a new editor'}));await screen.findByText(/Separate checkpoint failed/);expect(f.rows()).toHaveLength(2);expect(f.rows()[1].status).toBe('resolved');expect(screen.getByLabelText('Task title').value).toBe('Peer-preserved text');expect(f.store.saveTask).not.toHaveBeenCalled();expect(screen.getByTestId('approval-blocked').textContent).toBe('true');
});
test('late failed checkpoint from closed session cannot smear successful new editor',async()=>{const f=fixture(),put=f.recovery.put.getMockImplementation();let rejectOld;
 f.recovery.put.mockImplementationOnce(async input=>{await put(input);return new Promise((_resolve,reject)=>{rejectOld=reject;});});await show(f);await closeVisibleSession(f);
 fireEvent.click(screen.getByRole('button',{name:'Continue in a new editor'}));await screen.findByText(/Continued in a new editor at the same Ledger base revision/);
 await act(async()=>{rejectOld(Error('Old session readback failed'));});expect(screen.queryByText(/Old session readback failed/)).toBeNull();expect(screen.getByRole('button',{name:'Save task draft'}).closest('fieldset').disabled).toBe(false);expect(screen.getByLabelText('Task title').value).toBe('Peer-preserved text');expect(f.rows().at(-1).status).toBe('unfinished');
});
test('own save notification does not leave the next editor closed',async()=>{const f=fixture(),resolve=f.recovery.resolve.getMockImplementation();f.recovery.resolve.mockImplementation(async input=>{const record=await resolve(input);f.notify();return record;});await show(f);
 fireEvent.change(screen.getByLabelText('Task title'),{target:{value:'Saved first task'}});fireEvent.click(screen.getByRole('button',{name:'Save task draft'}));await screen.findByText(/Saved local draft revision 1/);
 expect(screen.queryByText(/This editor session was closed/)).toBeNull();expect(screen.getByRole('button',{name:'Save task draft'}).closest('fieldset').disabled).toBe(false);expect(screen.getByLabelText('Task title').value).toBe('');
 fireEvent.change(screen.getByLabelText('Task title'),{target:{value:'Next task stays editable'}});await waitFor(()=>expect(f.rows().at(-1).form.title).toBe('Next task stays editable'));expect(f.rows().at(-1).status).toBe('unfinished');
});
