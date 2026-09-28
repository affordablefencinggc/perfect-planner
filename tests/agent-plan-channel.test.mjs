import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp} from 'node:fs/promises';
import {createAgentPlanChannel} from '../mcp/agentPlanChannel.mjs';
import {createAgentSessionBroker} from '../mcp/agentSessionBroker.mjs';
import {createNativeReviewHostComposition} from '../src/node/nativeReviewHostComposition.mjs';
import {emptyTaskDraftLedger,updateTaskDraft} from '../src/project/taskDraftLedger.js';
assert.equal(os.hostname().toLowerCase(),'dans1');
const binding={projectId:'pp_plan_channel',rootIdentity:'a'.repeat(64),workspaceId:'reader',registryRevision:1};
const config={packageConfig:{packageRoot:'host-owned',manifestDigest:'c'.repeat(64)},metadataConfig:{executable:'host-owned',executableDigest:'d'.repeat(64),registryRoot:'host-registry',workspaceId:'reader',registryRevision:1,rootIdentity:binding.rootIdentity},stateDirectory:'host-state',actor:'Owner',source:'native'};
test('owner-scoped channel reads the real host submission and closes its session',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'pp-owner-plan-'));
  const draftBinding={projectId:binding.projectId,rootIdentity:binding.rootIdentity,censusDigest:'b'.repeat(64)};
  const host=createNativeReviewHostComposition({proposalConfig:{journalPath:path.join(root,'proposals.jsonl'),projectId:binding.projectId,rootIdentity:binding.rootIdentity},confirmationPath:path.join(root,'confirmations.json'),registeredBinding:async()=>draftBinding,actor:'Owner',source:'test',presenterConfig:{executable:path.join(root,'absent.exe'),executableDigest:'c'.repeat(64),cwd:root}});
  const ledger=updateTaskDraft(emptyTaskDraftLedger(draftBinding),{title:'Shared plan task',description:'Retain',acceptance:'Prove',recovery:'Preserve',owner:'Worker',claims:[],dependsOn:[],archived:false});
  assert.equal(JSON.parse(await host.dispatchLine(JSON.stringify({version:1,requestId:'submit',command:'submit-draft',payload:{ledger,request:{requestId:'original',expectedRevision:0,expectedHeadDigest:'GENESIS'}}}))).ok,true);
  const broker=createAgentSessionBroker({resolveBinding:async()=>binding});
  // Only package/native executable construction is substituted. The host,
  // journal, router, session authentication and reads are actual implementations.
  const channel=await createAgentPlanChannel({broker,binding,registryRoot:'host-registry',hostConfiguration:config},async received=>{assert.deepEqual(received,config);return {...host,binding:draftBinding,executionAuthorized:false};});
  try{
    const pair=await broker.issuePairing(binding);
    const connected=await channel.request({version:1,id:1,method:'client.connect',params:{pairingId:pair.pairingId,secret:pair.secret}});
    const result=await channel.request({version:1,id:2,method:'client.readBrief',params:{sessionId:connected.result.sessionId,secret:connected.result.secret,expectedSequence:1,input:{offset:0,expectedHeadDigest:null}}});
    assert.equal(result.ok,true);assert.equal(result.result.data.tasks[0].title,'Shared plan task');assert.equal(result.result.data.executionAuthorized,false);
    assert.equal(JSON.stringify(result).includes(connected.result.secret),false);
    assert.equal((await channel.close()).revocationComplete,true);
    assert.throws(()=>channel.request({}),/CLOSED/);
    await assert.rejects(host.readPlan('read-proposal-brief',{offset:0,expectedHeadDigest:null}),/STOPPED/);
  }finally{await channel.close();broker.dispose();}
});
test('foreign native configuration is rejected before host creation',async()=>{
  let creates=0;const createHost=async()=>{creates++;throw Error('must not run');};
  for(const change of [{metadataConfig:{...config.metadataConfig,registryRoot:'foreign'}},{metadataConfig:{...config.metadataConfig,workspaceId:'other'}},{metadataConfig:{...config.metadataConfig,registryRevision:2}},{metadataConfig:{...config.metadataConfig,rootIdentity:'e'.repeat(64)}},{checkContract:{}},{metadataConfig:{...config.metadataConfig,journalPath:'foreign'}}]){
    await assert.rejects(createAgentPlanChannel({broker:{},binding,registryRoot:'host-registry',hostConfiguration:{...config,...change}},createHost),/AGENT_PLAN_CONFIG/);
  }
  assert.equal(creates,0);
});
test('foreign host is shut down and cleanup failure cannot become a closed receipt',async()=>{
  let stops=0;const broker=createAgentSessionBroker({resolveBinding:async()=>binding});
  await assert.rejects(createAgentPlanChannel({broker,binding,registryRoot:'host-registry',hostConfiguration:config},async()=>({binding:{...binding,projectId:'pp_foreign'},executionAuthorized:false,readPlan:async()=>({}),shutdown:async()=>{stops++;return {cleanupComplete:true};}})),/HOST_FOREIGN/);
  assert.equal(stops,1);
  const channel=await createAgentPlanChannel({broker,binding,registryRoot:'host-registry',hostConfiguration:config},async()=>({binding,executionAuthorized:false,readPlan:async()=>({}),shutdown:async()=>({cleanupComplete:false})}));
  await assert.rejects(channel.close(),/CLEANUP_UNCONFIRMED/);assert.throws(()=>channel.request({}),/CLOSED/);broker.dispose();
});
