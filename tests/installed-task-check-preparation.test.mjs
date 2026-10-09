import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createInstalledTaskCheckPreparation} from '../src/node/installedTaskCheckPreparation.mjs';
import {createTaskLedgerAuthorityStore} from '../src/node/taskLedgerAuthorityStore.mjs';
import {createTaskCheckContractStore} from '../src/node/taskCheckContractStore.mjs';
import {emptyTaskDraftLedger,updateTaskDraft} from '../src/project/taskDraftLedger.js';
const hash=v=>createHash('sha256').update(v).digest('hex');
async function fixture(){
 const root=await mkdtemp(path.join(os.tmpdir(),'pp-check-preparation-')),stateDirectory=path.join(root,'state'),project=path.join(root,'project');await mkdir(stateDirectory);await mkdir(project);
 const scripts={test:'node --test tests/*.test.mjs',build:'npm run build:client && node scripts/prepare-sites-build.mjs','build:client':'vite build && node scripts/generate-truth-report.mjs --release','verify:secrets':'node scripts/verify-secrets.mjs'};
 for(const [name,bytes] of Object.entries({'package.json':JSON.stringify({name:'perfect-planner-cleanroom',scripts}),'package-lock.json':'{"lockfileVersion":3}','node_modules/vite/bin/vite.js':'// inert','scripts/generate-truth-report.mjs':'// inert','scripts/prepare-sites-build.mjs':'// inert','scripts/verify-secrets.mjs':'// inert','npm-cli.js':'// inert npm'})){const file=path.join(project,...name.split('/'));await mkdir(path.dirname(file),{recursive:true});await writeFile(file,bytes);}
 const binding={projectId:'pp_prepare_fixture',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)},proposalConfig={journalPath:path.join(stateDirectory,'proposals.jsonl'),projectId:binding.projectId,rootIdentity:binding.rootIdentity},proposals=createTaskLedgerAuthorityStore(proposalConfig);
 const ledger=updateTaskDraft(emptyTaskDraftLedger(binding),{title:'Checks',description:'Exact',owner:'owner',acceptance:'Pass',recovery:'Retain',claims:[],dependsOn:[],archived:false}),created=await proposals.propose(ledger,{requestId:'proposal-1',expectedRevision:0,expectedHeadDigest:'GENESIS'});
 const config={provision:{profileId:'perfect-planner-checks-v1',registeredRoot:project,npmCli:{path:path.join(project,'npm-cli.js'),sha256:hash('// inert npm')},assignments:[{taskId:'T0001',categories:['tests','build','secrets']}]},installed:{manifestDigest:'c'.repeat(64),nodeExecutable:process.execPath,files:[{path:'runtime/node.exe',sha256:'d'.repeat(64)}]},proposalConfig,registeredBinding:async()=>({...binding}),actor:'native-owner',source:'inert-host-fixture',stateDirectory};
 const payload={expected:{hostRevision:1,headDigest:created.proposal.recordHash},request:{requestId:'prepare-1',expectedRevision:0,expectedHeadDigest:'GENESIS'}};
 return {project,config,payload,proposals,ledger,adapter:createInstalledTaskCheckPreparation(config),contracts:createTaskCheckContractStore({journalPath:path.join(stateDirectory,binding.projectId+'.check-contracts.jsonl'),proposalConfig,registeredBinding:config.registeredBinding,actor:config.actor,source:config.source})};
}
test('check inspection shows genesis and exact historical original without preparing again',async()=>{
 const f=await fixture();const empty=await f.adapter.inspectChecks({requestId:null});assert.deepEqual(empty.contractHead,{revision:0,headDigest:'GENESIS'});assert.equal(empty.original,null);
 assert.deepEqual(await readdir(f.config.stateDirectory),['proposals.jsonl']);
 const first=await f.adapter.prepareChecks(f.payload),before=await f.contracts.inspect();
 const read=await f.adapter.inspectChecks({requestId:f.payload.request.requestId});
 assert.deepEqual(read.contractHead,first.contractHead);assert.deepEqual(read.original.request,f.payload.request);assert.deepEqual(read.original.proposalHead,f.payload.expected);assert.equal(read.original.contractDigest,first.contractDigest);assert.equal(read.original.observationEvidenceVerified,false);assert.equal(read.executionAuthorized,false);assert.equal(JSON.stringify(read).includes(f.project),false);
 assert.deepEqual(await f.contracts.inspect(),before);assert.equal((await f.adapter.inspectChecks({requestId:'missing-original'})).original,null);
});
test('historical inspection preserves old binding and never claims fresh tool evidence',async()=>{
 const f=await fixture(),first=await f.adapter.prepareChecks(f.payload);
 await f.adapter.prepareChecks({...f.payload,request:{requestId:'prepare-next',expectedRevision:1,expectedHeadDigest:first.contractHead.headDigest}});
 await writeFile(path.join(f.project,'npm-cli.js'),'changed tool; do not execute');
 const changed={...f.ledger.binding,censusDigest:'e'.repeat(64)},reader=createInstalledTaskCheckPreparation({...f.config,registeredBinding:async()=>changed});
 const read=await reader.inspectChecks({requestId:f.payload.request.requestId});assert.equal(read.contractHead.revision,2);assert.equal(read.original.matchesObservedContractHead,false);assert.deepEqual(read.binding,changed);assert.deepEqual(read.original.binding,f.ledger.binding);assert.equal(read.original.observationEvidenceVerified,false);
});
test('check inspection refuses inputs, foreign binding and registration changes during read',async()=>{
 const f=await fixture();for(const payload of [{},{requestId:'../x'},{requestId:null,path:f.project}])await assert.rejects(f.adapter.inspectChecks(payload),/INPUT_INVALID/);
 let reads=0;const changing=createInstalledTaskCheckPreparation({...f.config,registeredBinding:async()=>({...f.ledger.binding,censusDigest:++reads===1?f.ledger.binding.censusDigest:'f'.repeat(64)})});await assert.rejects(changing.inspectChecks({requestId:null}),/REGISTRATION_CHANGED/);
 const foreign=createInstalledTaskCheckPreparation({...f.config,registeredBinding:async()=>({...f.ledger.binding,projectId:'pp_other'})});await assert.rejects(foreign.inspectChecks({requestId:null}),/REGISTRATION_CHANGED/);
});
test('constructor performs no profile writes and dispatch retains exact original retry',async()=>{
 const f=await fixture();assert.deepEqual(await readdir(f.config.stateDirectory),['proposals.jsonl']);
 const result=await f.adapter.prepareChecks(f.payload);assert.equal(result.originalRequestId,'prepare-1');assert.equal(result.contractHead.revision,1);assert.equal(result.observationEvidencePersisted,true);assert.equal(result.reviewEnabled,false);assert.equal(result.executionAuthorized,false);assert.equal(JSON.stringify(result).includes(f.project),false);
 const restarted=createInstalledTaskCheckPreparation(f.config),retry=await restarted.prepareChecks(f.payload);assert.equal(retry.idempotent,true);assert.deepEqual(retry.contractHead,result.contractHead);assert.equal((await f.contracts.inspect()).revision,1);
});
test('payload cannot replace native provisioning and configuration is captured',async()=>{
 const f=await fixture();await assert.rejects(f.adapter.prepareChecks({...f.payload,registeredRoot:f.project}),/INPUT_INVALID/);f.config.provision.assignments[0].categories=['deploy'];assert.equal((await f.adapter.prepareChecks(f.payload)).preparationPersisted,true);
});
test('changed observation cannot substitute original request and retained record survives',async()=>{
 const f=await fixture(),first=await f.adapter.prepareChecks(f.payload);await writeFile(path.join(f.project,'package-lock.json'),'{"lockfileVersion":3,"changed":true}');await assert.rejects(f.adapter.prepareChecks(f.payload),/REQUEST_CONFLICT/);const state=await f.contracts.inspect();assert.equal(state.revision,1);assert.equal(state.history[0].snapshot.contract.contractDigest,first.contractDigest);
});
test('stale proposal and registration drift do not prepare a new contract',async()=>{
 const f=await fixture();await f.proposals.propose(f.ledger,{requestId:'proposal-next',expectedRevision:1,expectedHeadDigest:f.payload.expected.headDigest});await assert.rejects(f.adapter.prepareChecks(f.payload),/STALE_HEAD/);assert.equal((await f.contracts.inspect()).revision,0);
 const g=await fixture(),bad=createInstalledTaskCheckPreparation({...g.config,registeredBinding:async()=>({...g.ledger.binding,censusDigest:'f'.repeat(64)})});await assert.rejects(bad.prepareChecks(g.payload),/REGISTRATION_MISMATCH/);assert.equal((await g.contracts.inspect()).revision,0);
});
test('native review selection resolves exact saved custody without new authority records',async()=>{
 const f=await fixture(),saved=await f.adapter.prepareChecks(f.payload);
 const before=await f.contracts.inspect(),resolved=await f.adapter.resolveReview({expected:f.payload.expected,contractHead:saved.contractHead});
 assert.equal(resolved.checkContract.contractDigest,saved.contractDigest);assert.deepEqual(resolved.contractCustody.expectedHead,saved.contractHead);
 assert.equal(resolved.checkProfileEvidence.profileId,'perfect-planner-checks-v1');
 assert.equal(resolved.checkProfileEvidence.scriptDefinitions.test,'node --test tests/*.test.mjs');
 assert.ok(Object.isFrozen(resolved.checkProfileEvidence));
 assert.equal(resolved.executionAuthorized,false);assert.equal(resolved.toolchainVerified,false);assert.equal(resolved.candidateVerified,false);
 assert.deepEqual(await f.contracts.inspect(),before);
 assert.equal((await readdir(f.config.stateDirectory)).some(name=>name.includes('confirmation')),false);
});
test('native review selection refuses stale head and changed project evidence',async()=>{
 const f=await fixture(),saved=await f.adapter.prepareChecks(f.payload),selection={expected:f.payload.expected,contractHead:saved.contractHead};
 await assert.rejects(f.adapter.resolveReview({...selection,registeredRoot:f.project}),/SELECTION_INVALID/);
 await writeFile(path.join(f.project,'package-lock.json'),'{"lockfileVersion":3,"changed":true}');
 await assert.rejects(f.adapter.resolveReview(selection),/OBSERVATION_CHANGED/);
 const next=await f.adapter.prepareChecks({...f.payload,request:{requestId:'prepare-2',expectedRevision:1,expectedHeadDigest:saved.contractHead.headDigest}});
 await assert.rejects(f.adapter.resolveReview(selection),/STALE_HEAD/);
 assert.equal((await f.adapter.resolveReview({...selection,contractHead:next.contractHead})).checkContract.contractDigest,next.contractDigest);
});
test('native review selection refuses changed native provisioning and missing evidence',async()=>{
 const f=await fixture(),saved=await f.adapter.prepareChecks(f.payload),selection={expected:f.payload.expected,contractHead:saved.contractHead};
 const foreign=createInstalledTaskCheckPreparation({...f.config,installed:{...f.config.installed,manifestDigest:'f'.repeat(64)}});
 await assert.rejects(foreign.resolveReview(selection),/OBSERVATION_CHANGED/);
 const file=path.join(f.config.stateDirectory,'check-profile-evidence',saved.policyDigest+'.json');
 // Preserve the original evidence; corrupt only this isolated test fixture.
 await writeFile(file,'{}');await assert.rejects(f.adapter.resolveReview(selection),/PROFILE_EVIDENCE_/);
 assert.equal((await f.contracts.inspect()).revision,1);
});
