import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,link,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {packageNativeReviewHost} from '../scripts/package-native-review-host.mjs';
import {verifyNativeReviewHostPackage} from '../src/node/nativeReviewHostPackage.mjs';
const digest=b=>createHash('sha256').update(b).digest('hex');
async function fixture(withHelper=false){
  const root=await mkdtemp(path.join(os.tmpdir(),'pp-consumer-')),inputs=[];
  for(const name of ['native','node','module']){const sourcePath=path.join(root,name);await writeFile(sourcePath,name);inputs.push({sourcePath,sha256:digest(name)});}
  const packageRoot=path.join(root,'package');
  await packageNativeReviewHost({outputDir:packageRoot,hostExecutable:inputs[0],nodeExecutable:inputs[1],modules:[{...inputs[2],relativePath:'main.mjs'}],...(withHelper?{agentHelperExecutable:inputs[0]}:{})});
  const manifestPath=path.join(packageRoot,'manifest.json');
  return {root,packageRoot,manifestPath,manifestDigest:digest(await readFile(manifestPath))};
}
const config=f=>({packageRoot:f.packageRoot,manifestDigest:f.manifestDigest});
test('optional helper is accepted only with exact manifest-pinned bytes',async()=>{
  const f=await fixture(true);const result=await verifyNativeReviewHostPackage(config(f));assert.equal(result.files.length,4);
  assert.equal(result.files.find(v=>v.path==='native/planner-agent-helper.exe').sha256,digest('native'));
  await writeFile(path.join(f.packageRoot,'native','planner-agent-helper.exe'),'tampered');await assert.rejects(verifyNativeReviewHostPackage(config(f)));
});
test('consumer accepts pinned complete package without granting execution',async()=>{const f=await fixture(),result=await verifyNativeReviewHostPackage(config(f));assert.equal(result.files.length,3);assert.equal(result.executionAuthorized,false);assert.equal(result.publisherVerified,false);assert.equal(result.nodeExecutable,path.join(f.packageRoot,'runtime','node.exe'));assert.ok(Object.isFrozen(result.files[0]));});
test('changed module, wrong manifest pin and partial manifest fail closed',async()=>{
  const f=await fixture();await writeFile(path.join(f.packageRoot,'host','main.mjs'),'tamper');await assert.rejects(verifyNativeReviewHostPackage(config(f)));
  const g=await fixture();await assert.rejects(verifyNativeReviewHostPackage({...config(g),manifestDigest:'f'.repeat(64)}),/PIN_MISMATCH/);
  await writeFile(g.manifestPath,'{"schemaVersion":');g.manifestDigest=digest(await readFile(g.manifestPath));await assert.rejects(verifyNativeReviewHostPackage(config(g)),/MANIFEST_INVALID/);
});
test('installed hardlinks and redirected root are refused',async()=>{
  const f=await fixture();await link(path.join(f.packageRoot,'runtime','node.exe'),path.join(f.root,'alias.exe'));await assert.rejects(verifyNativeReviewHostPackage(config(f)),/FILE_UNSAFE/);
  const g=await fixture(),alias=path.join(g.root,'redirect');await symlink(g.packageRoot,alias,process.platform==='win32'?'junction':'dir');await assert.rejects(verifyNativeReviewHostPackage({...config(g),packageRoot:alias}),/DIRECTORY_UNSAFE/);
});
test('pinned malformed structure cannot add traversal, duplicate entries or misleading totals',async()=>{
  for(const mutate of [m=>{m.files[2].path='host/../escape.mjs';},m=>{m.files.push({...m.files[2]});m.totalBytes+=m.files[2].bytes;},m=>{m.totalBytes++;},m=>{m.executionAuthorized=true;},m=>{m.files=m.files.slice(1);},m=>{m.files[2].bytes=9*1024*1024;}]){
    const f=await fixture(),m=JSON.parse(await readFile(f.manifestPath));mutate(m);await writeFile(f.manifestPath,JSON.stringify(m));f.manifestDigest=digest(await readFile(f.manifestPath));await assert.rejects(verifyNativeReviewHostPackage(config(f)));
  }
});
test('caller cannot supply commands or relative package root',async()=>{const f=await fixture();await assert.rejects(verifyNativeReviewHostPackage({...config(f),command:'execute'}),/CONFIG_INVALID/);await assert.rejects(verifyNativeReviewHostPackage({...config(f),packageRoot:'relative'}),/CONFIG_INVALID/);});
