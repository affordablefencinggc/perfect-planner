import test from 'node:test';
import assert from 'node:assert/strict';
import fs,{link,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {createNativeReviewPresentationStore} from '../src/node/nativeReviewPresentationStore.mjs';

async function fixture(limits={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'pp-native-presentation-'));
  const config={journalPath:path.join(root,'presentations.jsonl'),projectId:'pp_presentation_fixture',rootIdentity:'a'.repeat(64),...limits};
  const binding={projectId:config.projectId,rootIdentity:config.rootIdentity,requestId:'review-1',proposalRevision:3,proposalDigest:'b'.repeat(64),checkContractDigest:'c'.repeat(64),source:'controlled-host-review'};
  return {root,config,binding,store:createNativeReviewPresentationStore(config)};
}
const begin=(operationId='begin-1',expectedRevision=0)=>({operationId,expectedRevision});
const close=(operationId='close-1',expectedRevision=1)=>({operationId,expectedRevision,closureEvidenceDigest:'d'.repeat(64)});

test('unresolved presentation survives reopen with immutable exact binding and no authority claim',async()=>{
  const f=await fixture(),binding=structuredClone(f.binding),request=begin();
  const work=f.store.begin(binding,request);binding.source='late mutation';request.operationId='late';
  const result=await work;
  assert.equal(result.record.binding.source,f.binding.source);assert.equal(result.record.operationId,'begin-1');
  assert.equal(result.presentation.status,'unresolved');assert.equal(result.executionAuthorized,false);assert.equal(result.nativeGestureVerified,false);
  const state=await createNativeReviewPresentationStore(f.config).inspect();
  assert.deepEqual(state.unresolved,result.record);assert.equal(state.revision,1);assert.equal(Object.isFrozen(state.unresolved.binding),true);
  await assert.rejects(f.store.begin({...f.binding,requestId:'review-2'},begin('second',1)),/UNRESOLVED/);
  assert.equal((await f.store.inspect()).revision,1);
});

test('exact closure survives restart and historical begin retries cannot reopen closed dialogs',async()=>{
  const f=await fixture();await f.store.begin(f.binding,begin());
  const closed=await createNativeReviewPresentationStore(f.config).close(f.binding,close());
  assert.equal(closed.presentation.status,'closed');assert.equal(closed.presentation.closed.closureEvidenceDigest,'d'.repeat(64));
  const restarted=createNativeReviewPresentationStore(f.config);
  assert.equal((await restarted.inspect()).unresolved,null);
  const retried=await restarted.begin(f.binding,begin());
  assert.equal(retried.idempotent,true);assert.equal(retried.presentation.status,'closed');assert.equal(retried.revision,2);
  assert.equal((await restarted.close(f.binding,close())).idempotent,true);
  await assert.rejects(restarted.begin(f.binding,begin('cannot-reopen',2)),/ALREADY_PRESENTED/);
  await assert.rejects(restarted.close(f.binding,close('second-close',2)),/CLOSURE_MISMATCH/);
  await restarted.begin({...f.binding,requestId:'review-2'},begin('begin-2',2));
  assert.equal((await restarted.inspect()).unresolved.binding.requestId,'review-2');
});

test('concurrent begin and close serialize with CAS and exact operation retries',async()=>{
  const f=await fixture();
  const begins=await Promise.allSettled(['a','b'].map(name=>f.store.begin(f.binding,begin(name))));
  assert.equal(begins.filter(value=>value.status==='fulfilled').length,1);
  assert.match(begins.find(value=>value.status==='rejected').reason.message,/STALE_HEAD/);
  const closes=await Promise.all([f.store.close(f.binding,close()),f.store.close(f.binding,close())]);
  assert.deepEqual(closes.map(value=>value.idempotent).sort(),[false,true]);
  await assert.rejects(f.store.close(f.binding,{...close(),closureEvidenceDigest:'e'.repeat(64)}),/REQUEST_CONFLICT/);
  assert.equal((await f.store.inspect()).revision,2);
});

test('all binding dimensions must match before host-confirmed closure',async()=>{
  const f=await fixture();await f.store.begin(f.binding,begin());
  for(const [key,value] of Object.entries({projectId:'pp_foreign_project',rootIdentity:'e'.repeat(64),requestId:'other',proposalRevision:4,proposalDigest:'e'.repeat(64),checkContractDigest:'e'.repeat(64),source:'foreign-host'})){
    await assert.rejects(f.store.close({...f.binding,[key]:value},close()),/BINDING_INVALID|CLOSURE_MISMATCH/);
  }
  assert.equal((await f.store.inspect()).unresolved.binding.requestId,'review-1');
  await f.store.close(f.binding,close());
});

