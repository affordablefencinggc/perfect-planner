import test from 'node:test';import assert from 'node:assert/strict';
import os from 'node:os';import path from 'node:path';import {mkdtemp} from 'node:fs/promises';
import {createAgentPlanChannel,createAgentProposalChannel} from '../mcp/agentPlanChannel.mjs';
import {createAgentSessionBroker} from '../mcp/agentSessionBroker.mjs';
import {createNativeReviewHostComposition} from '../src/node/nativeReviewHostComposition.mjs';
import {createTaskLedgerAuthorityStore} from '../src/node/taskLedgerAuthorityStore.mjs';
import {createAgentTaskIntentStore} from '../src/node/agentTaskIntentStore.mjs';
const frame=(id,method,params)=>({version:1,id,method,params});
async function fixture(options={}){
 assert.equal(os.hostname().toLowerCase(),'dans1');const root=await mkdtemp(path.join(os.tmpdir(),'pp-proposal-channel-'));
 const binding={projectId:'pp_proposal_channel',rootIdentity:'a'.repeat(64),workspaceId:'writer',registryRevision:1},draftBinding={projectId:binding.projectId,rootIdentity:binding.rootIdentity,censusDigest:'b'.repeat(64)};
 const proposalConfig={journalPath:path.join(root,'proposals.jsonl'),projectId:binding.projectId,rootIdentity:binding.rootIdentity};
 const host=createNativeReviewHostComposition({proposalConfig,confirmationPath:path.join(root,'confirmations.json'),registeredBinding:options.observe??(async()=>draftBinding),actor:'Owner',source:'test',presenterConfig:{executable:path.join(root,'absent.exe'),executableDigest:'c'.repeat(64),cwd:root}});
 const broker=createAgentSessionBroker({resolveBinding:async()=>binding});let calls=0;
 const config={packageConfig:{packageRoot:'host-owned',manifestDigest:'c'.repeat(64)},metadataConfig:{executable:'host-owned',executableDigest:'d'.repeat(64),registryRoot:root,workspaceId:binding.workspaceId,registryRevision:1,rootIdentity:binding.rootIdentity},stateDirectory:'host-state',actor:'Owner',source:'native'};
 const channel=await (options.readOnly?createAgentPlanChannel:createAgentProposalChannel)({broker,binding,registryRoot:root,hostConfiguration:config},async()=>({...host,binding:draftBinding,executionAuthorized:false,proposeTaskChange:async input=>{calls++;const result=await host.proposeTaskChange(input);if(options.loseReply)throw Error('PRIVATE detail');return result;}}));
 const pair=await (options.readPair?broker.issuePairing(binding):broker.issueProposalPairing(binding));const connected=await channel.request(frame(1,'client.connect',{pairingId:pair.pairingId,secret:pair.secret}));assert.equal(connected.ok,true);
 const credentials={sessionId:connected.result.sessionId,secret:connected.result.secret};
 const input={binding:draftBinding,request:{requestId:'original-task',expectedRevision:0,expectedHeadDigest:'GENESIS'},task:{title:'Agent task',description:'Scope',owner:'Display only',acceptance:'Proof',recovery:'Preserve',claims:[{path:'src/a.js',access:'write'}],dependsOn:[],archived:false},updatedAt:'2026-09-14T00:00:00.000Z'};
 return {root,binding,draftBinding,proposalConfig,host,broker,channel,credentials,input,calls:()=>calls,store:createTaskLedgerAuthorityStore(proposalConfig),write:(id=2,sequence=1,value=input)=>channel.request(frame(id,'client.proposeTask',{...credentials,expectedSequence:sequence,input:value})),close:async()=>{await channel.close();broker.dispose();}};
}
test('granted channel writes through actual host and reads the same Ledger; exact retry is idempotent',async()=>{
 const f=await fixture();try{
  const saved=await f.write();assert.equal(saved.ok,true);assert.equal(saved.result.writeState,'recorded-proposal');assert.equal(saved.result.executionAuthorized,false);assert.equal(saved.result.receipt.approvalState,'unapproved-proposal');assert.equal(JSON.stringify(saved).includes(f.credentials.secret),false);
  const read=await f.channel.request(frame(3,'client.readBrief',{...f.credentials,expectedSequence:2,input:{offset:0,expectedHeadDigest:null}}));assert.equal(read.result.data.tasks[0].title,'Agent task');
  const retry=await f.write(4,3);assert.equal(retry.result.receipt.idempotent,true);assert.deepEqual(retry.result.receipt.submitted,saved.result.receipt.submitted);assert.equal((await f.store.inspect()).proposals.length,1);
  const intents=createAgentTaskIntentStore({file:`${f.proposalConfig.journalPath}.agent-intents.jsonl`,projectId:f.binding.projectId,rootIdentity:f.binding.rootIdentity});assert.equal((await intents.inspect()).records.length,1);
 }finally{await f.close();}
});
test('read pairing cannot write even on a writer-capable channel, and read channel cannot be upgraded',async()=>{
 const f=await fixture({readPair:true});try{assert.equal((await f.write()).ok,false);assert.equal(f.calls(),0);const beat=await f.channel.request(frame(3,'client.heartbeat',{...f.credentials,expectedSequence:1}));assert.equal(beat.ok,true);assert.equal((await f.store.inspect()).proposals.length,0);}finally{await f.close();}
 const g=await fixture({readOnly:true});try{await assert.rejects(g.write(),/METHOD_REFUSED/);assert.equal(g.calls(),0);}finally{await g.close();}
});
test('foreign root, foreign census and unowned credentials cannot reach the writer',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.write(2,1,{...f.input,binding:{...f.draftBinding,rootIdentity:'c'.repeat(64)}}),/FOREIGN_PROPOSAL/);
  await assert.rejects(f.channel.request(frame(2,'client.proposeTask',{...f.credentials,sessionId:'d'.repeat(32),expectedSequence:1,input:f.input})),/METHOD_REFUSED/);
  const stale=await f.write(2,1,{...f.input,binding:{...f.draftBinding,censusDigest:'c'.repeat(64)}});assert.equal(stale.result.writeState,'outcome-unknown');assert.equal(f.calls(),0);assert.equal((await f.store.inspect()).proposals.length,0);
 }finally{await f.close();}
});
test('lost writer reply yields explicit uncertainty and original request is reconciled through the same channel',async()=>{
 const f=await fixture({loseReply:true});try{
  const result=await f.write();assert.equal(result.ok,true);assert.equal(result.result.writeState,'outcome-unknown');assert.equal(result.result.reconciliationRequired,true);assert.equal(result.result.requestMayHaveCommitted,true);assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
  const read=await f.channel.request(frame(3,'client.readRequestResult',{...f.credentials,expectedSequence:2,input:{requestId:f.input.request.requestId}}));assert.equal(read.ok,true);assert.equal(read.result.data.outcome,'recorded-proposal');assert.equal(read.result.data.submitted.hostRevision,1);
 }finally{await f.close();}
});
test('closing a channel revokes immediately but drains an admitted actual write without pretending rollback',async()=>{
 let enter,release;const started=new Promise(r=>enter=r),gate=new Promise(r=>release=r);let first=true;
 const draftBinding={projectId:'pp_proposal_channel',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)};
 const f=await fixture({observe:async()=>{if(first){first=false;enter();await gate;}return draftBinding;}});
 const pending=f.write();await started;let settled=false;const closing=f.channel.close().then(v=>{settled=true;return v;});await new Promise(r=>setImmediate(r));assert.equal(settled,false);assert.equal((await f.broker.inspect(f.binding)).length,0);
 release();assert.equal((await pending).ok,false);assert.equal((await closing).revocationComplete,true);assert.equal((await f.store.inspect()).proposals.length,1);assert.throws(()=>f.channel.request({}),/CLOSED/);f.broker.dispose();
});
