import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,open,link,symlink,access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createTaskRetainedInputsStore,parseRetainedNodeInputs} from '../src/node/taskRetainedInputsStore.mjs';
import {readProofArtifactBytes,readRetainedInputArtifactBytes} from '../src/node/proofArtifactRead.mjs';
import {createTaskNativeObservationStore} from '../src/node/taskNativeObservationStore.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
const runId='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
function nativeRecord(){
 const binding={runId,rootIdentity:'a'.repeat(64),candidateDigest:'b'.repeat(64),intentDigest:'c'.repeat(64)};
 const descriptor='O:BAD:P(A;OICI;FA;;;BA)';
 const archive={schemaVersion:1,kind:'NATIVE_TASK_RETAINED_INPUTS',binding,profileName:'perfect-planner.execution.123-123456789',profileSid:'S-1-15-2-1-2-3-4-5-6-7',root:'C:\\profile\\inputs',readonlyPolicy:'appcontainer-rx-owner-full-v1',entries:[{path:'',kind:'directory',bytes:0,sha256:null,descriptor},{path:'check.cjs',kind:'file',bytes:4,sha256:hash('code'),descriptor}],totalBytes:4,executionAuthorized:false};
 const value={schemaVersion:1,kind:'NATIVE_RETAINED_NODE_INPUTS',binding,archive,archiveDigest:hash(JSON.stringify(archive)),runtime:{root:'C:\\profile\\runtime',node:'C:\\profile\\runtime\\node.exe',bytes:8,sha256:'d'.repeat(64),rootDescriptor:descriptor,nodeDescriptor:descriptor},invocation:{sourceNode:'C:\\runtime\\node.exe',sourceRoot:'C:\\repo',cwd:'C:\\profile\\inputs',script:'C:\\profile\\inputs\\check.cjs',args:['--preserve-symlinks','--preserve-symlinks-main','C:\\profile\\inputs\\check.cjs'],timeoutMs:1000,outputLimits:{stdoutBytes:1000,stderrBytes:1000,combinedBytes:2000}},outputDirectory:'C:\\profile\\output',executionAuthorized:false};
 const intentReceipt={schemaVersion:1,kind:'TASK_EXECUTION_INTENT_RECEIPT',projectId:'pp_retained',rootIdentity:binding.rootIdentity,runId,recordDigest:binding.intentDigest,consumptionDigest:'e'.repeat(64),binding:{candidateDigest:binding.candidateDigest,checkContractDigest:'f'.repeat(64)},state:'launch-unresolved',executionAuthorized:false};
 const executionSpec={runId,intentDigest:binding.intentDigest,candidateDigest:binding.candidateDigest,checkContractDigest:'f'.repeat(64),executablePath:value.invocation.sourceNode,executableDigest:value.runtime.sha256,registeredRoot:value.invocation.sourceRoot,cwd:'C:\\repo',args:['C:\\repo\\check.cjs'],timeoutMs:1000,outputLimits:structuredClone(value.invocation.outputLimits)};
 return {value,intentReceipt,executionSpec};
}
async function fixture(){const data=nativeRecord(),directory=await mkdtemp(path.join(os.tmpdir(),'pp-retained-inputs-')),config={directory,projectId:'pp_retained',rootIdentity:'a'.repeat(64)},artifactBytes=Buffer.from(JSON.stringify(data.value));return {...data,config,store:createTaskRetainedInputsStore(config),input:{intentReceipt:data.intentReceipt,executionSpec:data.executionSpec,artifactBytes,artifactDigest:hash(artifactBytes)},file:path.join(directory,runId+'.inputs.json')};}

