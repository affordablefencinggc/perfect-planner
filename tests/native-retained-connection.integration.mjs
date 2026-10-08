import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdir,readFile,writeFile,access,mkdtemp,unlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createRetainedNativeTaskExecutionAdapter} from '../src/node/nativeTaskExecutionAdapter.mjs';
import {createTaskNativeObservationStore} from '../src/node/taskNativeObservationStore.mjs';
import {candidateSnapshot} from '../src/node/mergedStateRunner.mjs';

// Explicit DANS1 desktop integration fixture. Admission is synthetic; the
// process, guarded snapshot, retained archive, Node and owner stores are real.
const hash=b=>createHash('sha256').update(b).digest('hex');
async function fixture(answer){
 assert.ok(process.env.PP_CONNECTED_NATIVE_EXE,'explicit current native executable required');
 const root=await mkdtemp(path.join(os.tmpdir(),'pp-connected-'));
 const source=path.join(root,'source'),directory=path.join(root,'observations'),scratch=path.join(root,'scratch');
 for(const p of [source,directory,scratch])await mkdir(p);
 execFileSync('C:\\Program Files\\Git\\cmd\\git.exe',['init','--quiet',source],{windowsHide:true});
 await writeFile(path.join(source,'value.cjs'),`module.exports=${answer};`);
 await writeFile(path.join(source,'check.cjs'),`const fs=require('node:fs'),p=require('node:path'),a=require('node:assert/strict');a.throws(()=>fs.writeFileSync(p.join(__dirname,'value.cjs'),'changed'));const answer=require('./value.cjs');fs.writeFileSync(p.join(process.env.PP_TASK_OUTPUT,'marker'),'ran');console.log('answer='+answer);process.exitCode=answer===42?0:7;`);
 const candidate=await candidateSnapshot(source,undefined,{includeManifest:true});assert.equal(candidate.valid,true);assert.notEqual(candidate.cleanupComplete,false);
 const runId=randomUUID(),rootIdentity='a'.repeat(64),intentDigest=hash(runId),projectId='pp_connected';
 const executionSpec={runId,intentDigest,registeredRoot:source,cwd:source,executablePath:process.execPath,executableDigest:hash(await readFile(process.execPath)),args:[path.join(source,'check.cjs')],timeoutMs:10000,outputLimits:{stdoutBytes:8192,stderrBytes:8192,combinedBytes:16384},candidateDigest:candidate.digest,checkContractDigest:'f'.repeat(64)};
 const intentReceipt={schemaVersion:1,kind:'TASK_EXECUTION_INTENT_RECEIPT',projectId,rootIdentity,runId,recordDigest:intentDigest,consumptionDigest:'e'.repeat(64),binding:{candidateDigest:candidate.digest,candidateSchemaVersion:2,checkContractDigest:executionSpec.checkContractDigest},state:'launch-unresolved',executionAuthorized:false};
 const config={directory,projectId,rootIdentity},store=createTaskNativeObservationStore(config),events=[];let inputs;
 const execute=createRetainedNativeTaskExecutionAdapter({executable:process.env.PP_CONNECTED_NATIVE_EXE,executableDigest:hash(await readFile(process.env.PP_CONNECTED_NATIVE_EXE)),cwd:root,compilationTempRoot:scratch,rootIdentity});
 const context={intentReceipt,executionSpec};
 const options={expiresAt:new Date(Date.now()+120000).toISOString(),
  retainCandidate:async manifest=>{events.push('candidate');return store.retainCandidate({...context,manifest});},
  retainInputs:async(artifactBytes,artifactDigest)=>{events.push('inputs');inputs=JSON.parse(artifactBytes);await assert.rejects(access(path.join(inputs.outputDirectory,'marker')),{code:'ENOENT'});return store.retainInputs({...context,artifactBytes,artifactDigest});},
  retainIsolatedProvisional:async(observation,candidateManifestDigest,retainedInputsDigest)=>{events.push('provisional');await access(path.join(inputs.outputDirectory,'marker'));const receipt=await store.retainIsolatedProvisional({...context,observation,candidateManifestDigest,retainedInputsDigest});assert.equal((await store.inspect(intentReceipt)).receipt.state,'retained-provisional');await assert.rejects(access(path.join(directory,runId+'.finalization.json')),{code:'ENOENT'});return receipt;}
 };
 return {root,source,directory,executionSpec,intentReceipt,config,store,execute,options,events,get inputs(){return inputs;}};
}

