import React from 'react';
import {afterEach,expect,test,vi} from 'vitest';
import {act,cleanup,render,screen} from '@testing-library/react';
import {OperationTaskAccounting} from '../src/components/OperationTaskAccounting.jsx';
import {emptyTaskDraftLedger,taskDraftBinding,updateTaskDraft} from '../src/project/taskDraftLedger.js';
const counters=vi.hoisted(()=>({mounts:0,unmounts:0}));
vi.mock('../src/native/workspaceCensus.js',()=>({isNativeWorkspaceRuntime:()=>true}));
vi.mock('../src/components/OperationNativeTaskAttempts.jsx',()=>({OperationNativeTaskAttempts:({project})=>{
 React.useEffect(()=>{counters.mounts++;return()=>{counters.unmounts++;};},[]);
 return <section aria-label="Controlled native history">{project.projectId}: retained check history</section>;
}}));
afterEach(()=>{cleanup();counters.mounts=0;counters.unmounts=0;});
const project={projectId:'pp_independent',state:'observed',registration:{workspaceId:'fixture',registryRevision:1,rootIdentity:'a'.repeat(64)},census:{digest:'b'.repeat(64)}};
test('pending and failed draft do not prevent native history mounting',async()=>{
 let reject;const store={read:()=>new Promise((_,r)=>{reject=r;})};
 render(<OperationTaskAccounting project={project} store={store}/>);
 expect(screen.getByLabelText('Controlled native history')).toBeTruthy();expect(screen.getByText(/Reading numbered/)).toBeTruthy();
 await act(async()=>reject(Error('private disk path')));
 await screen.findByText('Change accounting unavailable');expect(screen.getByLabelText('Controlled native history')).toBeTruthy();expect(counters.mounts).toBe(1);expect(counters.unmounts).toBe(0);expect(screen.queryByText('private disk path')).toBeNull();
});
test('draft refresh failure and recovery leave native history mounted once',async()=>{
 let notify;const ledger=emptyTaskDraftLedger(taskDraftBinding(project));const store={read:vi.fn().mockResolvedValue(ledger),subscribe:(_,fn)=>{notify=fn;return()=>{};}};
 render(<OperationTaskAccounting project={project} store={store}/>);await screen.findByText(/0 active/);
 store.read.mockRejectedValueOnce(Error('unavailable'));await act(async()=>notify());await screen.findByText('Change accounting unavailable');
 await act(async()=>notify());await screen.findByText(/0 active/);expect(counters.mounts).toBe(1);expect(counters.unmounts).toBe(0);
});
test('project switch discards prior history and invalid registration renders no history',async()=>{
 const store={read:async b=>emptyTaskDraftLedger(b)};const view=render(<OperationTaskAccounting project={project} store={store}/>);await screen.findByText(/0 active/);
 view.rerender(<OperationTaskAccounting project={{...project,projectId:'pp_other'}} store={store}/>);await screen.findByText('pp_other: retained check history');expect(screen.queryByText('pp_independent: retained check history')).toBeNull();expect(counters.unmounts).toBe(1);
 view.rerender(<OperationTaskAccounting project={{projectId:'bad'}} store={store}/>);expect(screen.queryByLabelText('Controlled native history')).toBeNull();
});
test('native history precedes all 155 draft rows without hiding or deleting tasks',async()=>{
 let ledger=emptyTaskDraftLedger(taskDraftBinding(project));
 for(let i=1;i<=155;i++)ledger=updateTaskDraft(ledger,{id:null,title:`Long ledger change ${i}`,description:'Retain changes',owner:'Owner',acceptance:'Proof required',recovery:'Retain copy',claims:[],dependsOn:[],archived:false});
 render(<OperationTaskAccounting project={project} store={{read:async()=>ledger}}/>);
 await screen.findByText('155 active · 155 outcomes unverified · 0 archived');
 const history=screen.getByLabelText('Controlled native history'),rows=[...document.querySelectorAll('details')];
 expect(rows).toHaveLength(155);for(const row of rows)expect(history.compareDocumentPosition(row)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 expect(screen.getByText(/Long ledger change 155/)).toBeTruthy();expect(counters.mounts).toBe(1);
});