test('exact retained bytes survive duplicate writes and reopened owner inspection',async()=>{
 const f=await fixture(),receipts=await Promise.all([f.store.retain(f.input),f.store.retain(f.input)]);assert.deepEqual(receipts[0],receipts[1]);
 const reopened=await createTaskRetainedInputsStore(f.config).inspect(f.input);assert.deepEqual(reopened.receipt,receipts[0]);assert.deepEqual(reopened.bytes,f.input.artifactBytes);assert.equal(reopened.receipt.executionAuthorized,false);assert.equal(reopened.receipt.kind,'NATIVE_TASK_RETAINED_INPUT_RECEIPT');
});
test('foreign identities, changed invocation and archive tampering refuse before storage',async()=>{
 for(const mutate of [v=>v.binding.runId='foreign',v=>v.archive.binding.intentDigest='0'.repeat(64),v=>v.runtime.sha256='0'.repeat(64),v=>v.invocation.args.push('unapproved'),v=>v.invocation.cwd='C:\\elsewhere',v=>v.invocation.timeoutMs++,v=>v.archive.entries[1].sha256='0'.repeat(64),v=>v.archive.entries.push({...v.archive.entries[1],path:'extra'}),v=>v.executionAuthorized=true,v=>v.invocation.outputLimits.stdoutBytes++]){
  const f=await fixture();mutate(f.value);const artifactBytes=Buffer.from(JSON.stringify(f.value));await assert.rejects(f.store.retain({...f.input,artifactBytes,artifactDigest:hash(artifactBytes)}),undefined,mutate.toString());await assert.rejects(access(f.file),{code:'ENOENT'});
 }
 const f=await fixture();await assert.rejects(f.store.retain({...f.input,intentReceipt:{...f.intentReceipt,projectId:'foreign'}}));await assert.rejects(access(f.file),{code:'ENOENT'});
});
test('changed bytes, partial files, hardlinks and redirected storage remain unresolved',async()=>{
 for(const mode of ['changed','partial','hardlink']){const f=await fixture();await f.store.retain(f.input);if(mode==='hardlink')await link(f.file,path.join(f.config.directory,'alias'));else await writeFile(f.file,mode==='partial'?'{':Buffer.from(f.input.artifactBytes).fill(32,10,11));const before=await readFile(f.file);await assert.rejects(f.store.inspect(f.input));await assert.rejects(f.store.retain(f.input));assert.deepEqual(await readFile(f.file),before);}
 const f=await fixture(),redirect=path.join(f.config.directory,'redirect');await symlink(f.config.directory,redirect,process.platform==='win32'?'junction':'dir');await assert.rejects(createTaskRetainedInputsStore({...f.config,directory:redirect}).retain(f.input));
});
test('failed sync preserves exact bytes for same-input recovery without replacement',async t=>{
 const f=await fixture(),probe=await open(path.join(f.config.directory,'probe'),'wx'),prototype=Object.getPrototypeOf(probe);await probe.close();const mocked=t.mock.method(prototype,'sync',async()=>{throw Error('retained-input sync failure');});
 try{await assert.rejects(f.store.retain(f.input),/retained-input sync failure/);}finally{mocked.mock.restore();}
 assert.deepEqual(await readFile(f.file),f.input.artifactBytes);const receipt=await f.store.retain(f.input);assert.equal(receipt.artifactDigest,f.input.artifactDigest);
});
test('larger input inventories do not raise ordinary proof output limits',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'pp-input-bounds-')),file=path.join(directory,'large');const handle=await open(file,'wx');await handle.truncate(16*1024*1024+1);await handle.close();
 await assert.rejects(readProofArtifactBytes(file),/PROOF_ARTIFACT_UNVERIFIED/);assert.equal((await readRetainedInputArtifactBytes(file)).length,16*1024*1024+1);
 const oversized=await open(file,'r+');await oversized.truncate(32*1024*1024+1);await oversized.close();await assert.rejects(readRetainedInputArtifactBytes(file),/PROOF_ARTIFACT_UNVERIFIED/);
});
test('real retained Rust receipt agrees with owner parser when explicitly supplied',async()=>{
 if(!process.env.PP_RETAINED_NATIVE_RECEIPT){return;}
 const bytes=await readRetainedInputArtifactBytes(process.env.PP_RETAINED_NATIVE_RECEIPT),v=JSON.parse(bytes);
 const intentReceipt={schemaVersion:1,kind:'TASK_EXECUTION_INTENT_RECEIPT',projectId:'private-fixture',runId:v.binding.runId,rootIdentity:v.binding.rootIdentity,recordDigest:v.binding.intentDigest,binding:{candidateDigest:v.binding.candidateDigest,checkContractDigest:'f'.repeat(64)},state:'launch-unresolved',executionAuthorized:false};
 const executionSpec={runId:v.binding.runId,intentDigest:v.binding.intentDigest,candidateDigest:v.binding.candidateDigest,checkContractDigest:'f'.repeat(64),registeredRoot:v.invocation.sourceRoot,executablePath:v.invocation.sourceNode,executableDigest:v.runtime.sha256,cwd:v.invocation.sourceRoot,args:[path.win32.join(v.invocation.sourceRoot,'check.cjs')],timeoutMs:v.invocation.timeoutMs,outputLimits:v.invocation.outputLimits};
 assert.deepEqual(parseRetainedNodeInputs(bytes,hash(bytes),{intentReceipt,executionSpec}),v);
 // This proves cross-language receipt parsing, not an authenticated intent.
});