test('real four-frame native run retains failed and fresh successful candidates and reopens without relaunch',async()=>{
 const digests=[];
 for(const [answer,exit]of [[41,7],[42,0]]){
  const f=await fixture(answer),value=await f.execute(f.executionSpec,f.options);
  assert.equal(value.observation.exitCode,exit);assert.equal(value.observation.stdout.trim(),`answer=${answer}`);assert.equal(value.observation.descendantsSettled,true);
  assert.deepEqual(f.events,['candidate','inputs','provisional']);assert.equal(value.finalization.schemaVersion,3);
  const receipt=await f.store.finalize({intentReceipt:f.intentReceipt,finalization:value.finalization});assert.equal(receipt.state,'result-unverified');
  const reopened=await createTaskNativeObservationStore(f.config).inspect(f.intentReceipt);assert.deepEqual(reopened.receipt,receipt);assert.deepEqual(reopened.observation,value.observation);
  digests.push(value.finalization.retainedInputsDigest);await writeFile(path.join(f.root,'connection-evidence.json'),JSON.stringify({scope:'synthetic admission, real native connection',intentReceipt:f.intentReceipt,executionSpec:f.executionSpec,value,receipt,events:f.events},null,2));
 }
 assert.notEqual(digests[0],digests[1]);
});

test('lost, mismatched or cancelled input acknowledgment never runs the prepared child',async()=>{
 for(const mode of ['lost','mismatch','cancelled']){
  const f=await fixture(42),retain=f.options.retainInputs,cancel=new AbortController();f.options.signal=cancel.signal;
  f.options.retainInputs=async(...args)=>{const receipt=await retain(...args);if(mode==='lost')throw Error('controlled lost acknowledgment');if(mode==='cancelled'){cancel.abort();return receipt;}return {...receipt,artifactDigest:'0'.repeat(64)};};
  await assert.rejects(f.execute(f.executionSpec,f.options),/NATIVE_TASK_/);
  assert.deepEqual(f.events,['candidate','inputs']);await assert.rejects(access(path.join(f.inputs.outputDirectory,'marker')),{code:'ENOENT'});
  await assert.rejects(access(path.join(f.directory,f.intentReceipt.runId+'.finalization.json')),{code:'ENOENT'});
 }
});

test('lost output acknowledgment preserves provisional result without finalization',async()=>{
 const f=await fixture(42),retain=f.options.retainIsolatedProvisional;
 f.options.retainIsolatedProvisional=async(...args)=>{await retain(...args);throw Error('controlled lost output acknowledgment');};
 await assert.rejects(f.execute(f.executionSpec,f.options),/NATIVE_TASK_/);
 assert.equal((await createTaskNativeObservationStore(f.config).inspect(f.intentReceipt)).receipt.state,'retained-provisional');
 await assert.rejects(access(path.join(f.directory,f.intentReceipt.runId+'.finalization.json')),{code:'ENOENT'});
});

test('source change during provisional retention prevents native finalization',async()=>{
 const f=await fixture(42),retain=f.options.retainIsolatedProvisional;
 f.options.retainIsolatedProvisional=async(...args)=>{
  const receipt=await retain(...args),transient=path.join(f.source,'transient-change');
  await writeFile(transient,'observed mutation');await unlink(transient);return receipt;
 };
 await assert.rejects(f.execute(f.executionSpec,f.options),/NATIVE_TASK_/);
 assert.equal((await createTaskNativeObservationStore(f.config).inspect(f.intentReceipt)).receipt.state,'retained-provisional');
 await assert.rejects(access(path.join(f.directory,f.intentReceipt.runId+'.finalization.json')),{code:'ENOENT'});
});
