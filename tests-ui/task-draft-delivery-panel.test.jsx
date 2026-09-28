import React from 'react';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
vi.mock('../src/project/taskFormRecovery.js',async importOriginal=>{const actual=await importOriginal(),{createMemoryTaskFormRecovery}=await import('./fixtures/memoryTaskFormRecovery.js');return {...actual,createTaskFormRecovery:()=>createMemoryTaskFormRecovery(actual.appendTaskFormHistory)};});
import {withMemoryTaskSaveIntents} from './fixtures/memoryTaskSaveIntents.js';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
const hostFactory=vi.hoisted(()=>vi.fn());
vi.mock('../src/native/taskDraftHost.js',()=>({createNativeTaskDraftHost:hostFactory}));
import {TaskDraftDeliveryPanel} from '../src/components/TaskDraftDeliveryPanel.jsx';
import {TaskDraftLedger} from '../src/components/TaskDraftLedger.jsx';
import {emptyTaskDraftLedger,updateTaskDraft,taskDraftBinding} from '../src/project/taskDraftLedger.js';
import {submissionReceiptFromHost} from '../src/project/taskDraftSubmission.js';

// UI/controller coverage only. The host and durable storage are fixtures;
// these tests do not establish native IPC, IndexedDB durability or approval.
afterEach(cleanup);
beforeEach(()=>hostFactory.mockReset());
function fixture(name='panel'){
  const project={projectId:`pp_delivery_${name}`,state:'observed',registration:{workspaceId:'workspace-one',registryRevision:1,rootIdentity:'a'.repeat(64)},census:{digest:'b'.repeat(64)}};
  const binding=taskDraftBinding(project);
  const original=updateTaskDraft(emptyTaskDraftLedger(binding),{id:null,title:'Original saved task',description:'Original full description',owner:'',acceptance:'',recovery:'',claims:[],dependsOn:[],archived:false});
  const ledger=updateTaskDraft(original,{...original.tasks[0],title:'Newer saved task'});
  const records=new Map();
  const add=id=>{const record={schemaVersion:1,kind:'LOCAL_DRAFT_SUBMISSION',binding,localRevision:1,ledger:original,request:{requestId:id,expectedRevision:0,expectedHeadDigest:'GENESIS'},receipt:null,executionAuthorized:false};records.set(id,record);return record;};
  const store={read:vi.fn(async()=>ledger),history:vi.fn(async()=>[]),saveTask:vi.fn(async()=>{throw Error('Unexpected draft mutation');}),
    submissionHistory:vi.fn(async()=>structuredClone([...records.values()])),readSubmission:vi.fn(async(_binding,id)=>structuredClone(records.get(id))),prepareSubmission:vi.fn(async()=>{throw Error('Unexpected new submission');}),
    recordSubmissionReceipt:vi.fn(async(_binding,id,result)=>{const next={...records.get(id),receipt:submissionReceiptFromHost(result)};records.set(id,next);return structuredClone(next);})};
  const host={available:true,inspect:vi.fn(async()=>({schemaVersion:1,observedHead:{hostRevision:0,headDigest:'GENESIS'},registrationCurrent:true,registrationLeaseHeld:false,approvalState:'unapproved-proposal',executionAuthorized:false})),submit:vi.fn(async()=>({schemaVersion:1,observedHead:{hostRevision:1,headDigest:'c'.repeat(64)},registrationCurrent:true,registrationLeaseHeld:false,approvalState:'unapproved-proposal',executionAuthorized:false,submitted:{hostRevision:1,headDigest:'c'.repeat(64),ledgerDigest:'d'.repeat(64)},submissionPersisted:true,idempotent:true,submittedMatchesObservedHead:true}))};
  hostFactory.mockReturnValue(host);
  return {project,binding,ledger,original,store,records,host,add};
}
const panel=f=>render(<TaskDraftDeliveryPanel project={f.project} binding={f.binding} ledger={f.ledger} store={withMemoryTaskSaveIntents(f.store)} disabled={false} dirty={false}/>);
const retry=id=>screen.getByRole('button',{name:`Retry original submission ${id}`});
const submit=()=>screen.getByRole('button',{name:'Submit saved revision 2'});
function outstanding(id){return Object.assign(Error('Native original reconciliation required.'),{originalRequestId:id,requiresRecovery:false});}

