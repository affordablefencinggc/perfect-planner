import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,realpath,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {preparePlannerDraft} from '../mcp/plannerDraftBridge.mjs';
import {createImportedProjectId} from '../src/project/projectIds.js';
import {emptyTaskDraftLedger,updateTaskDraft,parseTaskDraftImport,importTaskDraft} from '../src/project/taskDraftLedger.js';
test('registered MCP proposal round-trips through guarded import without claiming live save',async()=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'pp-draft-bridge-')));
 try{
  const registry=path.join(root,'registry'),workspace=path.join(root,'workspace');await mkdir(registry);await mkdir(workspace);
  const identity=createHash('sha256').update(workspace).digest('hex');
  await writeFile(path.join(registry,'fixture.json'),JSON.stringify({schemaVersion:1,registryRevision:1,workspaceId:'fixture',canonicalRoot:workspace,rootIdentity:identity,access:'metadata-read-only'}));
  const binding={projectId:createImportedProjectId(identity),rootIdentity:identity,censusDigest:'b'.repeat(64)};
  const empty=emptyTaskDraftLedger(binding),ledger=updateTaskDraft(empty,{id:null,title:'Review auth boundaries',description:'Inspect existing code',owner:'Agent',acceptance:'Evidence attached',recovery:'No source edits',claims:[{path:'src/auth.ts',access:'read'}],dependsOn:[],archived:false});
  const result=await preparePlannerDraft(registry,'fixture',ledger);
  assert.equal(result.savedToPlanner,false);assert.equal(result.executionAuthorized,false);assert.equal(result.censusBindingVerified,false);
  assert.equal(importTaskDraft(empty,parseTaskDraftImport(result.draftJson)).ledger.tasks[0].title,ledger.tasks[0].title);
  await assert.rejects(preparePlannerDraft(registry,'fixture',{...ledger,binding:{...binding,rootIdentity:'c'.repeat(64)}}),/FOREIGN/);
  await assert.rejects(preparePlannerDraft(registry,'fixture',{...ledger,approved:true}),/unsupported shape/);
  assert.throws(()=>importTaskDraft(emptyTaskDraftLedger({...binding,censusDigest:'d'.repeat(64)}),parseTaskDraftImport(result.draftJson)),/another project/);
 }finally{await rm(root,{recursive:true,force:true});}
});
