import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,unlink,open,link,lstat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createInstalledTaskExecutionCustody} from '../src/node/installedTaskExecutionCustody.mjs';

async function fixture(){
 const root=await mkdtemp(path.join(os.tmpdir(),'pp-provisional-'));
 const binding={projectId:'pp_provisional',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)};
 const config={stateDirectory:root,binding,observeBinding:async()=>binding};
 const custody=createInstalledTaskExecutionCustody(config);
 const directory=path.join(root,`${binding.projectId}.native-observations`);await mkdir(directory);
 const manifest={schemaVersion:2,index:'c'.repeat(64),entries:[]},candidateDigest=createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
 const bound={proposalRevision:1,proposalDigest:'a'.repeat(64),checkContractDigest:'b'.repeat(64),enrollmentEpoch:1,taskId:'T0001',checkId:'unit',attemptId:'attempt1',attemptNumber:1,workerId:'worker1',sessionId:'session1',candidateSchemaVersion:2,candidateDigest,policyVersion:1,policyDigest:'d'.repeat(64)};
 const {grant}=await custody.grants.issue(bound,{requestId:'issue',expectedRevision:0,ttlMs:300000});
 const consumed=await custody.grants.consume(bound,{grantId:grant.grantId,requestId:'consume',expectedRevision:1});
 const {intentReceipt}=await custody.grants.recordExecutionIntent(consumed.consumptionReceipt,{grantId:grant.grantId,requestId:'intent',expectedRevision:2});
 const executionSpec={runId:intentReceipt.runId,intentDigest:intentReceipt.recordDigest,candidateDigest:bound.candidateDigest,checkContractDigest:bound.checkContractDigest,outputLimits:{stdoutBytes:100,stderrBytes:100,combinedBytes:200}};
 const observation={schemaVersion:2,kind:'NATIVE_TASK_OBSERVATION',runId:intentReceipt.runId,exitCode:0,timedOut:false,cancelObserved:false,outputTruncated:false,cpuTimeExceeded:false,cpuObservationFailed:false,processExited:true,jobEmptyObserved:true,descendantsSettled:true,ioSettled:true,ioFailed:false,stdout:'controlled output',stderr:''};
 const candidateReceipt=await custody.custody.retainCandidate({intentReceipt,executionSpec,manifest});
 const input={intentReceipt,executionSpec,observation,candidateManifestDigest:candidateReceipt.artifactDigest};
 return {root,directory,config,custody,input,grantId:grant.grantId,journal:path.join(root,`${binding.projectId}.execution-grants.jsonl`),file:path.join(directory,intentReceipt.runId+'.json')};
}
function frame(f,receipt){return {schemaVersion:2,kind:'NATIVE_TASK_GUARD_FINALIZED',runId:f.input.intentReceipt.runId,intentDigest:f.input.intentReceipt.recordDigest,candidateDigest:f.input.executionSpec.candidateDigest,checkContractDigest:f.input.executionSpec.checkContractDigest,artifactDigest:receipt.artifactDigest,executionAuthorized:false};}

test('retained provisional output cannot be reconciled into a completed result after reopen',async()=>{
 const f=await fixture(),before=await readFile(f.journal);
 const receipt=await f.custody.custody.retainProvisional(f.input);
 assert.equal(receipt.kind,'NATIVE_TASK_PROVISIONAL_RECEIPT');assert.equal(receipt.state,'retained-provisional');
 const retained=await readFile(f.file),reopened=createInstalledTaskExecutionCustody(f.config);
 await assert.rejects(reopened.custody.reconcile(f.input.intentReceipt),/FINALIZATION_UNRESOLVED/);
 await assert.rejects(reopened.results.readOwner({grantId:f.grantId}));
 assert.deepEqual(await readFile(f.journal),before);assert.deepEqual(await readFile(f.file),retained);
 assert.equal((await reopened.grants.inspect()).revision,3);
});

test('exact finalization links once without rewriting output or granting verification authority',async()=>{
 const f=await fixture(),receipt=await f.custody.custody.retainProvisional(f.input),before=await readFile(f.file);
 const request={intentReceipt:f.input.intentReceipt,finalization:frame(f,receipt)};
 const first=await f.custody.custody.finalize(request);
 const reopened=createInstalledTaskExecutionCustody(f.config),second=await reopened.custody.finalize(request);
 assert.deepEqual(second,first);assert.deepEqual(await readFile(f.file),before);assert.equal((await reopened.grants.inspect()).revision,4);
 const result=await reopened.results.readOwner({grantId:f.grantId});assert.equal(result.journalLinked,true);assert.equal(result.state,'result-unverified');assert.equal(result.authorityVerified,false);
});

