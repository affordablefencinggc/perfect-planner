import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createTaskRunObservationMiddleware } from '../src/node/taskRunObservationHttp.mjs';
import { emptyTaskDraftLedger,updateTaskDraft } from '../src/project/taskDraftLedger.js';
import { acceptanceSetDigest } from '../src/node/taskOutcomeContract.mjs';
import { runProof } from '../src/node/proofRunner.mjs';

test('actual retained runner failure is read through pinned host transport without path authority',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'pp-observation-http-'));
  const ledger=updateTaskDraft(emptyTaskDraftLedger({projectId:'pp_http_fixture',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)}),{title:'HTTP result',description:'',owner:'worker',acceptance:'check',recovery:'retain',claims:[],dependsOn:[],archived:false});
  const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const attempt={schemaVersion:1,kind:'TASK_ATTEMPT',binding:{projectId:ledger.binding.projectId,rootIdentity:ledger.binding.rootIdentity,ledgerRevision:ledger.revision,ledgerDigest:hash(ledger),taskId:'T0001',taskDigest:hash(ledger.tasks[0]),candidateDigest:'c'.repeat(64),acceptanceDigest:acceptanceSetDigest(['unit'])},attemptId:'attempt-1',attemptNumber:1,producerId:'worker',sessionId:'session-1',grantId:'unverified',requiredCheckIds:['unit']};
  const journalPath=path.join(root,'journal.jsonl'),script=path.join(root,'check.mjs');
  await writeFile(script,'console.error("synthetic private diagnostic");process.exit(3);');
  const actual=await runProof({allowedRoot:root,cwd:root,evidenceDirectory:path.join(root,'evidence'),journalPath,command:process.execPath,args:[script],policy:{allowedExecutables:[process.execPath]},planId:'PP-T',itemId:'T0001',actor:'fixture',taskAttemptWire:JSON.stringify(attempt),taskLedgerWire:JSON.stringify(ledger),taskCheckId:'unit'});
  let middleware;
  const server=createServer((req,res)=>middleware(req,res));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  const bindings=[{projectId:ledger.binding.projectId,rootIdentity:ledger.binding.rootIdentity,journalPath}];
  middleware=createTaskRunObservationMiddleware({origin,bindings});
  bindings[0].journalPath=path.join(root,'must-not-use');
  const url=origin+'/api/task-run-observations';
  try{
    const session=await fetch(url+'/session',{method:'POST',headers:{origin}});assert.equal(session.status,200);
    const {token,executionAuthorized}=await session.json();assert.equal(executionAuthorized,false);
    const headers={origin,'content-type':'application/json','x-pp-observation-token':token};
    const read=async(body={ledger},extra={})=>{const response=await fetch(url+'/read',{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
    const observed=await read();assert.equal(observed.status,200);assert.equal(observed.body.runs[0].exitCode,3);assert.equal(observed.body.runs[0].artifactDigest,actual.sha256);assert.equal(observed.body.authorityVerified,false);
    assert.equal(observed.body.ledgerSource,'renderer-supplied-draft');assert.equal(observed.body.currentHostLedgerVerified,false);
    assert.equal(JSON.stringify(observed.body).includes('synthetic private diagnostic'),false);assert.equal(JSON.stringify(observed.body).includes(root),false);
    assert.equal((await read({ledger,journalPath:script})).status,400);
    assert.equal((await read({ledger:{...ledger,binding:{...ledger.binding,rootIdentity:'f'.repeat(64)}}})).status,409);
    assert.equal((await read({ledger:{...ledger,binding:{...ledger.binding,projectId:'pp_unknown'}}})).status,503);
    assert.equal((await read({ledger},{origin:'http://evil.invalid'})).status,403);
    assert.equal((await read({ledger},{'x-pp-observation-token':'x'.repeat(64)})).status,403);
    await writeFile(journalPath,'corrupt\n');
    const refused=await read();assert.equal(refused.status,503);assert.deepEqual(refused.body,{error:'OBSERVATIONS_UNAVAILABLE'});
    assert.equal(middleware.revoke(ledger.binding.projectId),true);
    assert.deepEqual((await read()).body,{error:'OBSERVATIONS_NOT_CONFIGURED'});
    middleware.dispose();assert.deepEqual((await read()).body,{error:'READER_CLOSED'});
  }finally{const closed=once(server,'close');server.close();server.closeAllConnections();await closed;}
});

test('transport constructor rejects nonlocal origins and invalid or duplicate bindings',()=>{
  for(const origin of ['http://0.0.0.0:4173','https://127.0.0.1:4173','http://example.com','http://localhost:4173/path'])assert.throws(()=>createTaskRunObservationMiddleware({origin}));
  const source={projectId:'pp_fixture',rootIdentity:'a'.repeat(64),journalPath:path.resolve('fixture')};
  assert.throws(()=>createTaskRunObservationMiddleware({origin:'http://127.0.0.1:4173',bindings:[source,source]}));
  assert.throws(()=>createTaskRunObservationMiddleware({origin:'http://127.0.0.1:4173',bindings:[{...source,journalPath:'relative'}]}));
});
