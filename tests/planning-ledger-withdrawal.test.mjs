import test from 'node:test';
import assert from 'node:assert/strict';
import fs,{mkdtemp,rm,readFile,writeFile,symlink,link,mkdir,truncate,stat,open} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {createImportedProjectId} from '../src/project/projectIds.js';
import {createPlanningLedgerCustody} from '../src/node/planningLedgerCustody.mjs';
import {createTaskLedgerAuthorityStore} from '../src/node/taskLedgerAuthorityStore.mjs';
import {canonicalArchitectureJson as wire} from '../src/engine/architectureContractVerification.js';

async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'pp-custody-withdrawal-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const binding={projectId:createImportedProjectId('a'.repeat(64)),rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)};
 const ledger={schemaVersion:1,kind:'LOCAL_DRAFT',binding,revision:1,nextTaskNumber:2,updatedAt:'2026-09-13T01:00:00.000Z',tasks:[{id:'T0001',title:'Retained archived task',description:'Full original obligation',owner:'Owner',acceptance:'Keep every field',recovery:'Restore original',claims:[],dependsOn:[],archived:true}]};
 return {root,binding,ledger,original:{ledger,request:{requestId:'original',expectedRevision:0,expectedHeadDigest:'GENESIS'},expectedCensusDigest:null},custody:createPlanningLedgerCustody({root}),journal:path.join(root,binding.projectId,'planning-ledger-withdrawals.jsonl'),submittedJournal:path.join(root,binding.projectId,'planning-ledger.jsonl')};
}
const resolution=original=>({original,confirmation:{decision:'withdraw-if-unpublished',requestDigest:createHash('sha256').update(wire(original)).digest('hex')}});
function noGrants(value){for(const key of ['approvalAuthorized','executionAuthorized','filesystemVerified'])assert.equal(value[key],false);}

test('withdrawal retains exact original across reopen and refuses delayed submission',async t=>{
 const f=await fixture(t),first=await f.custody.resolveOriginal(resolution(f.original));assert.equal(first.outcome,'withdrawn');assert.equal(first.submissionPersisted,false);assert.equal(first.idempotent,false);assert.deepEqual(first.record.original,f.original);noGrants(first);
 const reopened=createPlanningLedgerCustody({root:f.root}),retry=await reopened.resolveOriginal(resolution(f.original));assert.equal(retry.idempotent,true);assert.deepEqual(retry.record,first.record);await assert.rejects(reopened.submit(f.original),/REQUEST_WITHDRAWN/);assert.equal((await reopened.inspect({binding:f.binding})).observedHead.hostRevision,0);
});

test('stale CAS census and local revision originals can withdraw before a fresh submission',async t=>{
 for(const kind of ['cas','census','revision']){
  const f=await fixture(t),saved=await f.custody.submit({...f.original,ledger:{...f.ledger,revision:3}});
  const original={ledger:{...f.ledger,revision:4},request:{requestId:`stale-${kind}`,expectedRevision:saved.observedHead.hostRevision,expectedHeadDigest:saved.observedHead.headDigest},expectedCensusDigest:f.binding.censusDigest};
  if(kind==='cas'){original.request.expectedRevision=0;original.request.expectedHeadDigest='GENESIS';}
  if(kind==='census')original.expectedCensusDigest='c'.repeat(64);
  if(kind==='revision')original.ledger.revision=2;
  await assert.rejects(f.custody.submit(original));assert.equal((await f.custody.resolveOriginal(resolution(original))).outcome,'withdrawn');
  const fresh={ledger:{...f.ledger,revision:4},request:{requestId:'fresh',expectedRevision:saved.observedHead.hostRevision,expectedHeadDigest:saved.observedHead.headDigest},expectedCensusDigest:f.binding.censusDigest};assert.equal((await f.custody.submit(fresh)).observedHead.hostRevision,2);await assert.rejects(f.custody.submit(original),/REQUEST_WITHDRAWN/);
 }
});

test('submitted original resolution returns actual historical receipt after successor',async t=>{
 const f=await fixture(t),first=await f.custody.submit(f.original);await f.custody.submit({ledger:{...f.ledger,revision:2},request:{requestId:'successor',expectedRevision:1,expectedHeadDigest:first.observedHead.headDigest},expectedCensusDigest:f.binding.censusDigest});const result=await f.custody.resolveOriginal(resolution(f.original));assert.equal(result.outcome,'submitted');assert.equal(result.receipt.idempotent,true);assert.deepEqual(result.receipt.submitted,first.submitted);assert.deepEqual(result.submittedProposal,first.latestProposal);assert.equal(result.submittedProposal.recordHash,result.receipt.submitted.headDigest);assert.equal(result.receipt.submittedMatchesObservedHead,false);assert.equal(result.receipt.observedHead.hostRevision,2);noGrants(result.receipt);
});

