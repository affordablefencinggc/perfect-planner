import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, open, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fork, spawnSync } from "node:child_process";
import { createHash } from 'node:crypto';
import { emptyTaskDraftLedger, updateTaskDraft, validateTaskDraftLedger } from '../src/project/taskDraftLedger.js';
import { acceptanceSetDigest, inspectTaskAttemptResults } from '../src/node/taskOutcomeContract.mjs';
import { readJournal, verifyJournal } from "../src/node/journalStore.mjs";
import { readTaskRunObservations } from '../src/node/taskRunObservations.mjs';
import { runProof, SAFE_PRODUCTION_PROOF_PROFILE, verifyProofArtifact } from "../src/node/proofRunner.mjs";

async function fixture(source) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pp-runner-"));
  const script = path.join(root, "check.mjs");
  await writeFile(script, source);
  return { root, script, evidence: path.join(root, "evidence"), journal: path.join(root, "journal.jsonl") };
}
const policy = { allowedExecutables: [process.execPath] };

test('proof artifact is flushed before its terminal; failed flush stays unresolved',async t=>{
 for(const failSync of [false,true]){
  const f=await fixture('process.stdout.write("controlled proof");');
  const probe=await open(path.join(f.root,'prototype-probe'),'wx');const prototype=Object.getPrototypeOf(probe);await probe.close();
  const write=prototype.writeFile,sync=prototype.sync,artifacts=new WeakSet();let flushed=false,terminalBeforeFlush=false;
  const writeMock=t.mock.method(prototype,'writeFile',async function(data,...args){
   if(Buffer.isBuffer(data)){const parsed=JSON.parse(data.toString());if(parsed.environment&&parsed.runId)artifacts.add(this);}
   if(typeof data==='string'&&data.includes('"action":"prove"')&&!flushed)terminalBeforeFlush=true;
   return write.call(this,data,...args);
  });
  const syncMock=t.mock.method(prototype,'sync',async function(){if(artifacts.has(this)){if(failSync)throw Error('CONTROLLED_ARTIFACT_SYNC_FAILURE');await sync.call(this);flushed=true;return;}return sync.call(this);});
  try{
   const options={allowedRoot:f.root,cwd:f.root,evidenceDirectory:f.evidence,journalPath:f.journal,command:process.execPath,args:[f.script],policy,planId:'PP-SYNC',itemId:'T0001',actor:'test'};
   if(failSync)await assert.rejects(runProof(options),/CONTROLLED_ARTIFACT_SYNC_FAILURE/);else assert.equal((await runProof(options)).proven,true);
  }finally{writeMock.mock.restore();syncMock.mock.restore();}
  const entries=await readJournal(f.journal);
  assert.equal(terminalBeforeFlush,false);assert.equal(flushed,!failSync);
  assert.deepEqual(entries.map(e=>e.action),['proof-admitted',failSync?'proof-unresolved':'prove']);
  if(failSync)assert.equal(entries.at(-1).payload.failureStage,'artifact-persistence');
  assert.equal((await readdir(f.evidence)).filter(name=>name.endsWith('.proof.json')).length,1);
 }
});

