import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {allocateCompilationTemp} from '../src/node/nativeCompilationScratch.mjs';

test('retained nested npm compile cache does not prevent the next allocation',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'planner-scratch-regression-'));
 const root=path.join(base,'scratch'),first=await allocateCompilationTemp(root);
 const cache=path.join(first.directory,'node-compile-cache','v22-fixture');
 await mkdir(cache,{recursive:true});const file=path.join(cache,'fixture');await writeFile(file,'retained cache');
 const second=await allocateCompilationTemp(root);
 assert.notEqual(second.directory,first.directory);
 assert.equal(await readFile(file,'utf8'),'retained cache');
 // Test data intentionally retained for failure diagnosis; never delete runtime scratch.
});

test('nested inventory retains the file-count bound',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'planner-scratch-limit-'));
 const root=path.join(base,'scratch'),first=await allocateCompilationTemp(root);
 const nested=path.join(first.directory,'cache');await mkdir(nested);
 for(let i=0;i<257;i++)await writeFile(path.join(nested,String(i)),'x');
 await assert.rejects(allocateCompilationTemp(root),/NATIVE_COMPILATION_SCRATCH_UNAVAILABLE/);
 assert.equal(await readFile(path.join(nested,'256'),'utf8'),'x');
});

test('over-deep retained trees are refused without removing data',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'planner-scratch-depth-'));
 const root=path.join(base,'scratch'),first=await allocateCompilationTemp(root);
 const nested=path.join(first.directory,...Array(9).fill('cache'));await mkdir(nested,{recursive:true});
 await assert.rejects(allocateCompilationTemp(root),/NATIVE_COMPILATION_SCRATCH_UNAVAILABLE/);
});