test('concurrent submit and resolution yield one terminal outcome',async t=>{
 const f=await fixture(t),[submitted,resolved]=await Promise.allSettled([f.custody.submit(f.original),f.custody.resolveOriginal(resolution(f.original))]);assert.equal(resolved.status,'fulfilled');
 if(resolved.value.outcome==='submitted'){assert.equal(submitted.status,'fulfilled');assert.deepEqual(resolved.value.receipt.submitted,submitted.value.submitted);}else{assert.equal(resolved.value.outcome,'withdrawn');assert.equal(submitted.status,'rejected');assert.match(submitted.reason.message,/REQUEST_WITHDRAWN/);}
});

test('concurrent exact resolution produces one withdrawal record',async t=>{
 const f=await fixture(t),values=await Promise.all([f.custody.resolveOriginal(resolution(f.original)),f.custody.resolveOriginal(resolution(f.original))]);assert.equal(values.filter(value=>value.idempotent).length,1);assert.deepEqual(values[0].record,values[1].record);assert.equal((await readFile(f.journal,'utf8')).trim().split('\n').length,1);
});

test('changed original with same ID and invalid confirmation refuse',async t=>{
 const f=await fixture(t);await assert.rejects(f.custody.resolveOriginal({...resolution(f.original),confirmation:{decision:'withdraw-if-unpublished',requestDigest:'f'.repeat(64)}}));await f.custody.resolveOriginal(resolution(f.original));const changed={...f.original,ledger:{...f.ledger,revision:2}};await assert.rejects(f.custody.resolveOriginal(resolution(changed)),/REQUEST_CONFLICT/);await assert.rejects(f.custody.submit(changed),/REQUEST_CONFLICT/);
});

test('withdrawal flush failure stays uncertain until retry reflushes identical bytes',async t=>{
 const f=await fixture(t),actualOpen=fs.open;let failing=true,calls=0;const mocked=t.mock.method(fs,'open',async(...args)=>{const handle=await actualOpen(...args);if(args[0]===f.journal){const sync=handle.sync.bind(handle);handle.sync=async()=>{calls++;if(failing)throw Error('Controlled withdrawal flush failure');return sync();};}return handle;});syncBuiltinESMExports();
 try{await assert.rejects(f.custody.resolveOriginal(resolution(f.original)),/Controlled withdrawal flush failure/);const bytes=await readFile(f.journal,'utf8');await assert.rejects(f.custody.resolveOriginal(resolution(f.original)),/Controlled withdrawal flush failure/);failing=false;const result=await f.custody.resolveOriginal(resolution(f.original));assert.equal(result.idempotent,true);assert.equal(calls,3);assert.equal(await readFile(f.journal,'utf8'),bytes);}finally{mocked.mock.restore();syncBuiltinESMExports();}
});

test('submitted resolution must reflush before returning receipt',async t=>{
 const f=await fixture(t);await f.custody.submit(f.original);const bytes=await readFile(f.submittedJournal,'utf8'),actualOpen=fs.open;let failing=true,calls=0;const mocked=t.mock.method(fs,'open',async(...args)=>{const handle=await actualOpen(...args);if(args[0]===f.submittedJournal){const sync=handle.sync.bind(handle);handle.sync=async()=>{calls++;if(failing)throw Error('Controlled submitted flush failure');return sync();};}return handle;});syncBuiltinESMExports();
 try{await assert.rejects(f.custody.resolveOriginal(resolution(f.original)),/Controlled submitted flush failure/);failing=false;const result=await f.custody.resolveOriginal(resolution(f.original));assert.equal(result.outcome,'submitted');assert.equal(result.receipt.idempotent,true);assert.equal(calls,2);assert.equal(await readFile(f.submittedJournal,'utf8'),bytes);}finally{mocked.mock.restore();syncBuiltinESMExports();}
});

test('corrupt and partial withdrawal history is preserved and blocks all custody reads',async t=>{
 for(const partial of [false,true]){const f=await fixture(t);await f.custody.resolveOriginal(resolution(f.original));const before=await readFile(f.journal,'utf8'),corrupt=partial?before.slice(0,-4):before.replace('Retained archived task','Changed archived task');assert.notEqual(before,corrupt);await writeFile(f.journal,corrupt);await assert.rejects(f.custody.inspect({binding:f.binding}));await assert.rejects(f.custody.resolveOriginal(resolution(f.original)));await assert.rejects(f.custody.submit(f.original));assert.equal(await readFile(f.journal,'utf8'),corrupt);}
});

