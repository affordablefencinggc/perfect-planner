import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {readFile} from 'node:fs/promises';
import {createNativeTaskResultHost} from '../src/native/taskResultHost.js';
const grantId='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const project=()=>({projectId:'pp_result',registration:{workspaceId:'fixture',registryRevision:1,rootIdentity:'a'.repeat(64)},census:{digest:'b'.repeat(64)}});
const runtime={__TAURI_INTERNALS__:{invoke(){}}};
const value=()=>({schemaVersion:1,projectId:'pp_result',rootIdentity:'a'.repeat(64),grantId,runId:'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',taskId:'T0001',checkId:'unit',attemptId:'attempt1',attemptNumber:1,workerId:'worker1',state:'failure-observed',exitCode:7,failureReasons:['nonzero-exit'],artifactDigest:'c'.repeat(64),intentDigest:'d'.repeat(64),journalLinked:true,observationLinkDigest:'e'.repeat(64),cleanup:'unknown',authorityVerified:false,executionAuthorized:false,binding:{projectId:'pp_result',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)},transportCleanupComplete:true});
test('native result adapter forwards exact project identity and exposes no execution',async()=>{
 const p=project();let calls=0;
 const host=createNativeTaskResultHost(p,{runtime,invoke:async(command,args)=>{calls++;assert.equal(command,'inspect_native_task_result');assert.deepEqual(args,{request:{identity:{schemaVersion:1,workspaceId:'fixture',registryRevision:1,rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)},grantId}});return value();}});
 const result=await host.read({grantId});assert.equal(calls,1);assert.equal(result.state,'failure-observed');assert.equal(result.cleanup,'unknown');assert.equal(Object.isFrozen(result.failureReasons),true);
});
test('browser runtime and injected paths are refused without invoking native',async()=>{
 const invoke=()=>{throw Error('must not invoke');};
 await assert.rejects(createNativeTaskResultHost(project(),{runtime:{},invoke}).read({grantId}),/UNAVAILABLE/);
 for(const input of [{grantId,path:'C:/other'},{grantId,credentials:{}},{grantId,executionAuthorized:true},{grantId:'bad'}])await assert.rejects(createNativeTaskResultHost(project(),{runtime,invoke}).read(input),/UNAVAILABLE/);
});
test('native result adapter refuses stale, foreign, secret-bearing and fabricated result',async()=>{
 for(const patch of [{projectId:'foreign'},{grantId:'wrong'},{state:'passed'},{failureReasons:[]},{failureReasons:['unknown']},{failureReasons:['nonzero-exit','nonzero-exit']},{authorityVerified:true},{executionAuthorized:true},{transportCleanupComplete:false},{cleanup:'complete'},{stdout:'secret'},{attemptNumber:0},{binding:{...value().binding,censusDigest:'f'.repeat(64)}}]){
  await assert.rejects(createNativeTaskResultHost(project(),{runtime,invoke:async()=>({...value(),...patch})}).read({grantId}),/UNAVAILABLE/);
 }
 const p=project();await assert.rejects(createNativeTaskResultHost(p,{runtime,invoke:async()=>{p.registration.registryRevision++;return value();}}).read({grantId}),/UNAVAILABLE/);
});
test('project cancellation hides late native replies without claiming I/O cancellation',async()=>{
 const c=new AbortController();let finish,started;const invoked=new Promise(resolve=>{started=resolve;});
 const host=createNativeTaskResultHost(project(),{runtime,invoke:()=>{started();return new Promise(resolve=>{finish=resolve;});}});
 const read=host.read({grantId},{signal:c.signal});await invoked;c.abort();await assert.rejects(read,/UNAVAILABLE/);finish(value());
});
test('native errors do not expose arbitrary diagnostic text or retry a command',async()=>{let calls=0;const host=createNativeTaskResultHost(project(),{runtime,invoke:async()=>{calls++;throw {message:'secret',credentials:'secret'};}});await assert.rejects(host.read({grantId}),e=>e.message==='NATIVE_TASK_RESULT_UNAVAILABLE');assert.equal(calls,1);});
test('native result command is registered and restricted to the main local Windows window',async()=>{
 const read=async file=>readFile(new URL('../'+file,import.meta.url),'utf8');
 const cap=JSON.parse(await read('src-tauri/capabilities/main-task-results.json')),config=JSON.parse(await read('src-tauri/tauri.conf.json'));
 assert.deepEqual(cap.permissions,['allow-inspect-native-task-result','allow-list-native-task-results','allow-read-native-task-result-page']);assert.deepEqual(cap.windows,['main']);assert.deepEqual(cap.platforms,['windows']);assert.equal(cap.local,true);assert.equal(cap.remote,undefined);
 assert.match(await read('src-tauri/build.rs'),/"read_native_task_result_page"/);assert.match(await read('src-tauri/src/lib.rs'),/native_draft_commands::read_native_task_result_page,/);
 assert.ok(config.app.security.capabilities.includes('main-task-results'));
 assert.match(await read('src-tauri/build.rs'),/"inspect_native_task_result"/);
 assert.match(await read('src-tauri/src/lib.rs'),/native_draft_commands::inspect_native_task_result,/);
 assert.match(await read('src-tauri/build.rs'),/"list_native_task_results"/);assert.match(await read('src-tauri/src/lib.rs'),/native_draft_commands::list_native_task_results,/);
});
const indexPage=()=>({schemaVersion:1,kind:'NATIVE_TASK_RESULT_INDEX',projectId:'pp_result',rootIdentity:'a'.repeat(64),journalHead:{revision:1,headDigest:'c'.repeat(64)},offset:0,totalGrants:1,nextOffset:null,entries:[{grantId,taskId:'T0001',checkId:'unit',attemptId:'attempt1',attemptNumber:1,workerId:'worker1',lifecycleState:'issued',journalRevision:1,recordedAt:'2026-09-14T00:00:00.000Z',runId:null,intentDigest:null,artifactDigest:null}],authorityVerified:false,executionAuthorized:false,binding:value().binding,transportCleanupComplete:true});
test('native index adapter returns only the bound historical snapshot',async()=>{
 const host=createNativeTaskResultHost(project(),{runtime,invoke:async(command,args)=>{assert.equal(command,'list_native_task_results');assert.equal(args.request.offset,0);assert.equal(args.request.expectedHeadDigest,null);return indexPage();}});
 const page=await host.list();assert.equal(page.entries[0].lifecycleState,'issued');assert.equal(page.authorityVerified,false);assert.equal(Object.isFrozen(page.entries),true);assert.equal(page.binding,undefined);
});
test('native index adapter rejects malformed pagination, authority and leaked fields',async()=>{
 for(const patch of [{projectId:'other'},{offset:1},{totalGrants:2},{nextOffset:1},{authorityVerified:true},{credentials:'secret'},{journalHead:{revision:0,headDigest:'GENESIS'}}])await assert.rejects(createNativeTaskResultHost(project(),{runtime,invoke:async()=>({...indexPage(),...patch})}).list());
 for(const patch of [{lifecycleState:'passed'},{runId:grantId},{recordedAt:'yesterday'},{journalRevision:2},{sessionId:'secret'}])await assert.rejects(createNativeTaskResultHost(project(),{runtime,invoke:async()=>{const page=indexPage();Object.assign(page.entries[0],patch);return page;}}).list());
});
test('native index stale-head error requires explicit refresh, never an automatic retry',async()=>{
 let calls=0;const host=createNativeTaskResultHost(project(),{runtime,invoke:async()=>{calls++;throw {code:'NATIVE_TASK_INDEX_STALE',executionAuthorized:false};}});
 await assert.rejects(host.list({offset:20,expectedHeadDigest:'c'.repeat(64)}),e=>e.code==='NATIVE_TASK_INDEX_STALE');assert.equal(calls,1);
});
const outcomePage=()=>{const page=indexPage(),v=value();Object.assign(page.entries[0],{lifecycleState:'result-recorded',runId:v.runId,intentDigest:v.intentDigest,artifactDigest:v.artifactDigest});return {page,outcomes:[{grantId,phase:'ready',value:v}],binding:v.binding,transportCleanupComplete:true};};
test('native outcome page uses one invocation for references and validated summaries',async()=>{
 let calls=0;const host=createNativeTaskResultHost(project(),{runtime,invoke:async(command,args)=>{calls++;assert.equal(command,'read_native_task_result_page');assert.equal(args.request.offset,0);return outcomePage();}});
 const r=await host.readPage();assert.equal(calls,1);assert.equal(r.outcomes[0].value.exitCode,7);assert.equal(r.outcomes[0].value.authorityVerified,false);assert(Object.isFrozen(r.outcomes));
});
test('native outcome page rejects missing, duplicated, reordered and foreign outcomes',async()=>{
 const changes=[r=>r.outcomes=[],r=>r.outcomes.push(r.outcomes[0]),r=>r.outcomes[0].value.workerId='other',r=>r.outcomes[0].value.intentDigest='e'.repeat(64),r=>r.outcomes[0].value.artifactDigest='e'.repeat(64),r=>r.outcomes[0].phase='passed',r=>r.outcomes[0].value.stdout='secret',r=>r.page.binding.censusDigest='f'.repeat(64),r=>r.transportCleanupComplete=false,r=>r.outcomes[0].value.transportCleanupComplete=false];
 for(const change of changes){const r=outcomePage();change(r);await assert.rejects(createNativeTaskResultHost(project(),{runtime,invoke:async()=>r}).readPage(),/UNAVAILABLE/);}
 const r=outcomePage();r.outcomes[0]={grantId,phase:'unavailable',value:null};assert.equal((await createNativeTaskResultHost(project(),{runtime,invoke:async()=>r}).readPage()).outcomes[0].value,null);
});
