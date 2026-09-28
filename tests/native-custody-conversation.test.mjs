import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {runBoundedTaskConversation} from '../src/node/guardedGitRunner.mjs';

async function fixture(body){
 assert.equal(os.hostname().toLowerCase(),'dans1');
 const directory=await mkdtemp(path.join(os.tmpdir(),'pp-conversation-'));
 const file=path.join(directory,'child.mjs');await writeFile(file,body);
 return {directory,file};
}
const interactive=`import readline from 'node:readline';let n=0;const lines=readline.createInterface({input:process.stdin});lines.on('line',line=>{const v=JSON.parse(line);if(n===0&&v.start!==true)process.exit(8);if(n>0&&v.reply!==n)process.exit(9);n++;console.log(JSON.stringify({frame:n}));if(n===3)lines.close();});`;
test('actual contained child exchanges three ordered frames and awaits each response',async()=>{
 const f=await fixture(interactive),seen=[];
 const result=await runBoundedTaskConversation(process.execPath,[f.file],{cwd:f.directory,timeoutMs:15000,input:'{"start":true}'},async value=>{seen.push(value.frame);await new Promise(r=>setTimeout(r,15));return value.frame===3?null:{reply:value.frame};});
 assert.equal(result.exit,0,JSON.stringify(result));assert.equal(result.reason,null);assert.equal(result.cleanupComplete,true);assert.deepEqual(seen,[1,2,3]);
});
test('pipelined, malformed, excess and truncated frames are refused',async()=>{
 for(const output of ['{}\n{}\n','not json\n','{}','{}\n{}\n{}\n{}\n']){
  const f=await fixture(`process.stdout.write(${JSON.stringify(output)});`);
  const result=await runBoundedTaskConversation(process.execPath,[f.file],{cwd:f.directory,timeoutMs:15000,input:'{}'},async()=>null);
  assert.notEqual(result.reason,null);assert.equal(result.outputComplete,false);
 }
});
test('cancellation waits for an in-flight persistence callback without sending another response',async()=>{
 const f=await fixture(interactive),abort=new AbortController();let settled=false,calls=0;
 const result=await runBoundedTaskConversation(process.execPath,[f.file],{cwd:f.directory,timeoutMs:15000,input:'{"start":true}',signal:abort.signal},async(value,{signal})=>{
  calls++;abort.abort();await new Promise(r=>setTimeout(r,250));assert.equal(signal.aborted,true);settled=true;return {reply:value.frame};
 });
 assert.equal(result.reason,'git-cancelled');assert.equal(settled,true);assert.equal(calls,1);
});
test('a child disconnect while persistence is running cannot return before persistence settles',async()=>{
 const f=await fixture(`console.log('{"frame":1}');`);let settled=false;
 const result=await runBoundedTaskConversation(process.execPath,[f.file],{cwd:f.directory,timeoutMs:15000,input:'{}'},async()=>{await new Promise(r=>setTimeout(r,500));settled=true;return {reply:1};});
 assert.equal(settled,true);assert.notEqual(result.reason,null);assert.equal(result.outputComplete,false);
});
test('callback failure settles the contained child and refuses output',async()=>{
 const f=await fixture(interactive);
 const result=await runBoundedTaskConversation(process.execPath,[f.file],{cwd:f.directory,timeoutMs:15000,input:'{"start":true}'},async()=>{throw Error('retention unavailable');});
 assert.equal(result.reason,'native-conversation-handler');assert.equal(result.cleanupComplete,true);
});
test('nested cleanup uncertainty survives callback failure before and after child close',async()=>{
 for(const disconnect of [false,true]){
  const f=await fixture(disconnect?`console.log('{"frame":1}');`:interactive);
  const result=await runBoundedTaskConversation(process.execPath,[f.file],{cwd:f.directory,timeoutMs:15000,input:'{"start":true}'},async()=>{if(disconnect)await new Promise(r=>setTimeout(r,500));throw Object.assign(Error('snapshot cleanup uncertain'),{cleanupComplete:false});});
  assert.equal(result.cleanupComplete,false);assert.notEqual(result.reason,null);
 }
});