test('existing symlink and hardlink targets remain unchanged',async t=>{
 for(const kind of ['symbolic','hard']){const f=await fixture(t);await mkdir(path.dirname(f.journal));const target=path.join(f.root,'existing-target'),bytes='preserve existing target\n';await writeFile(target,bytes);if(kind==='symbolic')await symlink(target,f.journal,'file');else await link(target,f.journal);await assert.rejects(f.custody.resolveOriginal(resolution(f.original)),/UNSAFE/);await assert.rejects(f.custody.submit(f.original),/UNSAFE/);await assert.rejects(f.custody.inspect({binding:f.binding}),/UNSAFE/);assert.equal(await readFile(target,'utf8'),bytes);}
});

test('resolution captures input before asynchronous work',async t=>{
 const f=await fixture(t),input=resolution(structuredClone(f.original)),pending=f.custody.resolveOriginal(input);input.original.ledger.tasks[0].title='Late mutation';input.confirmation.decision='approve';const result=await pending;assert.deepEqual(result.record.original,f.original);assert.equal(result.record.confirmation.decision,'withdraw-if-unpublished');
});

test('withdrawal record quota preserves all prior outcomes and exact retry remains available',async t=>{
 const f=await fixture(t);for(let index=0;index<64;index++){const original={...f.original,request:{...f.original.request,requestId:`withdraw-${index}`}};await f.custody.resolveOriginal(resolution(original));}
 const bytes=await readFile(f.journal,'utf8'),extra={...f.original,request:{...f.original.request,requestId:'over-quota'}};await assert.rejects(f.custody.resolveOriginal(resolution(extra)),/QUOTA/);assert.equal(await readFile(f.journal,'utf8'),bytes);
 const first={...f.original,request:{...f.original.request,requestId:'withdraw-0'}};assert.equal((await f.custody.resolveOriginal(resolution(first))).idempotent,true);assert.equal(await readFile(f.journal,'utf8'),bytes);
});

test('corrupt withdrawal prevents current submitted proposal callback',async t=>{
 const f=await fixture(t),saved=await f.custody.submit(f.original),other={...f.original,request:{...f.original.request,requestId:'withdraw-other'}};await f.custody.resolveOriginal(resolution(other));const corrupt=(await readFile(f.journal,'utf8')).slice(0,-4);await writeFile(f.journal,corrupt);let calls=0;
 await assert.rejects(f.custody.withCurrentProposal({binding:f.binding,expectedHead:saved.observedHead},()=>{calls++;return 'not permitted';}),/WITHDRAWAL_CORRUPT/);assert.equal(calls,0);assert.equal(await readFile(f.journal,'utf8'),corrupt);
});

test('unsupported direct authority write colliding with withdrawal is detected across custody',async t=>{
 const f=await fixture(t);await f.custody.resolveOriginal(resolution(f.original));
 // Deliberately bypass the wrapper to construct contradictory valid journals.
 // This is a detection test, not a supported writer workflow.
 const direct=createTaskLedgerAuthorityStore({journalPath:f.submittedJournal,projectId:f.binding.projectId,rootIdentity:f.binding.rootIdentity});const submitted=await direct.propose(f.ledger,f.original.request),head={hostRevision:submitted.proposal.hostRevision,headDigest:submitted.proposal.recordHash};
 const withdrawalBytes=await readFile(f.journal,'utf8'),submittedBytes=await readFile(f.submittedJournal,'utf8');let calls=0;
 await assert.rejects(f.custody.inspect({binding:f.binding}),/WITHDRAWAL_CORRUPT/);await assert.rejects(f.custody.resolveOriginal(resolution(f.original)),/WITHDRAWAL_CORRUPT/);await assert.rejects(f.custody.withCurrentProposal({binding:f.binding,expectedHead:head},()=>{calls++;return 'not permitted';}),/WITHDRAWAL_CORRUPT/);assert.equal(calls,0);assert.equal(await readFile(f.journal,'utf8'),withdrawalBytes);assert.equal(await readFile(f.submittedJournal,'utf8'),submittedBytes);
});

test('oversized withdrawal bytes refuse without truncation or replacement',async t=>{
 const f=await fixture(t);await f.custody.resolveOriginal(resolution(f.original));const prefix=await readFile(f.journal);await truncate(f.journal,32*1024*1024+1);const before=await stat(f.journal);
 await assert.rejects(f.custody.inspect({binding:f.binding}),/WITHDRAWAL_QUOTA/);await assert.rejects(f.custody.resolveOriginal(resolution(f.original)),/WITHDRAWAL_QUOTA/);await assert.rejects(f.custody.submit(f.original),/WITHDRAWAL_QUOTA/);const after=await stat(f.journal);assert.equal(after.size,before.size);assert.equal(after.mtimeMs,before.mtimeMs);const handle=await open(f.journal,'r');try{const bytes=Buffer.alloc(prefix.length);await handle.read(bytes,0,bytes.length,0);assert.deepEqual(bytes,prefix);}finally{await handle.close();}
});
