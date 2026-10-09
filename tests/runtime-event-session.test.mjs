import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeEventSession } from '../src/runtime/runtimeEventSession.js';
import { createRuntimeEventCodec } from '../src/runtime/runtimeEventLedger.js';
import { createRuntimeEventStore } from '../src/runtime/runtimeEventStore.js';
const codec=createRuntimeEventCodec(), scope='pp_session_test', globalScope='pp_global_test';
const event=message=>({projectId:scope,adapter:'browser-ui',generation:1,source:'runtime',severity:'error',message,payload:{password:'fixture'}});
const defer=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

test('a queued storage open times out, retains pending export and closes a late connection without writing',async()=>{
 const requests=[];
 const store=createRuntimeEventStore({indexedDB:{open(){const r={};requests.push(r);return r;}},legacyStorage:{getItem:()=>null},openTimeoutMs:10});
 const session=createRuntimeEventSession({store});
 const captured=session.append(event('queued open'));
 await session.settled();
 assert.equal(session.getSnapshot(scope).pending[0].state,'unsaved');
 let closed=0,transactions=0;
 requests[0].result={close(){closed++;},transaction(){transactions++;throw Error('Late write forbidden');}};
 requests[0].onsuccess();
 assert.equal(closed,1);assert.equal(transactions,0);
 const report=await session.exportReport(scope,globalScope);
 assert.equal(report.project.pending[0].eventId,captured.eventId);
 assert.equal(report.project.pending[0].state,'unsaved');
 assert.equal(report.health.persistence,'memory');
 assert.equal(requests.length,2,'A later read makes a fresh bounded attempt');
});
test('an abandoned queued upgrade aborts before creating any store',async()=>{
 let request;
 const store=createRuntimeEventStore({indexedDB:{open(){return request={};}},legacyStorage:{getItem:()=>null},openTimeoutMs:10});
 await assert.rejects(store.read(),{code:'diagnostic-storage-open-timeout'});
 let aborted=0,created=0;
 request.transaction={abort(){aborted++;}};request.result={createObjectStore(){created++;}};
 request.onupgradeneeded();
 assert.equal(aborted,1);assert.equal(created,0);
});
test('blocked storage rejects immediately and does not revive on late success',async()=>{
 let request;
 const store=createRuntimeEventStore({indexedDB:{open(){return request={};}},legacyStorage:{getItem:()=>null},openTimeoutMs:1000});
 const reading=store.read();
 await Promise.resolve();await Promise.resolve();
 request.onblocked();
 await assert.rejects(reading,{code:'diagnostic-storage-blocked'});
 let closed=0;request.result={close(){closed++;}};request.onsuccess();assert.equal(closed,1);
});
test('timeout aborts an upgrade that started before the deadline',async()=>{
 let request,aborted=0,created=0;
 const store=createRuntimeEventStore({indexedDB:{open(){return request={};}},legacyStorage:{getItem:()=>null},openTimeoutMs:10});
 const reading=store.read();await Promise.resolve();await Promise.resolve();
 request.transaction={abort(){aborted++;}};
 request.result={createObjectStore(){created++;}};
 request.onupgradeneeded();assert.equal(created,1);
 await assert.rejects(reading,{code:'diagnostic-storage-open-timeout'});
 assert.equal(aborted,1,'The active upgrade must be aborted, not just its future connection closed');
});
function harness(){let head=codec.empty();const writes=[],reads=[];let hint;const store={read:()=>{const d=defer();reads.push(d);return d.promise;},appendCaptured:e=>{const d=defer();writes.push({e,...d});return d.promise;},subscribe:fn=>{hint=fn;return()=>{hint=null;};}};return {session:createRuntimeEventSession({store}),reads,writes,hint:()=>hint?.(),result:()=>({envelope:head,legacyStatus:'snapshot-matches'}),advance:e=>{head=codec.append(head,e);return {envelope:head,legacyStatus:'snapshot-matches'};}};}
test('initial diagnostics are loading, not empty durable history',async()=>{const h=harness();assert.equal(h.session.getHealth().reason,'history-loading');const r=h.session.refresh();h.reads[0].resolve(h.result());await r;assert.equal(h.session.getHealth().persistence,'durable');});
test('failed append retains sanitized exact event for export',async()=>{const h=harness();const e=h.session.append(event('failure'));await Promise.resolve();h.writes[0].reject(new Error('aborted'));await h.session.settled();assert.equal(h.session.getSnapshot(scope).pending[0].state,'unsaved');const report=h.session.exportReport(scope,globalScope);h.reads[0].resolve(h.result());const data=await report;assert.equal(data.project.events[0].eventId,e.eventId);assert.equal(data.project.events[0].payload.password,'[REDACTED]');assert.equal(data.health.persistence,'memory');});
test('unsubscribing a view does not cancel pending commit',async()=>{const h=harness();const off=h.session.subscribe(scope,()=>{});h.reads[0].resolve(h.result());const e=h.session.append(event('late'));off();await Promise.resolve();h.writes[0].resolve(h.advance(e));await h.session.settled();assert.equal(h.session.getSnapshot(scope).pending.length,0);assert.equal(h.session.list(scope)[0].eventId,e.eventId);});
test('out-of-order successful reads cannot replace a newer revision',async()=>{const h=harness();const old=h.result(),e=codec.capture(event('new'));const a=h.session.refresh(),b=h.session.refresh();h.reads[1].resolve(h.advance(e));await b;h.reads[0].resolve(old);await a;assert.equal(h.session.list(scope)[0].eventId,e.eventId);});
test('older read failure cannot invalidate a newer successful read',async()=>{const h=harness();const a=h.session.refresh(),b=h.session.refresh();h.reads[1].resolve(h.result());await b;h.reads[0].reject(new Error('old'));await a;assert.equal(h.session.getHealth().persistence,'durable');});
test('older same-revision read cannot remove a newer legacy warning',async()=>{const h=harness();const a=h.session.refresh(),b=h.session.refresh();h.reads[1].resolve({...h.result(),legacyStatus:'changed-recovery-needed'});await b;h.reads[0].resolve(h.result());await a;assert.equal(h.session.getHealth().reason,'legacy-recovery-needed');});
test('export captures original project and includes global scope coherently',async()=>{const h=harness();h.session.append(event('project'));h.session.append({...event('global'),projectId:globalScope});const report=h.session.exportReport(scope,globalScope);h.reads[0].resolve(h.result());const data=await report;assert.equal(data.project.projectId,scope);assert.equal(data.project.events.length,1);assert.equal(data.global.events.length,1);await Promise.resolve();for(const w of h.writes)w.reject(new Error('fixture'));await h.session.settled();});
test('rejected same-ID pending event cannot hide a different saved event from export',async()=>{const h=harness();const saved=codec.capture({...event('original saved'),eventId:'evt_same_identifier'});h.advance(saved);h.session.append({...event('different unsaved'),eventId:saved.eventId});await Promise.resolve();h.writes[0].reject(new Error('duplicate'));await h.session.settled();const report=h.session.exportReport(scope,globalScope);h.reads[0].resolve(h.result());const data=await report;assert.deepEqual(data.project.events.map(e=>e.message),['original saved','different unsaved']);assert.equal(data.project.savedEvents[0].message,'original saved');assert.equal(data.project.pending[0].event.message,'different unsaved');assert.equal(data.project.pending[0].conflictsWithSaved,true);});
test('late save cannot clear newer legacy recovery warning',async()=>{const h=harness();const e=h.session.append(event('slow save'));await Promise.resolve();const r=h.session.refresh();h.reads[0].resolve({...h.result(),legacyStatus:'changed-recovery-needed'});await r;h.writes[0].resolve(h.advance(e));await h.session.settled();assert.equal(h.session.getHealth().reason,'legacy-recovery-needed');const fresh=h.session.refresh();h.reads[1].resolve(h.result());await fresh;assert.equal(h.session.getHealth().reason,'storage-ready');});

for(const ending of ['sk','rk','pk'])test(`generated event ID remains valid when timestamp ends ${ending}`,()=>{
 const timestamp=Math.floor(1790000000000/1296)*1296+parseInt(ending,36);
 assert.ok(timestamp.toString(36).endsWith(ending));
 const generated=createRuntimeEventCodec({now:()=>timestamp});
 const captured=generated.capture(event('generated identity'));
 assert.equal(captured.timestamp,new Date(timestamp).toISOString());
 assert.equal(generated.append(generated.empty(),captured).events[0].eventId,captured.eventId);
 assert.throws(()=>generated.capture({...event('reject caller secret'),eventId:'evt_sk_1234567890123456'}),{code:'runtime-event-sensitive-identifier'});
});
