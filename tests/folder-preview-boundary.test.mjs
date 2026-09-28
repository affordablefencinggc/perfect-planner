import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {previewRegisteredWorkspace} from "../src/native/workspaceCensus.js";
test("native preview is separately scoped and cannot become verified census",async()=>{
  const args={workspaceId:"preview-test",registryRevision:1,runtime:{__TAURI_INTERNALS__:{}}};
  const fixture={schemaVersion:1,kind:"folder-preview",authoritative:false,contentVerified:false,workspaceId:"preview-test",registryRevision:1,fileCount:1,files:[{path:"src/main.ts"}],skipped:[]};
  const result=await previewRegisteredWorkspace({...args,invoke:async(command,payload)=>{
    assert.equal(command,"preview_registered_workspace");assert.equal(payload.request.maxFiles,50000);return fixture;
  }});
  assert.equal(result.available,true);assert.equal(result.authoritative,false);assert.equal(result.contentVerified,false);
  for(const patch of [{authoritative:true},{contentVerified:true},{workspaceId:"other-project"},{registryRevision:2},{fileCount:2}]){
    assert.equal((await previewRegisteredWorkspace({...args,invoke:async()=>({...fixture,...patch})})).available,false);
  }
});
test("main-window preview permission names only its bounded native handler",async()=>{
  const capability=JSON.parse(await readFile(new URL("../src-tauri/capabilities/main-read-only.json",import.meta.url),"utf8"));
  assert.deepEqual(capability.permissions,["allow-runtime-snapshot","allow-select-workspace-folder","allow-register-workspace-read-only","allow-census-registered-workspace","allow-preview-registered-workspace"]);
  const build=await readFile(new URL("../src-tauri/build.rs",import.meta.url),"utf8");
  const lib=await readFile(new URL("../src-tauri/src/lib.rs",import.meta.url),"utf8");
  assert.match(build,/"preview_registered_workspace"/);assert.match(lib,/workspace_census::preview_registered_workspace/);
});
