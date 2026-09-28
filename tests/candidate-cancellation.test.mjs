import test from 'node:test';
import assert from 'node:assert/strict';
import fileSystem,{mkdtemp,writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {candidateSnapshot} from '../src/node/mergedStateRunner.mjs';

test('candidate pre-cancellation never reaches Git',async()=>{
 const controller=new AbortController();controller.abort();let calls=0;
 const result=await candidateSnapshot('unused',async()=>{calls++;},{signal:controller.signal});
 assert.equal(result.valid,false);assert.equal(result.reason,'candidate cancelled');assert.equal(calls,0);
});
test('aggregate deadline cancels pending inventory and waits for its completion',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'pp-snapshot-deadline-'));let settled=false,calls=0;
 const result=await candidateSnapshot(root,async(_root,_args,{signal})=>{
  calls++;
  await new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true});});
  settled=true;return {exit:null,stdout:'',reason:'git-cancelled'};
 },{timeoutMs:30});
 assert.equal(result.valid,false);assert.equal(result.reason,'candidate time limit');assert.equal(settled,true);assert.equal(calls,1);
});
test('cancellation between inventory calls stops further discovery',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'pp-snapshot-cancel-'));const controller=new AbortController();let calls=0;
 const result=await candidateSnapshot(root,async()=>{calls++;controller.abort();return {exit:0,stdout:''};},{signal:controller.signal});
 assert.equal(result.valid,false);assert.equal(result.reason,'candidate cancelled');assert.equal(calls,1);
});
test('cleanup uncertainty survives cancellation instead of looking stopped',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'pp-snapshot-uncertain-'));
 for(const throws of [false,true]){
  const controller=new AbortController();
  const result=await candidateSnapshot(root,async()=>{
   controller.abort();
   if(throws)throw Object.assign(Error('uncertain'),{code:'GIT_PROCESS_UNCERTAIN',cleanupComplete:false});
   return {exit:null,stdout:'',cleanupComplete:false};
  },{signal:controller.signal});
  assert.equal(result.valid,false);assert.equal(result.cleanupComplete,false);assert.equal(result.code,'GIT_PROCESS_UNCERTAIN');
  assert.equal(result.reason,'candidate process cleanup uncertain');
 }
});
test('cancellation during a real streamed read closes its handle before returning',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'pp-snapshot-read-cancel-')),target=path.join(root,'large.bin');
 await writeFile(target,Buffer.alloc(200000,7));
 const controller=new AbortController(),originalOpen=fileSystem.open;let reads=0,closed=false;
 fileSystem.open=async(...args)=>{
  const handle=await originalOpen(...args);
  if(path.resolve(String(args[0]))===target){
   const read=handle.read.bind(handle),close=handle.close.bind(handle);
   handle.read=async(...readArgs)=>{const result=await read(...readArgs);reads++;controller.abort();return result;};
   handle.close=async()=>{await close();closed=true;};
  }
  return handle;
 };
 syncBuiltinESMExports();
 try {
  const result=await candidateSnapshot(root,async(_root,args)=>({exit:0,stdout:args.includes('--cached')?'large.bin\0':''}),{signal:controller.signal});
  assert.equal(reads,1);assert.equal(closed,true);assert.equal(result.valid,false);assert.equal(result.reason,'candidate cancelled');
 } finally {fileSystem.open=originalOpen;syncBuiltinESMExports();}
});
