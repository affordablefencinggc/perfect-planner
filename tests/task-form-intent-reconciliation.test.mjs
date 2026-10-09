import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyTaskDraftLedger,updateTaskDraft} from '../src/project/taskDraftLedger.js';
import {appendTaskFormHistory} from '../src/project/taskFormRecovery.js';
import {validateTaskSaveIntent} from '../src/project/taskFormSaveIntent.js';
import {reconcileTaskFormIntent} from '../src/project/taskFormIntentReconciliation.js';

function fixture(kind='committed') {
 const binding={projectId:'pp_intent_bridge',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)};
 const form={id:null,title:'Original new task',description:'Exact unfinished text',owner:'',acceptance:'',recovery:'',claims:'',dependsOn:'',archived:false};
 const taskInput={...form,claims:[],dependsOn:[]},baseLedger=emptyTaskDraftLedger(binding),requestId='save-original-259';
 let history=appendTaskFormHistory([],{binding,editorId:'editor-original-259',expectedRevision:0,baseLedgerRevision:0,form},'put');
 const {editorId,revision,baseLedgerRevision}=history[0],checkpoint={binding,editorId,revision,baseLedgerRevision,form};
 const ledger=updateTaskDraft(baseLedger,taskInput,'2026-09-13T00:00:00.000Z');
 let record={schemaVersion:1,kind:'TASK_FORM_SAVE_INTENT',original:{requestId,binding,baseLedger,taskInput,checkpoint},outcome:kind==='pending'?null:kind==='committed'?{kind,ledger}:{kind},acknowledgment:null,executionAuthorized:false};
 let resolutions=0,acknowledgments=0;
 const store={readSaveIntent:async()=>structuredClone(record),readRevision:async()=>structuredClone(ledger),acknowledgeSaveIntent:async(_binding,id,ack)=>{assert.equal(id,requestId);acknowledgments++;record=validateTaskSaveIntent({...record,acknowledgment:{...ack,declarationSource:'browser-declared'}});return structuredClone(record);}};
 const recovery={list:async()=>structuredClone({history,records:[history.at(-1)]}),read:async()=>structuredClone(history.at(-1)),resolve:async input=>{resolutions++;history=appendTaskFormHistory(history,input,'resolve');return structuredClone(history.at(-1));}};
 return {binding,requestId,store,recovery,ledger,record:()=>record,history:()=>history,counts:()=>({resolutions,acknowledgments}),resolve:reason=>recovery.resolve({binding,editorId,expectedRevision:1,reason})};
}
test('committed original reconciles exact history and retains request; repeated review is idempotent',async()=>{
 const f=fixture(),original=structuredClone(f.record().original),saved=structuredClone(f.ledger);
 const first=await reconcileTaskFormIntent(f),second=await reconcileTaskFormIntent(f);
 assert.deepEqual(first,second);assert.deepEqual(first.original,original);assert.deepEqual(first.outcome.ledger,saved);assert.equal(first.acknowledgment.editorDisposition.resolution,'saved');assert.equal(f.history().length,2);assert.equal(f.counts().resolutions,1);
});
test('committed original preserves peer discarded disposition unchanged',async()=>{
 const f=fixture();await f.resolve('discarded');const before=structuredClone(f.history());const result=await reconcileTaskFormIntent(f);
 assert.equal(result.acknowledgment.editorDisposition.resolution,'discarded');assert.deepEqual(f.history(),before);
});
test('withdrawn original closes as superseded without rewriting saved tasks',async()=>{
 const f=fixture('withdrawn');f.store.readRevision=()=>{throw Error('Withdrawal must not fetch or write a task');};const result=await reconcileTaskFormIntent(f);
 assert.equal(result.acknowledgment.editorDisposition.resolution,'superseded');assert.equal(f.history()[0].status,'unfinished');assert.equal(f.history()[1].form.title,'Original new task');
});
test('pending original refuses instead of inventing a saved or withdrawn outcome',async()=>{
 const f=fixture('pending');await assert.rejects(reconcileTaskFormIntent(f),/no recorded outcome/);assert.deepEqual(f.counts(),{resolutions:0,acknowledgments:0});
});
test('different exact historical Ledger refuses before editor disposition',async()=>{
 const f=fixture();f.store.readRevision=async()=>({...f.ledger,updatedAt:'2026-09-13T00:00:01.000Z'});await assert.rejects(reconcileTaskFormIntent(f),/does not match/);assert.deepEqual(f.counts(),{resolutions:0,acknowledgments:0});
});
test('unverifiable newer checkpoint refuses without clearing or acknowledging it',async()=>{
 const f=fixture();f.recovery.read=async()=>({...f.history()[0],revision:2,form:{...f.history()[0].form,title:'Newer editor'}});await assert.rejects(reconcileTaskFormIntent(f),/newer editor checkpoint/);assert.deepEqual(f.counts(),{resolutions:0,acknowledgments:0});
});
test('lost acknowledgment after commit can be reviewed again without another resolution',async()=>{
 const f=fixture(),ack=f.store.acknowledgeSaveIntent;let first=true;f.store.acknowledgeSaveIntent=async(...args)=>{const result=await ack(...args);if(first){first=false;throw Error('Reply lost');}return result;};
 await assert.rejects(reconcileTaskFormIntent(f),/Reply lost/);const result=await reconcileTaskFormIntent(f);assert.equal(result.acknowledgment.editorDisposition.resolution,'saved');assert.equal(f.counts().resolutions,1);
});
test('withdrawal does not reinterpret a conflicting saved editor as discarded',async()=>{
 const f=fixture('withdrawn');await f.resolve('saved');const before=structuredClone(f.history());await assert.rejects(reconcileTaskFormIntent(f),/conflicting disposition/);assert.deepEqual(f.history(),before);assert.equal(f.counts().acknowledgments,0);
});
test('binding is captured before asynchronous original lookup',async()=>{
 const f=fixture(),read=f.store.readSaveIntent;let release;f.store.readSaveIntent=()=>new Promise(resolve=>{release=async()=>resolve(await read());});const input={...f,binding:{...f.binding}},pending=reconcileTaskFormIntent(input);input.binding.rootIdentity='c'.repeat(64);await release();const result=await pending;assert.equal(result.original.binding.rootIdentity,'a'.repeat(64));
});
