import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,unlink,link} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {candidateSnapshot} from '../src/node/mergedStateRunner.mjs';
import {createInstalledTaskExecutionCustody} from '../src/node/installedTaskExecutionCustody.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
async function fixture(manifestOverride){
 assert.equal(os.hostname().toLowerCase(),'dans1');
 const root=await mkdtemp(path.join(os.tmpdir(),'pp-candidate-manifest-')),candidate=path.join(root,'candidate');await mkdir(candidate);
 await writeFile(path.join(candidate,'input.txt'),'original tested input');
 const inventory=async(_root,args)=>({exit:0,stdout:args.includes('--stage')?'index-material':args.includes('--cached')?'input.txt\0':''});
 let snapshot=await candidateSnapshot(candidate,inventory,{includeManifest:true});assert.equal(snapshot.valid,true);assert.ok(snapshot.manifest,'exact snapshot manifest must be available');
 if(manifestOverride)snapshot={...snapshot,manifest:manifestOverride,digest:hash(JSON.stringify(manifestOverride))};
 const binding={projectId:'pp_manifest',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)};
 const config={stateDirectory:root,binding,observeBinding:async()=>binding},custody=createInstalledTaskExecutionCustody(config),directory=path.join(root,`${binding.projectId}.native-observations`);await mkdir(directory);
 const bound={proposalRevision:1,proposalDigest:'a'.repeat(64),checkContractDigest:'b'.repeat(64),enrollmentEpoch:1,taskId:'T0001',checkId:'unit',attemptId:'attempt1',attemptNumber:1,workerId:'worker1',sessionId:'session1',candidateSchemaVersion:2,candidateDigest:snapshot.digest,policyVersion:1,policyDigest:'d'.repeat(64)};
 const {grant}=await custody.grants.issue(bound,{requestId:'issue',expectedRevision:0,ttlMs:300000});
 const consumed=await custody.grants.consume(bound,{grantId:grant.grantId,requestId:'consume',expectedRevision:1});
 const {intentReceipt}=await custody.grants.recordExecutionIntent(consumed.consumptionReceipt,{grantId:grant.grantId,requestId:'intent',expectedRevision:2});
 const executionSpec={runId:intentReceipt.runId,intentDigest:intentReceipt.recordDigest,candidateDigest:bound.candidateDigest,checkContractDigest:bound.checkContractDigest,outputLimits:{stdoutBytes:100,stderrBytes:100,combinedBytes:200}};
 const observation={schemaVersion:2,kind:'NATIVE_TASK_OBSERVATION',runId:intentReceipt.runId,exitCode:0,timedOut:false,cancelObserved:false,outputTruncated:false,cpuTimeExceeded:false,cpuObservationFailed:false,processExited:true,jobEmptyObserved:true,descendantsSettled:true,ioSettled:true,ioFailed:false,stdout:'observed',stderr:''};
 const input={intentReceipt,executionSpec,observation},manifestFile=path.join(directory,intentReceipt.runId+'.candidate.json');
 const retain=()=>custody.custody.retainCandidate({intentReceipt,executionSpec,manifest:snapshot.manifest});
 return {root,candidate,inventory,snapshot,config,custody,input,manifestFile,retain,grantId:grant.grantId};
}
async function provisional(f){const saved=await f.retain();return f.custody.custody.retainProvisional({...f.input,candidateManifestDigest:saved.artifactDigest});}
function finalization(f,saved){return {schemaVersion:2,kind:'NATIVE_TASK_GUARD_FINALIZED',runId:f.input.intentReceipt.runId,intentDigest:f.input.intentReceipt.recordDigest,candidateDigest:f.snapshot.digest,checkContractDigest:f.input.executionSpec.checkContractDigest,artifactDigest:saved.artifactDigest,executionAuthorized:false};}
test('guarded manifest reproduces candidate identity and survives later working-copy edits',async()=>{
 const f=await fixture();assert.equal(hash(JSON.stringify(f.snapshot.manifest)),f.snapshot.digest);
 assert.equal((await candidateSnapshot(f.candidate,f.inventory)).manifest,undefined);
 const receipt=await f.retain(),bytes=await readFile(f.manifestFile);assert.equal(receipt.artifactDigest,hash(bytes));
 assert.deepEqual(await f.retain(),receipt);
 const saved=await provisional(f);await f.custody.custody.finalize({intentReceipt:f.input.intentReceipt,finalization:finalization(f,saved)});
 await writeFile(path.join(f.candidate,'input.txt'),'later input');
 assert.notEqual((await candidateSnapshot(f.candidate,f.inventory)).digest,f.snapshot.digest);
 const reopened=createInstalledTaskExecutionCustody(f.config),result=await reopened.results.readOwner({grantId:f.grantId});
 assert.equal(result.journalLinked,true);assert.equal(result.authorityVerified,false);assert.deepEqual(await readFile(f.manifestFile),bytes);
});
test('missing, altered, linked or foreign manifest prevents finalized recovery without altering history',async()=>{
 for(const mutation of ['missing','changed','hardlink','foreign']){
  const f=await fixture(),saved=await provisional(f);await f.custody.custody.finalize({intentReceipt:f.input.intentReceipt,finalization:finalization(f,saved)});
  if(mutation==='missing')await unlink(f.manifestFile);
  if(mutation==='changed')await writeFile(f.manifestFile,(await readFile(f.manifestFile,'utf8')).replace('input.txt','wrong.txt'));
  if(mutation==='hardlink')await link(f.manifestFile,path.join(f.root,'alias'));
  if(mutation==='foreign'){const other=await fixture();await other.retain();await writeFile(f.manifestFile,await readFile(other.manifestFile));}
  const reopened=createInstalledTaskExecutionCustody(f.config);await assert.rejects(reopened.results.readOwner({grantId:f.grantId}));await assert.rejects(reopened.custody.reconcile(f.input.intentReceipt));assert.equal((await reopened.grants.inspect()).revision,4);
 }
});
test('partial manifest and incorrect digest cannot be repaired into a final result',async()=>{
 const f=await fixture();await writeFile(f.manifestFile,'{"partial":');await assert.rejects(f.retain());assert.equal(await readFile(f.manifestFile,'utf8'),'{"partial":');
 await assert.rejects(f.custody.custody.retainProvisional({...f.input,candidateManifestDigest:'f'.repeat(64)}));assert.equal((await f.custody.grants.inspect()).revision,3);
});
test('omitted manifest digest cannot downgrade a new guarded observation',async()=>{
 const f=await fixture();await f.retain();
 await assert.rejects(f.custody.custody.retainProvisional(f.input));
 await assert.rejects(readFile(path.join(path.dirname(f.manifestFile),f.input.intentReceipt.runId+'.json')));
 assert.equal((await f.custody.grants.inspect()).revision,3);
});
test('retained historical schema-two output stays readable without invented manifest evidence',async()=>{
 const f=await fixture();await provisional(f);
 const file=path.join(path.dirname(f.manifestFile),f.input.intentReceipt.runId+'.json'),record=JSON.parse(await readFile(file,'utf8'));
 const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
 const wire=v=>JSON.stringify(canonical(v));
 // Construct previously supported disk bytes, not a new writer API.
 delete record.recordDigest;delete record.candidateManifestDigest;record.schemaVersion=2;
 record.recordDigest=hash(wire(record));const bytes=Buffer.from(wire(record)+'\n');await writeFile(file,bytes);await unlink(f.manifestFile);
 await f.custody.custody.finalize({intentReceipt:f.input.intentReceipt,finalization:finalization(f,{artifactDigest:hash(bytes)})});
 const read=await createInstalledTaskExecutionCustody(f.config).results.readOwner({grantId:f.grantId});assert.equal(read.authorityVerified,false);assert.equal(read.journalLinked,true);
 await assert.rejects(readFile(f.manifestFile));
});
test('actual serialized sidecar limit is enforced before a large manifest is retained',async()=>{
 const manifest={schemaVersion:2,index:'c'.repeat(64),entries:Array.from({length:512},(_,i)=>[String(i).padStart(5,'0')+'-'+ 'x'.repeat(32600),'missing'])};
 let remaining=16*1024*1024-1-Buffer.byteLength(JSON.stringify(manifest));assert.ok(remaining>0);
 for(const entry of manifest.entries){const n=Math.min(remaining,32768-entry[0].length);entry[0]+='x'.repeat(n);remaining-=n;}
 assert.equal(remaining,0);assert.equal(Buffer.byteLength(JSON.stringify(manifest)),16*1024*1024-1);
 const f=await fixture(manifest);await assert.rejects(f.retain());await assert.rejects(readFile(f.manifestFile));assert.equal((await f.custody.grants.inspect()).revision,3);
});
test('manifest structure, exact candidate binding and file accounting are enforced before retention',async()=>{
 const f=await fixture();
 for(const mutation of [m=>m.entries.push(m.entries[0]),m=>m.entries[0][0]='../escape',m=>m.entries[0][2]++,m=>m.index='f'.repeat(64),m=>m.authorityVerified=true]){
  const manifest=structuredClone(f.snapshot.manifest);mutation(manifest);await assert.rejects(f.custody.custody.retainCandidate({...f.input,manifest}));
 }
 await assert.rejects(readFile(f.manifestFile));assert.equal((await f.custody.grants.inspect()).revision,3);
});
