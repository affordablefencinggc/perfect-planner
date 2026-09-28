import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {readNativeTaskBatchOutcome} from '../src/native/taskBatchOutcome.js';
function fixture(){
 const request={requestId:'batch',taskId:'T0001',attemptId:'attempt',attemptNumber:1};
 const checks=[0,7,0].map((exitCode,i)=>({grantId:`grant-${i}`,checkId:`check-${i}`,runId:`run-${i}`,intentDigest:'a'.repeat(64),artifactDigest:String(i).repeat(64),taskId:request.taskId,attemptId:request.attemptId,attemptNumber:1,journalLinked:true,exitCode,state:exitCode?'failure-observed':'result-unverified',failureReasons:exitCode?['nonzero-exit']:[]}));
 const refs=checks.map(c=>({artifactDigest:c.artifactDigest,checkId:c.checkId,grantId:c.grantId,intentDigest:c.intentDigest,runId:c.runId}));
 const receipt={kind:'NATIVE_TASK_EXECUTION_RECEIPT',requestId:'batch',anchorGrantId:checks[0].grantId,checkCount:3,checksDigest:createHash('sha256').update(JSON.stringify(refs)).digest('hex'),authorityVerified:false,executionAuthorized:false};
 const pages=checks.toReversed().map((c,i)=>({page:{offset:i,journalHead:{headDigest:'a'.repeat(64)},nextOffset:i===2?null:i+1,entries:[{...c,lifecycleState:'result-recorded',journalRevision:12-i*4}]},outcomes:[{grantId:c.grantId,phase:'ready',value:c}]}));
 return {request,receipt,pages,reader:{readPage:async({offset,expectedHeadDigest})=>{assert.equal(expectedHeadDigest,offset?'a'.repeat(64):null);return pages[offset];}}};
}
test('batch display matches all ordered references and preserves failed check',async()=>{
 const f=fixture(),result=await readNativeTaskBatchOutcome(f.reader,f.receipt,f.request);assert.deepEqual(result.checks.map(c=>c.exitCode),[0,7,0]);assert.equal(result.checks[1].state,'failure-observed');assert.equal(result.authorityVerified,false);
});
test('batch display refuses missing, changed, duplicate, stale and unavailable results',async()=>{
 const mutations=[f=>{f.receipt.checksDigest='f'.repeat(64);},f=>{f.pages[1].outcomes[0].phase='unavailable';},f=>{f.pages[1].page.entries[0].attemptNumber=2;},f=>{f.pages[1].page.journalHead.headDigest='b'.repeat(64);},f=>{f.pages[1].page.nextOffset=1;},f=>{f.receipt.checkCount=2;},f=>{f.pages[1].outcomes[0].value.journalLinked=false;},f=>{f.pages[1].outcomes[0].value.checkId='check-0';}];
 for(const mutate of mutations){const f=fixture();mutate(f);await assert.rejects(readNativeTaskBatchOutcome(f.reader,f.receipt,f.request));}
});
