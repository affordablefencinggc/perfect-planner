import "./helpers/hermetic-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import { applyArchivedPlanConfirmationRetention, applyConfirmationRetention, awaitConfirmation, cancelConfirmation, createTrustedUserGestureBoundary, createTrustedUserGestureProducer, decideConfirmation, inspectConfirmationRetention, inspectConfirmations, requestConfirmation } from "../src/node/confirmationStore.mjs";

const fixture = async () => path.join(await mkdtemp(path.join(os.tmpdir(), "pp-confirm-")), "state", "confirmations.json");
const request = (storePath) => requestConfirmation(storePath, { planId: "PP-014", itemId: "B07-4", question: "Approve destructive migration?", requestedBy: "session-a" });
const gestureBoundary = createTrustedUserGestureBoundary(async (evidence,binding) => evidence === "trusted-click" ? { trusted: true, binding, source: "local-confirmation-ui", eventId: "gesture-1", occurredAt: "2026-09-02T00:01:00.000Z" } : { trusted: false });
const mockDpapi = { protect: async (value) => Buffer.concat([Buffer.from("dpapi:"), Buffer.from(value)]), unprotect: async (value) => Buffer.from(value).subarray(6) };

test('a published decision with a lost response is recovered only by its exact retry',async t=>{
  const storePath=await fixture(),pending=await request(storePath);
  const producer=createTrustedUserGestureProducer({source:'test-host'});
  const evidence=producer.capture({isTrusted:true},'Danie',{request:pending,decision:'approved'});
  const input={id:pending.id,decision:'approved',decidedBy:'Danie',userGestureEvidence:evidence,rationale:'Reviewed exact scope'};
  const original=fs.rename;
  const mock=t.mock.method(fs,'rename',async(from,to)=>{await original(from,to);if(to===storePath)throw Error('Response lost after publication');});
  syncBuiltinESMExports();
  try{await assert.rejects(decideConfirmation(storePath,input,{gestureBoundary:producer.boundary}),/Response lost/);}
  finally{mock.mock.restore();syncBuiltinESMExports();}
  const before=(await inspectConfirmations(storePath))[0];assert.equal(before.status,'approved');
  const retried=await decideConfirmation(storePath,input,{gestureBoundary:producer.boundary});
  assert.deepEqual(retried,before);assert.equal('decisionEvidenceDigest' in retried,false);
  assert.deepEqual(await decideConfirmation(storePath,input,{gestureBoundary:producer.boundary}),before);
  for(const override of [{decision:'rejected'},{decidedBy:'Other'},{rationale:'Different scope'},{userGestureEvidence:{...evidence,token:'forged'}}])await assert.rejects(decideConfirmation(storePath,{...input,...override},{gestureBoundary:producer.boundary}),/immutable/);
  assert.equal((await inspectConfirmations(storePath)).length,1);
});

test('proposal confirmation snapshots the exact head and rejects substituted review subjects',async()=>{
  const storePath=await fixture();
  const subject={kind:'TASK_LEDGER_PROPOSAL',projectId:'pp_approval_fixture',rootIdentity:'a'.repeat(64),hostRevision:1,proposalDigest:'b'.repeat(64),ledgerDigest:'c'.repeat(64)};
  const input={planId:'PP-014',itemId:'PROPOSAL',question:'Review this proposal?',requestedBy:'session-a',subject};
  const pendingWork=requestConfirmation(storePath,input);subject.hostRevision=2;
  const pending=await pendingWork;assert.equal(pending.subject.hostRevision,1);
  const producer=createTrustedUserGestureProducer({source:'test-host'});
  for(const override of [{hostRevision:2},{proposalDigest:'d'.repeat(64)},{ledgerDigest:'d'.repeat(64)},{rootIdentity:'d'.repeat(64)},{projectId:'pp_other_fixture'}]){
    const evidence=producer.capture({isTrusted:true},'Danie',{request:{...pending,subject:{...pending.subject,...override}},decision:'approved'});
    await assert.rejects(decideConfirmation(storePath,{id:pending.id,decision:'approved',decidedBy:'Danie',userGestureEvidence:evidence},{gestureBoundary:producer.boundary}),/refused/);
  }
  const evidence=producer.capture({isTrusted:true},'Danie',{request:pending,decision:'approved'});
  const result=await decideConfirmation(storePath,{id:pending.id,decision:'approved',decidedBy:'Danie',userGestureEvidence:evidence},{gestureBoundary:producer.boundary});
  assert.deepEqual(result.subject,pending.subject);
  assert.deepEqual((await awaitConfirmation(storePath,pending,{timeoutMs:0})).request.subject,pending.subject);
  await assert.rejects(requestConfirmation(await fixture(),{...input,subject:{...subject,executionAuthorized:true}}),/subject is invalid/);
});