test('foreign or malformed finalization cannot link a provisional observation',async()=>{
 for(const key of ['runId','intentDigest','candidateDigest','checkContractDigest','artifactDigest','executionAuthorized']){
  const f=await fixture(),receipt=await f.custody.custody.retainProvisional(f.input),before=await readFile(f.journal);
  const altered=frame(f,receipt);altered[key]=key==='executionAuthorized'?true:'f'.repeat(64);
  await assert.rejects(f.custody.custody.finalize({intentReceipt:f.input.intentReceipt,finalization:altered}));
  assert.deepEqual(await readFile(f.journal),before);assert.equal((await f.custody.grants.inspect()).revision,3);
 }
});

test('partial finalization remains unresolved and cannot be overwritten by recovery',async()=>{
 const f=await fixture(),receipt=await f.custody.custody.retainProvisional(f.input),file=path.join(f.directory,f.input.intentReceipt.runId+'.finalization.json');
 await writeFile(file,'{"partial":');
 await assert.rejects(f.custody.custody.finalize({intentReceipt:f.input.intentReceipt,finalization:frame(f,receipt)}));
 await assert.rejects(f.custody.custody.reconcile(f.input.intentReceipt));
 assert.equal(await readFile(file,'utf8'),'{"partial":');assert.equal((await f.custody.grants.inspect()).revision,3);
});

test('finalization retained before journal linking recovers without relaunch',async()=>{
 const f=await fixture(),receipt=await f.custody.custody.retainProvisional(f.input);
 await f.custody.observations.finalize({intentReceipt:f.input.intentReceipt,finalization:frame(f,receipt)});
 assert.equal((await f.custody.grants.inspect()).revision,3);
 const reopened=createInstalledTaskExecutionCustody(f.config);
 await reopened.custody.reconcile(f.input.intentReceipt);
 assert.equal((await reopened.grants.inspect()).revision,4);
 assert.equal((await reopened.results.readOwner({grantId:f.grantId})).authorityVerified,false);
});

test('removing or changing finalized evidence prevents owner reads despite an existing journal link',async()=>{
 for(const mutation of ['remove','change']){
  const f=await fixture(),receipt=await f.custody.custody.retainProvisional(f.input),value=frame(f,receipt);
  await f.custody.custody.finalize({intentReceipt:f.input.intentReceipt,finalization:value});
  const file=path.join(f.directory,f.input.intentReceipt.runId+'.finalization.json');
  if(mutation==='remove')await unlink(file);else await writeFile(file,JSON.stringify({...value,artifactDigest:'e'.repeat(64)}));
  const reopened=createInstalledTaskExecutionCustody(f.config);
  await assert.rejects(reopened.results.readOwner({grantId:f.grantId}));
  await assert.rejects(reopened.custody.reconcile(f.input.intentReceipt));
  assert.equal((await reopened.grants.inspect()).revision,4);
 }
});

test('legacy observations cannot acquire guard finalization retroactively',async()=>{
 const f=await fixture(),receipt=await f.custody.custody.record(f.input),before=await readFile(f.file);
 await assert.rejects(f.custody.custody.finalize({intentReceipt:f.input.intentReceipt,finalization:frame(f,receipt)}));
 assert.deepEqual(await readFile(f.file),before);
 assert.equal((await f.custody.results.readOwner({grantId:f.grantId})).authorityVerified,false);
});

test('concurrent identical finalizations retain one journal event',async()=>{
 const f=await fixture(),receipt=await f.custody.custody.retainProvisional(f.input),input={intentReceipt:f.input.intentReceipt,finalization:frame(f,receipt)};
 const results=await Promise.all([f.custody.custody.finalize(input),createInstalledTaskExecutionCustody(f.config).custody.finalize(input)]);
 assert.deepEqual(results[0],results[1]);assert.equal((await f.custody.grants.inspect()).revision,4);
});

