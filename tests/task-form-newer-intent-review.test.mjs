import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyTaskDraftLedger,updateTaskDraft} from '../src/project/taskDraftLedger.js';
import {appendTaskFormHistory} from '../src/project/taskFormRecovery.js';
import {validateTaskSaveIntent} from '../src/project/taskFormSaveIntent.js';
import {reconcileTaskFormIntent} from '../src/project/taskFormIntentReconciliation.js';

function fixture(kind='committed') {
 const binding={projectId:'pp_newer_intent_review',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)},editorId='editor-newer-review',requestId='request-newer-review';
 const form={id:null,title:'Original task',description:'Original raw text',owner:'',acceptance:'',recovery:'',claims:'',dependsOn:'',archived:false};
 let history=appendTaskFormHistory([],{binding,editorId,expectedRevision:0,baseLedgerRevision:0,form},'put');
 const baseLedger=emptyTaskDraftLedger(binding),taskInput={...form,claims:[],dependsOn:[]},ledger=updateTaskDraft(baseLedger,taskInput,'2026-09-13T00:00:00.000Z');
 let record={schemaVersion:1,kind:'TASK_FORM_SAVE_INTENT',original:{requestId,binding,baseLedger,taskInput,checkpoint:{binding,editorId,revision:1,baseLedgerRevision:0,form}},outcome:kind==='committed'?{kind,ledger}:{kind},acknowledgment:null,executionAuthorized:false},calls={resolve:0,ack:0};
 const store={readSaveIntent:async()=>structuredClone(record),readRevision:async()=>structuredClone(ledger),acknowledgeSaveIntent:async(_binding,id,evidence)=>{calls.ack++;assert.equal(id,requestId);const next=validateTaskSaveIntent({...record,acknowledgment:{...evidence,declarationSource:'browser-declared'}});if(record.acknowledgment)assert.deepEqual(next,record);record=structuredClone(next);return structuredClone(record);}};
 const recovery={list:async()=>({history:structuredClone(history),records:[structuredClone(history.at(-1))]}),read:async()=>structuredClone(history.at(-1)),resolve:async()=>{calls.resolve++;throw Error('Newer editor must not be resolved');}};
 const advance=(title='Newer text',base=0)=>{history=appendTaskFormHistory(history,{binding,editorId,expectedRevision:history.at(-1).revision,baseLedgerRevision:base,form:{...form,title}},'put');};
 const resolve=()=>{history=appendTaskFormHistory(history,{binding,editorId,expectedRevision:history.at(-1).revision,reason:'discarded'},'resolve');};
 return {binding,requestId,store,recovery,advance,resolve,calls,history:()=>structuredClone(history),record:()=>structuredClone(record)};
}

for(const kind of ['committed','withdrawn'])test(`${kind} original acknowledges newer text without resolving or rewriting it`,async()=>{
 const f=fixture(kind);f.advance();const before=f.history(),original=f.record().original;
 const result=await reconcileTaskFormIntent(f);
 assert.deepEqual(result.original,original);assert.deepEqual(result.acknowledgment.newerEditorPreserved,{originalCheckpoint:before[0],laterCheckpoint:before[1]});assert.deepEqual(f.history(),before);assert.equal(f.calls.resolve,0);assert.equal(result.executionAuthorized,false);
});

test('later resolved checkpoint and reviewed higher base remain immutable',async()=>{
 const f=fixture();f.advance('Reviewed newer text',1);f.resolve();const before=f.history();const result=await reconcileTaskFormIntent(f);
 assert.deepEqual(result.acknowledgment.newerEditorPreserved.laterCheckpoint,before.at(-1));assert.deepEqual(f.history(),before);assert.equal(f.calls.resolve,0);
});

test('gapped recovery history refuses before acknowledgment',async()=>{
 const f=fixture();f.advance();f.advance('Third');f.recovery.list=async()=>({history:[f.history()[0],f.history()[2]],records:[f.history()[2]]});await assert.rejects(reconcileTaskFormIntent(f));assert.equal(f.calls.ack,0);assert.equal(f.calls.resolve,0);
});

test('valid history with substituted original text refuses acknowledgment',async()=>{
 const f=fixture();f.advance();const altered=f.history();altered[0].form.title='Not original';f.recovery.list=async()=>({history:altered,records:[altered.at(-1)]});await assert.rejects(reconcileTaskFormIntent(f));assert.equal(f.calls.ack,0);assert.equal(f.calls.resolve,0);
});

test('newer editor does not bypass exact saved Ledger verification',async()=>{
 const f=fixture();f.advance();const read=f.store.readRevision;f.store.readRevision=async()=>({...await read(),updatedAt:'2026-09-13T01:00:00.000Z'});await assert.rejects(reconcileTaskFormIntent(f));assert.equal(f.calls.ack,0);assert.equal(f.calls.resolve,0);
});

test('lost acknowledgment retry returns original evidence after editor advances again',async()=>{
 const f=fixture();f.advance();const ack=f.store.acknowledgeSaveIntent;let lose=true;f.store.acknowledgeSaveIntent=async(...args)=>{const result=await ack(...args);if(lose){lose=false;throw Error('Acknowledgment reply lost');}return result;};
 await assert.rejects(reconcileTaskFormIntent(f),/reply lost/);const retained=f.record();f.advance('After acknowledgment');const result=await reconcileTaskFormIntent(f);assert.deepEqual(result,retained);assert.equal(f.history().at(-1).form.title,'After acknowledgment');assert.equal(f.calls.resolve,0);
});

test('newer evidence from another editor cannot validate as preserved original',()=>{
 const f=fixture();f.advance();const [originalCheckpoint,laterCheckpoint]=f.history();assert.throws(()=>validateTaskSaveIntent({...f.record(),acknowledgment:{declarationSource:'browser-declared',newerEditorPreserved:{originalCheckpoint,laterCheckpoint:{...laterCheckpoint,editorId:'another-editor-identity'}}}}));
});

test('acknowledged record still refuses missing preserved recovery evidence',async()=>{
 const f=fixture();f.advance();await reconcileTaskFormIntent(f);const retained=f.record(),before=f.calls.ack;f.recovery.list=async()=>({history:[],records:[]});await assert.rejects(reconcileTaskFormIntent(f));assert.deepEqual(f.record(),retained);assert.equal(f.calls.ack,before);assert.equal(f.calls.resolve,0);
});
