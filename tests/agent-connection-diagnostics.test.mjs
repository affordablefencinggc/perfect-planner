import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {recordAgentConnectionFailure} from '../src/runtime/agentConnectionDiagnostics.js';
import {createRuntimeEventCodec} from '../src/runtime/runtimeEventLedger.js';

test('agent errors retain original project/generation and whitelist their message',()=>{
  const codec=createRuntimeEventCodec();const saved=[];
  const events={append(input){const captured=codec.capture(input);saved.push(captured);return captured;}};
  const request={projectId:'pp_original',generation:7,workspaceId:'workspace-original',registryRevision:3};
  const receipt=recordAgentConnectionFailure('AGENT_BROKER_BUSY',request,true,events);
  assert.equal(receipt.projectId,'pp_original');assert.equal(receipt.generation,7);
  assert.equal(receipt.payload.operation,'stop-project-agents');assert.equal(receipt.message,'AGENT_BROKER_BUSY');
  assert.equal(receipt.payload.connectionVerified,false);
  recordAgentConnectionFailure(new Error('secret=do-not-retain C:/private/repo'),request,false,events);
  assert.equal(saved[1].message,'AGENT_CONNECTION_CHECK_FAILED');
  assert.ok(!JSON.stringify(saved).includes('do-not-retain'));assert.ok(!JSON.stringify(saved).includes('C:/private'));
});
test('failed event capture never becomes a saved receipt',()=>{
  const result=recordAgentConnectionFailure('AGENT_WORKER_PANICKED',{projectId:'pp_original',generation:1},false,{append(){throw Error('disk full');}});
  assert.equal(result,null);
});
