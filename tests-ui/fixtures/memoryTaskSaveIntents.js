import {vi} from 'vitest';
import {validateTaskSaveOriginal,validateTaskSaveIntent,sameTaskSaveRoot} from '../../src/project/taskFormSaveIntent.js';
import {canonicalArchitectureJson as wire} from '../../src/engine/architectureContractVerification.js';

// Explicit component-test adapter, not IndexedDB/atomicity qualification. The
// real browser-storage campaign tests transactions separately on DANS1.
export function withMemoryTaskSaveIntents(store){
 if(typeof store.prepareSaveIntent==='function')return store;
 const records=new Map(),history=new Map(),listeners=new Set();let tail=Promise.resolve();
 const serial=fn=>{const work=tail.catch(()=>{}).then(fn);tail=work;return work;};
 const read=(binding,id)=>{const row=records.get(id);if(row&&wire(row.original.binding)!==wire(binding))throw Error('Wrong Save binding');return row;};
 const put=row=>{validateTaskSaveIntent(row);records.set(row.original.requestId,structuredClone(row));listeners.forEach(fn=>fn());return structuredClone(row);};
 const subscribe=store.subscribe?.bind(store);
 store.subscribe=(binding,fn)=>{listeners.add(fn);const stop=subscribe?.(binding,fn);return()=>{listeners.delete(fn);stop?.();};};
 if(!store.readRevision)store.readRevision=vi.fn(async(_binding,revision)=>history.get(revision));
 store.listSaveIntents=vi.fn(async binding=>structuredClone([...records.values()].filter(row=>sameTaskSaveRoot(row.original.binding,binding))));
 store.readSaveIntent=vi.fn(async(binding,id)=>structuredClone(read(binding,id)??null));
 store.prepareSaveIntent=vi.fn(original=>{original=structuredClone(original);return serial(async()=>{
  validateTaskSaveOriginal(original);const prior=records.get(original.requestId);
  if(prior){if(wire(prior.original)!==wire(original))throw Error('Save request ID conflict');return structuredClone(prior);}
  if([...records.values()].some(row=>sameTaskSaveRoot(row.original.binding,original.binding)&&!row.acknowledgment))throw Error('Original Save needs reconciliation');
  if(wire(await store.read(original.binding))!==wire(original.baseLedger))throw Error('Another window saved a newer revision.');
  return put({schemaVersion:1,kind:'TASK_FORM_SAVE_INTENT',original,outcome:null,acknowledgment:null,executionAuthorized:false});
 });});
 store.commitSaveIntent=vi.fn((binding,id)=>serial(async()=>{
  const prior=read(binding,id);if(!prior)throw Error('Original Save is missing');
  if(prior.outcome?.kind==='withdrawn')throw Error('Original Save was withdrawn');
  if(prior.outcome)return structuredClone(prior);
  const ledger=await store.saveTask(binding,prior.original.baseLedger.revision,structuredClone(prior.original.taskInput));history.set(ledger.revision,structuredClone(ledger));
  return put({...prior,outcome:{kind:'committed',ledger}});
 }));
 store.withdrawSaveIntent=vi.fn((binding,id,original)=>{original=original===undefined?undefined:structuredClone(original);return serial(async()=>{const prior=read(binding,id);if(original){validateTaskSaveOriginal(original);if(original.requestId!==id||wire(original.binding)!==wire(binding))throw Error('Withdrawal identity differs');}if(prior){if(original&&wire(prior.original)!==wire(original))throw Error('Withdrawal original differs');return put(prior.outcome?prior:{...prior,outcome:{kind:'withdrawn'}});}if(!original)throw Error('Original Save missing');return put({schemaVersion:1,kind:'TASK_FORM_SAVE_INTENT',original,outcome:{kind:'withdrawn'},acknowledgment:null,executionAuthorized:false});});});
 store.acknowledgeSaveIntent=vi.fn((binding,id,evidence)=>serial(async()=>{const prior=read(binding,id);if(!prior)throw Error('Original Save missing');const acknowledgment={...structuredClone(evidence),declarationSource:'browser-declared'};if(prior.acknowledgment&&wire(prior.acknowledgment)!==wire(acknowledgment))throw Error('Acknowledgment conflict');return put({...prior,acknowledgment});}));
 return store;
}