test('failed actor validation or decision persistence does not burn the correct gesture',async t=>{
  const storePath=await fixture(),pending=await request(storePath);
  const producer=createTrustedUserGestureProducer({source:'test-host'});
  const evidence=producer.capture({isTrusted:true},'Danie',{request:pending,decision:'approved'});
  const input={id:pending.id,decision:'approved',decidedBy:'Danie',userGestureEvidence:evidence};
  await assert.rejects(decideConfirmation(storePath,{...input,decidedBy:'Other'},{gestureBoundary:producer.boundary}),/actor does not match/);
  const original=fs.rename;
  const mock=t.mock.method(fs,'rename',async(from,to)=>{if(to===storePath)throw Error('Controlled rename failure');return original(from,to);});
  syncBuiltinESMExports();
  try{await assert.rejects(decideConfirmation(storePath,input,{gestureBoundary:producer.boundary}),/Controlled rename failure/);}
  finally{mock.mock.restore();syncBuiltinESMExports();}
  assert.equal((await awaitConfirmation(storePath,pending,{timeoutMs:0})).state,'waiting');
  assert.equal((await decideConfirmation(storePath,input,{gestureBoundary:producer.boundary})).decision,'approved');
});

test('gesture cannot approve another request or reverse the reviewed decision',async()=>{
  const storePath=await fixture(),first=await request(storePath);
  const second=await requestConfirmation(storePath,{planId:'PP-014',itemId:'OTHER',question:'Different work?',requestedBy:'session-a'});
  const producer=createTrustedUserGestureProducer({source:'test-host'});
  assert.throws(()=>producer.capture({isTrusted:true},'Danie'),/exact request/);
  const evidence=producer.capture({isTrusted:true},'Danie',{request:first,decision:'rejected'});
  for(const value of [{id:second.id,decision:'rejected'},{id:first.id,decision:'approved'}]){
    await assert.rejects(decideConfirmation(storePath,{...value,decidedBy:'Danie',userGestureEvidence:evidence},{gestureBoundary:producer.boundary}),/refused/);
  }
  assert.ok((await inspectConfirmations(storePath)).every(item=>item.status==='pending'));
  await decideConfirmation(storePath,{id:first.id,decision:'rejected',decidedBy:'Danie',userGestureEvidence:evidence},{gestureBoundary:producer.boundary});
  const result=await awaitConfirmation(storePath,first,{timeoutMs:0});
  assert.equal(result.state,'rejected');assert.equal(result.request.gesture.binding.requestId,first.id);
});

test('decision snapshots caller input before asynchronous verification',async()=>{
  const storePath=await fixture(),pending=await request(storePath);
  let proceed,entered;
  const ready=new Promise(resolve=>{entered=resolve;});
  const boundary=createTrustedUserGestureBoundary(async(evidence,binding)=>{entered();await new Promise(resolve=>{proceed=resolve;});return {trusted:true,binding,source:'test-host',eventId:'bound-event',occurredAt:new Date().toISOString(),actor:'Danie'};});
  const input={id:pending.id,decision:'rejected',decidedBy:'Danie',userGestureEvidence:'test',rationale:'Keep work'};
  const work=decideConfirmation(storePath,input,{gestureBoundary:boundary});await ready;
  input.id='changed';input.decision='approved';input.rationale='Changed after review';proceed();
  const result=await work;assert.equal(result.id,pending.id);assert.equal(result.decision,'rejected');assert.equal(result.rationale,'Keep work');
});

