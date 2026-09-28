import {createHash} from 'node:crypto';
import {lstat,realpath,open} from 'node:fs/promises';
import path from 'node:path';
import {verifyTaskCheckContract} from './taskCheckContract.mjs';

const fail=()=>{throw Error('TASK_CHECK_FILES_UNVERIFIED');};
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
const spelling=value=>process.platform==='win32'?value.toLowerCase():value;
async function directories(target){
 const chain=[];
 for(let current=target;;current=path.dirname(current)){
  const stat=await lstat(current,{bigint:true});
  if(!stat.isDirectory()||stat.isSymbolicLink()||spelling(await realpath(current))!==spelling(current))fail();
  chain.push({path:current,dev:stat.dev,ino:stat.ino});
  if(path.dirname(current)===current)break;
 }
 return chain;
}
async function recheck(chain){
 for(const entry of chain){const stat=await lstat(entry.path,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||stat.dev!==entry.dev||stat.ino!==entry.ino||spelling(await realpath(entry.path))!==spelling(entry.path))fail();}
}

// Host-only observation. This detects ordinary replacement during this read,
// but is not an exclusive filesystem lease or an OS execute-by-handle binding.
// The broker must separately verify candidate contents, approval, enrollment,
// policy and a durable grant; it cannot turn this snapshot into launch authority.
export async function inspectTaskCheckFiles({checkContract,taskId,checkId,registeredRoot}){
 const contract=verifyTaskCheckContract(checkContract);
 const check=contract.tasks.find(task=>task.taskId===taskId)?.checks.find(item=>item.checkId===checkId);
 if(!check||typeof registeredRoot!=='string'||!path.isAbsolute(registeredRoot)||path.normalize(registeredRoot)!==registeredRoot)fail();
 const cwd=path.resolve(registeredRoot,check.cwd);
 const relative=path.relative(registeredRoot,cwd);
 if(relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))fail();
 const cwdChain=await directories(cwd),executableChain=await directories(path.dirname(check.executablePath));
 const before=await lstat(check.executablePath,{bigint:true});
 const maxBytes=256n*1024n*1024n;
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size<1n||before.size>maxBytes)fail();
 const handle=await open(check.executablePath,'r');
 const hash=createHash('sha256');let bytes=0n;
 try{
  if(!same(before,await handle.stat({bigint:true})))fail();
  const buffer=Buffer.alloc(64*1024);
  for(;;){const result=await handle.read(buffer,0,buffer.length,null);if(!result.bytesRead)break;bytes+=BigInt(result.bytesRead);if(bytes>before.size)fail();hash.update(buffer.subarray(0,result.bytesRead));}
  if(bytes!==before.size||!same(before,await handle.stat({bigint:true})))fail();
 }finally{await handle.close();}
 const after=await lstat(check.executablePath,{bigint:true});
 if(after.isSymbolicLink()||after.nlink!==1n||!same(before,after))fail();
 await recheck(cwdChain);await recheck(executableChain);
 const executableDigest=hash.digest('hex');if(executableDigest!==check.executableDigest)fail();
 return Object.freeze({contractDigest:contract.contractDigest,taskId,checkId,cwd,executablePath:check.executablePath,executableDigest,executableBytes:Number(bytes),observedAt:new Date().toISOString(),candidateVerified:false,executionAuthorized:false});
}
