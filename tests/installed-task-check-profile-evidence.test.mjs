import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createInstalledTaskCheckProfileEvidenceStore} from '../src/node/installedTaskCheckProfileEvidence.mjs';
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
async function fixture(limits={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pp-profile-evidence-')),directory=path.join(root,'evidence');
 const evidence={profileId:'perfect-planner-checks-v1',packageManifestDigest:'a'.repeat(64),registeredRoot:root,npmCli:{path:path.join(root,'npm-cli.js'),sha256:'b'.repeat(64),bytes:10},files:['package.json','package-lock.json','node_modules/vite/bin/vite.js','scripts/generate-truth-report.mjs','scripts/prepare-sites-build.mjs','scripts/verify-secrets.mjs'].map(name=>({path:name,sha256:'c'.repeat(64),bytes:20})),assignments:[{taskId:'T0001',categories:['tests','build','secrets']}],scriptDefinitions:{test:'node --test tests/*.test.mjs',build:'npm run build:client && node scripts/prepare-sites-build.mjs','build:client':'vite build && node scripts/generate-truth-report.mjs --release','verify:secrets':'node scripts/verify-secrets.mjs'}};
 return {root,directory,evidence,policyDigest:digest(evidence),store:createInstalledTaskCheckProfileEvidenceStore({directory,...limits})};
}
test('immutable exact evidence survives restart and concurrent original retries',async()=>{
 const f=await fixture(),input=structuredClone(f.evidence),pending=f.store.retain(input,f.policyDigest);input.assignments[0].categories=['secrets'];await pending;
 const results=await Promise.all([f.store.retain(f.evidence,f.policyDigest),f.store.retain(f.evidence,f.policyDigest)]);assert.ok(results.every(v=>v.idempotent&&v.observationEvidencePersisted&&v.executionAuthorized===false));
 const restarted=createInstalledTaskCheckProfileEvidenceStore({directory:f.directory});assert.deepEqual(await restarted.read(f.policyDigest),f.evidence);assert.equal((await fs.readdir(f.directory)).length,1);assert.ok(Object.isFrozen(results[0].evidence.assignments));
});
test('wrong digest and unsupported fields refuse without substitution',async()=>{
 const f=await fixture();await assert.rejects(f.store.read(f.policyDigest),error=>error.code==='ENOENT');await f.store.retain(f.evidence,f.policyDigest);await assert.rejects(f.store.retain({...f.evidence,packageManifestDigest:'d'.repeat(64)},f.policyDigest),/DIGEST_MISMATCH/);await assert.rejects(f.store.retain({...f.evidence,approval:true},f.policyDigest),/INVALID/);assert.deepEqual(await f.store.read(f.policyDigest),f.evidence);
});
test('partial and duplicate-key evidence remain preserved and fail closed',async()=>{
 for(const mode of ['partial','duplicate']){const f=await fixture();await f.store.retain(f.evidence,f.policyDigest);const file=path.join(f.directory,f.policyDigest+'.json'),original=await fs.readFile(file,'utf8'),changed=mode==='partial'?original.slice(0,-2):original.replace('{','{"profileId":"perfect-planner-checks-v1",');await fs.writeFile(file,changed);await assert.rejects(f.store.read(f.policyDigest),/CORRUPT/);await assert.rejects(f.store.retain(f.evidence,f.policyDigest),/CORRUPT/);assert.equal(await fs.readFile(file,'utf8'),changed);}
});
test('quota preserves orphan evidence and denies new entries without deleting history',async()=>{
 const f=await fixture({maxFiles:1});await f.store.retain(f.evidence,f.policyDigest);const next={...f.evidence,packageManifestDigest:'d'.repeat(64)};await assert.rejects(f.store.retain(next,digest(next)),/QUOTA/);assert.deepEqual(await f.store.read(f.policyDigest),f.evidence);assert.equal((await f.store.retain(f.evidence,f.policyDigest)).idempotent,true);
 const small=await fixture({maxBytes:1});await assert.rejects(small.store.retain(small.evidence,small.policyDigest),/QUOTA/);assert.deepEqual(await fs.readdir(small.directory),[]);
});
test('linked evidence, redirected directory and unknown entries are refused',async()=>{
 const f=await fixture();await f.store.retain(f.evidence,f.policyDigest);await fs.link(path.join(f.directory,f.policyDigest+'.json'),path.join(f.root,'retained-alias.json'));await assert.rejects(f.store.read(f.policyDigest),/UNSAFE_FILE/);
 const g=await fixture();await fs.mkdir(g.directory);const alias=path.join(g.root,'alias');await fs.symlink(g.directory,alias,process.platform==='win32'?'junction':'dir');await assert.rejects(createInstalledTaskCheckProfileEvidenceStore({directory:alias}).retain(g.evidence,g.policyDigest),/UNSAFE_PATH/);await fs.writeFile(path.join(g.directory,'unknown.txt'),'keep');await assert.rejects(g.store.retain(g.evidence,g.policyDigest),/UNEXPECTED_FILE/);
});
test('failed sync refuses success and exact retry must flush retained bytes',async t=>{
 const f=await fixture(),actualOpen=fs.open;let syncs=0;
 const mock=t.mock.method(fs,'open',async(...args)=>{const handle=await actualOpen(...args);if(args[0]===path.join(f.directory,f.policyDigest+'.json')&&(args[1]&1)){const sync=handle.sync.bind(handle);handle.sync=async()=>{if(++syncs===1)throw Error('simulated sync failure');return sync();};}return handle;});syncBuiltinESMExports();
 try{await assert.rejects(f.store.retain(f.evidence,f.policyDigest),/simulated sync failure/);assert.equal((await fs.readdir(f.directory)).length,1);const retry=await f.store.retain(f.evidence,f.policyDigest);assert.equal(retry.idempotent,true);assert.equal(syncs,2);assert.deepEqual(retry.evidence,f.evidence);}finally{mock.mock.restore();syncBuiltinESMExports();}
});
test('partial write and lost readback never report success or erase evidence',async t=>{
 for(const failure of ['partial','readback']){
  const f=await fixture(),actualOpen=fs.open,file=path.join(f.directory,f.policyDigest+'.json');let injected=false;
  const mock=t.mock.method(fs,'open',async(...args)=>{
   if(failure==='readback'&&!injected&&args[0]===file&&!(args[1]&1)){injected=true;throw Error('simulated readback failure');}
   const handle=await actualOpen(...args);
   if(failure==='partial'&&!injected&&args[0]===file&&(args[1]&1)){injected=true;const write=handle.writeFile.bind(handle);handle.writeFile=async bytes=>{await write(bytes.subarray(0,Math.floor(bytes.length/2)));throw Error('simulated partial write');};}
   return handle;
  });syncBuiltinESMExports();
  try{await assert.rejects(f.store.retain(f.evidence,f.policyDigest),/simulated/);}finally{mock.mock.restore();syncBuiltinESMExports();}
  const retained=await fs.readFile(file);assert.ok(retained.length>0);const restarted=createInstalledTaskCheckProfileEvidenceStore({directory:f.directory});
  if(failure==='partial'){await assert.rejects(restarted.retain(f.evidence,f.policyDigest),/CORRUPT/);assert.deepEqual(await fs.readFile(file),retained);}
  else{assert.equal((await restarted.retain(f.evidence,f.policyDigest)).idempotent,true);assert.deepEqual(await restarted.read(f.policyDigest),f.evidence);}
 }
});