test("a pending confirmation times out as waiting, never approved", async () => {
  const storePath = await fixture(); const pending = await request(storePath);
  const result = await awaitConfirmation(storePath, pending, { timeoutMs: 10, pollMs: 5 });
  assert.equal(result.state, "waiting"); assert.equal(result.request.status, "pending");
});

test("only the exact watcher can resume the exact item", async () => {
  const storePath = await fixture(); const pending = await request(storePath);
  await assert.rejects(() => awaitConfirmation(storePath, { ...pending, watcherToken: "stolen" }, { timeoutMs: 0 }), /ownership does not match/);
  await assert.rejects(() => awaitConfirmation(storePath, { ...pending, requestedBy: "session-b" }, { timeoutMs: 0 }), /ownership does not match/);
});

test("a decision requires an explicit user gesture and named actor", async () => {
  const storePath = await fixture(); const pending = await request(storePath);
  await assert.rejects(() => decideConfirmation(storePath, { id: pending.id, decision: "approved", decidedBy: "Danie", userGesture: true }), /trusted user-gesture boundary/);
  await assert.rejects(() => decideConfirmation(storePath, { id: pending.id, decision: "approved", decidedBy: "Danie", userGestureEvidence: "forged" }, { gestureBoundary }), /refused the decision evidence/);
  await decideConfirmation(storePath, { id: pending.id, decision: "approved", decidedBy: "Danie", userGestureEvidence: "trusted-click", rationale: "Reviewed migration proof" }, { gestureBoundary });
  const result = await awaitConfirmation(storePath, pending, { timeoutMs: 0 });
  assert.equal(result.state, "approved"); assert.equal(result.request.decidedBy, "Danie"); assert.equal(result.request.gesture.source, "local-confirmation-ui"); assert.equal("watcherToken" in result.request, false);
});

test("a recorded decision is immutable", async () => {
  const storePath = await fixture(); const pending = await request(storePath);
  await decideConfirmation(storePath, { id: pending.id, decision: "rejected", decidedBy: "Danie", userGestureEvidence: "trusted-click" }, { gestureBoundary });
  await assert.rejects(() => decideConfirmation(storePath, { id: pending.id, decision: "approved", decidedBy: "Agent", userGestureEvidence: "trusted-click" }, { gestureBoundary }), /immutable/);
});

test("only the exact watcher may cancel a pending confirmation with a reason", async () => {
  const storePath = await fixture(); const pending = await request(storePath);
  await assert.rejects(() => cancelConfirmation(storePath, { ...pending, watcherToken: "forged" }, { reason: "superseded" }), /ownership does not match/);
  const cancelled = await cancelConfirmation(storePath, pending, { reason: "migration withdrawn", timestamp: "2026-09-02T00:02:00.000Z" }); assert.equal(cancelled.status, "cancelled"); assert.equal("watcherToken" in cancelled, false);
  assert.equal((await awaitConfirmation(storePath, pending, { timeoutMs: 0 })).state, "cancelled");
  await assert.rejects(() => decideConfirmation(storePath, { id: pending.id, decision: "approved", decidedBy: "Danie", userGestureEvidence: "trusted-click" }, { gestureBoundary }), /immutable/);
});

test("retention removes only old terminal requests and preserves a hashed receipt", async () => {
  const storePath = await fixture(); const old = await request(storePath); await cancelConfirmation(storePath, old, { reason: "withdrawn", timestamp: "2026-09-01T00:00:00.000Z" });
  const pending = await requestConfirmation(storePath, { planId: "PP-014", itemId: "B07-5", question: "Approve follow-up?", requestedBy: "session-a" }, { timestamp: "2026-09-02T00:00:00.000Z" });
  const receipt = await applyConfirmationRetention(storePath, { actor: "retention-owner", before: "2026-09-02T00:00:00.000Z" }, { timestamp: "2026-09-03T00:00:00.000Z" }); assert.equal(receipt.removed.length, 1); assert.match(receipt.hash, /^[a-f0-9]{64}$/);
  const visible = await inspectConfirmations(storePath); assert.deepEqual(visible.map((item) => item.id), [pending.id]); assert.equal((await inspectConfirmationRetention(storePath))[0].hash, receipt.hash);
});

