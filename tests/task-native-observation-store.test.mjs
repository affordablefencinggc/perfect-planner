import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,open,link,symlink,access} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createTaskNativeObservationStore} from '../src/node/taskNativeObservationStore.mjs';
async function fixture(){
 const directory=await mkdtemp(path.join(os.tmpdir(),'pp-native-observation-'));
 const config={directory,projectId:'pp_observation',rootIdentity:'a'.repeat(64)};
 const intentReceipt={schemaVersion:1,kind:'TASK_EXECUTION_INTENT_RECEIPT',projectId:config.projectId,rootIdentity:config.rootIdentity,runId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',recordDigest:'b'.repeat(64),consumptionDigest:'c'.repeat(64),binding:{taskId:'T0001',candidateDigest:'d'.repeat(64),checkContractDigest:'e'.repeat(64)},state:'launch-unresolved',executionAuthorized:false};
 const executionSpec={runId:intentReceipt.runId,intentDigest:intentReceipt.recordDigest,candidateDigest:intentReceipt.binding.candidateDigest,checkContractDigest:intentReceipt.binding.checkContractDigest,outputLimits:{stdoutBytes:1000,stderrBytes:1000,combinedBytes:1500}};
 const observation={schemaVersion:1,kind:'NATIVE_TASK_OBSERVATION',runId:intentReceipt.runId,exitCode:7,timedOut:false,cancelObserved:false,outputTruncated:false,cpuTimeExceeded:false,cpuObservationFailed:false,processExited:true,jobEmptyObserved:true,ioSettled:true,ioFailed:false,stdout:'retained output',stderr:'failure'};
 return {config,store:createTaskNativeObservationStore(config),input:{intentReceipt,executionSpec,observation},file:path.join(directory,intentReceipt.runId+'.json')};
}
test('candidate and check-contract mismatch cannot create a retained result',async()=>{
 for(const key of ['candidateDigest','checkContractDigest']){
  for(const mode of ['different','missing','malformed']){
   const f=await fixture();
   if(mode==='missing')delete f.input.executionSpec[key];else f.input.executionSpec[key]=mode==='different'?'f'.repeat(64):'not-a-digest';
   await assert.rejects(f.store.record(f.input),/NATIVE_TASK_OBSERVATION_CUSTODY_UNRESOLVED/);
   await assert.rejects(access(f.file),{code:'ENOENT'});
  }
 }
});

test('invalid admitted binding refuses retention even when the supplied spec matches',async()=>{
 for(const key of ['candidateDigest','checkContractDigest']){
  const f=await fixture();f.input.intentReceipt.binding[key]='invalid';f.input.executionSpec[key]='invalid';
  await assert.rejects(f.store.record(f.input),/NATIVE_TASK_OBSERVATION_CUSTODY_UNRESOLVED/);
  await assert.rejects(access(f.file),{code:'ENOENT'});
 }
});

test('legacy observations remain readable without rewriting or promoting trust',async()=>{
 const f=await fixture();delete f.input.intentReceipt.binding.candidateDigest;delete f.input.intentReceipt.binding.checkContractDigest;
 delete f.input.executionSpec.candidateDigest;delete f.input.executionSpec.checkContractDigest;
 const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
 const wire=v=>JSON.stringify(canonical(v)),hash=v=>createHash('sha256').update(v).digest('hex');
 const body={schemaVersion:1,kind:'NATIVE_TASK_RETAINED_OBSERVATION',intentReceipt:f.input.intentReceipt,executionSpecDigest:hash(wire(f.input.executionSpec)),outputLimits:f.input.executionSpec.outputLimits,observation:f.input.observation};
 const bytes=Buffer.from(wire({...body,recordDigest:hash(wire(body))})+'\n');await writeFile(f.file,bytes);
 const reopened=await f.store.inspect(f.input.intentReceipt);
 assert.deepEqual(reopened.observation,f.input.observation);assert.equal(reopened.receipt.state,'result-unverified');assert.equal(reopened.receipt.executionAuthorized,false);
 await assert.rejects(f.store.record(f.input),/NATIVE_TASK_OBSERVATION_CUSTODY_UNRESOLVED/);
 assert.deepEqual(await readFile(f.file),bytes);
});
test('concurrent identical observation writes and reopened inspection retain one identity',async()=>{
 const f=await fixture(),[a,b]=await Promise.all([f.store.record(f.input),f.store.record(f.input)]);assert.deepEqual(a,b);
 const reopened=createTaskNativeObservationStore(f.config),r=await reopened.inspect(f.input.intentReceipt);assert.deepEqual(r.receipt,a);assert.deepEqual(r.observation,f.input.observation);assert.equal(r.receipt.state,'result-unverified');assert.equal(r.receipt.executionAuthorized,false);
 await assert.rejects(reopened.record({...f.input,observation:{...f.input.observation,exitCode:0}}));assert.equal((await reopened.inspect(f.input.intentReceipt)).observation.exitCode,7);
 await assert.rejects(reopened.inspect({...f.input.intentReceipt,recordDigest:'d'.repeat(64)}));
});
test('failed sync preserves bytes for explicit same-observation recovery, never replacement',async t=>{
 const f=await fixture(),probe=await open(path.join(f.config.directory,'probe'),'wx'),prototype=Object.getPrototypeOf(probe);await probe.close();
 const mock=t.mock.method(prototype,'sync',async()=>{throw Error('controlled sync failure');});
 try{await assert.rejects(f.store.record(f.input),/controlled sync failure/);}finally{mock.mock.restore();}
 const before=await readFile(f.file),r=await f.store.record(f.input);assert.deepEqual(await readFile(f.file),before);assert.equal(r.state,'result-unverified');
});
test('partial, corrupted, linked or redirected records fail without overwriting',async()=>{
 const f=await fixture();await writeFile(f.file,'{"partial":');await assert.rejects(f.store.record(f.input));assert.equal(await readFile(f.file,'utf8'),'{"partial":');await assert.rejects(f.store.inspect(f.input.intentReceipt));
 const g=await fixture();await g.store.record(g.input);const record=JSON.parse(await readFile(g.file,'utf8'));record.observation.exitCode=0;await writeFile(g.file,JSON.stringify(record));await assert.rejects(g.store.inspect(g.input.intentReceipt));
 const h=await fixture();await h.store.record(h.input);await link(h.file,path.join(h.config.directory,'alias'));await assert.rejects(h.store.inspect(h.input.intentReceipt));
 const j=await fixture(),redirect=path.join(j.config.directory,'redirect');await symlink(j.config.directory,redirect,process.platform==='win32'?'junction':'dir');await assert.rejects(createTaskNativeObservationStore({...j.config,directory:redirect}).record(j.input));
});
test('foreign identity, unsafe paths and excessive output refuse custody',async()=>{
 const f=await fixture();assert.throws(()=>createTaskNativeObservationStore({...f.config,directory:'relative'}));
 await assert.rejects(f.store.record({...f.input,intentReceipt:{...f.input.intentReceipt,projectId:'pp_foreign'}}));
 await assert.rejects(f.store.record({...f.input,executionSpec:{...f.input.executionSpec,runId:'../escape'}}));
 await assert.rejects(f.store.record({...f.input,observation:{...f.input.observation,stdout:'x'.repeat(1001)}}));
 await assert.rejects(f.store.record({...f.input,executionSpec:{...f.input.executionSpec,outputLimits:{stdoutBytes:2097152,stderrBytes:1000,combinedBytes:2097152}}}));
});
test('maximum permitted captured output survives JSON escaping without data loss',async()=>{
 const f=await fixture();f.input.executionSpec.outputLimits={stdoutBytes:1048576,stderrBytes:1048576,combinedBytes:2097152};
 f.input.observation.stdout='\u0000'.repeat(1048576);f.input.observation.stderr='\u0001'.repeat(1048576);
 const saved=await f.store.record(f.input),reopened=await createTaskNativeObservationStore(f.config).inspect(f.input.intentReceipt);
 assert.deepEqual(reopened.receipt,saved);assert.equal(reopened.observation.stdout,f.input.observation.stdout);assert.equal(reopened.observation.stderr,f.input.observation.stderr);
});

test('version two descendant evidence survives immutable storage and exact reopen',async()=>{
 for(const descendantsSettled of [true,false]){
  const f=await fixture();f.input.observation={...f.input.observation,schemaVersion:2,descendantsSettled};
  const receipt=await f.store.record(f.input);
  const reopened=await createTaskNativeObservationStore(f.config).inspect(f.input.intentReceipt);
  assert.deepEqual(reopened.receipt,receipt);assert.deepEqual(reopened.observation,f.input.observation);
  await assert.rejects(f.store.record({...f.input,observation:{...f.input.observation,descendantsSettled:!descendantsSettled}}));
  assert.equal((await f.store.inspect(f.input.intentReceipt)).observation.descendantsSettled,descendantsSettled);
 }
});
