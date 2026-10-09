import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,lstat,link,mkdir,symlink} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {inspectConfirmations,requestConfirmation} from '../src/node/confirmationStore.mjs';

test('confirmation reads refuse oversized files and hardlink aliases',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'pp-confirm-storage-')),file=path.join(root,'store.json');
 await writeFile(file,Buffer.alloc(8*1024*1024+1,32));
 await assert.rejects(inspectConfirmations(file),/unsafe or oversized/);
 await writeFile(file,JSON.stringify({schemaVersion:1,requests:[]}));
 await link(file,path.join(root,'alias.json'));
 await assert.rejects(inspectConfirmations(file),/unsafe or oversized/);
});
test('confirmation reads refuse redirected parent directories',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'pp-confirm-parent-')),real=path.join(root,'real'),alias=path.join(root,'alias');
 await mkdir(real);await writeFile(path.join(real,'store.json'),JSON.stringify({schemaVersion:1,requests:[]}));
 await symlink(real,alias,process.platform==='win32'?'junction':'dir');
 await assert.rejects(inspectConfirmations(path.join(alias,'store.json')),/parent is redirected/);
 await assert.rejects(requestConfirmation(path.join(alias,'new-child','store.json'),{planId:'plan',itemId:'item',question:'review',requestedBy:'worker'}),/parent is redirected/);
 await assert.rejects(lstat(path.join(real,'new-child')),error=>error.code==='ENOENT');
});
test('oversized publication preserves existing requests without a partial temporary file',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'pp-confirm-write-limit-')),file=path.join(root,'store.json');
 const request={planId:'plan',itemId:'first',question:'Existing review',requestedBy:'worker'};
 await requestConfirmation(file,request);
 const before=await readFile(file,'utf8'),files=await readdir(root);
 await assert.rejects(requestConfirmation(file,{...request,itemId:'second',question:'x'.repeat(8*1024*1024)}),/exceeds byte limit/);
 assert.equal(await readFile(file,'utf8'),before);assert.deepEqual(await readdir(root),files);
 assert.equal((await inspectConfirmations(file)).length,1);
});
test('missing parents are unavailable, and relative writes are refused before mutation',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'pp-confirm-missing-'));
 await assert.rejects(inspectConfirmations(path.join(root,'missing','store.json')),error=>error.code==='ENOENT');
 await assert.rejects(requestConfirmation('relative-confirmation/store.json',{planId:'plan',itemId:'item',question:'review',requestedBy:'worker'}),/path is invalid/);
});
