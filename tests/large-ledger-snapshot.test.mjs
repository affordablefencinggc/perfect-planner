import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createAgentLedgerReads} from '../src/node/proposalLedgerReads.mjs';
import {createNativeReviewHostProtocol} from '../src/node/nativeReviewHostProtocol.mjs';
import {readSharedLedgerSnapshot} from '../src/native/sharedLedgerSnapshot.js';
import {emptyTaskDraftLedger,updateTaskDraft} from '../src/project/taskDraftLedger.js';
import {submissionWire} from '../src/project/taskDraftSubmission.js';
import {PassThrough,Writable} from 'node:stream';
import {createNativeReviewHostStream} from '../src/node/nativeReviewHostStream.mjs';
const binding={projectId:'pp_large_snapshot',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)};
const hash=v=>createHash('sha256').update(v).digest('hex');
const flow={inspectRecoveryState:async()=>({}),reviewProposal:async()=>({}),recoverFailedPresentation:async()=>({}),recoverInterruptedRequest:async()=>({}),cancelActiveReview:async()=>({})};
test('near-limit owner snapshot crosses protocol and renderer in one request with exact archived content',async()=>{
 let ledger=emptyTaskDraftLedger(binding);
 for(let i=0;i<110;i++)ledger=updateTaskDraft(ledger,{title:'Task '+i,description:'x'.repeat(7800),owner:'Worker',acceptance:'Compare exact bytes',recovery:'Keep original',claims:[],dependsOn:[],archived:i%2===0});
 assert.ok(Buffer.byteLength(JSON.stringify(ledger))>850000);
 const head={hostRevision:7,headDigest:'c'.repeat(64)};
 const owner=createAgentLedgerReads({submission:{readProposal:async()=>({binding,ledger,observedHead:head,ledgerDigest:hash(submissionWire(ledger)),registrationCurrent:true,approvalState:'unapproved-proposal',executionAuthorized:false}),readRequestResult:async()=>{throw Error('not used');}}});
 let reads=0,envelopeBytes=0;
 const protocol=createNativeReviewHostProtocol({flow,proposalReads:{read:async(_command,input)=>{reads++;return owner.read('owner.readLedgerSnapshot',input,binding);}}});
 const result=await readSharedLedgerSnapshot(binding,async payload=>{
   const input=new PassThrough();let received;
   const output=new Writable({write(chunk,_encoding,done){received=chunk.toString();done();}});
   const stream=createNativeReviewHostStream({input,output,protocol,shutdown:async()=>({cleanupComplete:true})});stream.start();
   const written=new Promise(resolve=>output.once('finish',resolve));
   // End output only after its actual write callback, not a timer or polling.
   const originalWrite=output._write.bind(output);output._write=(chunk,encoding,done)=>originalWrite(chunk,encoding,()=>{done();queueMicrotask(()=>output.end());});
   input.write(JSON.stringify({version:1,requestId:'large-snapshot-'+reads,command:'read-proposal-snapshot',payload})+'\n');
   await written;await stream.stop();const wire=received;
   envelopeBytes=Buffer.byteLength(wire);assert.ok(envelopeBytes>65536&&envelopeBytes<=protocol.limits.snapshotResponseBytes);
   const reply=JSON.parse(wire);assert.equal(reply.ok,true,wire.slice(0,300));
   return {...reply.result,cleanupComplete:true}; // Controlled native projection, not OS cleanup proof.
 });
 assert.equal(reads,1);assert.deepEqual(result.ledger,ledger);assert.equal(result.executionAuthorized,false);
});
test('owner refuses oversized source instead of using expanded transport as a bigger ledger allowance',async()=>{
 const owner=createAgentLedgerReads({submission:{readProposal:async()=>({binding,ledger:{text:'x'.repeat(1024*1024)},observedHead:{hostRevision:1,headDigest:'c'.repeat(64)},registrationCurrent:true,approvalState:'unapproved-proposal',executionAuthorized:false}),readRequestResult:async()=>{}}});
 await assert.rejects(owner.read('owner.readLedgerSnapshot',{offset:0,expectedHeadDigest:null},binding),/OFFSET/);
});
