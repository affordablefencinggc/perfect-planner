import path from 'node:path';
import {lstat,mkdir,realpath} from 'node:fs/promises';

// Host composition only. Never pass a request-selected path. These checks and
// single-directory creation reject existing links; they are not a filesystem
// lease against arbitrary changes by another process running as the same user.
const chainOf=root=>{const chain=[];for(let cursor=root;;cursor=path.dirname(cursor)){chain.unshift(cursor);if(path.dirname(cursor)===cursor)break;}return chain;};
const unsafe=()=>Error('PLANNING_LEDGER_HOST_ROOT_UNSAFE');
// Canonicalize once. OS redirection that is not a link (e.g. MSIX LocalAppData
// virtualization, where realpath names the package LocalCache) is accepted;
// any symlink/junction in the requested chain is still refused, and the
// requested deepest existing directory must be the same object as its
// canonical form, observed before and after resolution.
async function canonicalize(root){
 const seen=[];
 for(const name of chainOf(root)){let stat;try{stat=await lstat(name);}catch(error){if(error.code==='ENOENT')break;throw error;}if(!stat.isDirectory()||stat.isSymbolicLink())throw unsafe();seen.push({name,ino:stat.ino,dev:stat.dev});}
 const deepest=seen.at(-1);if(!deepest)throw unsafe();
 const canonical=await realpath(deepest.name),target=await lstat(canonical);
 if(!target.isDirectory()||target.isSymbolicLink()||target.ino!==deepest.ino||target.dev!==deepest.dev)throw unsafe();
 for(const previous of seen){const stat=await lstat(previous.name);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.ino!==previous.ino||stat.dev!==previous.dev)throw Error('PLANNING_LEDGER_HOST_ROOT_CHANGED');}
 return path.join(canonical,path.relative(deepest.name,root));
}

// Returns the canonical root; callers should use it for all later access.
export async function initializePlanningLedgerHostRoot(requested){
 if(typeof requested!=='string'||!path.isAbsolute(requested)||path.normalize(requested)!==requested||path.dirname(requested)===requested)throw Error('PLANNING_LEDGER_HOST_ROOT_INVALID');
 const root=await canonicalize(requested);
 if(!path.isAbsolute(root)||path.normalize(root)!==root||path.dirname(root)===root)throw unsafe();
 const chain=chainOf(root);
 const snapshots=[];
 async function check(name){const stat=await lstat(name);if(!stat.isDirectory()||stat.isSymbolicLink()||path.relative(name,await realpath(name)))throw unsafe();return {name,ino:stat.ino,dev:stat.dev};}
 async function verify(){for(const previous of snapshots){const current=await check(previous.name);if(current.ino!==previous.ino||current.dev!==previous.dev)throw Error('PLANNING_LEDGER_HOST_ROOT_CHANGED');}}
 for(const name of chain){
  await verify();
  try{snapshots.push(await check(name));}
  catch(error){if(error.code!=='ENOENT')throw error;await verify();try{await mkdir(name);}catch(createError){if(createError.code!=='EEXIST')throw createError;}snapshots.push(await check(name));}
 }
 await verify();return root;
}
