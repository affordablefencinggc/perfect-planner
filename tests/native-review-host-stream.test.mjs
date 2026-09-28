import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough,Writable,Readable} from 'node:stream';
import {createNativeReviewHostStream} from '../src/node/nativeReviewHostStream.mjs';

const reply=JSON.stringify({ok:true})+'\n';
function fixture({dispatchLine=async()=>reply,shutdown=async()=>({cleanupComplete:true}),output=new PassThrough(),settleMs=100,writeTimeoutMs=5000}={}) {
  const input=new PassThrough();let shutdownCalls=0;
  const adapter=createNativeReviewHostStream({input,output,protocol:{dispatchLine},shutdown:async()=>{shutdownCalls++;return shutdown();},settleMs,writeTimeoutMs});
  return {input,output,adapter,calls:()=>shutdownCalls};
}
const nextData=stream=>new Promise(resolve=>stream.once('data',resolve));

test('large line in single-byte fragments retains exact contents',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const line='x'.repeat(32768)+'\n';
  const input=Readable.from((async function*(){for(const c of line)yield Buffer.from(c);await gate;})(),{objectMode:false});
  const output=new PassThrough();let seen;
  const adapter=createNativeReviewHostStream({input,output,protocol:{limits:{lineBytes:1024*1024+4096},dispatchLine:async value=>{seen=value;return reply;}},shutdown:async()=>({cleanupComplete:true})});
  const received=nextData(output),done=adapter.start();await received;assert.equal(seen,line);release();assert.equal((await done).cleanupComplete,true);
});

test('host-advertised draft framing accepts bounded larger lines and caps configuration',async()=>{
  const input=new PassThrough(),output=new PassThrough();let seen;
  const protocol={limits:{lineBytes:1024*1024+4096},dispatchLine:async line=>{seen=line;return reply;}};
  const adapter=createNativeReviewHostStream({input,output,protocol,shutdown:async()=>({cleanupComplete:true})});
  const done=adapter.start(),received=nextData(output),line='x'.repeat(32768)+'\n';input.write(line);await received;assert.equal(seen,line);input.end();assert.equal((await done).cleanupComplete,true);
  for(const lineBytes of [16383,1024*1024+4097,Infinity])assert.throws(()=>createNativeReviewHostStream({input:new PassThrough(),output:new PassThrough(),protocol:{...protocol,limits:{lineBytes}},shutdown:async()=>({cleanupComplete:true})}),/CONFIG_INVALID/);
});

test('UTF8 line split across chunks dispatches once and keeps native closure unknown',async()=>{
  let seen;const f=fixture({dispatchLine:async line=>{seen=line;return reply;}});const done=f.adapter.start();
  const bytes=Buffer.from('{"label":"café"}\n');const split=bytes.indexOf(0xc3)+1;
  const received=nextData(f.output);f.input.write(bytes.subarray(0,split));f.input.write(bytes.subarray(split));await received;
  assert.equal(seen,bytes.toString());f.input.end();const result=await done;
  assert.equal(result.reason,'STREAM_EOF');assert.equal(result.dialogClosed,null);assert.equal(result.executionAuthorized,false);assert.equal(f.calls(),1);
});

test('oversize, invalid UTF8 and trailing partial input are rejected without dispatch',async()=>{
  for(const [bytes,reason] of [[Buffer.alloc(16385,65),'STREAM_INPUT_LIMIT'],[Buffer.from([0xff,10]),'STREAM_UTF8_INVALID'],[Buffer.from('{"unfinished":'),'STREAM_TRAILING_PARTIAL']]) {
    let calls=0;const f=fixture({dispatchLine:async()=>{calls++;return reply;}});const done=f.adapter.start();f.input.end(bytes);
    assert.equal((await done).reason,reason);assert.equal(calls,0);assert.equal(f.calls(),1);
  }
});

test('second dispatch reaches cancellation while original review remains pending',async()=>{
  let release,entered;const started=new Promise(resolve=>{entered=resolve;});const review=new Promise(resolve=>{release=resolve;});
  let active=0,maximum=0;
  const f=fixture({dispatchLine:async line=>{active++;maximum=Math.max(maximum,active);if(line==='review\n'){entered();await review;}else if(line==='cancel\n')release();active--;return reply;}});
  f.output.resume();const done=f.adapter.start();f.input.write('review\n');await started;
  const response=nextData(f.output);f.input.write('cancel\n');await response;f.input.end();await done;
  assert.equal(maximum,2);assert.equal(f.calls(),1);
});

