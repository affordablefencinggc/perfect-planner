import React from 'react';
import {test,expect,vi,afterEach,beforeEach} from 'vitest';
import {webcrypto} from 'node:crypto';
import {render,screen,cleanup} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {SharedReconciliationControls} from '../src/components/SharedReconciliationControls.jsx';
import {emptyTaskDraftLedger,updateTaskDraft} from '../src/project/taskDraftLedger.js';
import {submissionWire} from '../src/project/taskDraftSubmission.js';
beforeEach(()=>vi.stubGlobal('crypto',webcrypto));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
async function setup(readError=false,saveError=false){
 const binding={projectId:'pp_stale',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)};
 const local=emptyTaskDraftLedger(binding),shared=updateTaskDraft(local,{title:'Task',description:'Scope',owner:'Danie',acceptance:'Test',recovery:'Keep',claims:[],dependsOn:[],archived:false});
 const hash=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),n=>n.toString(16).padStart(2,'0')).join('');
 const snapshot={binding,observedHead:{hostRevision:1,headDigest:'c'.repeat(64)},ledger:shared,ledgerDigest:await hash(submissionWire(shared)),snapshotDigest:await hash(JSON.stringify(shared)),approvalState:'unapproved-proposal',executionAuthorized:false};
 const store={commitSharedReview:vi.fn(async()=>{throw Error('uncertain storage result');})},onRefresh=vi.fn();
 const host={readSnapshot:vi.fn(async()=>{if(readError)throw Error('private transport detail');return saveError?snapshot:{...snapshot,observedHead:{hostRevision:2,headDigest:'d'.repeat(64)}};})};
 render(<SharedReconciliationControls ledger={local} snapshot={snapshot} rows={[{id:'T0001',shared:shared.tasks[0],label:'Shared only'}]} store={store} host={host} onRefresh={onRefresh}/>);
 const user=userEvent.setup();await user.click(screen.getByRole('radio'));await user.click(screen.getByRole('button',{name:'Preview combined plan'}));await user.click(await screen.findByRole('checkbox'));await user.click(screen.getByRole('button',{name:'Save reviewed local plan'}));return {store,host,onRefresh,user};
}
test('known shared change blocks stale save and offers an explicit fresh read',async()=>{const f=await setup();await screen.findByText(/shared plan changed after this preview/);expect(f.store.commitSharedReview).not.toHaveBeenCalled();expect(screen.getByRole('button',{name:'Save reviewed local plan'}).disabled).toBe(true);expect(screen.getByRole('radio').matches(':disabled')).toBe(true);expect(screen.getByRole('checkbox').checked).toBe(false);await f.user.click(screen.getByRole('button',{name:'Read latest shared plan'}));expect(f.onRefresh).toHaveBeenCalledTimes(1);expect(f.store.commitSharedReview).not.toHaveBeenCalled();});
test('transport uncertainty is not falsely labelled a known stale refusal',async()=>{const f=await setup(true);await screen.findByText(/review action was not confirmed/);expect(screen.queryByText(/shared plan changed after this preview/)).toBeNull();expect(screen.queryByText(/private transport detail/)).toBeNull();expect(f.store.commitSharedReview).not.toHaveBeenCalled();});
test('uncertain save keeps original recovery messaging rather than claiming no write',async()=>{const f=await setup(false,true);await screen.findByText(/review action was not confirmed/);expect(f.store.commitSharedReview).toHaveBeenCalledTimes(1);expect(screen.queryByText(/This review was not saved/)).toBeNull();});