test("OS-bound watcher mode returns only an opaque handle and refuses forged handles", async () => {
  const storePath = await fixture(); const secretCustody = { root: path.join(path.dirname(storePath), "custody"), dpapi: mockDpapi }; const pending = await requestConfirmation(storePath, { planId: "PP-014", itemId: "B07-6", question: "Approve protected action?", requestedBy: "session-a" }, { secretCustody }); assert.match(pending.watcherHandle, /^dpapi:v1:/); assert.equal(pending.watcherToken, null);
  await assert.rejects(() => awaitConfirmation(storePath, { ...pending, watcherHandle: "dpapi:v1:00000000-0000-0000-0000-000000000000" }, { timeoutMs: 0, secretCustody }), /ownership does not match/); assert.equal((await awaitConfirmation(storePath, pending, { timeoutMs: 0, secretCustody })).state, "waiting"); const visible = await inspectConfirmations(storePath); assert.equal("watcherTokenDigest" in visible[0], false); await cancelConfirmation(storePath, pending, { reason: "withdrawn", secretCustody });
});

test("duplicate pending requests cannot replace the original watcher", async () => {
  const storePath = await fixture(); await request(storePath);
  await assert.rejects(() => request(storePath), /already pending/);
  const visible = await inspectConfirmations(storePath);
  assert.equal(visible.length, 1); assert.equal("watcherToken" in visible[0], false);
});

test("the native gesture producer accepts one trusted event exactly once", async () => {
  const storePath = await fixture(); const pending = await request(storePath); const producer = createTrustedUserGestureProducer({ source: "tauri-confirmation-window", now: () => "2026-09-02T00:01:00.000Z" });
  assert.throws(() => producer.capture({ isTrusted: false }, "Danie"), /trusted native event/); const evidence = producer.capture({ isTrusted: true }, "Danie", {request:pending,decision:"approved"}); await decideConfirmation(storePath, { id: pending.id, decision: "approved", decidedBy: "Danie", userGestureEvidence: evidence }, { gestureBoundary: producer.boundary });
  const second = await requestConfirmation(storePath, { planId: "PP-014", itemId: "B07-9", question: "Approve another?", requestedBy: "session-a" }); await assert.rejects(() => decideConfirmation(storePath, { id: second.id, decision: "approved", decidedBy: "Danie", userGestureEvidence: evidence }, { gestureBoundary: producer.boundary }), /refused/);
});

test("a trusted native gesture cannot be relabelled as another decider", async () => { const storePath = await fixture(); const pending = await request(storePath); const producer = createTrustedUserGestureProducer({ source: "tauri-confirmation-window" }); const evidence = producer.capture({ isTrusted: true }, "Danie", {request:pending,decision:"approved"}); await assert.rejects(() => decideConfirmation(storePath, { id: pending.id, decision: "approved", decidedBy: "Mira", userGestureEvidence: evidence }, { gestureBoundary: producer.boundary }), /actor does not match/); });

test("plan-level retention requires a journal-bound archive decision and fixed 365-day cutoff", async () => {
  const storePath = await fixture(); const old = await request(storePath); await cancelConfirmation(storePath, old, { reason: "withdrawn", timestamp: "2025-01-01T00:00:00.000Z" }); const pending = await requestConfirmation(storePath, { planId: "PP-014", itemId: "B07-10", question: "Still pending?", requestedBy: "session-a" });
  await assert.rejects(() => applyArchivedPlanConfirmationRetention(storePath, { actor: "retention-owner", archiveDecision: { state: "ARCHIVED", planId: "PP-014" } }), /journal-bound/); const receipt = await applyArchivedPlanConfirmationRetention(storePath, { actor: "retention-owner", archiveDecision: { state: "ARCHIVED", planId: "PP-014", decidedBy: "Danie", decidedAt: "2026-01-01T00:00:00.000Z", journalHash: "a".repeat(64) } }, { timestamp: "2026-09-02T00:00:00.000Z" }); assert.equal(receipt.policy, "terminal-confirmations-365d-after-plan-archive-v1"); assert.deepEqual(receipt.removed.map((item) => item.id), [old.id]); assert.deepEqual((await inspectConfirmations(storePath)).map((item) => item.id), [pending.id]);
});
