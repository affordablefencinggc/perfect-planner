import { inspectArchitecture } from '../runtime/architectureClient.js';

// Browser summary cache only. The server remains the publication authority.
export function createArchitectureRefresh({registry,recordStatus}) {
 const sequences=new Map();let disposed=false;
 function invalidate(projectId){sequences.set(projectId,(sequences.get(projectId)??0)+1);}
 async function refresh(projectId){
  const project=registry.get(projectId);
  if(disposed||!project||project.kind!=='imported'||!project.registration)return null;
  const rootIdentity=project.registration.rootIdentity;
  const sequence=(sequences.get(projectId)??0)+1;sequences.set(projectId,sequence);
  const current=()=>!disposed&&sequences.get(projectId)===sequence&&registry.get(projectId)?.registration?.rootIdentity===rootIdentity;
  try{const result=recordStatus(projectId,{state:'stale',expectedRootIdentity:rootIdentity,reason:'architecture-refresh-pending'});if(result?.persisted===false)return {status:'local-cache-unavailable'};}catch{return {status:'local-cache-unavailable'};}
  try{
   const receipt=await inspectArchitecture(projectId);
   if(!current())return null;
   if(receipt?.valid!==true||receipt.planId!==projectId)throw Error('Invalid architecture observation');
   try{const result=recordStatus(projectId,{state:'observed',expectedRootIdentity:rootIdentity,receipt,reason:'architecture-refreshed'});if(result?.persisted===false)return {status:'local-cache-unavailable'};}catch{return {status:'local-cache-unavailable'};}
   return {status:'observed',receipt};
  }catch{
   if(!current())return null;
   try{const result=recordStatus(projectId,{state:'unavailable',expectedRootIdentity:rootIdentity,reason:'architecture-refresh-unavailable'});if(result?.persisted===false)return {status:'local-cache-unavailable'};}catch{return {status:'local-cache-unavailable'};}
   return {status:'unavailable'};
  }
 }
 return {refresh,invalidate,dispose(){disposed=true;sequences.clear();}};
}
