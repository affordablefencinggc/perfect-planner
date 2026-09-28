import {validateTaskDraftBinding,validateTaskDraftLedger,sameTaskDraftBinding,TASK_DRAFT_BYTES} from '../project/taskDraftLedger.js';
import {submissionWire} from '../project/taskDraftSubmission.js';
const fail=()=>{throw Error('Shared plan could not be verified. Local drafts were not changed. Refresh and review again.');};
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const digest=async wire=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(wire)))].map(v=>v.toString(16).padStart(2,'0')).join('');
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
// Read into a separate value. No editor/store reference, mutation or submission.
export async function readSharedLedgerSnapshot(binding,readChunk){
 binding=structuredClone(validateTaskDraftBinding(binding));if(typeof readChunk!=='function')fail();
 const keys=['schemaVersion','binding','observedHead','ledgerDigest','snapshotDigest','encoding','offset','totalLength','nextOffset','chunk','approvalState','executionAuthorized','cleanupComplete'];
 let offset=0,first=null,wire='',bytes=0;
 for(let count=0;count<1024;count++){
  const part=structuredClone(await readChunk({offset,expectedHeadDigest:first?.observedHead.headDigest??null}));
  if(!exact(part,keys)||part.schemaVersion!==1||!exact(part.binding,['projectId','rootIdentity','censusDigest'])||!sameTaskDraftBinding(part.binding,binding)||part.cleanupComplete!==true||part.executionAuthorized!==false||part.approvalState!=='unapproved-proposal'||!exact(part.observedHead,['hostRevision','headDigest']))fail();
  const head=part.observedHead;
  if(!Number.isSafeInteger(head.hostRevision)||head.hostRevision<0||(head.hostRevision===0?head.headDigest!=='GENESIS':!hash(head.headDigest))||!hash(part.snapshotDigest)||(part.ledgerDigest!==null&&!hash(part.ledgerDigest))||part.encoding!=='json; offsets in UTF-16 code units; concatenate all chunks before parsing'||part.offset!==offset||!Number.isSafeInteger(part.totalLength)||part.totalLength<1||part.totalLength>TASK_DRAFT_BYTES||typeof part.chunk!=='string'||part.chunk.length<1||part.chunk.length>TASK_DRAFT_BYTES)fail();
  const end=offset+part.chunk.length;if(end>part.totalLength||part.nextOffset!==(end<part.totalLength?end:null))fail();
  if(first&&(submissionWire(head)!==submissionWire(first.observedHead)||part.snapshotDigest!==first.snapshotDigest||part.ledgerDigest!==first.ledgerDigest||part.totalLength!==first.totalLength))fail();
  first??=part;bytes+=new TextEncoder().encode(part.chunk).length;if(bytes>TASK_DRAFT_BYTES)fail();wire+=part.chunk;
  if(part.nextOffset===null){
   if(await digest(wire)!==first.snapshotDigest)fail();let ledger;try{ledger=JSON.parse(wire);}catch{fail();}
   if(ledger===null){if(head.hostRevision!==0||first.ledgerDigest!==null)fail();}
   else{ledger=validateTaskDraftLedger(ledger);if(head.hostRevision===0||!sameTaskDraftBinding(ledger.binding,binding)||await digest(submissionWire(ledger))!==first.ledgerDigest)fail();}
   return freeze({binding,observedHead:head,ledger,ledgerDigest:first.ledgerDigest,snapshotDigest:first.snapshotDigest,approvalState:'unapproved-proposal',executionAuthorized:false});
  }
  offset=part.nextOffset;
 }
 fail();
}
