import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {watch} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runBoundedProcess,runGuardedGit} from '../src/node/guardedGitRunner.mjs';

test('pre-cancelled process and Git request never start',async()=>{
 const controller=new AbortController();controller.abort();
 const result=await runBoundedProcess('does-not-exist',[],{signal:controller.signal});
 assert.equal(result.reason,'git-cancelled');assert.equal(result.cleanupComplete,true);assert.equal(result.outputComplete,false);
 await assert.rejects(runGuardedGit('does-not-exist',['status'],{signal:controller.signal}),/git-cancelled/);
});

test('cancellation after real child readiness waits for contained process closure',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'pp-cancel-proof-'));
 const script=path.join(root,'wait.cjs');
 await writeFile(script,"const fs=require('node:fs');fs.writeFileSync('pid',String(process.pid));fs.writeFileSync('ready','ready');setInterval(()=>{},1000);");
 const controller=new AbortController();let ready=false;
 const watcher=watch(root,(_event,name)=>{if(String(name)==='ready'){ready=true;controller.abort();}});
 try {
  const result=await runBoundedProcess(process.execPath,[script],{cwd:root,signal:controller.signal,timeoutMs:10000});
  assert.equal(ready,true);assert.equal(result.reason,'git-cancelled');assert.equal(result.exit,null);
  assert.equal(result.cleanupComplete,true);assert.equal(result.outputComplete,false);assert.equal(result.timedOut,false);
  const pid=Number(await readFile(path.join(root,'pid'),'utf8'));assert.ok(Number.isSafeInteger(pid)&&pid>0);
  assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
 } finally {watcher.close();}
});
