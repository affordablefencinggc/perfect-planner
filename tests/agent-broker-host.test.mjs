import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {createImportedProjectId} from '../src/project/projectIds.js';
const host=fileURLToPath(new URL('../mcp/agentBrokerHost.mjs',import.meta.url));
async function fixture(){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'pp-broker-host-')));
 const registry=path.join(root,'registry'),workspace=path.join(root,'workspace');await mkdir(registry);await mkdir(workspace);
 const identity=createHash('sha256').update(workspace).digest('hex');
 await writeFile(path.join(registry,'fixture.json'),JSON.stringify({schemaVersion:1,registryRevision:1,workspaceId:'fixture',canonicalRoot:workspace,rootIdentity:identity,access:'metadata-read-only'}));
 return {registry,binding:{projectId:createImportedProjectId(identity),rootIdentity:identity,workspaceId:'fixture',registryRevision:1}};
}
function launch(registry){
 const child=spawn(process.execPath,[host,'--owner-stdio'],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PERFECT_PLANNER_REGISTRY_ROOT:registry}});
 let buffer='',errors='',sequence=0;const waiting=new Map();
 const closed=once(child,'close');
 child.stderr.on('data',b=>errors+=b.toString());
 child.stdout.on('data',b=>{buffer+=b;let end;while((end=buffer.indexOf('\n'))>=0){const response=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);const resolve=waiting.get(response.id);waiting.delete(response.id);resolve?.(response);}});
 child.on('close',()=>{for(const resolve of waiting.values())resolve({ok:false,error:'CHILD_CLOSED'});waiting.clear();});
 return {child,closed,errors:()=>errors,call:(method,params)=>new Promise(resolve=>{const id=++sequence;waiting.set(id,resolve);child.stdin.write(JSON.stringify({version:1,id,method,params})+'\n');})};
}
test('actual private child process pairs, connects, heartbeats and revokes',{timeout:15000},async()=>{
 const f=await fixture(),p=launch(f.registry);
 try{
  const pair=await p.call('owner.pair',{binding:f.binding});assert.equal(pair.ok,true);
  const connected=await p.call('client.connect',{pairingId:pair.result.pairingId,secret:pair.result.secret});assert.equal(connected.ok,true);
  const {sessionId,secret}=connected.result;
  assert.equal((await p.call('client.heartbeat',{sessionId,secret,expectedSequence:1})).result.sequence,2);
  const view=await p.call('owner.inspect',{binding:f.binding});assert.equal(view.result[0].state,'reachable');assert.ok(!JSON.stringify(view).includes(secret));
  assert.equal((await p.call('owner.revoke',{sessionId})).result,true);
  assert.equal((await p.call('client.heartbeat',{sessionId,secret,expectedSequence:2})).error,'BROKER_OPERATION_REFUSED');
  p.child.stdin.end();assert.equal((await p.closed)[0],0);assert.equal(p.errors(),'');
 }finally{if(p.child.exitCode===null&&p.child.signalCode===null){p.child.kill();await p.closed;}}
});
test('proposal grants require a verified writer channel and cannot be requested through a client route',{timeout:15000},async()=>{
 const f=await fixture(),p=launch(f.registry);
 try{
  assert.equal((await p.call('owner.pairProposal',{channelId:'a'.repeat(32)})).ok,false);
  const opened=await p.call('owner.openClient',{binding:f.binding});assert.equal(opened.ok,true);const channelId=opened.result.channelId;
  assert.equal((await p.call('owner.pairProposal',{channelId})).ok,false);
  for(const method of ['owner.pairProposal','owner.openProposalClient']){
   const nested=await p.call('client.request',{channelId,request:{version:1,id:1,method,params:method==='owner.pairProposal'?{channelId}:{binding:f.binding,hostConfiguration:{}}}});assert.equal(nested.ok,false);
  }
  const invalid=await p.call('owner.openProposalClient',{binding:f.binding,hostConfiguration:{}});assert.equal(invalid.ok,false);
  assert.deepEqual((await p.call('owner.inspect',{binding:f.binding})).result,[]);
  const pair=await p.call('owner.pair',{binding:f.binding});assert.equal(pair.ok,true);
  const connected=await p.call('client.request',{channelId,request:{version:1,id:1,method:'client.connect',params:{pairingId:pair.result.pairingId,secret:pair.result.secret}}});assert.equal(connected.result.ok,true);
  const {sessionId,secret}=connected.result.result;
  const refused=await p.call('client.request',{channelId,request:{version:1,id:2,method:'client.proposeTask',params:{sessionId,secret,expectedSequence:1,input:{}}}});assert.equal(refused.ok,false);
  await p.call('owner.closeClient',{channelId});assert.equal((await p.call('owner.pairProposal',{channelId})).ok,false);
  p.child.stdin.end();assert.equal((await p.closed)[0],0);assert.equal(p.errors(),'');
 }finally{if(p.child.exitCode===null&&p.child.signalCode===null){p.child.kill();await p.closed;}}
});
test('larger proposal envelopes do not expand limits for ordinary private-owner requests',{timeout:15000},async()=>{
 const f=await fixture(),p=launch(f.registry);
 try{p.child.stdin.end(JSON.stringify({version:1,id:1,method:'owner.inspect',params:{binding:{...f.binding,padding:'x'.repeat(18000)}}})+'\n');assert.equal((await p.closed)[0],1);assert.equal(p.errors().includes('xxxxx'),false);}
 finally{if(p.child.exitCode===null&&p.child.signalCode===null){p.child.kill();await p.closed;}}
});
test('owner EOF closes a live scoped session before disposing its broker',{timeout:15000},async()=>{
 const f=await fixture(),p=launch(f.registry);
 try{
  const opened=await p.call('owner.openClient',{binding:f.binding});assert.equal(opened.ok,true);
  const pair=(await p.call('owner.pair',{binding:f.binding})).result;
  const connected=await p.call('client.request',{channelId:opened.result.channelId,request:{version:1,id:1,method:'client.connect',params:{pairingId:pair.pairingId,secret:pair.secret}}});assert.equal(connected.result.ok,true);
  // Deliberately do not send owner.closeClient. EOF owns final cleanup.
  p.child.stdin.end();assert.equal((await p.closed)[0],0);assert.equal(p.errors(),'');
 }finally{if(p.child.exitCode===null&&p.child.signalCode===null){p.child.kill();await p.closed;}}
});
test('oversized and malformed frames close child without echoing input',{timeout:15000},async()=>{
 const f=await fixture();
 for(const frame of ['x'.repeat(17000),JSON.stringify({version:1,id:1,method:'owner.approve',params:{secret:'never-echo-this'}})+'\n']){
  const p=launch(f.registry);try{p.child.stdin.end(frame);assert.equal((await p.closed)[0],1);assert.ok(!p.errors().includes('never-echo-this'));}finally{if(p.child.exitCode===null&&p.child.signalCode===null){p.child.kill();await p.closed;}}
 }
});

