import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

export const MAX_PROOF_ARTIFACT_BYTES=16*1024*1024;
export const MAX_RETAINED_INPUT_ARTIFACT_BYTES=32*1024*1024;
const fail=()=>{throw Error('PROOF_ARTIFACT_UNVERIFIED');};
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
const regular=s=>s.isFile()&&!s.isSymbolicLink()&&s.nlink===1n;
const samePath=(a,b)=>path.relative(path.toNamespacedPath(a),path.toNamespacedPath(b))==='';

// Host-selected file only. A stable bounded observation is not producer
// authentication, an exclusive lease or protection against hostile rollback.
async function readProofArtifact(artifactPath,collectBytes,limit=MAX_PROOF_ARTIFACT_BYTES){
 try{
  if(typeof artifactPath!=='string'||!path.isAbsolute(artifactPath))fail();
  const file=path.resolve(artifactPath),parents=[];
  for(let current=path.dirname(file);;){
   const stat=await lstat(current,{bigint:true});
   if(!stat.isDirectory()||stat.isSymbolicLink()||!samePath(current,await realpath(current)))fail();
   parents.push({path:current,stat});const next=path.dirname(current);if(next===current)break;current=next;
  }
  const before=await lstat(file,{bigint:true});
  if(!regular(before)||before.size<1n||before.size>BigInt(limit))fail();
  const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
  const chunks=[],digest=createHash('sha256');let length=0;
  try{
   const opened=await handle.stat({bigint:true});if(!regular(opened)||!same(before,opened))fail();
   const buffer=Buffer.alloc(65536);
   while(length<=Number(before.size)){
    const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,Number(before.size)+1-length),length);
    if(!bytesRead)break;length+=bytesRead;if(length>Number(before.size))fail();digest.update(buffer.subarray(0,bytesRead));if(collectBytes)chunks.push(Buffer.from(buffer.subarray(0,bytesRead)));
   }
   const after=await handle.stat({bigint:true}),named=await lstat(file,{bigint:true});
   if(length!==Number(before.size)||!regular(after)||!regular(named)||!same(before,after)||!same(before,named))fail();
   for(const parent of parents){const stat=await lstat(parent.path,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||stat.dev!==parent.stat.dev||stat.ino!==parent.stat.ino||!samePath(parent.path,await realpath(parent.path)))fail();}
  }finally{await handle.close();}
  return collectBytes?Buffer.concat(chunks,length):digest.digest('hex');
 }catch{fail();}
}

export async function readProofArtifactBytes(artifactPath){return readProofArtifact(artifactPath,true);}
// Separate host-owned input inventory only. Captured-output and ordinary proof
// limits stay at 16 MiB; callers cannot select an arbitrary larger allowance.
export async function readRetainedInputArtifactBytes(artifactPath){return readProofArtifact(artifactPath,true,MAX_RETAINED_INPUT_ARTIFACT_BYTES);}

export async function readProofArtifactDigest(artifactPath,expectedHash){
 if(typeof expectedHash!=='string'||!/^[a-f0-9]{64}$/.test(expectedHash))fail();
 const sha256=await readProofArtifact(artifactPath,false);
 return Object.freeze({valid:sha256===expectedHash,sha256});
}
