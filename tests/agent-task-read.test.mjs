import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createAgentLedgerReads} from '../mcp/agentLedgerReads.mjs';
import {createAgentClientRouter} from '../mcp/agentClientRouter.mjs';
import {createAgentSessionBroker} from '../mcp/agentSessionBroker.mjs';
import {createNativeTaskDraftSubmission} from '../src/node/nativeTaskDraftSubmission.mjs';
import {emptyTaskDraftLedger,updateTaskDraft} from '../src/project/taskDraftLedger.js';

test('full task chunks retain Unicode, obligations and claims at one exact journal head',async()=>{
  const binding={projectId:'pp_task_reads',rootIdentity:'a'.repeat(64),workspaceId:'reader',registryRevision:1};
  const draftBinding={projectId:binding.projectId,rootIdentity:binding.rootIdentity,censusDigest:'b'.repeat(64)};
  const directory=await mkdtemp(path.join(os.tmpdir(),'pp-task-read-'));
  const submission=createNativeTaskDraftSubmission({proposalConfig:{journalPath:path.join(directory,'proposal.jsonl'),projectId:binding.projectId,rootIdentity:binding.rootIdentity},registeredBinding:async()=>draftBinding});
  const ledger=updateTaskDraft(emptyTaskDraftLedger(draftBinding),{title:'Full task',description:'x'.repeat(1951)+'😀'.repeat(2800),acceptance:'界'.repeat(8000),recovery:'Keep all work'.repeat(600),owner:'Worker',claims:[{path:'src/feature.js',access:'write'}],dependsOn:[],archived:false});
  await submission.submitDraft({ledger,request:{requestId:'first',expectedRevision:0,expectedHeadDigest:'GENESIS'}});
  const broker=createAgentSessionBroker({resolveBinding:async()=>binding});
  const router=createAgentClientRouter({broker,binding,ledgerReads:createAgentLedgerReads({submission})});
  try{
    const pair=await broker.issuePairing(binding);
    const connect=await router.request({version:1,id:1,method:'client.connect',params:{pairingId:pair.pairingId,secret:pair.secret}});
    const credentials={sessionId:connect.result.sessionId,secret:connect.result.secret};
    const head=(await submission.readProposal()).observedHead;
    let id=2,sequence=1,offset=0,wire='',taskDigest;
    async function read(input){const reply=await router.request({version:1,id:id++,method:'client.readTask',params:{...credentials,expectedSequence:sequence,input}});assert.equal(reply.ok,true);sequence=reply.result.observation.sequence;assert.ok(Buffer.byteLength(JSON.stringify(reply))<24000);return reply.result;}
    do{
      const result=await read({taskId:'T0001',offset,expectedHeadDigest:head.headDigest});
      assert.equal(result.readError,undefined);const data=result.data;
      assert.equal(data.offset,wire.length);assert.equal(data.executionAuthorized,false);
      if(taskDigest)assert.equal(data.taskDigest,taskDigest);taskDigest=data.taskDigest;
      wire+=data.chunk;offset=data.nextOffset;
    }while(offset!==null);
    assert.deepEqual(JSON.parse(wire),ledger.tasks[0]);
    assert.equal(createHash('sha256').update(wire).digest('hex'),taskDigest);
    for(const input of [{taskId:'T9999',offset:0,expectedHeadDigest:head.headDigest},{taskId:'T0001',offset:wire.length,expectedHeadDigest:head.headDigest},{taskId:'T0001',offset:0,expectedHeadDigest:null}])assert.equal((await read(input)).readError,'AGENT_LEDGER_READ_REFUSED');
    await submission.submitDraft({ledger,request:{requestId:'next',expectedRevision:1,expectedHeadDigest:head.headDigest}});
    assert.equal((await read({taskId:'T0001',offset:2000,expectedHeadDigest:head.headDigest})).data,null);
  }finally{await router.close();broker.dispose();}
});

test('oversized read preserves sequence and allows the next heartbeat',async()=>{
  const binding={projectId:'pp_task_limits',rootIdentity:'a'.repeat(64),workspaceId:'reader',registryRevision:1};
  const broker=createAgentSessionBroker({resolveBinding:async()=>binding});
  const router=createAgentClientRouter({broker,binding,ledgerReads:{read:async()=>({payload:'x'.repeat(24000)})}});
  try{
    const pair=await broker.issuePairing(binding);
    const connected=await router.request({version:1,id:1,method:'client.connect',params:{pairingId:pair.pairingId,secret:pair.secret}});
    const credentials={sessionId:connected.result.sessionId,secret:connected.result.secret};
    const reply=await router.request({version:1,id:2,method:'client.readBrief',params:{...credentials,expectedSequence:1,input:{}}});
    assert.equal(reply.ok,true);assert.equal(reply.result.data,null);assert.equal(reply.result.readError,'AGENT_LEDGER_READ_REFUSED');assert.equal(reply.result.observation.sequence,2);
    const heartbeat=await router.request({version:1,id:3,method:'client.heartbeat',params:{...credentials,expectedSequence:2}});
    assert.equal(heartbeat.ok,true);assert.equal(heartbeat.result.sequence,3);
  }finally{await router.close();broker.dispose();}
});
