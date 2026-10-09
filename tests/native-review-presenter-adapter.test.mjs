import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,mkdir,lstat,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createNativeReviewPresenterAdapter} from '../src/node/nativeReviewPresenterAdapter.mjs';
const display={requestId:'review-1',subject:{proposalDigest:'a'.repeat(64),checkContractDigest:'b'.repeat(64)},ledger:{tasks:[{id:'T0001',description:'Full review content'}]}};
async function fixture(execute){
 const cwd=await mkdtemp(path.join(tmpdir(),'pp-native-presenter-')),executable=path.join(cwd,'controlled-helper.exe');
 await writeFile(executable,'fixture only; never executed');
 const executableDigest=createHash('sha256').update(await readFile(executable)).digest('hex');
 return {cwd,executable,executableDigest,execute,compilationTempRoot:path.join(cwd,'compilation-temp')};
}
function response(options,decision='approved'){
 const {content,...input}=JSON.parse(options.input);
 return {exit:0,reason:null,outputComplete:true,cleanupComplete:true,stdout:JSON.stringify({...input,instanceId:'instance-1',decision,destroyed:true,humanVerified:false})};
}
test('private presenter transports full display and verifies exact owned receipt',async()=>{
 const config=await fixture(async(file,args,options)=>{assert.equal(file,config.executable);assert.deepEqual(args,['--presenter']);assert.equal(JSON.parse(options.input).content,JSON.stringify(display));assert.equal(options.env.NODE_OPTIONS,undefined);return response(options);});
 const adapter=createNativeReviewPresenterAdapter(config),answer=await adapter.presentNativeReview(display);
 assert.equal(answer.decision,'approved');assert.equal(answer.nativeEvent,undefined);
 const query={evidence:answer.decisionEvidence,requestId:display.requestId,displayDigest:createHash('sha256').update(JSON.stringify(display)).digest('hex'),decision:'approved'};
 assert.equal((await adapter.verifyNativeDecision(query)).trusted,true);
 assert.equal((await adapter.verifyNativeDecision({...query,requestId:'other'})).trusted,false);
 assert.equal((await adapter.verifyPresentationClosed({requestId:display.requestId,...display.subject})).closed,true);
 await assert.rejects(adapter.presentNativeReview(display),/REQUEST_REUSED/);
});
test('untrusted helper receipt and uncertain process cleanup cannot create approval or closure',async()=>{
 for(const mode of ['digest','destroyed','extra','uncertain','exit']){
  const adapter=createNativeReviewPresenterAdapter(await fixture(async(file,args,options)=>{
   const result=response(options),value=JSON.parse(result.stdout);
   if(mode==='digest')value.displayDigest='c'.repeat(64);
   if(mode==='destroyed')value.destroyed=false;
   if(mode==='extra')value.trusted=true;
   if(mode==='uncertain')result.cleanupComplete=false;
   if(mode==='exit')result.exit=1;
   result.stdout=JSON.stringify(value);return result;
  }));
  await assert.rejects(adapter.presentNativeReview(display),error=>mode!=='uncertain'||error.cleanupComplete===false);
  assert.equal((await adapter.verifyPresentationClosed({requestId:display.requestId,...display.subject})).closed,false);
  await assert.rejects(adapter.presentNativeReview(display),/CLOSURE_UNCONFIRMED/);
  await assert.rejects(adapter.presentNativeReview({...display,requestId:'replacement'}),/CLOSURE_UNCONFIRMED/);
 }
});
test('modified fixed executable is refused before launch',async()=>{
 let calls=0;const config=await fixture(async()=>{calls++;});await writeFile(config.executable,'changed');
 await assert.rejects(createNativeReviewPresenterAdapter(config).presentNativeReview(display),/RESOURCE_CHANGED/);assert.equal(calls,0);
});
test('late approval after signal cancellation is not returned as a decision',async()=>{
 const controller=new AbortController();const adapter=createNativeReviewPresenterAdapter(await fixture(async(file,args,options)=>{controller.abort();return response(options);}));
 assert.equal((await adapter.presentNativeReview(display,{signal:controller.signal})).decision,'cancelled');
});
test('presenter invocations use unique native scratch with exact environment and empty-only cleanup',async()=>{
 const paths=[],environment={...process.env};const config=await fixture(async(file,args,options)=>{
  assert.deepEqual(Object.keys(options.env).sort(),['SystemRoot','TEMP','TMP','WINDIR'].sort());assert.equal(options.env.TEMP,options.env.TMP);assert.equal(path.dirname(options.env.TEMP),config.compilationTempRoot);paths.push(options.env.TEMP);return response(options);
 });const adapter=createNativeReviewPresenterAdapter(config);await adapter.presentNativeReview(display);await adapter.presentNativeReview({...display,requestId:'review-2'});
 assert.equal(new Set(paths).size,2);assert.deepEqual(await readdir(config.compilationTempRoot),[]);assert.deepEqual({...process.env},environment);
});
test('presenter preserves scratch on uncertain cleanup and nonempty output',async()=>{
 for(const uncertain of [true,false]){let scratch;const config=await fixture(async(file,args,options)=>{scratch=options.env.TEMP;if(!uncertain)await writeFile(path.join(scratch,'retained.txt'),'retained proof');return uncertain?{cleanupComplete:false}:response(options);});const adapter=createNativeReviewPresenterAdapter(config);
  if(uncertain){await assert.rejects(adapter.presentNativeReview(display),error=>error.cleanupComplete===false);await assert.rejects(adapter.presentNativeReview({...display,requestId:'replacement'}),/CLOSURE_UNCONFIRMED/);}else await adapter.presentNativeReview(display);
  assert.equal((await lstat(scratch)).isDirectory(),true);assert.deepEqual(await readdir(scratch),uncertain?[]:['retained.txt']);
 }
});
test('pre-launch scratch refusal leaves the same request available and never marks unresolved',async()=>{
 let calls=0;const config=await fixture(async(file,args,options)=>{calls++;return response(options);});await mkdir(config.compilationTempRoot);for(let i=0;i<64;i++)await mkdir(path.join(config.compilationTempRoot,`retained-${i}`));
 const adapter=createNativeReviewPresenterAdapter(config);await assert.rejects(adapter.presentNativeReview(display),/SCRATCH_UNAVAILABLE/);assert.equal(calls,0);
 // Explicitly remove this test's known empty slot; production never discards it.
 await rmdir(path.join(config.compilationTempRoot,'retained-63'));assert.equal((await adapter.presentNativeReview(display)).decision,'approved');assert.equal(calls,1);
});
test('presenter refuses missing native compilation root instead of inheriting user environment',async()=>{const config=await fixture(async()=>{});assert.throws(()=>createNativeReviewPresenterAdapter({...config,compilationTempRoot:undefined}),/CONFIG_INVALID/);});

