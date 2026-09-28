import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,link,symlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {createTaskCheckContract} from '../src/node/taskCheckContract.mjs';
import {inspectTaskCheckFiles} from '../src/node/taskCheckFileEvidence.mjs';
async function fixture(){
 const root=await mkdtemp(path.join(os.tmpdir(),'pp-check-files-'));
 const executablePath=path.join(root,'tool.bin');await writeFile(executablePath,'reviewed bytes');
 const contract=createTaskCheckContract({schemaVersion:1,kind:'TASK_CHECK_CONTRACT',projectId:'pp_files_fixture',rootIdentity:'a'.repeat(64),policyVersion:1,policyDigest:'b'.repeat(64),tasks:[{taskId:'T0001',checks:[{checkId:'unit',executablePath,executableDigest:createHash('sha256').update('reviewed bytes').digest('hex'),args:[],cwd:'.',timeoutMs:1000,outputLimits:{stdoutBytes:100,stderrBytes:100,combinedBytes:200}}]}]});
 return {root,executablePath,options:{checkContract:contract,taskId:'T0001',checkId:'unit',registeredRoot:root}};
}
test('reads actual executable bytes, rejects changed bytes and never claims candidate or launch authority',async()=>{
 const f=await fixture();const evidence=await inspectTaskCheckFiles(f.options);
 assert.equal(evidence.executableBytes,14);assert.equal(evidence.executionAuthorized,false);assert.equal(evidence.candidateVerified,false);assert.ok(Object.isFrozen(evidence));
 await writeFile(f.executablePath,'replaced bytes');await assert.rejects(inspectTaskCheckFiles(f.options),/FILES_UNVERIFIED/);
 await assert.rejects(inspectTaskCheckFiles({...f.options,checkId:'unreviewed'}),/FILES_UNVERIFIED/);
});
test('refuses hardlinked executable and junction cwd rather than following aliases',async()=>{
 const f=await fixture();await link(f.executablePath,path.join(f.root,'alias.bin'));
 await assert.rejects(inspectTaskCheckFiles(f.options),/FILES_UNVERIFIED/);
 const g=await fixture();const outside=await mkdtemp(path.join(os.tmpdir(),'pp-check-outside-'));
 await mkdir(path.join(g.root,'nested'));await symlink(outside,path.join(g.root,'nested','alias'),process.platform==='win32'?'junction':'dir');
 const {contractDigest,executionAuthorized,authorityVerified,...body}=structuredClone(g.options.checkContract);body.tasks[0].checks[0].cwd='nested/alias';
 await assert.rejects(inspectTaskCheckFiles({...g.options,checkContract:createTaskCheckContract(body)}),/FILES_UNVERIFIED/);
});
