import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {packageNativeReviewHost} from '../scripts/package-native-review-host.mjs';
import {prepareNativeHostBundle} from '../scripts/prepare-native-host-bundle.mjs';
const digest=b=>createHash('sha256').update(b).digest('hex');
async function fixture(bootstrap=true){
  const root=await mkdtemp(path.join(os.tmpdir(),'pp-bundle-')),inputs=[];
  for(const name of ['native','node','module']){const sourcePath=path.join(root,name);await writeFile(sourcePath,name);inputs.push({sourcePath,sha256:digest(name)});}
  const packageRoot=path.join(root,'package');
  await packageNativeReviewHost({outputDir:packageRoot,hostExecutable:inputs[0],nodeExecutable:inputs[1],modules:[{...inputs[2],relativePath:bootstrap?'src/node/installedNativeReviewHostProcess.mjs':'other.mjs'}]});
  return {packageRoot,manifestDigest:digest(await readFile(path.join(packageRoot,'manifest.json'))),outputFile:path.join(root,'tauri-host.json')};
}
test('bundle maps only pinned files to fixed installed paths and returns the compiled pin',async()=>{
  const f=await fixture();await writeFile(path.join(f.packageRoot,'unlisted.js'),'not bundled');
  const result=await prepareNativeHostBundle(f),overlay=JSON.parse(await readFile(f.outputFile));
  assert.equal(result.resourceCount,4);assert.deepEqual(result.buildEnvironment,{PP_NATIVE_HOST_MANIFEST_SHA256:f.manifestDigest});
  assert.equal(result.executionAuthorized,false);assert.equal(result.publisherVerified,false);
  assert.deepEqual(Object.values(overlay.bundle.resources).sort(),['native-review-host/manifest.json','native-review-host/native/native-review.exe','native-review-host/runtime/node.exe','native-review-host/host/src/node/installedNativeReviewHostProcess.mjs'].sort());
  for(const source of Object.keys(overlay.bundle.resources))assert.ok(path.isAbsolute(source));
});
test('missing bootstrap, tampering and mismatched trusted pin cannot create a build overlay',async()=>{
  await assert.rejects(prepareNativeHostBundle(await fixture(false)),/BOOTSTRAP_MISSING/);
  const f=await fixture();await writeFile(path.join(f.packageRoot,'runtime','node.exe'),'changed');await assert.rejects(prepareNativeHostBundle(f));
  const g=await fixture();await assert.rejects(prepareNativeHostBundle({...g,manifestDigest:'f'.repeat(64)}));
});
test('existing build artifacts are preserved and package/output redirects refused',async()=>{
  const f=await fixture();await writeFile(f.outputFile,'preserve');await assert.rejects(prepareNativeHostBundle(f),/EEXIST/);assert.equal(await readFile(f.outputFile,'utf8'),'preserve');
  const g=await fixture();await assert.rejects(prepareNativeHostBundle({...g,outputFile:path.join(g.packageRoot,'overlay.json')}),/INSIDE_PACKAGE/);
  const alias=path.join(path.dirname(g.packageRoot),'redirect');await symlink(g.packageRoot,alias,process.platform==='win32'?'junction':'dir');
  await assert.rejects(prepareNativeHostBundle({...g,packageRoot:alias}));
});
test('relative outputs and extra renderer-style configuration are not accepted',async()=>{
  const f=await fixture();await assert.rejects(prepareNativeHostBundle({...f,outputFile:'relative.json'}),/OUTPUT_INVALID/);
  await assert.rejects(prepareNativeHostBundle({...f,command:'execute'}),/CONFIG_INVALID/);
  for(const name of ['existing.txt:overlay.json','CON','nul.json','trailing.','trailing ','bad\u0001.json']){
    await assert.rejects(prepareNativeHostBundle({...f,outputFile:path.join(path.dirname(f.outputFile),name)}),/OUTPUT_INVALID/);
  }
});