test('adapter-reported truncation stays failed through artifact, typed receipt and journal reader',async()=>{
 const f=await fixture('unused controlled adapter');
 const ledger=updateTaskDraft(emptyTaskDraftLedger({projectId:'pp_truncation_fixture',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)}),{title:'Check truncation',description:'Controlled adapter result',owner:'worker',acceptance:'Complete output',recovery:'Retain',claims:[],dependsOn:[],archived:false});
 const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 const attempt={schemaVersion:1,kind:'TASK_ATTEMPT',binding:{projectId:ledger.binding.projectId,rootIdentity:ledger.binding.rootIdentity,ledgerRevision:ledger.revision,ledgerDigest:hash(ledger),taskId:'T0001',taskDigest:hash(ledger.tasks[0]),candidateDigest:'c'.repeat(64),acceptanceDigest:acceptanceSetDigest(['unit'])},attemptId:'truncated-1',attemptNumber:1,producerId:'worker',sessionId:'session-1',grantId:'unverified-grant',requiredCheckIds:['unit']};
 const isolationAdapter={execute:async({profile})=>({exit:0,timedOut:false,stdout:'partial',stderr:'',output:{truncated:true},isolation:{enforced:true,profileId:profile.id,platform:process.platform,shell:false,mechanism:profile.mechanisms[process.platform][0],limits:{maxMemoryBytes:profile.maxMemoryBytes,maxCpuTimeMs:profile.maxCpuTimeMs,maxProcesses:profile.maxProcesses}}})};
 const result=await runProof({allowedRoot:f.root,cwd:f.root,evidenceDirectory:f.evidence,journalPath:f.journal,command:process.execPath,args:[f.script],policy:{...policy,executionProfile:'production-isolated'},isolationAdapter,planId:'PP-T',itemId:'T0001',actor:'test',taskAttemptWire:JSON.stringify(attempt),taskLedgerWire:JSON.stringify(ledger),taskCheckId:'unit'});
 assert.equal(result.proven,false);assert.equal(result.output.truncated,true);assert.equal(result.taskCheckResult.outputTruncated,true);
 assert.equal((await verifyProofArtifact(result.artifactPath,result.sha256)).valid,true);
 const terminal=(await readJournal(f.journal)).at(-1).payload;assert.equal(terminal.proven,false);assert.equal(terminal.outputOverflow,true);
 const observed=await readTaskRunObservations({journalPath:f.journal,ledgerWire:JSON.stringify(ledger)});
 assert.equal(observed.runs[0].state,'failure-observed');assert.equal(observed.runs[0].outputTruncated,true);
});

