import "./helpers/hermetic-env.mjs";
import test from 'node:test';import assert from 'node:assert/strict';
import {createAgentSessionBroker} from '../mcp/agentSessionBroker.mjs';
const binding={projectId:'pp_permission',workspaceId:'workspace-permission',rootIdentity:'a'.repeat(64),registryRevision:1};
function fixture(){let current=binding;const broker=createAgentSessionBroker({resolveBinding:async()=>current});return {broker,change:b=>current=b};}
const credentials=s=>({sessionId:s.sessionId,secret:s.secret,expectedSequence:1});
test('normal pairing and client-injected flags cannot grant proposal writes',async()=>{
 const {broker}=fixture();const pair=await broker.issuePairing(binding,{proposalWriteAllowed:true});const session=await broker.connect({...pair,proposalWriteAllowed:true});let calls=0;
 await assert.rejects(broker.runAdmittedProposal({...credentials(session),proposalWriteAllowed:true},binding,'change',async()=>{calls++;}),/WRITE_NOT_ALLOWED/);
 assert.equal(calls,0);assert.equal((await broker.heartbeat(credentials(session),binding)).sequence,2);broker.dispose();
});
test('separate owner pairing grants only the new session, not prior readers',async()=>{
 const {broker}=fixture();const reader=await broker.connect(await broker.issuePairing(binding));const writer=await broker.connect(await broker.issueProposalPairing(binding));let calls=0;
 await assert.rejects(broker.runAdmittedProposal(credentials(reader),binding,'reader',async()=>{calls++;}),/WRITE_NOT_ALLOWED/);
 const result=await broker.runAdmittedProposal(credentials(writer),binding,'writer',async()=>{calls++;throw Error('No store configured');});assert.equal(calls,1);assert.equal(result.writeState,'outcome-unknown');assert.equal(result.executionAuthorized,false);broker.dispose();
});
test('proposal pairing is one use and invalidated by changed registration',async()=>{
 const f=fixture();const pair=await f.broker.issueProposalPairing(binding);f.change({...binding,registryRevision:2});await assert.rejects(f.broker.connect(pair,binding),/BINDING_CHANGED/);f.change(binding);await assert.rejects(f.broker.connect(pair,binding),/AGENT_BROKER_FOREIGN_PROJECT/);assert.equal((await f.broker.inspect(binding)).length,0);
 const next=await f.broker.issueProposalPairing(binding);await f.broker.connect(next,binding);await assert.rejects(f.broker.connect(next,binding),/FOREIGN_PROJECT|PAIRING_REFUSED/);f.broker.dispose();
});
test('proposal permission is scoped to the exact project binding',async()=>{
 const {broker}=fixture();const writer=await broker.connect(await broker.issueProposalPairing(binding));let calls=0;
 await assert.rejects(broker.runAdmittedProposal(credentials(writer),{...binding,projectId:'pp_foreign'},'foreign',async()=>{calls++;}),/FOREIGN_PROJECT/);assert.equal(calls,0);broker.dispose();
});
