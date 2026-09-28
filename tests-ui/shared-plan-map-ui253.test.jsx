import React from 'react';
import {afterEach,test,expect,vi} from 'vitest';
import {render,screen,cleanup,act} from '@testing-library/react';
import {ProjectContext} from '../src/project/ProjectProvider.jsx';
import {TaskDraftMap} from '../src/components/TaskDraftMap.jsx';
import {emptyTaskDraftLedger,updateTaskDraft,taskDraftBinding} from '../src/project/taskDraftLedger.js';
afterEach(cleanup);
const project={projectId:'pp_shared_plan',name:'Shared plan',state:'observed',registration:{rootIdentity:'a'.repeat(64)},census:{digest:'b'.repeat(64)}};
const binding=taskDraftBinding(project),ledger=updateTaskDraft(emptyTaskDraftLedger(binding),{id:null,title:'Keep obligations',description:'Full task',owner:'Owner',acceptance:'Proof',recovery:'Preserve',claims:[],dependsOn:[],archived:false});
const observed={state:'observed',...binding,revision:2,ledgerRevision:ledger.revision,checkedLedger:ledger};
function show(status,store={read:async()=>ledger}){return <ProjectContext.Provider value={{planStatuses:{[binding.projectId]:status},refreshPlan:vi.fn()}}><TaskDraftMap project={project} store={store}/></ProjectContext.Provider>;}
test('map shows checked approval only for exact full saved ledger',async()=>{render(show(observed));await screen.findByText(/Checked planning approval revision 2 for this exact saved Ledger/);expect(screen.getByRole('status').textContent).toContain('no work executed or completed');});
test.each(['missing','stale','unavailable','pending'])('map never shows current approval for %s',async state=>{render(show({...observed,state}));await screen.findByRole('button',{name:'Open T0001: Keep obligations in Ledger'});expect(screen.queryByText(/Checked planning approval revision/)).toBeNull();});
test('same revision altered ledger is not accepted as exact approval',async()=>{render(show({...observed,checkedLedger:{...ledger,tasks:ledger.tasks.map(task=>({...task,description:'Different obligation'}))}}));await screen.findByRole('button',{name:'Open T0001: Keep obligations in Ledger'});expect(screen.queryByText(/Checked planning approval revision/)).toBeNull();});
test('new saved ledger notification removes checked map label immediately',async()=>{let current=ledger,notify;const store={read:async()=>current,subscribe:(_binding,callback)=>{notify=callback;return()=>{};}};render(show(observed,store));await screen.findByText(/Checked planning approval revision 2/);current={...ledger,revision:ledger.revision+1};await act(async()=>notify());expect(screen.queryByText(/Checked planning approval revision/)).toBeNull();});
test('failed map reload does not preserve checked approval badge',async()=>{let notify;const store={read:vi.fn(async()=>ledger),subscribe:(_binding,callback)=>{notify=callback;return()=>{};}};render(show(observed,store));await screen.findByText(/Checked planning approval revision 2/);store.read.mockRejectedValue(Error('Offline storage'));await act(async()=>notify());expect(screen.queryByText(/Checked planning approval revision/)).toBeNull();});
