import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, link, symlink, open } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { appendJournalEvent } from '../src/node/journalStore.mjs';
import { acceptanceSetDigest } from '../src/node/taskOutcomeContract.mjs';
import { readTaskRunObservations } from '../src/node/taskRunObservations.mjs';
import { emptyTaskDraftLedger, updateTaskDraft } from '../src/project/taskDraftLedger.js';

async function fixture() {
  const root=await mkdtemp(path.join(os.tmpdir(),'pp-task-read-'));
  const journalPath=path.join(root,'journal.jsonl');
  const ledger=updateTaskDraft(emptyTaskDraftLedger({projectId:'pp_receipt_test',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)}),{title:'Receipt test',description:'',owner:'worker',acceptance:'check',recovery:'Retain',claims:[],dependsOn:[],archived:false});
  const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const attempt={schemaVersion:1,kind:'TASK_ATTEMPT',binding:{projectId:ledger.binding.projectId,rootIdentity:ledger.binding.rootIdentity,ledgerRevision:ledger.revision,ledgerDigest:hash(ledger),taskId:'T0001',taskDigest:hash(ledger.tasks[0]),candidateDigest:'c'.repeat(64),acceptanceDigest:acceptanceSetDigest(['unit'])},attemptId:'attempt-1',attemptNumber:1,producerId:'worker',sessionId:'session-1',grantId:'not-authorized',requiredCheckIds:['unit']};
  const payload={runId:randomUUID(),planId:'PP-TEST',itemId:'T0001',proven:false,taskContext:{attempt,checkId:'unit',authorityVerified:false}};
  const result={schemaVersion:1,kind:'TASK_CHECK_RESULT',binding:attempt.binding,attemptId:attempt.attemptId,checkId:'unit',producerId:attempt.producerId,sessionId:attempt.sessionId,exitCode:3,timedOut:false,outputTruncated:false,cleanup:'unknown',artifactDigest:'d'.repeat(64)};
  const terminal={...payload,taskCheckResult:result,sha256:result.artifactDigest,exit:3,timedOut:false,outputOverflow:false};
  const append=(action,body=payload,timestamp='2026-09-09T00:00:00.000Z')=>appendJournalEvent(journalPath,{action,payload:body},{actor:'fixture',timestamp});
  return {root,journalPath,ledger,attempt,payload,terminal,append,read:()=>readTaskRunObservations({journalPath,ledgerWire:JSON.stringify(ledger)})};
}
const refused=promise=>assert.rejects(promise,/^Error: TASK_RUN_OBSERVATIONS_UNAVAILABLE$/);

test('admission without terminal remains unresolved and strips untrusted output',async()=>{
  const f=await fixture();await f.append('proof-admitted',{...f.payload,stdout:'secret fixture'});
  const value=await f.read();assert.equal(value.runs[0].state,'unresolved');assert.equal(value.runs[0].terminalAt,null);
  assert.equal(value.authorityVerified,false);assert.equal(JSON.stringify(value).includes('secret fixture'),false);
});
test('orphan and duplicate terminals are refused',async()=>{
  const orphan=await fixture();await orphan.append('prove',orphan.terminal);await refused(orphan.read());
  const duplicate=await fixture();await duplicate.append('proof-admitted');await duplicate.append('prove',duplicate.terminal);await duplicate.append('prove',duplicate.terminal);await refused(duplicate.read());
});
test('changed context, invalid timestamps and backwards time are refused',async()=>{
  for (const variant of ['context','timestamp','backwards']) {
    const f=await fixture();await f.append('proof-admitted');
    const payload=structuredClone(f.terminal);
    if(variant==='context')payload.taskContext.attempt.grantId='changed';
    await f.append('prove',payload,variant==='timestamp'?'invalid':variant==='backwards'?'2026-09-08T00:00:00.000Z':'2026-09-09T00:00:01.000Z');
    await refused(f.read());
  }
});
test('contradictory exit, timeout, truncation and artifact fields are refused',async()=>{
  for(const change of [{exit:0},{timedOut:true},{outputOverflow:true},{sha256:'e'.repeat(64)}]){
    const f=await fixture();await f.append('proof-admitted');await f.append('prove',{...f.terminal,...change});await refused(f.read());
  }
});
test('timeout and truncation observations survive an exit-zero result',async()=>{
  for(const key of ['timedOut','outputTruncated']){
    const f=await fixture();await f.append('proof-admitted');
    const result={...f.terminal.taskCheckResult,exitCode:0,[key]:true};
    await f.append('prove',{...f.terminal,exit:0,timedOut:result.timedOut,outputOverflow:result.outputTruncated,taskCheckResult:result});
    const run=(await f.read()).runs[0];assert.equal(run.state,'failure-observed');assert.equal(run[key],true);assert.equal(run.cause,'unknown');
  }
});
test('unresolved execution preserves bounded stage and remains unverified',async()=>{
  const f=await fixture();await f.append('proof-admitted');await f.append('proof-unresolved',{...f.payload,failureStage:'artifact-persistence',cause:'unknown',nextAction:'untrusted text'});
  const run=(await f.read()).runs[0];assert.equal(run.failureStage,'artifact-persistence');assert.equal(run.state,'unresolved');assert.equal(run.nextAction.includes('untrusted text'),false);
});
test('other project results are not returned',async()=>{
  const f=await fixture();const foreign=structuredClone(f.payload);foreign.taskContext.attempt.binding.projectId='pp_other';await f.append('proof-admitted',foreign);
  assert.deepEqual((await f.read()).runs,[]);
});
test('oversized, invalid UTF8, hardlinked and redirected journals are refused',async()=>{
  const f=await fixture();const file=await open(f.journalPath,'wx');await file.truncate(8*1024*1024+1);await file.close();await refused(f.read());
  const utf=await fixture();await writeFile(utf.journalPath,Buffer.from([0xff,10]));await refused(utf.read());
  const hard=await fixture();await hard.append('proof-admitted');await link(hard.journalPath,path.join(hard.root,'alias'));await refused(hard.read());
  const redirected=await fixture();await redirected.append('proof-admitted');const folder=path.join(redirected.root,'redirect');
  await symlink(redirected.root,folder,process.platform==='win32'?'junction':'dir');
  await refused(readTaskRunObservations({journalPath:path.join(folder,'journal.jsonl'),ledgerWire:JSON.stringify(redirected.ledger)}));
});
