import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,link,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createTaskCheckContractStore} from '../src/node/taskCheckContractStore.mjs';
import {createTaskLedgerAuthorityStore} from '../src/node/taskLedgerAuthorityStore.mjs';
import {createTaskCheckContract} from '../src/node/taskCheckContract.mjs';
import {emptyTaskDraftLedger,updateTaskDraft} from '../src/project/taskDraftLedger.js';
const request=(requestId='first',revision=0,headDigest='GENESIS')=>({requestId,expectedRevision:revision,expectedHeadDigest:headDigest});
const head=record=>({revision:record.revision,headDigest:record.recordHash});
async function fixture(limits={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'pp-check-contract-'));const binding={projectId:'pp_contract_fixture',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)};let observed={...binding};
 const proposalConfig={journalPath:path.join(root,'proposals.jsonl'),projectId:binding.projectId,rootIdentity:binding.rootIdentity};const proposals=createTaskLedgerAuthorityStore(proposalConfig);
 const ledger=updateTaskDraft(emptyTaskDraftLedger(binding),{title:'Bounded task',description:'Full scope',owner:'Owner',acceptance:'Exact check',recovery:'Keep original',claims:[],dependsOn:[],archived:false});
 const created=await proposals.propose(ledger,{requestId:'proposal-first',expectedRevision:0,expectedHeadDigest:'GENESIS'});const expected={hostRevision:1,headDigest:created.proposal.recordHash};
 const raw={schemaVersion:1,kind:'TASK_CHECK_CONTRACT',projectId:binding.projectId,rootIdentity:binding.rootIdentity,policyVersion:1,policyDigest:'c'.repeat(64),tasks:[{taskId:'T0001',checks:[{checkId:'check-1',executablePath:process.execPath,executableDigest:'d'.repeat(64),args:[],cwd:'.',timeoutMs:1000,outputLimits:{stdoutBytes:1024,stderrBytes:1024,combinedBytes:2048}}]}]};
 const contract=createTaskCheckContract(raw),config={journalPath:path.join(root,'contracts.jsonl'),proposalConfig,registeredBinding:async()=>({...observed}),actor:'native-owner',source:'installed-host',...limits};
 return {root,binding,ledger,proposals,expected,raw,contract,config,store:createTaskCheckContractStore(config),observe:value=>{observed=value;}};
}
test('retains immutable exact contract with host provenance but no approval',async()=>{
 const f=await fixture(),contract=structuredClone(f.contract),req=request(),pending=f.store.retain(f.expected,contract,req);contract.tasks[0].checks[0].args.push('changed');req.requestId='late';f.config.proposalConfig.rootIdentity='f'.repeat(64);
 const result=await pending;assert.equal(result.record.request.requestId,'first');assert.deepEqual(result.record.snapshot.contract.tasks[0].checks[0].args,[]);assert.equal(result.record.actor,'native-owner');assert.equal(result.approvalGranted,false);assert.equal(result.executionAuthorized,false);
 const state=await f.store.inspect();assert.equal(state.revision,1);assert.ok(Object.isFrozen(state.history[0].snapshot.contract.tasks));assert.equal(await f.store.withCurrentContract(f.expected,head(result.record),value=>value.registrationLeaseHeld),false);
 const restarted=createTaskCheckContractStore({...f.config,proposalConfig:{...f.config.proposalConfig,rootIdentity:f.binding.rootIdentity}});assert.equal((await restarted.inspect()).headDigest,state.headDigest);assert.equal(await restarted.withCurrentContract(f.expected,head(result.record),value=>value.record.recordHash),result.record.recordHash);
});
test('concurrent CAS yields one winner and original retry remains historical',async()=>{
 const f=await fixture(),attempts=await Promise.allSettled(['a','b','c'].map(id=>f.store.retain(f.expected,f.contract,request(id))));assert.equal(attempts.filter(v=>v.status==='fulfilled').length,1);const first=(await f.store.inspect()).history[0];
 for(const loser of attempts.filter(v=>v.status==='rejected'))assert.match(loser.reason.message,/STALE_HEAD/);
 await assert.rejects(f.store.retain(f.expected,f.contract,request('wrong-head',1,'f'.repeat(64))),/STALE_HEAD/);
 const second=await f.store.retain(f.expected,createTaskCheckContract({...f.raw,policyVersion:2}),request('second',1,first.recordHash));const retry=await f.store.retain(f.expected,f.contract,first.request);
 assert.equal(retry.idempotent,true);assert.equal(retry.matchesObservedContractHead,false);assert.equal(retry.record.revision,1);assert.equal(retry.observedContractHead.revision,2);await assert.rejects(f.store.withCurrentContract(f.expected,head(first),()=>true),/STALE_HEAD/);
 await assert.rejects(f.store.retain(f.expected,createTaskCheckContract({...f.raw,policyVersion:3}),first.request),/REQUEST_CONFLICT/);assert.equal((await f.store.inspect()).revision,2);assert.equal(second.approvalGranted,false);
});
test('registration change and newer proposal reject stale current use and retry',async()=>{
 const f=await fixture(),saved=await f.store.retain(f.expected,f.contract,request());f.observe({...f.binding,censusDigest:'e'.repeat(64)});let called=false;await assert.rejects(f.store.withCurrentContract(f.expected,head(saved.record),()=>{called=true;}),/REGISTRATION_MISMATCH/);assert.equal(called,false);
 f.observe(f.binding);await f.proposals.propose(f.ledger,{requestId:'proposal-next',expectedRevision:1,expectedHeadDigest:f.expected.headDigest});await assert.rejects(f.store.retain(f.expected,f.contract,request()),/STALE_HEAD/);await assert.rejects(f.store.withCurrentContract(f.expected,head(saved.record),()=>true),/STALE_HEAD/);assert.equal((await f.store.inspect()).history.length,1);
 const current=await f.proposals.inspect();await assert.rejects(f.store.withCurrentContract({hostRevision:2,headDigest:current.headDigest},head(saved.record),()=>true),/PROPOSAL_MISMATCH/);
});
test('postappend registration drift preserves durable history and refuses success',async()=>{
 const f=await fixture();let observations=0;const store=createTaskCheckContractStore({...f.config,registeredBinding:async()=>({...f.binding,censusDigest:++observations===1?f.binding.censusDigest:'e'.repeat(64)})});
 await assert.rejects(store.retain(f.expected,f.contract,request()),/PUBLICATION_UNCERTAIN/);const retained=await store.inspect();assert.equal(retained.revision,1);assert.equal(retained.registrationLeaseHeld,false);assert.equal(retained.approvalGranted,false);
 await assert.rejects(store.withCurrentContract(f.expected,head(retained.history[0]),()=>true),/REGISTRATION_MISMATCH/);
});
test('journal paths cannot overlap the other journal lock contents',async()=>{
 const f=await fixture();assert.throws(()=>createTaskCheckContractStore({...f.config,journalPath:path.join(f.config.proposalConfig.journalPath+'.pp-lock','holder.json')}),/CONFIG_INVALID/);
 assert.throws(()=>createTaskCheckContractStore({...f.config,proposalConfig:{...f.config.proposalConfig,journalPath:path.join(f.config.journalPath+'.pp-lock','holder.json')}}),/CONFIG_INVALID/);
});
test('active task coverage and foreign contract binding refuse without writing',async()=>{
 const f=await fixture();for(const raw of [{...f.raw,tasks:[{...f.raw.tasks[0],taskId:'T0002'}]},{...f.raw,rootIdentity:'f'.repeat(64)}])await assert.rejects(f.store.retain(f.expected,createTaskCheckContract(raw),request()),/COVERAGE|BINDING/);assert.equal((await f.store.inspect()).revision,0);
});
test('bounded history refuses new append while identical historical retry remains readable',async()=>{
 const f=await fixture({maxRecords:1}),saved=await f.store.retain(f.expected,f.contract,request());await assert.rejects(f.store.retain(f.expected,f.contract,request('next',1,saved.record.recordHash)),/QUOTA/);assert.equal((await f.store.retain(f.expected,f.contract,request())).idempotent,true);
});
test('partial, modified and duplicate-key records fail closed without repair',async()=>{
 for(const mode of ['partial','modified','duplicate']){const f=await fixture();await f.store.retain(f.expected,f.contract,request());const bytes=await readFile(f.config.journalPath,'utf8');let changed=bytes;if(mode==='partial')changed=bytes.slice(0,-1);if(mode==='modified')changed=bytes.replace('native-owner','other-owner');if(mode==='duplicate')changed=bytes.replace('{','{"schemaVersion":1,');await writeFile(f.config.journalPath,changed);await assert.rejects(f.store.inspect());assert.equal(await readFile(f.config.journalPath,'utf8'),changed);}
});
test('hard-linked history and redirected parent are refused',async()=>{
 const f=await fixture();await f.store.retain(f.expected,f.contract,request());await link(f.config.journalPath,path.join(f.root,'alias.jsonl'));await assert.rejects(f.store.inspect(),/UNSAFE_FILE/);
 const g=await fixture(),alias=g.root+'-alias';await symlink(g.root,alias,process.platform==='win32'?'junction':'dir');const redirected=createTaskCheckContractStore({...g.config,journalPath:path.join(alias,'contracts.jsonl')});await assert.rejects(redirected.inspect(),/UNSAFE_PATH/);
});