test('unsettled observations cannot be finalized, while a settled failed check can',async()=>{
 for(const mutation of [{schemaVersion:1,descendantsSettled:undefined},{processExited:false,exitCode:null,descendantsSettled:false},{descendantsSettled:false},{ioSettled:false,ioFailed:true}]){
  const f=await fixture();Object.assign(f.input.observation,mutation);if(mutation.schemaVersion===1)delete f.input.observation.descendantsSettled;
  const receipt=await f.custody.custody.retainProvisional(f.input);
  await assert.rejects(f.custody.custody.finalize({intentReceipt:f.input.intentReceipt,finalization:frame(f,receipt)}));
  assert.equal((await f.custody.grants.inspect()).revision,3);
 }
 const f=await fixture();f.input.observation.exitCode=7;
 const receipt=await f.custody.custody.retainProvisional(f.input);
 await f.custody.custody.finalize({intentReceipt:f.input.intentReceipt,finalization:frame(f,receipt)});
 assert.equal((await f.custody.results.readOwner({grantId:f.grantId})).state,'failure-observed');
});

test('complete bytes after a failed sync cannot link until recovery re-sync succeeds',async t=>{
 const f=await fixture(),receipt=await f.custody.custody.retainProvisional(f.input);
 const handle=await open(f.file,'r'),proto=Object.getPrototypeOf(handle),original=proto.sync;await handle.close();
 const finalPath=path.join(f.directory,f.input.intentReceipt.runId+'.finalization.json');
 let calls=0,failSync=true;
 // Candidate evidence now also syncs before finalization. Inject failure only
 // after the finalization file exists, retaining this test's original boundary:
 // complete finalization bytes whose durability was not acknowledged.
 t.mock.method(proto,'sync',async function(){calls++;const finalExists=await lstat(finalPath).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});if(failSync&&finalExists)throw Error('injected flush failure');return original.call(this);});
 await assert.rejects(f.custody.custody.finalize({intentReceipt:f.input.intentReceipt,finalization:frame(f,receipt)}),/injected flush failure/);
 const retained=await readFile(path.join(f.directory,f.input.intentReceipt.runId+'.finalization.json'));
 assert.equal(JSON.parse(retained).artifactDigest,receipt.artifactDigest);
 const reopened=createInstalledTaskExecutionCustody(f.config);
 await assert.rejects(reopened.custody.reconcile(f.input.intentReceipt),/injected flush failure/);
 assert.equal((await reopened.grants.inspect()).revision,3);assert.ok(calls>=2);
 failSync=false;const before=calls;await reopened.custody.reconcile(f.input.intentReceipt);
 assert.ok(calls>before);assert.equal((await reopened.grants.inspect()).revision,4);
 assert.deepEqual(await readFile(path.join(f.directory,f.input.intentReceipt.runId+'.finalization.json')),retained);
});

test('modified observation and hard-linked finalization cannot be recovered as finalized',async()=>{
 for(const mutation of ['observation','hardlink']){
  const f=await fixture(),receipt=await f.custody.custody.retainProvisional(f.input),value=frame(f,receipt);
  await f.custody.observations.finalize({intentReceipt:f.input.intentReceipt,finalization:value});
  const finalPath=path.join(f.directory,f.input.intentReceipt.runId+'.finalization.json');
  if(mutation==='observation')await writeFile(f.file,(await readFile(f.file,'utf8')).replace('controlled output','corrupted output'));
  else await link(finalPath,path.join(f.root,'alias.json'));
  const retained=await readFile(finalPath),journal=await readFile(f.journal);
  await assert.rejects(f.custody.custody.reconcile(f.input.intentReceipt));
  await assert.rejects(f.custody.custody.finalize({intentReceipt:f.input.intentReceipt,finalization:value}));
  assert.deepEqual(await readFile(finalPath),retained);assert.deepEqual(await readFile(f.journal),journal);
 }
});

test('observation changing during finalization re-sync is refused before journal promotion',async t=>{
 const f=await fixture(),receipt=await f.custody.custody.retainProvisional(f.input);
 await f.custody.observations.finalize({intentReceipt:f.input.intentReceipt,finalization:frame(f,receipt)});
 const handle=await open(f.file,'r'),proto=Object.getPrototypeOf(handle),original=proto.sync;await handle.close();
 let changed=false;t.mock.method(proto,'sync',async function(){await original.call(this);if(!changed){changed=true;await writeFile(f.file,(await readFile(f.file,'utf8')).replace('controlled output','corrupted output'));}});
 await assert.rejects(f.custody.custody.reconcile(f.input.intentReceipt));
 assert.equal(changed,true);assert.equal((await f.custody.grants.inspect()).revision,3);
});
