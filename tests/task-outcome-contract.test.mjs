import "./helpers/hermetic-env.mjs";
import test from 'node:test';import assert from 'node:assert/strict';
import {acceptanceSetDigest,parseTaskAttempt,inspectTaskAttemptResults} from '../src/node/taskOutcomeContract.mjs';
const binding={projectId:'pp_outcome_fixture',rootIdentity:'a'.repeat(64),ledgerRevision:1,ledgerDigest:'b'.repeat(64),taskId:'T0001',taskDigest:'c'.repeat(64),candidateDigest:'d'.repeat(64),acceptanceDigest:acceptanceSetDigest(['unit','integration'])};
const attempt={schemaVersion:1,kind:'TASK_ATTEMPT',binding,attemptId:'attempt-1',attemptNumber:1,producerId:'runner-1',sessionId:'session-1',grantId:'grant-1',requiredCheckIds:['unit','integration']};
const result=checkId=>({schemaVersion:1,kind:'TASK_CHECK_RESULT',binding,attemptId:'attempt-1',checkId,producerId:'runner-1',sessionId:'session-1',exitCode:0,timedOut:false,outputTruncated:false,cleanup:'complete',artifactDigest:'e'.repeat(64)});
const inspect=results=>inspectTaskAttemptResults(JSON.stringify(attempt),results.map(r=>JSON.stringify(r)));
test('complete required set passes structural inspection but grants no authority',()=>{const r=inspect([result('unit'),result('integration')]);assert.equal(r.allRequiredChecksPassed,true);assert.equal(r.authorityVerified,false);assert.equal(r.promotionAuthority,false);});
test('missing, failed, timed-out and incomplete cleanup never become complete success',()=>{
 assert.deepEqual(inspect([result('unit')]).missing,['integration']);
 for(const override of [{exitCode:1},{exitCode:null},{timedOut:true},{outputTruncated:true},{cleanup:'unknown'},{cleanup:'incomplete'}])assert.equal(inspect([result('unit'),{...result('integration'),...override}]).allRequiredChecksPassed,false);
});
test('every binding dimension, producer, session and attempt must match',()=>{
 for(const field of Object.keys(binding)){const changed={...binding,[field]:field==='ledgerRevision'?2:field==='projectId'?'pp_other_fixture':field==='taskId'?'T0002':'f'.repeat(64)};assert.throws(()=>inspect([{...result('unit'),binding:changed}]),/TASK_OUTCOME_INVALID/);}
 for(const field of ['producerId','sessionId','attemptId'])assert.throws(()=>inspect([{...result('unit'),[field]:'other-id'}]),/TASK_OUTCOME_INVALID/);
});
test('duplicate results, unknown checks and changed acceptance population refuse',()=>{
 assert.throws(()=>inspect([result('unit'),result('unit')]),/TASK_OUTCOME_INVALID/);assert.throws(()=>inspect([result('other')]),/TASK_OUTCOME_INVALID/);
 assert.throws(()=>parseTaskAttempt(JSON.stringify({...attempt,requiredCheckIds:['unit']})),/TASK_OUTCOME_INVALID/);
});
test('exact wire schema refuses caller authority flags, malformed JSON and oversized input',()=>{
 assert.throws(()=>parseTaskAttempt(JSON.stringify({...attempt,trusted:true})),/TASK_OUTCOME_INVALID/);
 assert.throws(()=>parseTaskAttempt('{bad'),/TASK_OUTCOME_INVALID/);assert.throws(()=>parseTaskAttempt(' '.repeat(262145)),/TASK_OUTCOME_INVALID/);
 assert.throws(()=>inspect([{...result('unit'),exitCode:'0'}]),/TASK_OUTCOME_INVALID/);
});
test('decoded attempts are immutable snapshots',()=>{const parsed=parseTaskAttempt(JSON.stringify(attempt));assert.ok(Object.isFrozen(parsed.binding));assert.ok(Object.isFrozen(parsed.requiredCheckIds));});
test('acceptance digest rejects holes and accessors and ignores custom iteration',()=>{
 assert.throws(()=>acceptanceSetDigest(new Array(1)),/TASK_OUTCOME_INVALID/);
 const accessor=['unit'];Object.defineProperty(accessor,'0',{get(){throw new Error('getter executed');}});
 assert.throws(()=>acceptanceSetDigest(accessor),/TASK_OUTCOME_INVALID/);
 const custom=['unit'];custom[Symbol.iterator]=function*(){yield 'integration';};
 assert.equal(acceptanceSetDigest(custom),acceptanceSetDigest(['unit']));
});