test('exact validated closure survives adapter restart without restoring decision authority',async()=>{
 const config=await fixture(async(file,args,options)=>response(options));config.closureDirectory=path.join(config.cwd,'closures');
 const first=createNativeReviewPresenterAdapter(config),answer=await first.presentNativeReview(display);
 const restarted=createNativeReviewPresenterAdapter({...config,execute:async()=>{throw Error('must not launch');}});
 assert.equal((await restarted.verifyPresentationClosed({requestId:display.requestId,...display.subject})).closed,true);
 assert.equal((await restarted.verifyNativeDecision({evidence:answer.decisionEvidence})).trusted,false);
 await assert.rejects(restarted.presentNativeReview(display),/REQUEST_REUSED/);
 assert.equal((await restarted.verifyPresentationClosed({requestId:display.requestId,...display.subject,proposalDigest:'c'.repeat(64)})).closed,false);
});

test('damaged or foreign executable closure never becomes restart proof',async()=>{
 const config=await fixture(async(file,args,options)=>response(options));config.closureDirectory=path.join(config.cwd,'closures');await createNativeReviewPresenterAdapter(config).presentNativeReview(display);
 await assert.rejects(createNativeReviewPresenterAdapter({...config,executableDigest:'f'.repeat(64)}).verifyPresentationClosed({requestId:display.requestId,...display.subject}),/CLOSURE_STORAGE_INVALID/);
 const file=path.join(config.closureDirectory,(await readdir(config.closureDirectory))[0]);await writeFile(file,'{"partial":');
 await assert.rejects(createNativeReviewPresenterAdapter(config).verifyPresentationClosed({requestId:display.requestId,...display.subject}),/CLOSURE_STORAGE_INVALID/);
});
