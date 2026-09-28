import path from 'node:path';
import {lstat,mkdir,realpath} from 'node:fs/promises';

// Host composition only. Never pass a request-selected path. These checks and
// single-directory creation reject existing links; they are not a filesystem
// lease against arbitrary changes by another process running as the same user.
export async function initializePlanningLedgerHostRoot(root){
 if(typeof root!=='string'||!path.isAbsolute(root)||path.normalize(root)!==root||path.dirname(root)===root)throw Error('PLANNING_LEDGER_HOST_ROOT_INVALID');
 const chain=[];for(let cursor=root;;cursor=path.dirname(cursor)){chain.unshift(cursor);if(path.dirname(cursor)===cursor)break;}
 const snapshots=[];
 async function check(name){const stat=await lstat(name);if(!stat.isDirectory()||stat.isSymbolicLink()||path.relative(name,await realpath(name)))throw Error('PLANNING_LEDGER_HOST_ROOT_UNSAFE');return {name,ino:stat.ino,dev:stat.dev};}
 async function verify(){for(const previous of snapshots){const current=await check(previous.name);if(current.ino!==previous.ino||current.dev!==previous.dev)throw Error('PLANNING_LEDGER_HOST_ROOT_CHANGED');}}
 for(const name of chain){
  await verify();
  try{snapshots.push(await check(name));}
  catch(error){if(error.code!=='ENOENT')throw error;await verify();try{await mkdir(name);}catch(createError){if(createError.code!=='EEXIST')throw createError;}snapshots.push(await check(name));}
 }
 await verify();return root;
}
