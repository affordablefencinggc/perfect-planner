import React from 'react';
import {afterEach,test,expect,vi} from 'vitest';
import {render,screen,cleanup,act} from '@testing-library/react';
import {ProjectContext} from '../src/project/ProjectProvider.jsx';
import {TaskDraftMap} from '../src/components/TaskDraftMap.jsx';
import {recordPlanApproval} from '../src/project/planApproval.js';
import {resetPersonSession} from '../src/core-screens/coreApi.js';
import {emptyTaskDraftLedger,updateTaskDraft,taskDraftBinding} from '../src/project/taskDraftLedger.js';
afterEach(()=>{cleanup();localStorage.clear();});
const project={projectId:'pp_shared_plan',name:'Shared plan',state:'observed',registration:{rootIdentity:'a'.repeat(64)},census:{digest:'b'.repeat(64)}};
const binding=taskDraftBinding(project),ledger=updateTaskDraft(emptyTaskDraftLedger(binding),{id:null,title:'Keep obligations',description:'Full task',owner:'Owner',acceptance:'Proof',recovery:'Preserve',claims:[],dependsOn:[],archived:false});
const observed={state:'observed',...binding,revision:2,ledgerRevision:ledger.revision,checkedLedger:ledger};
function show(status,store={read:async()=>ledger}){return <ProjectContext.Provider value={{planStatuses:{[binding.projectId]:status},refreshPlan:vi.fn()}}><TaskDraftMap project={project} store={store}/></ProjectContext.Provider>;}
test('map shows checked approval only for exact full saved ledger',async()=>{render(show(observed));await screen.findByText(/Saved-plan check passed: planning approval revision 2 matches this exact saved Ledger/);expect(screen.getByRole('status').textContent).toContain('no work executed or completed');});
test.each(['missing','stale','unavailable','pending'])('map never shows current approval for %s',async state=>{render(show({...observed,state}));await screen.findByRole('button',{name:'Open T0001: Keep obligations in Ledger'});expect(screen.queryByText(/Saved-plan check passed/)).toBeNull();});
test('same revision altered ledger is not accepted as exact approval',async()=>{render(show({...observed,checkedLedger:{...ledger,tasks:ledger.tasks.map(task=>({...task,description:'Different obligation'}))}}));await screen.findByRole('button',{name:'Open T0001: Keep obligations in Ledger'});expect(screen.queryByText(/Saved-plan check passed/)).toBeNull();});
test('new saved ledger notification removes checked map label immediately',async()=>{let current=ledger,notify;const store={read:async()=>current,subscribe:(_binding,callback)=>{notify=callback;return()=>{};}};render(show(observed,store));await screen.findByText(/Saved-plan check passed: planning approval revision 2/);current={...ledger,revision:ledger.revision+1};await act(async()=>notify());expect(screen.queryByText(/Saved-plan check passed/)).toBeNull();});
test('failed map reload does not preserve checked approval badge',async()=>{let notify;const store={read:vi.fn(async()=>ledger),subscribe:(_binding,callback)=>{notify=callback;return()=>{};}};render(show(observed,store));await screen.findByText(/Saved-plan check passed: planning approval revision 2/);store.read.mockRejectedValue(Error('Offline storage'));await act(async()=>notify());expect(screen.queryByText(/Saved-plan check passed/)).toBeNull();});
test('gap 17: an approval made by the person is never shown as "not checked"; the ledger check has its own name',async()=>{
 render(show(undefined));await screen.findByRole('button',{name:'Open T0001: Keep obligations in Ledger'});
 expect(screen.getByText('No plan approved yet. Approve the plan on the Plan page first.')).toBeTruthy();
 cleanup();
 await recordPlanApproval(project.projectId,{tasks:ledger.tasks,censusDigest:project.census.digest});
 render(show({state:'stale',projectId:project.projectId,reason:'ledger-context-changed'}));await screen.findByRole('button',{name:'Open T0001: Keep obligations in Ledger'});
 expect(screen.getByText(/^Plan approved[.:] .*Run the saved-plan check to lock it to this exact Ledger\.$/)).toBeTruthy();
 expect(screen.queryByText(/not checked/i)).toBeNull();
 expect(screen.getByRole('button',{name:'Run saved-plan check'})).toBeTruthy();
 expect(screen.getByText(/^Saved-plan check: an extra step after you approve/)).toBeTruthy();
});

test('a new folder with no history offers the button that starts it, right under "No plan approved yet"',async()=>{
 resetPersonSession();sessionStorage.setItem('pp.core.csrf','csrf-1');
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,status:200,json:async()=>({ok:true,result:{project:'default',owner:{state:'new',signals:[],started:false}}})})));
 render(show(undefined));
 expect(await screen.findByRole('button',{name:'Start a new history for this folder'})).toBeTruthy();
 expect(screen.getByText(/^No plan approved yet\./)).toBeTruthy();
 vi.unstubAllGlobals();resetPersonSession();sessionStorage.clear();
});

test('B2: with no plan approved the map offers Deep planning, the real place to approve, not a dead end',async()=>{
 const onWorkspace=vi.fn();
 render(<ProjectContext.Provider value={{planStatuses:{},refreshPlan:vi.fn()}}><TaskDraftMap project={project} store={{read:async()=>ledger}} onWorkspace={onWorkspace}/></ProjectContext.Provider>);
 const open=await screen.findByRole('button',{name:'Open Deep planning'});
 open.click();
 expect(onWorkspace).toHaveBeenCalledWith('planning');
 cleanup();
 await recordPlanApproval(project.projectId,{tasks:ledger.tasks,censusDigest:project.census.digest});
 render(<ProjectContext.Provider value={{planStatuses:{},refreshPlan:vi.fn()}}><TaskDraftMap project={project} store={{read:async()=>ledger}} onWorkspace={onWorkspace}/></ProjectContext.Provider>);
 await screen.findByRole('button',{name:'Open T0001: Keep obligations in Ledger'});
 expect(screen.queryByRole('button',{name:'Open Deep planning'})).toBeNull();
});
