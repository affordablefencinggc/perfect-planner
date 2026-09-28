import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createAgentExchangeStore} from '../mcp/agentExchangeStore.mjs';
import {createAgentSessionBroker} from '../mcp/agentSessionBroker.mjs';
import {createAgentClientRouter} from '../mcp/agentClientRouter.mjs';
assert.equal(os.hostname().toLowerCase(),'dans1');
const binding={projectId:'pp_exchange',workspaceId:'exchange',registryRevision:1,rootIdentity:'a'.repeat(64)};
const input=()=>({binding,exchangeId:'turn-1',summary:{turn:'First exchange',request:'Inspect one task',response:'Read the task',observed:'Read receipt returned',explanation:'',error:'',solution:'Review before approving',evidence:''}});
async function fixture(write=true){
 const directory=await mkdtemp(path.join(os.tmpdir(),'planner-exchange-'));
 const store=createAgentExchangeStore(directory),broker=createAgentSessionBroker({resolveBinding:async()=>binding});
 const router=createAgentClientRouter({broker,binding,...(write?{proposalWrites:{propose:()=>{}},exchangeReports:store}:{})});
 const pair=await (write?broker.issueProposalPairing(binding):broker.issuePairing(binding));
 const connected=await router.request({version:1,id:1,method:'client.connect',params:{pairingId:pair.pairingId,secret:pair.secret}});
 const {sessionId,secret}=connected.result;let sequence=1,id=1;
 return {store,broker,router,directory,sessionId,async report(report=input()){const result=await router.request({version:1,id:++id,method:'client.reportExchange',params:{sessionId,secret,expectedSequence:sequence,input:report}});if(result.ok)sequence=result.result.observation.sequence;return result;}};
}
test('authenticated exchange reaches durable owner store, exact retry does not duplicate, reopen retains it',async()=>{
 const f=await fixture();try{
 const result=await f.report();assert.equal(result.result.writeState,'recorded-exchange');assert.equal(result.result.receipt.sessionId,f.sessionId);assert.equal(result.result.receipt.verification,'not-verified');
 const retry=await f.report();assert.equal(retry.result.receipt.idempotent,true);
 const reopened=await createAgentExchangeStore(f.directory).read(binding);assert.equal(reopened.total,1);assert.equal(reopened.records[0].summary.observed,'Read receipt returned');assert.equal(reopened.coverage,'reported-exchanges-only');
 }finally{await f.router.close();f.broker.dispose();}
});
test('changed retry cannot overwrite the original report',async()=>{
 const f=await fixture();try{await f.report();const changed=input();changed.summary.response='Changed';assert.equal((await f.report(changed)).result.writeState,'outcome-unknown');assert.equal((await f.store.read(binding)).records[0].summary.response,'Read the task');}finally{await f.router.close();f.broker.dispose();}
});
test('read-only sessions, foreign projects and revoked sessions cannot report',async()=>{
 const read=await fixture(false);try{await assert.rejects(read.report(),/METHOD_REFUSED/);assert.equal((await read.store.read(binding)).total,0);}finally{await read.router.close();read.broker.dispose();}
 const foreign=await fixture();try{const report=input();report.binding={...binding,projectId:'pp_foreign'};await assert.rejects(foreign.report(report),/FOREIGN/);assert.equal((await foreign.store.read(binding)).total,0);}finally{await foreign.router.close();foreign.broker.dispose();}
 const revoked=await fixture();revoked.broker.revoke(revoked.sessionId);try{assert.equal((await revoked.report()).ok,false);assert.equal((await revoked.store.read(binding)).total,0);}finally{await revoked.router.close();revoked.broker.dispose();}
});
test('known secrets are redacted before publishing; missing or oversized summaries refused',async()=>{
 const f=await fixture();try{
 const note=input();note.summary.error='password=fixture-private-secret';const result=await f.report(note);assert.equal(result.result.writeState,'recorded-exchange');
 const view=JSON.stringify(await f.store.read(binding));assert(!view.includes('fixture-private-secret'));
 const nested=(await readdir(path.join(f.directory,'agent-exchanges-v1')))[0];const files=await readdir(path.join(f.directory,'agent-exchanges-v1',nested));for(const file of files)assert(!(await readFile(path.join(f.directory,'agent-exchanges-v1',nested,file),'utf8')).includes('fixture-private-secret'));
 }finally{await f.router.close();f.broker.dispose();}
 const invalid=await fixture();try{const bad=input();bad.summary.request='';await assert.rejects(invalid.report(bad),/INVALID/);}finally{await invalid.router.close();invalid.broker.dispose();}
});