async function isolatedObservation(){
 const f=await fixture(),manifest={schemaVersion:2,index:'1'.repeat(64),entries:[['check.cjs','file',4,0,hash('code')]]};
 const candidateDigest=hash(JSON.stringify(manifest));f.intentReceipt.binding.candidateSchemaVersion=2;f.intentReceipt.binding.candidateDigest=candidateDigest;f.executionSpec.candidateDigest=candidateDigest;f.value.binding.candidateDigest=candidateDigest;f.value.archive.binding.candidateDigest=candidateDigest;f.value.archiveDigest=hash(JSON.stringify(f.value.archive));
 const bytes=Buffer.from(JSON.stringify(f.value));f.input={intentReceipt:f.intentReceipt,executionSpec:f.executionSpec,artifactBytes:bytes,artifactDigest:hash(bytes)};
 const observations=createTaskNativeObservationStore(f.config),candidate=await observations.retainCandidate({...f.input,manifest}),inputs=await observations.retainInputs(f.input);
 const observation={schemaVersion:2,kind:'NATIVE_TASK_OBSERVATION',runId,exitCode:7,timedOut:false,cancelObserved:false,outputTruncated:false,cpuTimeExceeded:false,cpuObservationFailed:false,processExited:true,jobEmptyObserved:true,descendantsSettled:true,ioSettled:true,ioFailed:false,stdout:'failure preserved',stderr:''};
 const provisional={...f.input,observation,candidateManifestDigest:candidate.artifactDigest,retainedInputsDigest:inputs.artifactDigest};
 return {...f,observations,provisional};
}
test('isolated observation remains provisional until exact archive-bound finalization',async()=>{
 const f=await isolatedObservation(),saved=await f.observations.retainIsolatedProvisional(f.provisional);
 const before=await f.observations.inspect(f.intentReceipt);assert.equal(before.receipt.kind,'NATIVE_TASK_PROVISIONAL_RECEIPT');
 const finalization={schemaVersion:3,kind:'NATIVE_TASK_GUARD_FINALIZED',runId,intentDigest:f.intentReceipt.recordDigest,candidateDigest:f.executionSpec.candidateDigest,checkContractDigest:f.executionSpec.checkContractDigest,artifactDigest:saved.artifactDigest,retainedInputsDigest:f.input.artifactDigest,executionAuthorized:false};
 for(const mutation of [v=>delete v.retainedInputsDigest,v=>v.retainedInputsDigest='0'.repeat(64),v=>v.schemaVersion=2]){const wrong=structuredClone(finalization);mutation(wrong);await assert.rejects(f.observations.finalize({intentReceipt:f.intentReceipt,finalization:wrong}));assert.equal((await f.observations.inspect(f.intentReceipt)).receipt.kind,'NATIVE_TASK_PROVISIONAL_RECEIPT');}
 await f.observations.finalize({intentReceipt:f.intentReceipt,finalization});const reopened=await createTaskNativeObservationStore(f.config).inspect(f.intentReceipt);assert.equal(reopened.observation.exitCode,7);assert.equal(reopened.receipt.kind,'NATIVE_TASK_OBSERVATION_RECEIPT');assert.equal(reopened.receipt.executionAuthorized,false);
 await writeFile(f.file,'{"interrupted":');await assert.rejects(createTaskNativeObservationStore(f.config).inspect(f.intentReceipt));
});
test('isolated result cannot omit retained inputs or borrow a different archive',async()=>{
 for(const digest of [undefined,'0'.repeat(64)]){const f=await isolatedObservation();await assert.rejects(f.observations.retainIsolatedProvisional({...f.provisional,retainedInputsDigest:digest}));await assert.rejects(access(path.join(f.config.directory,runId+'.json')),{code:'ENOENT'});}
});
test('isolated receipt cannot be silently sent through the historical writer',async()=>{
 const f=await isolatedObservation();await assert.rejects(f.observations.retainProvisional(f.provisional));await assert.rejects(access(path.join(f.config.directory,runId+'.json')),{code:'ENOENT'});
});
test('control-character archive members rejected by Rust are refused by owner parser',async()=>{
 for(const control of ['\u007f','\u0085']){
  const f=await fixture();f.value.archive.entries.push({...f.value.archive.entries[1],path:'extra'+control});f.value.archive.totalBytes+=4;f.value.archiveDigest=hash(JSON.stringify(f.value.archive));const artifactBytes=Buffer.from(JSON.stringify(f.value));
  await assert.rejects(f.store.retain({...f.input,artifactBytes,artifactDigest:hash(artifactBytes)}));await assert.rejects(access(f.file),{code:'ENOENT'});
 }
});