test('actual failed execution retains matching task snapshot in admission, artifact and result', async () => {
  const f=await fixture('process.exit(3);');
  const ledger=updateTaskDraft(emptyTaskDraftLedger({projectId:'pp_outcome_fixture',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)}),{title:'Bound failure',description:'Controlled failure',owner:'worker',acceptance:'Check exits zero',recovery:'Keep files',claims:[],dependsOn:[],archived:false});
  const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const attempt={schemaVersion:1,kind:'TASK_ATTEMPT',binding:{projectId:ledger.binding.projectId,rootIdentity:ledger.binding.rootIdentity,ledgerRevision:ledger.revision,ledgerDigest:hash(ledger),taskId:'T0001',taskDigest:hash(ledger.tasks[0]),candidateDigest:'c'.repeat(64),acceptanceDigest:acceptanceSetDigest(['unit'])},attemptId:'attempt-1',attemptNumber:1,producerId:'worker',sessionId:'session-1',grantId:'unverified-grant',requiredCheckIds:['unit']};
  const options={allowedRoot:f.root,cwd:f.root,evidenceDirectory:f.evidence,journalPath:f.journal,command:process.execPath,args:[f.script],policy,planId:'PP-T',itemId:'T0001',actor:'test',taskAttemptWire:JSON.stringify(attempt),taskLedgerWire:JSON.stringify(ledger),taskCheckId:'unit'};
  for(const override of [{taskCheckId:'unknown'},{taskLedgerWire:JSON.stringify({...ledger,revision:ledger.revision+1})},{taskLedgerWire:JSON.stringify({...ledger,tasks:[{...ledger.tasks[0],archived:true}]})},{itemId:'T0002'},{taskLedgerWire:undefined}]){
    await assert.rejects(runProof({...options,...override}),/TASK_OUTCOME_/);
    assert.equal((await readJournal(f.journal)).length,0);
  }
  const changed=validateTaskDraftLedger({...ledger,tasks:[{...ledger.tasks[0],title:'Edited'}]});
  await assert.rejects(runProof({...options,taskLedgerWire:JSON.stringify(changed)}),/TASK_OUTCOME_LEDGER_MISMATCH/);
  const pendingRun=runProof(options);
  options.itemId='T0002';options.journalPath=path.join(f.root,'wrong-journal.jsonl');options.args[0]=path.join(f.root,'wrong-script.mjs');
  const result=await pendingRun,entries=await readJournal(f.journal);
  assert.equal(result.itemId,'T0001');
  assert.equal((await readJournal(options.journalPath)).length,0);
  assert.equal(result.exit,3);assert.equal(result.proven,false);
  assert.equal(result.taskContext.authorityVerified,false);
  assert.equal(result.taskContext.attempt.binding.taskId,'T0001');
  assert.deepEqual(entries[0].payload.taskContext,result.taskContext);
  assert.deepEqual(entries.at(-1).payload.taskContext,result.taskContext);
  assert.equal((await verifyProofArtifact(result.artifactPath,result.sha256)).valid,true);
  assert.equal(result.taskCheckResult.artifactDigest,result.sha256);
  assert.deepEqual(entries.at(-1).payload.taskCheckResult,result.taskCheckResult);
  const observation=inspectTaskAttemptResults(JSON.stringify(attempt),[JSON.stringify(result.taskCheckResult)]);
  assert.deepEqual(observation.failed,['unit']);assert.deepEqual(observation.unresolved,['unit']);
  await writeFile(f.script,'process.exit(0);');
  const retry={...attempt,attemptId:'attempt-2',attemptNumber:2};
  const success=await runProof({...options,itemId:'T0001',journalPath:f.journal,args:[f.script],taskAttemptWire:JSON.stringify(retry)});
  assert.equal(success.proven,true);
  const unverified=inspectTaskAttemptResults(JSON.stringify(retry),[JSON.stringify(success.taskCheckResult)]);
  assert.equal(unverified.allRequiredChecksPassed,false);assert.equal(unverified.authorityVerified,false);
  assert.deepEqual(unverified.unresolved,['unit']);
  const observed = await readTaskRunObservations({journalPath:f.journal,ledgerWire:JSON.stringify(ledger)});
  assert.deepEqual(observed.runs.map(run=>run.state),['failure-observed','result-unverified']);
  assert.ok(observed.runs.every(run=>run.ledgerMatch==='current-draft' && run.authorityVerified===false && run.artifactVerified===false));
  assert.equal(observed.runs[0].exitCode,3);
  assert.equal(observed.runs[0].timedOut,false); assert.equal(observed.runs[0].outputTruncated,false);
  assert.equal(observed.runs[0].artifactDigest,result.sha256);
  const changedRead = await readTaskRunObservations({journalPath:f.journal,ledgerWire:JSON.stringify(changed)});
  assert.ok(changedRead.runs.every(run=>run.ledgerMatch==='historical-or-changed'));
  const reader = path.join(f.root,'read-retained.mjs');
  await writeFile(reader,`import {readTaskRunObservations} from ${JSON.stringify(new URL('../src/node/taskRunObservations.mjs',import.meta.url).href)}; process.stdout.write(JSON.stringify(await readTaskRunObservations(${JSON.stringify({journalPath:f.journal,ledgerWire:JSON.stringify(ledger)})})));`);
  const reopened = spawnSync(process.execPath,[reader],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024,windowsHide:true});
  assert.equal(reopened.status,0,reopened.stderr);
  assert.deepEqual(JSON.parse(reopened.stdout),observed);
  const corrupt = path.join(f.root,'corrupt.jsonl');
  await writeFile(corrupt,'{"partial":');
  await assert.rejects(readTaskRunObservations({journalPath:corrupt,ledgerWire:JSON.stringify(ledger)}),/TASK_RUN_OBSERVATIONS_UNAVAILABLE/);
  await assert.rejects(readTaskRunObservations({journalPath:'relative.jsonl',ledgerWire:JSON.stringify(ledger)}),/TASK_RUN_OBSERVATIONS_UNAVAILABLE/);
});

