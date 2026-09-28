import path from 'node:path';
import {lstat,realpath,mkdir,mkdtemp,opendir,rmdir} from 'node:fs/promises';
import {withPlanLock} from './planLock.mjs';
const fail=()=>{throw Error('NATIVE_COMPILATION_SCRATCH_UNAVAILABLE');};
async function canonicalDirectory(dir){for(let p=dir;;){const s=await lstat(p);if(!s.isDirectory()||s.isSymbolicLink()||path.relative(p,await realpath(p))!=='')fail();const next=path.dirname(p);if(next===p)break;p=next;}}
// Bounded retained scratch inventory, not a disk-space reservation. Unexpected
// files remain available for diagnosis; never recursively delete compiler output.
export async function allocateCompilationTemp(root){
 if(typeof root!=='string'||!path.isAbsolute(root)||path.normalize(root)!==root||root.includes('\0'))fail();
 await canonicalDirectory(path.dirname(root));
 try{await mkdir(root);}catch(error){if(error.code!=='EEXIST')throw error;}
 await canonicalDirectory(root);
 return withPlanLock(`${root}.capacity`,{actor:'native-compilation-temp',timeoutMs:1000,retryMs:10},async()=>{
  await canonicalDirectory(root);let directories=0,files=0,bytes=0,nestedDirectories=0;
  async function inspectTree(directory,depth=0){
   if(depth>8)fail();await canonicalDirectory(directory);
   for await(const entry of await opendir(directory)){
    const child=path.join(directory,entry.name),info=await lstat(child);
    if(info.isSymbolicLink())fail();
    if(info.isDirectory()){if(++nestedDirectories>256)fail();await inspectTree(child,depth+1);}
    else if(!info.isFile()||info.nlink!==1||++files>256||(bytes+=info.size)>16*1024*1024)fail();
   }
   await canonicalDirectory(directory);
  }
  for await(const entry of await opendir(root)){
   if(++directories>=64)fail();const child=path.join(root,entry.name);await canonicalDirectory(child);
   await inspectTree(child);
  }
  const directory=await mkdtemp(path.join(root,'invocation-'));await canonicalDirectory(directory);
  const info=await lstat(directory);return {directory,dev:info.dev,ino:info.ino};
 });
}
export async function removeEmptyCompilationTemp(owned){
 if(!owned)return;
 try{await canonicalDirectory(owned.directory);const current=await lstat(owned.directory);if(current.dev!==owned.dev||current.ino!==owned.ino)return;await rmdir(owned.directory);}catch{/* Preserve nonempty, replaced or uncertain scratch. */}
}
