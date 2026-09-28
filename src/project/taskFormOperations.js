import {validateTaskDraftBinding} from './taskDraftLedger.js';
// SPA coordination only, not durable recovery or proof of a failed transaction.
export function createTaskFormOperations(){
 const slots=new Map(),listeners=new Map();
 const key=binding=>{validateTaskDraftBinding(binding);return `${binding.projectId}:${binding.rootIdentity}:${binding.censusDigest}`;};
 const notify=id=>listeners.get(id)?.forEach(listener=>listener());
 return {
  read(binding){return slots.get(key(binding))??null;},
  subscribe(binding,listener){const id=key(binding);if(!listeners.has(id))listeners.set(id,new Set());listeners.get(id).add(listener);return()=>{listeners.get(id)?.delete(listener);if(!listeners.get(id)?.size)listeners.delete(id);};},
  begin(binding,payload){const id=key(binding);if(slots.has(id))throw Error('An editor operation still needs reconciliation.');const value=Object.freeze({...payload,token:crypto.randomUUID(),status:'pending'});slots.set(id,value);notify(id);return value;},
  update(binding,token,patch){const id=key(binding),old=slots.get(id);if(!old||old.token!==token)return false;slots.set(id,Object.freeze({...old,...patch,token:old.token}));notify(id);return true;},
  clear(binding,token){const id=key(binding);if(slots.get(id)?.token!==token)return false;slots.delete(id);notify(id);return true;},
 };
}
export const taskFormOperations=createTaskFormOperations();
