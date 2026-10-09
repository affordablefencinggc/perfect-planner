import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createTaskDraftDelivery} from '../src/project/taskDraftDelivery.js';
import {emptyTaskDraftLedger,updateTaskDraft} from '../src/project/taskDraftLedger.js';
import {submissionReceiptFromHost,submissionWire} from '../src/project/taskDraftSubmission.js';
const binding={projectId:'pp_delivery_test',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)};
const clone=structuredClone;
test('unseen shared head never becomes the parent of a replacement local draft',async()=>{
 const f=fixture();const inspect=f.host.inspect;
 f.host.inspect=async()=>({...await inspect(),observedHead:{hostRevision:1,headDigest:'d'.repeat(64)}});
 await assert.rejects(f.delivery().start(binding,1),e=>e.code==='REMOTE_CHANGED');
 assert.equal(f.records.size,0);assert.ok(!f.events.includes('send'));
});
test('agent change after local acknowledgement is preserved; exact acknowledged retry still works',async()=>{
 const f=fixture();await f.delivery().start(binding,1);f.newer();const inspect=f.host.inspect;
 f.host.inspect=async()=>({...await inspect(),observedHead:{hostRevision:2,headDigest:'d'.repeat(64)}});
 const sends=f.events.filter(e=>e==='send').length;
 await assert.rejects(f.delivery().start(binding,2),e=>e.code==='REMOTE_CHANGED');
 assert.equal(f.records.size,1);assert.equal(f.events.filter(e=>e==='send').length,sends);
 assert.equal((await f.delivery().retry(binding,'original-delivery')).status,'previously-acknowledged');
});
test('known current parent permits a newer local draft but rejects reset and mismatched heads',async()=>{
 const f=fixture();await f.delivery().start(binding,1);f.newer();const inspect=f.host.inspect;
 for(const head of [{hostRevision:0,headDigest:'GENESIS'},{hostRevision:1,headDigest:'d'.repeat(64)}]){
  f.host.inspect=async()=>({...await inspect(),observedHead:head});await assert.rejects(f.delivery().start(binding,2),e=>e.code==='REMOTE_CHANGED');
 }
 f.host.inspect=async()=>({...await inspect(),observedHead:{hostRevision:1,headDigest:'c'.repeat(64)}});
 f.store.prepareSubmission=async(b,revision,request)=>{assert.equal(revision,2);assert.equal(request.expectedRevision,1);assert.equal(request.expectedHeadDigest,'c'.repeat(64));throw Error('Sentinel: preparation reached');};
 await assert.rejects(f.delivery().start(binding,2),e=>e.code==='PREPARE_FAILED');
});
test('native outstanding original stays distinct from current local request and survives inspection',async()=>{
  const nativeError=()=>Object.assign(Error('private details'),{requiresRecovery:false,originalRequestId:'older-native-original'});
  const f=fixture();f.host.submit=async()=>{throw nativeError();};
  await assert.rejects(f.delivery().start(binding,1),e=>e.requestId==='original-delivery'&&e.originalRequestId==='older-native-original'&&e.requiresRecovery===false);
  assert.equal(f.records.get('original-delivery').receipt,null);
  const g=fixture();g.host.inspect=async()=>{throw nativeError();};
  await assert.rejects(g.delivery().start(binding,1),e=>e.requestId===null&&e.originalRequestId==='older-native-original'&&e.requiresRecovery===false);
  assert.equal(g.records.size,0);
});
function fixture(){
  let ledger=updateTaskDraft(emptyTaskDraftLedger(binding),{id:null,title:'Original saved task',description:'',owner:'',acceptance:'',recovery:'',claims:[],dependsOn:[],archived:false});
  const records=new Map(),events=[];
  const store={async submissionHistory(){return [...records.values()].map(value=>clone(value));},async prepareSubmission(b,revision,request){events.push('persist');if(ledger.revision!==revision)throw Error('stale');const record={schemaVersion:1,kind:'LOCAL_DRAFT_SUBMISSION',binding:clone(b),localRevision:revision,ledger:clone(ledger),request:clone(request),receipt:null,executionAuthorized:false};records.set(request.requestId,record);return clone(record);},async readSubmission(b,id){return clone(records.get(id));},async recordSubmissionReceipt(b,id,result){events.push('receipt');const old=records.get(id);old.receipt=submissionReceiptFromHost(result);return clone(old);}};
  const host={async inspect(){events.push('inspect');return {schemaVersion:1,observedHead:{hostRevision:0,headDigest:'GENESIS'},registrationCurrent:true,registrationLeaseHeld:false,approvalState:'unapproved-proposal',executionAuthorized:false};},async submit(payload){events.push('send');assert.ok(records.has(payload.request.requestId));return {schemaVersion:1,observedHead:{hostRevision:1,headDigest:'c'.repeat(64)},registrationCurrent:true,registrationLeaseHeld:false,approvalState:'unapproved-proposal',executionAuthorized:false,submissionPersisted:true,idempotent:false,submittedMatchesObservedHead:true,submitted:{hostRevision:1,headDigest:'c'.repeat(64),ledgerDigest:createHash('sha256').update(submissionWire(payload.ledger)).digest('hex')}};}};
  const delivery=()=>createTaskDraftDelivery({store,host,createRequestId:()=> 'original-delivery'});
  return {store,host,records,events,delivery,newer(){ledger=updateTaskDraft(ledger,{...ledger.tasks[0],title:'Newer edited task'});}};
}
test('original submission is persisted before delivery and receipt is retained',async()=>{const f=fixture();const result=await f.delivery().start(binding,1);assert.deepEqual(f.events,['inspect','persist','send','receipt']);assert.equal(result.status,'acknowledged');assert.equal(result.executionAuthorized,false);assert.ok(f.records.get('original-delivery').receipt);});
test('lost reply preserves original content and explicit retry after newer edits reuses it',async()=>{
  const f=fixture(),submit=f.host.submit;f.host.submit=async payload=>{await submit(payload);throw Error('lost reply with private details');};
  await assert.rejects(f.delivery().start(binding,1),e=>e.code==='NOT_CONFIRMED'&&e.requestId==='original-delivery'&&!e.message.includes('private'));
  f.newer();await assert.rejects(f.delivery().start(binding,2),e=>e.code==='PENDING');
  f.host.submit=async payload=>{assert.equal(payload.ledger.tasks[0].title,'Original saved task');assert.equal(payload.ledger.revision,1);assert.equal(payload.request.requestId,'original-delivery');return submit(payload);};
  assert.equal((await f.delivery().retry(binding,'original-delivery')).status,'acknowledged');assert.equal(f.events.filter(e=>e==='persist').length,1);
});
test('failed preparation and unavailable inspection never send a draft',async()=>{
  const f=fixture();f.store.prepareSubmission=async()=>{throw Error('disk full');};await assert.rejects(f.delivery().start(binding,1),e=>e.code==='PREPARE_FAILED');assert.ok(!f.events.includes('send'));
  const g=fixture();g.host.inspect=async()=>{throw Error('native unavailable');};await assert.rejects(g.delivery().start(binding,1),e=>e.code==='UNAVAILABLE');assert.equal(g.records.size,0);
});
test('receipt storage failure remains pending; recorded acknowledgement does not resend',async()=>{
  const f=fixture(),write=f.store.recordSubmissionReceipt;f.store.recordSubmissionReceipt=async()=>{throw Error('quota');};await assert.rejects(f.delivery().start(binding,1),e=>e.code==='NOT_CONFIRMED');assert.equal(f.records.get('original-delivery').receipt,null);
  f.store.recordSubmissionReceipt=write;await f.delivery().retry(binding,'original-delivery');const sends=f.events.filter(e=>e==='send').length;assert.equal((await f.delivery().retry(binding,'original-delivery')).status,'previously-acknowledged');assert.equal(f.events.filter(e=>e==='send').length,sends);
});
test('concurrent clicks are refused and delayed receipt persistence is not view-dependent',async()=>{
  const f=fixture(),submit=f.host.submit;let release;f.host.submit=async payload=>{await new Promise(resolve=>{release=resolve;});return submit(payload);};
  const service=f.delivery(),pending=service.start(binding,1);await assert.rejects(service.start(binding,1),e=>e.code==='BUSY');
  while(!release)await new Promise(resolve=>setImmediate(resolve));release();await pending;assert.ok(f.records.get('original-delivery').receipt);
});
test('cross-project retry and malformed authority claims cannot persist acknowledgement',async()=>{
  const f=fixture();f.host.submit=async()=>({executionAuthorized:true});await assert.rejects(f.delivery().start(binding,1),e=>e.code==='NOT_CONFIRMED');assert.equal(f.records.get('original-delivery').receipt,null);
  await assert.rejects(f.delivery().retry({...binding,projectId:'pp_other_project'},'original-delivery'),e=>e.code==='INVALID');
});
test('inspection keeps the native recovery requirement without preparing or sending',async()=>{const f=fixture();f.host.inspect=async()=>{const error=Error('private native details');error.requiresRecovery=true;throw error;};await assert.rejects(f.delivery().start(binding,1),e=>e.code==='UNAVAILABLE'&&e.requiresRecovery===true&&!e.message.includes('private'));assert.equal(f.records.size,0);assert.ok(!f.events.includes('send'));});
