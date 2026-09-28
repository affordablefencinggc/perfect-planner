import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, act, fireEvent } from '@testing-library/react';
import { OperationTaskAccounting } from '../src/components/OperationTaskAccounting.jsx';
import { OperationTaskRunObservations } from '../src/components/OperationTaskRunObservations.jsx';
import { emptyTaskDraftLedger, updateTaskDraft, taskDraftBinding } from '../src/project/taskDraftLedger.js';
const project={projectId:'pp_accounting_test',state:'observed',registration:{rootIdentity:'a'.repeat(64)},census:{digest:'b'.repeat(64)}};
const binding=taskDraftBinding(project);
const task={id:null,title:'Preserve local edits',description:'Keep work',owner:'Worker A',acceptance:'Proof required',recovery:'Retain working copy',claims:[],dependsOn:[],archived:false};
const ledger=updateTaskDraft(emptyTaskDraftLedger(binding),task);

const run={runId:'11111111-1111-4111-8111-111111111111',taskId:'T0001',checkId:'unit',attemptId:'attempt-1',attemptNumber:1,state:'failure-observed',ledgerMatch:'current-draft',exitCode:3,timedOut:false,outputTruncated:false,failureStage:null,cleanup:'unknown',artifactDigest:'d'.repeat(64),admittedAt:'2026-09-09T00:00:00.000Z',terminalAt:'2026-09-09T00:00:01.000Z',nextAction:'Inspect retained check evidence.'};

test('retained failed attempt remains visible beside unverified successful retry',async()=>{
 const read=async()=>({runs:[run,{...run,runId:'22222222-2222-4222-8222-222222222222',attemptNumber:2,state:'result-unverified',exitCode:0}]});
 render(<OperationTaskRunObservations ledger={ledger} read={read}/>);
 await screen.findByText(/attempt 1 — Check failure recorded/);
 expect(screen.getByText(/attempt 2 — Check returned — task not verified/)).toBeTruthy();
 expect(screen.getByText(/attempt 1 —/).closest('details').open).toBe(true);
 expect(screen.getByText(/attempt 2 —/).closest('details').open).toBe(true);
 expect(screen.getAllByText(/contents not verified/)).toHaveLength(2);
 expect(screen.getByText(/host’s latest ledger/)).toBeTruthy();
});

test('older unresolved and failed attempts default open while explicit collapse survives an unrelated rerender',async()=>{
 const read=async()=>({runs:[run,{...run,runId:'33333333-3333-4333-8333-333333333333',attemptNumber:3,state:'unresolved',exitCode:null},{...run,runId:'44444444-4444-4444-8444-444444444444',attemptNumber:4,state:'result-unverified',exitCode:0}]});
 const view=render(<OperationTaskRunObservations ledger={ledger} read={read}/>);
 await screen.findByText(/attempt 3 — Completion unknown/);
 const failure=screen.getByText(/attempt 1 —/).closest('details'),unknown=screen.getByText(/attempt 3 —/).closest('details');
 expect(failure.open).toBe(true);expect(unknown.open).toBe(true);expect(screen.getByText(/attempt 4 —/).closest('details').open).toBe(true);
 fireEvent.click(failure.querySelector('summary'));expect(failure.open).toBe(false);
 view.rerender(<OperationTaskRunObservations ledger={ledger} read={read}/>);expect(failure.open).toBe(false);expect(unknown.open).toBe(true);
 fireEvent.click(failure.querySelector('summary'));expect(failure.open).toBe(true);
});

test('retained reader failure is generic and late old-project results are discarded',async()=>{
 let resolve;const read=vi.fn().mockImplementationOnce(()=>new Promise(done=>{resolve=done;})).mockRejectedValue(new Error('private path'));
 const view=render(<OperationTaskRunObservations ledger={ledger} read={read}/>);
 const other=emptyTaskDraftLedger({...binding,projectId:'pp_other_project'});
 view.rerender(<OperationTaskRunObservations ledger={other} read={read}/>);
 await screen.findByText(/Retained check attempts unavailable/);
 await act(async()=>resolve({runs:[run]}));
 expect(screen.queryByText(/Check failure recorded/)).toBeNull();expect(screen.queryByText('private path')).toBeNull();
});
afterEach(cleanup);
test('counts every draft but never manufactures verified or failed outcomes from logs',async()=>{
 let many=emptyTaskDraftLedger(binding);for(let i=0;i<155;i++)many=updateTaskDraft(many,{...task,title:`Change ${i+1}`});
 const diagnostics=[{projectId:project.projectId,taskId:'T0001',level:'error',message:'Settings check failed',timestamp:'2026-09-06',runId:'run-1'},{projectId:'pp_other_project',taskId:'T0001',level:'error',message:'Foreign private error'}];
 render(<OperationTaskAccounting project={project} diagnostics={diagnostics} store={{read:async()=>many}}/>);
 await screen.findByText('155 active · 155 outcomes unverified · 0 archived');
 expect(screen.getByText(/Verified and failed totals are unavailable/)).toBeTruthy();
 expect(screen.getByText('Settings check failed').closest('details').open).toBe(true);
 expect(screen.queryByText('Foreign private error')).toBeNull();
 expect(screen.getByText(/Cause: unknown/)).toBeTruthy();
});
test('archiving is separate from completion and unmatched errors stay visible',async()=>{
 const archived=updateTaskDraft(ledger,{...ledger.tasks[0],archived:true});
 render(<OperationTaskAccounting project={project} store={{read:async()=>archived}} diagnostics={[{projectId:project.projectId,taskId:'T0999',severity:'critical',message:'Unknown task failed'}]}/>);
 await screen.findByText('0 active · 0 outcomes unverified · 1 archived');
 expect(screen.getByText(/T0999: Unknown task failed/)).toBeTruthy();
});
test('failed refresh removes stale totals and subscription recovers current revision',async()=>{
 let notify;const store={read:vi.fn(async()=>ledger),subscribe:(_binding,fn)=>{notify=fn;return()=>{};}};
 render(<OperationTaskAccounting project={project} store={store}/>);
 await screen.findByText('1 active · 1 outcomes unverified · 0 archived');
 store.read.mockRejectedValueOnce(new Error('private storage path'));await act(async()=>notify());
 await screen.findByText('Change accounting unavailable');expect(screen.queryByText(/1 active/)).toBeNull();expect(screen.queryByText('private storage path')).toBeNull();
 await act(async()=>notify());await screen.findByText('1 active · 1 outcomes unverified · 0 archived');
});
test('late reads from previous project cannot populate the next project',async()=>{
 let resolve;const store={read:vi.fn().mockImplementationOnce(()=>new Promise(done=>{resolve=done;})).mockResolvedValue(emptyTaskDraftLedger({...binding,projectId:'pp_other_project'}))};
 const view=render(<OperationTaskAccounting project={project} store={store}/>);
 view.rerender(<OperationTaskAccounting project={{...project,projectId:'pp_other_project'}} store={store}/>);
 await screen.findByText('0 active · 0 outcomes unverified · 0 archived');
 await act(async()=>resolve(ledger));expect(screen.queryByText(/1 active/)).toBeNull();
});
test('wrong census fails closed instead of counting a different revision',async()=>{
 render(<OperationTaskAccounting project={{...project,census:{digest:'c'.repeat(64)}}} store={{read:async()=>ledger}}/>);
 await screen.findByText('Change accounting unavailable');expect(screen.queryByText(/1 active/)).toBeNull();
});
