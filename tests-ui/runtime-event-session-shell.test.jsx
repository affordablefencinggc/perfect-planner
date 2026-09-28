import React from 'react';
import { test, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, screen, act, cleanup } from '@testing-library/react';
import { PerfectPlannerShell } from '../src/PerfectPlannerShell.jsx';
import { createRuntimeEventSession } from '../src/runtime/runtimeEventSession.js';
import { createRuntimeEventCodec } from '../src/runtime/runtimeEventLedger.js';
import { ProjectProvider } from '../src/project/ProjectProvider.jsx';
import { createMemoryStorage, createProjectRegistry } from '../src/project/projectRegistry.js';
import { createDemoProjectSession, DEMO_PROJECT_ID } from '../src/demo/demoProject.js';
import { downloadDiagnosticReport } from '../src/runtime/downloadDiagnosticReport.js';
afterEach(cleanup);
test('Operations footer double-click toggles once in either direction and header collapses', () => {
  const {container}=render(<PerfectPlannerShell diagnosticSession={fixture()}/>);
  const handle=container.querySelector('.ops-handle');
  const doubleClick=()=>{
    fireEvent.click(handle,{detail:1});
    fireEvent.click(handle,{detail:2});
    fireEvent.doubleClick(handle,{detail:2});
  };
  expect(handle.getAttribute('aria-expanded')).toBe('false');
  doubleClick();expect(handle.getAttribute('aria-expanded')).toBe('true');
  doubleClick();expect(handle.getAttribute('aria-expanded')).toBe('false');
  doubleClick();fireEvent.doubleClick(container.querySelector('.ops-panel-dragbar'));
  expect(handle.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(handle,{detail:0});expect(handle.getAttribute('aria-expanded')).toBe('true');
});

const codec=createRuntimeEventCodec();
test('Operations shows newest events first even when an older event arrives later', async () => {
  const session=fixture();
  const {container}=render(<PerfectPlannerShell diagnosticSession={session}/>);
  fireEvent.click(container.querySelector('.ops-handle'));
  await act(async()=>{
    session.append({projectId:'pp_global_runtime',generation:0,source:'workspace',adapter:'native',severity:'error',message:'Newest fixture event',timestamp:'2026-09-13T12:00:00.000Z'});
    session.append({projectId:'pp_global_runtime',generation:0,source:'workspace',adapter:'native',severity:'error',message:'Oldest fixture event',timestamp:'2026-09-13T10:00:00.000Z'});
    await session.settled();
  });
  const rows=[...container.querySelectorAll('.diagnostic-row')];
  expect(rows.findIndex(row=>row.textContent.includes('Newest fixture event'))).toBeLessThan(rows.findIndex(row=>row.textContent.includes('Oldest fixture event')));
  expect(await screen.findByText('Oldest fixture event')).toBeTruthy();
});
function fixture({fail=false,legacyStatus='snapshot-matches'}={}) {
  let head=codec.empty();
  const store={read:async()=>({envelope:head,legacyStatus}),subscribe:()=>()=>{},appendCaptured:async event=>{if(fail)throw Error('fixture abort');head=codec.append(head,event);return {envelope:head,legacyStatus};}};
  return createRuntimeEventSession({store});
}
test('Operations distinguishes failed session events from locally saved events',async()=>{
  const session=fixture({fail:true});const {container}=render(<PerfectPlannerShell diagnosticSession={session}/>);
  fireEvent.click(container.querySelector('.ops-handle'));
  await act(async()=>{window.dispatchEvent(new ErrorEvent('error',{message:'Synthetic unsaved event'}));await session.settled();});
  expect(await screen.findByText('Synthetic unsaved event')).toBeTruthy();
  expect(screen.getByText(/Some history could not be loaded or saved/)).toBeTruthy();
  expect(screen.getByText('unsaved',{exact:true})).toBeTruthy();
  expect(screen.getByRole('button',{name:'Export diagnostics'}).disabled).toBe(false);
});
test('Operations shows committed events as saved locally',async()=>{
  const session=fixture();const {container}=render(<PerfectPlannerShell diagnosticSession={session}/>);
  fireEvent.click(container.querySelector('.ops-handle'));
  await act(async()=>{window.dispatchEvent(new ErrorEvent('error',{message:'Synthetic saved event'}));await session.settled();});
  expect(await screen.findByText('Synthetic saved event')).toBeTruthy();
  expect(screen.getByText('log entry saved locally',{exact:true})).toBeTruthy();
});
test('legacy recovery warning remains visible even when current storage is durable',async()=>{
  const session=fixture({legacyStatus:'changed-recovery-needed'});const {container}=render(<PerfectPlannerShell diagnosticSession={session}/>);
  fireEvent.click(container.querySelector('.ops-handle'));
  expect(await screen.findByText(/Older diagnostic history changed or could not be read/)).toBeTruthy();
});
test('pending event survives shell unmount and remount with same session',async()=>{
  const session=fixture({fail:true});const first=render(<PerfectPlannerShell diagnosticSession={session}/>);
  await act(async()=>{window.dispatchEvent(new ErrorEvent('error',{message:'Retained after remount'}));await session.settled();});first.unmount();
  const second=render(<PerfectPlannerShell diagnosticSession={session}/>);fireEvent.click(second.container.querySelector('.ops-handle'));
  expect(await screen.findByText('Retained after remount')).toBeTruthy();
  expect(screen.getByText('unsaved',{exact:true})).toBeTruthy();
});
test('saving to saved keeps row selection and disclosure stable',async()=>{
  let head=codec.empty(),finish;
  const session=createRuntimeEventSession({store:{read:async()=>({envelope:head,legacyStatus:'snapshot-matches'}),subscribe:()=>()=>{},appendCaptured:event=>new Promise(resolve=>{finish=()=>{head=codec.append(head,event);resolve({envelope:head,legacyStatus:'snapshot-matches'});};})}});
  const {container}=render(<PerfectPlannerShell diagnosticSession={session}/>);fireEvent.click(container.querySelector('.ops-handle'));
  await act(async()=>{window.dispatchEvent(new ErrorEvent('error',{message:'Selected while saving'}));await Promise.resolve();});
  const message=await screen.findByText('Selected while saving');const row=message.closest('.diagnostic-row'),checkbox=row.querySelector('input'),details=row.querySelector('details');
  fireEvent.click(checkbox);fireEvent.click(details.querySelector('summary'));expect(checkbox.checked).toBe(true);expect(details.open).toBe(true);
  await act(async()=>{finish();await session.settled();});
  expect(message.closest('.diagnostic-row')).toBe(row);expect(checkbox.checked).toBe(true);expect(details.open).toBe(true);
  expect(screen.getByRole('textbox',{name:'Operations copy tray'}).value).toContain('Selected while saving');
});
test('focus refresh recovers history when cross-tab hints are absent',async()=>{
  let head=codec.empty();
  const session=createRuntimeEventSession({store:{read:async()=>({envelope:head,legacyStatus:'snapshot-matches'}),subscribe:()=>()=>{},appendCaptured:async()=>{throw Error('unused');}}});
  const registry=createProjectRegistry({storage:createMemoryStorage()});registry.upsert(createDemoProjectSession(),{activate:true});
  window.history.replaceState({},'',`/?project=${DEMO_PROJECT_ID}&workspace=home`);
  const view=render(<ProjectProvider registry={registry}><PerfectPlannerShell diagnosticSession={session}/></ProjectProvider>);fireEvent.click(view.container.querySelector('.ops-handle'));
  await act(async()=>{await session.refresh();});
  head=codec.append(head,codec.capture({projectId:DEMO_PROJECT_ID,generation:0,source:'fixture',adapter:'fixture',severity:'info',message:'Missed hint recovered'}));
  fireEvent.focus(window);expect(await screen.findByText('Missed hint recovered')).toBeTruthy();
});
test('late export failure remains bound to original project and does not notify next project',async()=>{
  const base=fixture();let rejectExport;
  const session={...base,exportReport:()=>new Promise((resolve,reject)=>{rejectExport=reject;})};
  const registry=createProjectRegistry({storage:createMemoryStorage()});registry.upsert(createDemoProjectSession(),{activate:true});
  window.history.replaceState({},'',`/?project=${DEMO_PROJECT_ID}&workspace=home`);
  const view=render(<ProjectProvider registry={registry}><PerfectPlannerShell diagnosticSession={session}/></ProjectProvider>);fireEvent.click(view.container.querySelector('.ops-handle'));
  // This test owns export scope, not the independently tested runtime listener.
  await act(async()=>{base.append({projectId:DEMO_PROJECT_ID,generation:0,source:'fixture',adapter:'fixture',severity:'error',message:'Export scope fixture'});await base.settled();});
  await screen.findByText('Export scope fixture');
  const exportButton=screen.getByRole('button',{name:'Export diagnostics'});
  expect(exportButton.disabled).toBe(false);
  fireEvent.click(exportButton);
  expect(typeof rejectExport).toBe('function');
  act(()=>registry.clear());
  await act(async()=>{rejectExport(Error('fixture export rejected'));await Promise.resolve();await base.settled();});
  expect(base.list(DEMO_PROJECT_ID).some(e=>e.message==='The diagnostic report could not be exported in this runtime.')).toBe(true);
  expect(screen.queryByText('Operations export is unavailable in this runtime. The failure was logged.')).toBeNull();
});
test('discovering a same-ID conflict cannot transfer pending selection to different saved content',async()=>{
  let head=codec.empty();const input={eventId:'evt_conflicting_selection',projectId:DEMO_PROJECT_ID,generation:0,source:'fixture',adapter:'fixture',severity:'error'};
  const session=createRuntimeEventSession({store:{read:async()=>({envelope:head,legacyStatus:'snapshot-matches'}),subscribe:()=>()=>{},appendCaptured:async()=>{throw Error('duplicate fixture');}}});
  const registry=createProjectRegistry({storage:createMemoryStorage()});registry.upsert(createDemoProjectSession(),{activate:true});window.history.replaceState({},'',`/?project=${DEMO_PROJECT_ID}&workspace=home`);
  const view=render(<ProjectProvider registry={registry}><PerfectPlannerShell diagnosticSession={session}/></ProjectProvider>);fireEvent.click(view.container.querySelector('.ops-handle'));
  await act(async()=>{session.append({...input,message:'Selected pending content'});await session.settled();});
  const row=(await screen.findByText('Selected pending content')).closest('.diagnostic-row');fireEvent.click(row.querySelector('input'));
  head=codec.append(head,codec.capture({...input,message:'Different saved content'}));await act(async()=>{await session.refresh();});
  expect(row.querySelector('input').checked).toBe(true);expect(screen.getByText('Different saved content').closest('.diagnostic-row').querySelector('input').checked).toBe(false);
  const tray=screen.getByRole('textbox',{name:'Operations copy tray'});expect(tray.value).toContain('Selected pending content');expect(tray.value).not.toContain('Different saved content');
});
test('failed download releases its temporary object URL',()=>{
  const create=URL.createObjectURL,revoke=URL.revokeObjectURL;
  URL.createObjectURL=()=> 'blob:diagnostic-fixture';URL.revokeObjectURL=vi.fn();
  const click=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{throw Error('fixture download denied');});
  try {expect(()=>downloadDiagnosticReport({schemaVersion:2},DEMO_PROJECT_ID)).toThrow('fixture download denied');expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:diagnostic-fixture');}
  finally {click.mockRestore();if(create)URL.createObjectURL=create;else delete URL.createObjectURL;if(revoke)URL.revokeObjectURL=revoke;else delete URL.revokeObjectURL;}
});