test('disconnect requests shutdown exactly once and reports a stuck dispatcher honestly',async()=>{
  let entered;const started=new Promise(resolve=>{entered=resolve;});
  const f=fixture({dispatchLine:async()=>{entered();await new Promise(()=>{});},shutdown:async()=>({cleanupComplete:true}),settleMs:20});
  const done=f.adapter.start();f.input.write('{}\n');await started;f.input.destroy();
  const result=await done;await f.adapter.stop();
  assert.equal(f.calls(),1);assert.equal(result.dispatchesSettled,false);assert.equal(result.cleanupComplete,false);assert.equal(result.dialogClosed,null);
});

test('output backpressure bounds dispatch and does not produce concurrent writes',async()=>{
  const callbacks=[];let writes=0,writeEntered;const firstWrite=new Promise(resolve=>{writeEntered=resolve;});
  const output=new Writable({highWaterMark:1,write(chunk,encoding,callback){writes++;callbacks.push(callback);writeEntered();}});
  let calls=0,notify;const observed=new Promise(resolve=>{notify=resolve;});
  const f=fixture({output,dispatchLine:async()=>{calls++;if(calls===2)notify();return reply;}});const done=f.adapter.start();
  f.input.write('{}\n{}\n{}\n');await observed;await firstWrite;
  // Two slots include waiting output; the third line is not dispatched yet.
  assert.equal(calls,2);assert.ok(writes<=1);
  await f.adapter.stop();const result=await done;assert.equal(result.cleanupComplete,false);
  for(const callback of callbacks)callback();output.destroy();
});

test('failed output and failed shutdown remain redacted and uncertain',async()=>{
  const output=new Writable({write(chunk,encoding,callback){callback(Error('PRIVATE-WATCHER-TOKEN'));}});
  const f=fixture({output,shutdown:async()=>{throw Error('PRIVATE-WATCHER-TOKEN');}});const done=f.adapter.start();f.input.write('{}\n');
  const result=await done;assert.equal(result.cleanupComplete,false);assert.equal(JSON.stringify(result).includes('PRIVATE'),false);assert.equal(f.calls(),1);
});

test('a stalled shutdown callback is bounded and never reported settled',async()=>{
  const f=fixture({shutdown:async()=>new Promise(()=>{}),settleMs:20});const done=f.adapter.start();f.input.end();
  const result=await done;assert.equal(result.shutdownSettled,false);assert.equal(result.cleanupComplete,false);assert.equal(f.calls(),1);
});

test('EOF with two stalled dispatches and another queued line still shuts down',async()=>{
  let calls=0;const f=fixture({dispatchLine:async()=>{calls++;await new Promise(()=>{});},settleMs:20});
  const done=f.adapter.start();f.input.end('{}\n{}\n{}\n');
  const result=await done;assert.equal(result.cleanupComplete,false);assert.equal(result.dispatchesSettled,false);assert.equal(calls,2);assert.equal(f.calls(),1);
});

test('oversized or multiline host responses never reach output',async()=>{
  for(const value of ['x'.repeat(65537)+'\n','{}\n{}\n']) {
    const f=fixture({dispatchLine:async()=>value});let written=0;f.output.on('data',()=>written++);const done=f.adapter.start();f.input.write('{}\n');
    assert.equal((await done).reason,'STREAM_DISPATCH_OR_OUTPUT_FAILED');assert.equal(written,0);
  }
});

test('later invalid bytes in same chunk prevent already-queued host dispatch',async()=>{
  for(const suffix of [Buffer.from([0xff,10]),Buffer.alloc(16385,65)]) {
    let calls=0;const f=fixture({dispatchLine:async()=>{calls++;return reply;}});const done=f.adapter.start();
    f.input.write(Buffer.concat([Buffer.from('{}\n'),suffix]));await done;assert.equal(calls,0);assert.equal(f.calls(),1);
  }
});

test('blocked output times out and cancels host with queued cancellation still waiting',async()=>{
  const output=new Writable({highWaterMark:1,write(chunk,encoding,callback){}});
  let calls=0;const f=fixture({output,writeTimeoutMs:20,settleMs:20,dispatchLine:async()=>{calls++;if(calls===2)await new Promise(()=>{});return reply;}});
  const done=f.adapter.start();f.input.write('{}\n{}\n{}\n');const result=await done;
  assert.equal(result.reason,'STREAM_OUTPUT_TIMEOUT');assert.equal(result.outputSettled,false);assert.equal(result.cleanupComplete,false);assert.equal(f.calls(),1);assert.equal(calls,2);output.destroy();
});
