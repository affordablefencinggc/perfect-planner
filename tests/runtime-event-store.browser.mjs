import { createRuntimeEventStore } from '../src/runtime/runtimeEventStore.js';
import { createRuntimeEventCodec, createRuntimeEventMemoryStorage, DEFAULT_RUNTIME_EVENT_STORAGE_KEY } from '../src/runtime/runtimeEventLedger.js';

const require = (condition, label) => { if (!condition) throw new Error(label); };
const input = (id, projectId = 'pp_store_test') => ({ eventId: `evt_${id}`, projectId, adapter: 'browser-ui', generation: 0, source: 'runtime', severity: 'error', message: id });
const expectReject = async (promise) => { try { await promise; } catch { return; } throw new Error('Expected refusal'); };
const rawRead = (db, key) => new Promise((resolve,reject) => { const tx=db.transaction('history','readonly'),req=tx.objectStore('history').get(key);tx.oncomplete=()=>resolve(req.result);tx.onabort=()=>reject(tx.error); });
const rawPut = (db, key, value) => new Promise((resolve,reject) => { const tx=db.transaction('history','readwrite');tx.objectStore('history').put(value,key);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error); });
const openDb = (name) => new Promise((resolve,reject)=>{const req=indexedDB.open(name);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});

// Run in an isolated real browser origin. These are own synthetic histories only.
export async function runRuntimeEventStoreScenarios(prefix) {
  const checks=[];
  const stores=[];
  const make=(suffix, options={})=>{const store=createRuntimeEventStore({name:`${prefix}-${suffix}`,legacyStorage:createRuntimeEventMemoryStorage(),...options});stores.push(store);return store;};
  try {
    const a=make('concurrent'), b=make('concurrent');
    await Promise.all([a.read(),b.read()]);
    await Promise.all(Array.from({length:40},(_,i)=>(i%2?a:b).append(input(`parallel_${i}`))));
    let snapshot=await a.read();
    require(snapshot.envelope.revision===40 && snapshot.envelope.events.length===40,'Concurrent events lost');
    checks.push('40 competing writes from independent connections survive with exact revision');
    const outcomes=await Promise.allSettled([a.clear('pp_store_test',40),b.clear('pp_store_test',40)]);
    require(outcomes.filter(o=>o.status==='fulfilled').length===1,'Stale clear succeeded');
    await b.append(input('after_clear','pp_other_test'));
    await expectReject(a.clear('pp_other_test',41));
    require((await a.read()).envelope.events.length===1,'Stale clear erased newer event');
    checks.push('Competing clears yield one commit; reviewed stale revision cannot erase newer events');

    const codec=createRuntimeEventCodec();
    const original=JSON.stringify(codec.append(codec.empty(),codec.capture(input('legacy_original'))));
    const legacy=createRuntimeEventMemoryStorage({[DEFAULT_RUNTIME_EVENT_STORAGE_KEY]:original});
    const m1=make('migration',{legacyStorage:legacy}),m2=make('migration',{legacyStorage:legacy});
    const migrated=await Promise.all([m1.read(),m2.read()]);
    require(migrated.every(s=>s.envelope.events.length===1),'Migration duplicated events');
    require(migrated[0].migration.fingerprint===migrated[1].migration.fingerprint,'Migration marker mismatch');
    require(legacy.getItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY)===original,'Legacy was rewritten');
    await m1.clear('pp_store_test',1);
    const changed=JSON.stringify(codec.append(codec.empty(),codec.capture(input('late_legacy'))));
    legacy.setItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY,changed);
    const m3=make('migration',{legacyStorage:legacy});
    const afterLegacyChange=await m3.read();
    require(afterLegacyChange.envelope.events.length===0,'Cleared history resurrected from legacy');
    require(afterLegacyChange.legacyStatus==='changed-recovery-needed','Changed legacy silently ignored');
    require((await m1.read()).legacyStatus==='changed-recovery-needed','Existing connection missed legacy change');
    legacy.setItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY,'{unreadable');
    const unreadableLegacy=await m1.read();
    require(unreadableLegacy.legacyStatus==='unreadable-recovery-needed' && unreadableLegacy.envelope.events.length===0,'Unreadable changed legacy hid recovery or reset history');
    checks.push('Concurrent snapshot migration commits once; legacy untouched; reopen never reimports after clear');

    let abortNext=false;
    const proxy={open(...args){const request=indexedDB.open(...args);return new Proxy(request,{get(target,key){if(key==='result'){const db=target.result;return new Proxy(db,{get(real,prop){if(prop==='transaction')return(...options)=>{const tx=real.transaction(...options);if(abortNext){abortNext=false;queueMicrotask(()=>tx.abort());}return tx;};const value=real[prop];return typeof value==='function'?value.bind(real):value;},set(real,prop,value){real[prop]=value;return true;}});}const value=target[key];return typeof value==='function'?value.bind(target):value;},set(target,key,value){target[key]=value;return true;}});}};
    const fault=make('aborted',{indexedDB:proxy});
    await fault.append(input('survives_abort'));
    const retained=fault.capture(input('must_not_commit'));
    abortNext=true;await expectReject(fault.appendCaptured(retained));
    require(retained.eventId==='evt_must_not_commit','Pending identity lost');
    require((await fault.read()).envelope.events.map(e=>e.message).join(',')==='survives_abort','Abort changed committed head');
    checks.push('Injected transaction abort preserves previous head and rejects append');

    const migrationAbort=make('migration-abort',{indexedDB:proxy,legacyStorage:createRuntimeEventMemoryStorage({[DEFAULT_RUNTIME_EVENT_STORAGE_KEY]:original})});
    abortNext=true;await expectReject(migrationAbort.read());
    const abortedDb=await openDb(`${prefix}-migration-abort`);
    require(await rawRead(abortedDb,'head')===undefined && await rawRead(abortedDb,'migration')===undefined,'Partial migration survived abort');
    abortedDb.close();
    require((await migrationAbort.read()).envelope.events.length===1,'Migration could not retry after rollback');
    checks.push('Aborted migration commits neither marker nor head; retry imports one snapshot');

    const corrupt=make('corrupt');await corrupt.read();
    const db=await openDb(`${prefix}-corrupt`);
    const future={...(await rawRead(db,'head')),schemaVersion:99};
    await rawPut(db,'head',future);
    await expectReject(corrupt.append(input('refused_future')));
    require(JSON.stringify(await rawRead(db,'head'))===JSON.stringify(future),'Future head rewritten');
    await rawPut(db,'head',null);await expectReject(corrupt.read());
    require(await rawRead(db,'head')===null,'Malformed history reset');db.close();
    checks.push('Future and malformed stored heads are refused without reset');

    const badMarker=make('marker');await badMarker.append(input('marker_preserved'));
    const markerDb=await openDb(`${prefix}-marker`);
    const preservedHead=await rawRead(markerDb,'head');
    await rawPut(markerDb,'migration',{schemaVersion:99,fingerprint:null});
    await expectReject(badMarker.append(input('bad_marker_refused')));
    require(JSON.stringify(await rawRead(markerDb,'head'))===JSON.stringify(preservedHead),'Invalid migration marker allowed mutation');
    markerDb.close();checks.push('Invalid migration metadata refuses mutation and preserves existing head');

    const brokenLegacy=createRuntimeEventMemoryStorage({[DEFAULT_RUNTIME_EVENT_STORAGE_KEY]:'{broken'});
    await expectReject(make('bad-legacy',{legacyStorage:brokenLegacy}).read());
    require(brokenLegacy.getItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY)==='{broken','Bad legacy deleted');
    await expectReject(make('unavailable',{indexedDB:null}).read());
    checks.push('Unreadable legacy and unavailable storage reject without erasing source');

    const denied=createRuntimeEventStore({name:`${prefix}-denied-getter`});stores.push(denied);
    const descriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
    try {
      Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw new DOMException('Denied fixture','SecurityError');}});
      await expectReject(denied.read());
    } finally { Object.defineProperty(globalThis,'localStorage',descriptor); }
    require((await denied.read()).legacyStatus==='snapshot-matches','Restored getter did not recover');
    try {
      Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw new DOMException('Denied fixture','SecurityError');}});
      require((await denied.read()).legacyStatus==='unreadable-recovery-needed','Existing history swallowed getter denial');
    } finally { Object.defineProperty(globalThis,'localStorage',descriptor); }
    checks.push('Denied legacy getter is not treated as empty; restoring access permits fresh observation');

    const capture=make('capture');
    const mutable={...input('captured'),payload:{password:'fixture'}};
    const pending=capture.append(mutable);mutable.projectId='pp_wrong_test';mutable.payload.password='changed';
    const captured=await pending;
    require(captured.event.projectId==='pp_store_test' && captured.event.payload.password==='[REDACTED]','Capture changed across await');
    checks.push('Project identity and redacted payload captured before asynchronous work');

    let notifications=0;
    const off=capture.subscribe(()=>notifications++);
    await capture.append(input('notify_commit'));
    require(notifications>0,'No post-commit notification');off();
    checks.push('Commit delivers a refresh hint without exposing records');
    return checks;
  } finally { await Promise.all(stores.map(s=>s.close().catch(()=>{}))); }
}

export function createCrossTabStore(name) { return createRuntimeEventStore({name,legacyStorage:createRuntimeEventMemoryStorage()}); }
export { input as syntheticEvent };