test('strict schemas refuse renderer-like authority additions and malformed bounds without writes',async()=>{
  const f=await fixture();
  for(const patch of [{executionAuthorized:true},{proposalRevision:0},{proposalDigest:'bad'},{source:' bad '},{source:'x\n'},{source:'x'.repeat(257)},{requestId:'../escape'}])await assert.rejects(f.store.begin({...f.binding,...patch},begin()));
  for(const request of [{...begin(),closed:true},begin('',0),begin('b',-1)])await assert.rejects(f.store.begin(f.binding,request));
  assert.equal((await f.store.inspect()).revision,0);
  await f.store.begin(f.binding,begin());
  await assert.rejects(f.store.close(f.binding,{...close(),closureEvidenceDigest:'invalid'}),/REQUEST_INVALID/);
  assert.equal((await f.store.inspect()).revision,1);
});

test('closure quota is reserved before begin and quota failure preserves recorded history',async()=>{
  const tooSmall=await fixture({maxRecords:1});
  await assert.rejects(tooSmall.store.begin(tooSmall.binding,begin()),/CLOSURE_CAPACITY/);
  assert.equal((await tooSmall.store.inspect()).revision,0);
  const f=await fixture({maxRecords:2});await f.store.begin(f.binding,begin());await f.store.close(f.binding,close());
  const before=await readFile(f.config.journalPath);
  await assert.rejects(f.store.begin({...f.binding,requestId:'review-2'},begin('begin-2',2)),/QUOTA/);
  assert.deepEqual(await readFile(f.config.journalPath),before);
  assert.equal((await f.store.close(f.binding,close())).idempotent,true);
  const bytes=await fixture({maxBytes:1});await assert.rejects(bytes.store.begin(bytes.binding,begin()),/QUOTA/);
  assert.equal((await bytes.store.inspect()).revision,0);
});

test('partial, altered, duplicated and foreign-project journal data remains preserved and refused',async()=>{
  const f=await fixture();await f.store.begin(f.binding,begin());const original=await readFile(f.config.journalPath,'utf8');
  const changed=JSON.parse(original);changed.binding.source='other';
  for(const value of ['',original.slice(0,-1),`${original}${original}`,`${JSON.stringify(changed)}\n`,'{broken}\n']){
    await writeFile(f.config.journalPath,value);await assert.rejects(f.store.inspect());await assert.rejects(f.store.close(f.binding,close()));
    assert.equal(await readFile(f.config.journalPath,'utf8'),value);
  }
  await writeFile(f.config.journalPath,original);
  await assert.rejects(createNativeReviewPresentationStore({...f.config,projectId:'pp_other_project'}).inspect(),/BINDING_INVALID/);
  assert.equal(await readFile(f.config.journalPath,'utf8'),original);
});

test('hardlinked journal, redirected ancestors and lock aliases are refused',async()=>{
  const f=await fixture();await f.store.begin(f.binding,begin());
  const alias=path.join(f.root,'hardlink.jsonl');await link(f.config.journalPath,alias);
  await assert.rejects(f.store.inspect(),/UNSAFE_FILE/);await rm(alias);
  const directoryAlias=`${f.root}-alias`;
  await symlink(f.root,directoryAlias,process.platform==='win32'?'junction':'dir');
  await assert.rejects(createNativeReviewPresentationStore({...f.config,journalPath:path.join(directoryAlias,'presentations.jsonl')}).inspect(),/UNSAFE_PATH/);
  await symlink(f.root,`${f.config.journalPath}.pp-lock`,process.platform==='win32'?'junction':'dir');
  await assert.rejects(f.store.inspect(),/UNSAFE_LOCK/);
});

test('failed flush preserves uncertainty, original error, and exact retry reflushes without duplicate transitions',async t=>{
  const f=await fixture(),actualOpen=fs.open;let broken=true,flushes=0;
  const mock=t.mock.method(fs,'open',async(...args)=>{
    const handle=await actualOpen(...args);
    if(args[0]===f.config.journalPath&&(args[1]&1)){
      const sync=handle.sync.bind(handle),closeHandle=handle.close.bind(handle);
      handle.sync=async()=>{flushes++;if(broken)throw Error('First flush failure');return sync();};
      handle.close=async()=>{await closeHandle();if(broken)throw Error('Secondary close failure');};
    }
    return handle;
  });syncBuiltinESMExports();
  try{
    await assert.rejects(f.store.begin(f.binding,begin()),/First flush failure/);
    assert.equal((await f.store.inspect()).unresolved.binding.requestId,f.binding.requestId);
    broken=false;assert.equal((await f.store.begin(f.binding,begin())).idempotent,true);
    broken=true;await assert.rejects(f.store.close(f.binding,close()),/First flush failure/);
    broken=false;assert.equal((await f.store.close(f.binding,close())).idempotent,true);
    assert.equal(flushes,4);assert.equal((await f.store.inspect()).revision,2);
  }finally{mock.mock.restore();syncBuiltinESMExports();}
});
