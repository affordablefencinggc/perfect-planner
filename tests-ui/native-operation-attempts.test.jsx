import React from 'react';
import {afterEach,expect,test,vi} from 'vitest';
import {render,screen,cleanup,act,fireEvent,waitFor} from '@testing-library/react';
import {OperationNativeTaskAttempts} from '../src/components/OperationNativeTaskAttempts.jsx';
afterEach(cleanup);
test('storage refusal explains recovery without inventing task totals or exposing native text',async()=>{
 const error=Object.assign(Error('private-path-must-not-render'),{code:'NATIVE_SESSION_STORE_UNCERTAIN',executionAuthorized:false,requiresRecovery:true,requestMayHaveCommitted:true});
 const host={available:true,readPage:vi.fn().mockRejectedValue(error)};
 render(<OperationNativeTaskAttempts project={project} host={host}/>);
 await screen.findByText(/Native session history needs recovery/);
 expect(screen.queryByLabelText('This page only')).toBeNull();expect(screen.queryByText(/private-path-must-not-render/)).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Refresh native attempts'}));await waitFor(()=>expect(host.readPage).toHaveBeenCalledTimes(2));
 expect(screen.queryByLabelText('This page only')).toBeNull();
});
// Controlled test adapter constructs the new single page response.
const asPageHost=host=>({available:true,readPage:async(input,options)=>{
 const page=await host.list(input,options),outcomes=[];
 for(const row of page.entries.filter(r=>r.runId!==null)){
  try{outcomes.push({grantId:row.grantId,phase:'ready',value:await host.read({grantId:row.grantId},options)});}
  catch{outcomes.push({grantId:row.grantId,phase:'unavailable',value:null});}
 }
 return {page,outcomes};
}});
const project={projectId:'pp_ui_results',state:'observed',registration:{workspaceId:'ui-results',registryRevision:1,rootIdentity:'a'.repeat(64)},census:{digest:'b'.repeat(64)}};
const row=n=>({grantId:`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,taskId:'T0001',checkId:'unit',attemptId:`attempt${n}`,attemptNumber:n,workerId:'worker1',lifecycleState:'result-recorded',journalRevision:n,recordedAt:'2026-09-14T00:00:00.000Z',runId:`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`,intentDigest:'c'.repeat(64),artifactDigest:'d'.repeat(64)});
const page=entries=>({schemaVersion:1,kind:'NATIVE_TASK_RESULT_INDEX',projectId:project.projectId,rootIdentity:project.registration.rootIdentity,journalHead:{revision:100,headDigest:'e'.repeat(64)},offset:0,totalGrants:entries.length,nextOffset:null,entries,authorityVerified:false,executionAuthorized:false});
const outcome=(entry,exit)=>({...entry,projectId:project.projectId,rootIdentity:project.registration.rootIdentity,state:exit===0?'result-unverified':'failure-observed',exitCode:exit,failureReasons:exit===0?[]:['nonzero-exit'],cleanup:'unknown',journalLinked:true});
test('native outcomes load without clicks and never hide a failed earlier attempt',async()=>{
 const entries=[{...row(3),lifecycleState:'intent-recorded',artifactDigest:null},row(2),row(1)];
 const host={available:true,list:async()=>page(entries),read:vi.fn(async({grantId})=>{const r=entries.find(r=>r.grantId===grantId);if(r.attemptNumber===3)throw Error('private path');return outcome(r,r.attemptNumber===1?7:0);})};
 render(<OperationNativeTaskAttempts project={project} host={asPageHost(host)}/>);
 await screen.findByText('Check failed');expect(screen.getByText('Check returned — task unverified')).toBeTruthy();expect(screen.getByText('Result unavailable — outcome unknown')).toBeTruthy();
 expect(screen.getByText('Check failed').closest('details').open).toBe(true);expect(host.read).toHaveBeenCalledTimes(3);expect(screen.queryByText('private path')).toBeNull();
 expect([...document.querySelectorAll('[aria-label="This page only"] dd')].map(x=>x.textContent)).toEqual(['3','1','1']);expect(screen.getByText(/Snapshot revision/)).toBeTruthy();
});
test('wrong artifact identity remains unknown rather than showing success',async()=>{
 const r=row(1);const host={available:true,list:async()=>page([r]),read:async()=>({...outcome(r,0),intentDigest:'f'.repeat(64)})};
 render(<OperationNativeTaskAttempts project={project} host={asPageHost(host)}/>);await screen.findByText(/Native attempts unavailable/);expect(screen.queryByText('Check returned — task unverified')).toBeNull();
});
test('project switching discards the old page and aborts observation without extra calls',async()=>{
 let resolve;const host={available:true,readPage:vi.fn().mockImplementationOnce(()=>new Promise(done=>{resolve=done;})).mockResolvedValue({page:{...page([]),projectId:'pp_other'},outcomes:[]})};
 const view=render(<OperationNativeTaskAttempts project={project} host={host}/>);await waitFor(()=>expect(host.readPage).toHaveBeenCalledTimes(1));
 const signal=host.readPage.mock.calls[0][1].signal;
 view.rerender(<OperationNativeTaskAttempts project={{...project,projectId:'pp_other'}} host={host}/>);await screen.findByText(/No native attempt references/);
 await act(async()=>resolve({page:page([row(1)]),outcomes:[{grantId:row(1).grantId,phase:'ready',value:outcome(row(1),7)}]}));
 expect(screen.queryByText('Check failed')).toBeNull();expect(signal.aborted).toBe(true);expect(host.readPage).toHaveBeenCalledTimes(2);
});
test('pagination pins the head and stale pages ask for refresh without mixing rows',async()=>{
 const entries=Array.from({length:20},(_,i)=>({...row(21-i),lifecycleState:'issued',runId:null,intentDigest:null,artifactDigest:null}));
 const host={available:true,list:vi.fn().mockResolvedValueOnce({...page(entries),totalGrants:21,nextOffset:20}).mockRejectedValueOnce(Object.assign(Error('stale'),{code:'NATIVE_TASK_INDEX_STALE'})).mockResolvedValue(page([])),read:vi.fn()};
 render(<OperationNativeTaskAttempts project={project} host={asPageHost(host)}/>);await screen.findByText('1–20 of 21');fireEvent.click(screen.getByRole('button',{name:'Older references'}));
 await screen.findByText(/Recorded activity changed between pages/);expect(host.list.mock.calls[1][0]).toEqual({offset:20,expectedHeadDigest:'e'.repeat(64)});expect(screen.queryByText(/attempt 21/)).toBeNull();expect(host.read).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Refresh native attempts'}));await screen.findByText(/No native attempt references/);expect(host.list.mock.calls[2][0]).toEqual({offset:0,expectedHeadDigest:null});
});
test('failed refresh removes stale results instead of retaining a last-known failure',async()=>{
 const r=row(1);const host={available:true,list:vi.fn().mockResolvedValueOnce(page([r])).mockRejectedValueOnce(Error('private data')),read:async()=>outcome(r,7)};
 render(<OperationNativeTaskAttempts project={project} host={asPageHost(host)}/>);await screen.findByText('Check failed');fireEvent.click(screen.getByRole('button',{name:'Refresh native attempts'}));await screen.findByText(/Native attempts unavailable/);expect(screen.queryByText('Check failed')).toBeNull();expect(screen.queryByText('private data')).toBeNull();
});
test('recorded reference disclosure expands and collapses without changing outcomes',async()=>{
 const r=row(1),host={available:true,list:async()=>page([r]),read:async()=>outcome(r,7)};render(<OperationNativeTaskAttempts project={project} host={asPageHost(host)}/>);await screen.findByText('Check failed');const disclosure=screen.getByText('Recorded references').closest('details');expect(disclosure.open).toBe(false);fireEvent.click(disclosure.querySelector('summary'));expect(disclosure.open).toBe(true);fireEvent.click(disclosure.querySelector('summary'));expect(disclosure.open).toBe(false);
});
test('failure shortcut opens the failed row and moves keyboard focus to its summary',async()=>{
 const r=row(1),host={available:true,list:async()=>page([r]),read:async()=>outcome(r,7)};render(<OperationNativeTaskAttempts project={project} host={asPageHost(host)}/>);await screen.findByText('Check failed');
 const failed=screen.getByText('Check failed').closest('details');failed.open=false;failed.scrollIntoView=vi.fn();fireEvent.click(screen.getByRole('button',{name:'Show failed check'}));expect(failed.open).toBe(true);expect(failed.scrollIntoView).toHaveBeenCalledWith({block:'center'});expect(document.activeElement).toBe(failed.querySelector('summary'));
});
test('production component performs exactly one page request and never detail/list fallback',async()=>{
 const r=row(1),readPage=vi.fn().mockResolvedValue({page:page([r]),outcomes:[{grantId:r.grantId,phase:'ready',value:outcome(r,7)}]});
 const host={available:true,readPage,list:vi.fn(),read:vi.fn()};
 render(<OperationNativeTaskAttempts project={project} host={host}/>);
 await screen.findByText('Check failed');expect(readPage).toHaveBeenCalledTimes(1);expect(host.list).not.toHaveBeenCalled();expect(host.read).not.toHaveBeenCalled();
});