test('real host routes scoped client frames and revokes on channel close',{timeout:15000},async()=>{
 const f=await fixture(),p=launch(f.registry);
 try{
  const opened=await p.call('owner.openClient',{binding:f.binding});assert.equal(opened.ok,true);
  const channelId=opened.result.channelId;assert.match(channelId,/^[a-f0-9]{32}$/);
  const send=(id,method,params)=>p.call('client.request',{channelId,request:{version:1,id,method,params}});
  const refused=await send(1,'owner.pair',{binding:f.binding});assert.equal(refused.ok,false);
  const pair=(await p.call('owner.pair',{binding:f.binding})).result;
  const connection=await send(1,'client.connect',{pairingId:pair.pairingId,secret:pair.secret});
  assert.equal(connection.result.ok,true);const {sessionId,secret}=connection.result.result;
  const beat=await send(2,'client.heartbeat',{sessionId,secret,expectedSequence:1});assert.equal(beat.result.result.sequence,2);
  const closed=await p.call('owner.closeClient',{channelId});assert.equal(closed.result.revocationComplete,true);
  assert.equal((await p.call('client.heartbeat',{sessionId,secret,expectedSequence:2})).ok,false);
  assert.equal((await send(3,'client.heartbeat',{sessionId,secret,expectedSequence:2})).ok,false);
  assert.deepEqual((await p.call('owner.inspect',{binding:f.binding})).result,[]);
  const reopened=await p.call('owner.openClient',{binding:f.binding});assert.notEqual(reopened.result.channelId,channelId);
  await p.call('owner.closeClient',{channelId:reopened.result.channelId});
  p.child.stdin.end();assert.equal((await p.closed)[0],0);assert.equal(p.errors(),'');
 }finally{if(p.child.exitCode===null&&p.child.signalCode===null){p.child.kill();await p.closed;}}
});
