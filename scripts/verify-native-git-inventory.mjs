import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { validateGitInventory } from "../src/runtime/plannerGitInventory.js";

if (process.platform !== "win32") throw new Error("Native Git verification requires Windows.");
const executable = process.env.PERFECT_PLANNER_NATIVE_EXECUTABLE ?? fileURLToPath(new URL("../src-tauri/target/debug/perfect-planner-desktop.exe", import.meta.url));
if (!path.isAbsolute(executable)) throw new Error("Absolute native executable required.");
await realpath(executable);
const base = await realpath(await mkdtemp(path.join(tmpdir(), "pp-native-git-proof-")));
const root = path.join(base,"repo"), registry = path.join(base,"registry");
const git = (args) => {
  const result=spawnSync("C:\\Program Files\\Git\\cmd\\git.exe",args,{cwd:root,encoding:"utf8",windowsHide:true,shell:false,timeout:10000});
  assert.equal(result.status,0,result.stderr);return result.stdout;
};
try {
  await mkdir(root);await mkdir(registry);
  const canonicalRoot = `//?/${root.replaceAll("\\","/")}`;
  const request={schemaVersion:1,requestId:"native-proof-1",projectId:"native-proof",generation:1,workspaceId:"native-proof",registryRevision:1,rootIdentity:createHash("sha256").update(canonicalRoot).digest("hex")};
  await writeFile(path.join(registry,"native-proof.json"),JSON.stringify({schemaVersion:1,workspaceId:request.workspaceId,registryRevision:1,rootIdentity:request.rootIdentity,canonicalRoot,access:"metadata-read-only"}));
  const inspect=(binding=request)=>{
    const startedAt = Date.now();
    const result=spawnSync(executable,["--planner-git-probe","--registry-root",registry],{input:JSON.stringify(binding)+"\n",encoding:"utf8",windowsHide:true,shell:false,timeout:25000,maxBuffer:3*1024*1024,
      env:{...process.env,GIT_DIR:"untrusted-inherited-routing",GIT_EXEC_PATH:root}});
    assert.equal(result.status,0,JSON.stringify({error:result.error?.message,stderr:result.stderr,signal:result.signal}));
    const value=validateGitInventory(JSON.parse(result.stdout), binding, { startedAt, now: Date.now() });for(const [key,item]of Object.entries(binding))assert.equal(value[key],item);
    assert.equal(value.cleanupComplete,true,JSON.stringify(value));assert.equal(value.computerUse,false);assert.equal(value.executionAuthorized,false);return value;
  };
  assert.equal(inspect().observation.state,"no-git-marker");
  git(["init","-b","main"]);git(["config","user.name","Native Fixture"]);git(["config","user.email","fixture@example.invalid"]);
  await writeFile(path.join(root,"source.txt"),"baseline\n");git(["add","."]);git(["commit","-m","baseline"]);
  const linked=path.join(base,"working-copy");git(["worktree","add","-b","feature",linked]);git(["worktree","lock","--reason","private lock reason",linked]);
  await writeFile(path.join(root,"source.txt"),"unfinished work\n");await writeFile(path.join(linked,"untracked.txt"),"keep me\n");
  const before=git(["status","--porcelain=v1"]);
  const observed=inspect();assert.equal(observed.code,"GIT_OBSERVED",JSON.stringify(observed));
  assert.equal(observed.observation.worktrees.length,2);assert.equal(observed.observation.branches.length,2);
  assert.equal(observed.observation.worktrees.filter((row)=>row.locked).length,1);
  assert.equal(observed.observation.cleanState,"not-inspected");assert.equal(observed.observation.productionState,"not-inspected");
  assert.equal(JSON.stringify(observed).includes("private lock reason"),false);
  assert.equal(git(["status","--porcelain=v1"]),before);assert.equal(await readFile(path.join(root,"source.txt"),"utf8"),"unfinished work\n");assert.equal(await readFile(path.join(linked,"untracked.txt"),"utf8"),"keep me\n");
  const stale=inspect({...request,registryRevision:2});assert.equal(stale.code,"GIT_REGISTRATION_INVALID");assert.equal(stale.observation,null);
  console.log(JSON.stringify({state:"verified",scope:"native-executable-headless-fixture",guiIpcVerified:false,computerUse:false,worktrees:2,branches:2,cleanupComplete:true,dirtyWorkPreserved:true,staleRegistrationRefused:true,durationMs:observed.durationMs}));
} finally {
  // Only this uniquely created, canonical fixture tree is removed.
  assert.equal(path.dirname(base).toLowerCase(),(await realpath(tmpdir())).toLowerCase());
  assert.ok(path.basename(base).startsWith("pp-native-git-proof-"));
  await rm(base,{recursive:true,force:true});
}
