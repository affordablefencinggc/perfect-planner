// One session's ordered checkpoint queue. Never infer that a failed write did
// not commit; reconcile its exact readback before retrying another version.
import {canonicalArchitectureJson as wire} from '../engine/architectureContractVerification.js';
export function createTaskFormSession(recovery,binding){
 let editorId=crypto.randomUUID(),revision=0,latest=null,ack=null,tail=Promise.resolve(),uncertain=null;
 function update(form,baseLedgerRevision){latest={form:structuredClone(form),baseLedgerRevision};}
 async function write(){
  if(uncertain){const found=await recovery.read(binding,editorId);if(found?.revision===uncertain.expectedRevision+1&&found.status==='unfinished'&&wire(found.form)===wire(uncertain.form)&&found.baseLedgerRevision===uncertain.baseLedgerRevision){revision=found.revision;ack={form:found.form,baseLedgerRevision:found.baseLedgerRevision};uncertain=null;}else if(!found||found.revision===revision)uncertain=null;else throw Error('Recovery checkpoint changed. Export your text and review the retained session.');}
  const snapshot=latest;if(!snapshot)return null;
  if(!ack||wire(snapshot)!==wire(ack)){const input={binding,editorId,expectedRevision:revision,...snapshot};uncertain=input;const saved=await recovery.put(input);revision=saved.revision;ack=snapshot;uncertain=null;}
  return {binding,editorId,revision,form:ack.form,baseLedgerRevision:ack.baseLedgerRevision};
 }
 function flush(){const next=tail.catch(()=>{}).then(write);tail=next;return next;}
 async function resolve(reason,checkpoint){checkpoint=checkpoint??await flush();if(!checkpoint)return;const found=await recovery.read(binding,editorId);if(found?.status==='resolved'&&found.revision===checkpoint.revision+1&&found.resolution===reason&&wire(found.form)===wire(checkpoint.form))return checkpoint;await recovery.resolve({binding,editorId,expectedRevision:checkpoint.revision,reason});return checkpoint;}
 return {update,flush,resolve,get editorId(){return editorId;}};
}
