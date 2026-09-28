import {validateTaskDraftLedger,updateTaskDraft} from './taskDraftLedger.js';
import {canonicalArchitectureJson as wire} from '../engine/architectureContractVerification.js';

export async function reviewFailedTaskSave(operation,binding){
 binding=structuredClone(binding);const taskInput=structuredClone(operation.taskInput),dispatched=operation.dispatched,store=operation.store;
 const base=validateTaskDraftLedger(structuredClone(operation.baseLedger));
 if(wire(base.binding)!==wire(binding))throw Error('Operation binding changed. Keep your text.');
 const current=validateTaskDraftLedger(await store.read(binding));
 if(wire(current.binding)!==wire(binding)||current.revision<base.revision)throw Error('Current draft cannot be compared with the operation. Keep your text.');
 if(!dispatched)return {outcome:'not-dispatched',current};
 if(current.revision===base.revision){if(wire(current)!==wire(base))throw Error('Draft revision content changed. Keep your text.');return {outcome:'unchanged',current};}
 const candidate=validateTaskDraftLedger(await store.readRevision(binding,base.revision+1));
 const expected=updateTaskDraft(base,taskInput,candidate.updatedAt);
 if(wire(candidate)!==wire(expected))return {outcome:'different-successor',current};
 return {outcome:'saved',current,savedLedger:candidate};
}