test('web-unavailable view never sends and keeps saved submission history readable',async()=>{
  const f=fixture('web');f.host.available=false;f.add('original-web');panel(f);
  await screen.findByText(/Native delivery is unavailable in this view/);
  await screen.findByText('original-web');expect(submit().disabled).toBe(true);expect(retry('original-web').disabled).toBe(true);
  fireEvent.click(submit());fireEvent.click(retry('original-web'));expect(f.host.inspect).not.toHaveBeenCalled();expect(f.host.submit).not.toHaveBeenCalled();
});

test('native-required older ID disables wrong retry and new submission without inventing process cleanup failure',async()=>{
  const f=fixture('foreign_original');f.add('current-pending');f.host.submit.mockRejectedValue(outstanding('older-original'));panel(f);
  await waitFor(()=>expect(retry('current-pending').disabled).toBe(false));fireEvent.click(retry('current-pending'));
  await screen.findByText('older-original');await screen.findByText(/This original is not listed for the current folder inventory/);
  await waitFor(()=>expect(retry('current-pending').disabled).toBe(true));expect(submit().disabled).toBe(true);
  expect(screen.queryByText(/previous session has not been confirmed stopped/)).toBeNull();
  fireEvent.click(retry('current-pending'));expect(f.host.submit).toHaveBeenCalledTimes(1);expect(f.records.get('current-pending').receipt).toBeNull();
});

test('matching explicit retry acknowledges the original and clears native-ID requirement without automatic resend',async()=>{
  const f=fixture('matching');f.add('matching-original');f.host.submit.mockRejectedValueOnce(outstanding('matching-original'));panel(f);
  await waitFor(()=>expect(retry('matching-original').disabled).toBe(false));fireEvent.click(retry('matching-original'));
  await screen.findByText(/Native host requires the original submission/);
  await waitFor(()=>expect(retry('matching-original').disabled).toBe(false));expect(f.host.submit).toHaveBeenCalledTimes(1);
  fireEvent.click(retry('matching-original'));
  await screen.findByText(/Native host acknowledged saved revision 1/);
  await waitFor(()=>expect(screen.queryByText(/Native host requires the original submission/)).toBeNull());
  await waitFor(()=>expect(screen.queryByRole('button',{name:'Retry original submission matching-original'})).toBeNull());
  expect(f.host.submit).toHaveBeenCalledTimes(2);expect(f.host.submit.mock.calls[1][0].request.requestId).toBe('matching-original');
  expect(f.host.submit.mock.calls[1][0].ledger).toEqual(f.original);expect(f.store.prepareSubmission).not.toHaveBeenCalled();
});

test('retry from the real task editor preserves unsaved text and newer saved revision',async()=>{
  const f=fixture('editor');f.add('editor-original');render(<TaskDraftLedger project={f.project} store={withMemoryTaskSaveIntents(f.store)}/>);
  await screen.findByRole('heading',{name:'Newer saved task'});
  fireEvent.change(screen.getByLabelText('Task title'),{target:{value:'Do not lose this unsaved title'}});
  fireEvent.change(screen.getByLabelText('Full description'),{target:{value:'Unfinished editor text must remain unchanged'}});
  const region=screen.getByRole('region',{name:'Send saved planning draft'});
  expect(within(region).getByRole('button',{name:'Submit saved revision 2'}).disabled).toBe(true);
  await waitFor(()=>expect(retry('editor-original').disabled).toBe(false));fireEvent.click(retry('editor-original'));
  await within(region).findByText(/Native host acknowledged saved revision 1/);
  expect(screen.getByLabelText('Task title').value).toBe('Do not lose this unsaved title');expect(screen.getByLabelText('Full description').value).toBe('Unfinished editor text must remain unchanged');
  expect(f.host.submit.mock.calls[0][0].ledger).toEqual(f.original);expect((await f.store.read()).revision).toBe(2);expect(f.store.saveTask).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Discard unsaved edits'}));
});
