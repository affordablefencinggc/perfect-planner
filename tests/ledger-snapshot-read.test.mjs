import test from 'node:test';import assert from 'node:assert/strict';import os from 'node:os';import {createHash} from 'node:crypto';
import {createAgentLedgerReads} from '../src/node/proposalLedgerReads.mjs';
const binding={projectId:'pp_snapshot',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)};
const ledger={binding,revision:7,tasks:[{id:'T0001',title:'Archived task',archived:true,description:'😀'.repeat(2400)}]};
function fixture(){let value={schemaVersion:1,binding,observedHead:{hostRevision:2,headDigest:'c'.repeat(64)},ledger,ledgerDigest:'d'.repeat(64),registrationCurrent:true,approvalState:'unapproved-proposal',executionAuthorized:false};const reads=createAgentLedgerReads({submission:{readProposal:async()=>structuredClone(value),readRequestResult:async()=>{throw Error('not needed');}}});return {read:input=>reads.read('owner.readLedgerSnapshot',input,binding),change:next=>value={...value,...next}};}
test('full snapshot chunks preserve archived tasks, ledger identity and unicode without mutating a draft',async()=>{
 const f=fixture();let offset=0,head=null,wire='',digest;
 while(offset!==null){const r=await f.read({offset,expectedHeadDigest:head});assert.equal(r.offset,offset);assert.ok(Buffer.byteLength(r.chunk)<=1024*1024);assert.equal(r.nextOffset,null);assert.equal(r.executionAuthorized,false);assert.equal(r.approvalState,'unapproved-proposal');if(digest)assert.equal(r.snapshotDigest,digest);digest=r.snapshotDigest;head=r.observedHead.headDigest;wire+=r.chunk;offset=r.nextOffset;}
 assert.deepEqual(JSON.parse(wire),ledger);assert.equal(createHash('sha256').update(wire).digest('hex'),digest);
});
test('snapshot refuses mixed heads, foreign bindings and unbound continuation',async()=>{
 const f=fixture();await f.read({offset:0,expectedHeadDigest:null});f.change({observedHead:{hostRevision:3,headDigest:'e'.repeat(64)}});
 await assert.rejects(f.read({offset:2000,expectedHeadDigest:'c'.repeat(64)}),/STALE_HEAD/);
 await assert.rejects(f.read({offset:2000,expectedHeadDigest:null}),/INPUT/);
 f.change({binding:{...binding,projectId:'pp_foreign'}});await assert.rejects(f.read({offset:0,expectedHeadDigest:null}),/BINDING/);
});
test('empty authoritative proposal is null, never an invented empty ledger',async()=>{
 const f=fixture();f.change({ledger:null,ledgerDigest:null,observedHead:{hostRevision:0,headDigest:'GENESIS'}});const r=await f.read({offset:0,expectedHeadDigest:null});assert.equal(r.chunk,'null');assert.equal(r.nextOffset,null);assert.equal(r.ledgerDigest,null);
 await assert.rejects(f.read({offset:4,expectedHeadDigest:'GENESIS'}),/OFFSET/);
});
test('snapshot chunk boundary never sends a lone Unicode surrogate to native JSON',async()=>{
 const f=fixture();const value={text:''};const prefix=JSON.stringify(value).indexOf('""')+1;
 value.text='a'.repeat(1999-prefix)+'😀'+'z';f.change({ledger:value});
 const first=await f.read({offset:0,expectedHeadDigest:null});assert.equal(first.nextOffset,null);assert.deepEqual(JSON.parse(first.chunk),value);
 await assert.rejects(f.read({offset:2000,expectedHeadDigest:first.observedHead.headDigest}),/OFFSET/);
});