test('forced runner termination preserves admission, and retry does not erase it', async () => {
  const f=await fixture("process.exit(3);");
  const runnerModule=new URL('../src/node/proofRunner.mjs',import.meta.url).href;
  const journalModule=new URL('../src/node/journalStore.mjs',import.meta.url).href;
  const options={allowedRoot:f.root,cwd:f.root,evidenceDirectory:f.evidence,journalPath:f.journal,command:process.execPath,args:[f.script],policy:{...policy,executionProfile:'production-isolated'},planId:'PP-T',itemId:'CRASH',actor:'test'};
  const harness=path.join(f.root,'interrupted.mjs');
  await writeFile(harness,`import {runProof} from ${JSON.stringify(runnerModule)}; await runProof({...${JSON.stringify(options)}, isolationAdapter:{execute:async()=>{process.send('admitted'); await new Promise(()=>{});}}});`);
  const child=fork(harness,[],{stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
  child.stdout.resume();child.stderr.resume();
  try {
    await new Promise((resolve,reject)=>{
      let admitted=false;
      const timer=setTimeout(()=>{child.kill();reject(new Error('Admission handshake deadline exceeded'));},10000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.on('message',message=>{if(message==='admitted'){admitted=true;child.kill();}});
      child.once('close',()=>{clearTimeout(timer);admitted?resolve():reject(new Error('Exited before admission'));});
    });
  } finally { if(child.exitCode===null&&child.signalCode===null) child.kill(); }
  const reader=path.join(f.root,'restart-read.mjs');
  await writeFile(reader,`import {readJournal,verifyJournal} from ${JSON.stringify(journalModule)}; console.log(JSON.stringify({entries:await readJournal(${JSON.stringify(f.journal)}),integrity:await verifyJournal(${JSON.stringify(f.journal)})}));`);
  const restarted=spawnSync(process.execPath,[reader],{encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(restarted.status,0,restarted.stderr);
  const recovered=JSON.parse(restarted.stdout);
  assert.equal(recovered.integrity.valid,true);
  assert.deepEqual(recovered.entries.map(e=>e.action),['proof-admitted']);
  assert.equal(recovered.entries[0].payload.proven,false);
  await runProof({...options,policy});
  const retried=await readJournal(f.journal);
  assert.deepEqual(retried.map(e=>e.action),['proof-admitted','proof-admitted','prove']);
  assert.equal(retried[0].hash,recovered.entries[0].hash);
  assert.notEqual(retried[0].payload.runId,retried[1].payload.runId);
  assert.equal(retried[2].payload.exit,3);
});

test('admission is durable before execution and adapter failure remains unresolved on reread', async () => {
  const f = await fixture('');
  const isolationAdapter = { execute: async () => {
    const entries = await readJournal(f.journal);
    assert.equal(entries.length, 1); assert.equal(entries[0].action, 'proof-admitted');
    throw new Error('controlled execution failure');
  } };
  await assert.rejects(runProof({allowedRoot:f.root,cwd:f.root,evidenceDirectory:f.evidence,journalPath:f.journal,command:process.execPath,args:[f.script],policy:{...policy,executionProfile:'production-isolated'},isolationAdapter,planId:'PP-T',itemId:'FAILURE',actor:'test'}), /controlled execution failure/);
  const entries = await readJournal(f.journal);
  assert.deepEqual(entries.map(e=>e.action), ['proof-admitted','proof-unresolved']);
  assert.equal(entries[0].payload.runId,entries[1].payload.runId);
  assert.equal(entries[1].payload.cleanup,'unknown');
  assert.equal(entries[1].payload.failureStage,'execution');
  assert.equal(entries[1].payload.cause,'unknown');
  assert.equal(entries[1].payload.proven,false);
});

test('corrupt admission journal refuses execution', async () => {
  const f=await fixture('');let executed=false;
  await writeFile(f.journal,'corrupt\n');
  await assert.rejects(runProof({allowedRoot:f.root,cwd:f.root,evidenceDirectory:f.evidence,journalPath:f.journal,command:process.execPath,args:[f.script],policy:{...policy,executionProfile:'production-isolated'},isolationAdapter:{execute:async()=>{executed=true;}},planId:'PP-T',itemId:'NO-SPAWN',actor:'test'}));
  assert.equal(executed,false);
});

test("a successful reviewed command captures output, hash, environment, and journal proof", async () => {
  const f = await fixture("console.log('17 checks passed'); console.error('diagnostic');");
  const result = await runProof({ allowedRoot: f.root, cwd: f.root, evidenceDirectory: f.evidence, journalPath: f.journal, command: process.execPath, args: [f.script], policy, planId: "PP-T", itemId: "B01-1", actor: "agent-a" });
  assert.equal(result.proven, true);
  assert.match(result.stdout, /17 checks passed/);
  assert.match(result.stderr, /diagnostic/);
  assert.equal((await verifyProofArtifact(result.artifactPath, result.sha256)).valid, true);
  assert.deepEqual(await verifyJournal(f.journal), { valid: true, brokenAt: null });
  const entries = await readJournal(f.journal);
  assert.equal(entries[0].action, 'proof-admitted');
  assert.equal(entries[1].action, 'prove');
  assert.equal(entries[1].payload.runId, entries[0].payload.runId);
  assert.equal(entries[1].payload.proven, true);
});

test("a failing command is captured but never marked proven", async () => {
  const f = await fixture("console.error('deliberate failure'); process.exit(3);");
  const result = await runProof({ allowedRoot: f.root, cwd: f.root, evidenceDirectory: f.evidence, journalPath: f.journal, command: process.execPath, args: [f.script], policy, planId: "PP-T", itemId: "B01-2", actor: "agent-a" });
  assert.equal(result.proven, false);
  assert.equal(result.exit, 3);
  assert.match(result.stderr, /deliberate failure/);
  assert.equal((await readJournal(f.journal)).at(-1).payload.proven, false);
});

test("a timed-out command is killed, captured, and kept unproven", async () => {
  const f = await fixture("setTimeout(() => console.log('too late'), 5000);");
  const result = await runProof({ allowedRoot: f.root, cwd: f.root, evidenceDirectory: f.evidence, journalPath: f.journal, command: process.execPath, args: [f.script], policy, timeoutMs: 50, planId: "PP-T", itemId: "B01-3", actor: "agent-a" });
  assert.equal(result.proven, false);
  assert.equal(result.timedOut, true);
});

test("stdout overflow is bounded, terminated, captured, and journalled unproven", async () => {
  const f = await fixture("process.stdout.write('x'.repeat(4096)); setTimeout(() => {}, 5000);");
  const boundedPolicy = { ...policy, maxStdoutBytes: 128, maxStderrBytes: 128, maxCombinedOutputBytes: 192 };
  const result = await runProof({ allowedRoot: f.root, cwd: f.root, evidenceDirectory: f.evidence, journalPath: f.journal, command: process.execPath, args: [f.script], policy: boundedPolicy, planId: "PP-T", itemId: "B01-OVERFLOW", actor: "agent-a" });
  assert.equal(result.proven, false);
  assert.equal(result.outputOverflow.stream, "stdout");
  assert.equal(result.outputOverflow.limit, "stdoutBytes");
  assert.equal(Buffer.byteLength(result.stdout), 128);
  assert.equal(result.output.truncated, true);
  const entry = (await readJournal(f.journal)).at(-1);
  assert.equal(entry.payload.outputOverflow, true);
  assert.equal(entry.payload.outputLimit, "stdoutBytes");
  assert.equal(entry.payload.proven, false);
});

test("combined output ceiling applies across independently bounded streams", async () => {
  const f = await fixture("process.stdout.write('o'.repeat(80)); process.stderr.write('e'.repeat(80)); setTimeout(() => {}, 5000);");
  const boundedPolicy = { ...policy, maxStdoutBytes: 100, maxStderrBytes: 100, maxCombinedOutputBytes: 120 };
  const result = await runProof({ allowedRoot: f.root, cwd: f.root, evidenceDirectory: f.evidence, journalPath: f.journal, command: process.execPath, args: [f.script], policy: boundedPolicy, planId: "PP-T", itemId: "B01-COMBINED", actor: "agent-a" });
  assert.equal(result.proven, false);
  assert.equal(result.outputOverflow.limit, "combinedBytes");
  assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 120);
});

test("invalid output ceilings are refused before spawn", async () => {
  const f = await fixture("console.log('must not run');");
  await assert.rejects(() => runProof({ allowedRoot: f.root, cwd: f.root, evidenceDirectory: f.evidence, journalPath: f.journal, command: process.execPath, args: [f.script], policy: { ...policy, maxCombinedOutputBytes: 0 }, planId: "PP-T", itemId: "B01-LIMIT", actor: "agent-a" }), /positive safe integer/);
});

test("shells, inline evaluation, and unapproved executables are refused before spawn", async () => {
  const f = await fixture("console.log('never');");
  const common = { allowedRoot: f.root, cwd: f.root, evidenceDirectory: f.evidence, journalPath: f.journal, planId: "PP-T", itemId: "B01-4", actor: "agent-a" };
  await assert.rejects(() => runProof({ ...common, command: "cmd.exe", args: ["/c", "echo unsafe"], policy: { allowedExecutables: ["cmd"] } }), /forbidden/);
  await assert.rejects(() => runProof({ ...common, command: process.execPath, args: ["--eval", "console.log(1)"], policy }), /Inline Node evaluation/);
  await assert.rejects(() => runProof({ ...common, command: "unknown-tool", args: [], policy }), /not approved/);
});

test("working directories and evidence paths cannot escape the approved root", async () => {
  const f = await fixture("console.log('never');");
  const outside = await mkdtemp(path.join(os.tmpdir(), "pp-outside-runner-"));
  await mkdir(path.join(f.root, "safe"));
  await assert.rejects(() => runProof({ allowedRoot: f.root, cwd: outside, evidenceDirectory: f.evidence, journalPath: f.journal, command: process.execPath, args: [f.script], policy, planId: "PP-T", itemId: "B01-5", actor: "agent-a" }), /cwd escapes/);
  await assert.rejects(() => runProof({ allowedRoot: f.root, cwd: f.root, evidenceDirectory: outside, journalPath: f.journal, command: process.execPath, args: [f.script], policy, planId: "PP-T", itemId: "B01-5", actor: "agent-a" }), /Evidence directory escapes/);
});

test("production proof requires and records an exact supported OS isolation profile", async () => {
  const f = await fixture("console.log('adapter owns execution');"); let request;
  const isolationAdapter = { execute: async (value) => { request = value; return { exit: 0, signal: null, timedOut: false, stdout: "isolated\n", stderr: "", isolation: { enforced: true, profileId: value.profile.id, platform: process.platform, shell: false, mechanism: value.profile.mechanisms[process.platform][0], limits: { maxMemoryBytes: value.profile.maxMemoryBytes, maxCpuTimeMs: value.profile.maxCpuTimeMs, maxProcesses: value.profile.maxProcesses } } }; } };
  const result = await runProof({ allowedRoot: f.root, cwd: f.root, evidenceDirectory: f.evidence, journalPath: f.journal, command: process.execPath, args: [f.script], policy: { ...policy, executionProfile: "production-isolated" }, isolationAdapter, planId: "PP-T", itemId: "PRODUCTION", actor: "agent-a" });
  assert.equal(result.proven, true); assert.equal(result.productionReady, true); assert.equal(result.isolation.enforced, true); assert.equal(request.profile, SAFE_PRODUCTION_PROOF_PROFILE);
  const journal = await readJournal(f.journal); assert.equal(journal.at(-1).payload.productionReady, true); assert.equal(journal.at(-1).payload.isolationProfile, "bounded-production-v1");
});

test("production proof refuses absent, forged, or weaker isolation adapters", async () => {
  const f = await fixture("console.log('must not run directly');"); const common = { allowedRoot: f.root, cwd: f.root, evidenceDirectory: f.evidence, journalPath: f.journal, command: process.execPath, args: [f.script], policy: { ...policy, executionProfile: "production-isolated" }, planId: "PP-T", itemId: "ISOLATION-FAIL", actor: "agent-a" };
  await assert.rejects(() => runProof(common), /explicit OS isolation adapter/);
  const isolationAdapter = { execute: async ({ profile }) => ({ exit: 0, timedOut: false, stdout: "", stderr: "", isolation: { enforced: true, profileId: profile.id, platform: process.platform, shell: false, mechanism: profile.mechanisms[process.platform][0], limits: { maxMemoryBytes: profile.maxMemoryBytes - 1, maxCpuTimeMs: profile.maxCpuTimeMs, maxProcesses: profile.maxProcesses } } }) };
  await assert.rejects(() => runProof({ ...common, isolationAdapter }), /maxMemoryBytes/);
});
