import path from 'node:path';
import {open,lstat,realpath,mkdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {runBoundedProcess} from './guardedGitRunner.mjs';
import {allocateCompilationTemp,removeEmptyCompilationTemp} from './nativeCompilationScratch.mjs';

const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const token=value=>typeof value==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(value);
const fail=code=>{throw Error(code);};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const bytesHash=value=>createHash('sha256').update(value).digest('hex');
async function safeDirectories(directory){
 for(let current=directory;;current=path.dirname(current)){
  const info=await lstat(current);if(!info.isDirectory()||info.isSymbolicLink()||path.relative(current,await realpath(current))!=='')fail('NATIVE_PRESENTER_CLOSURE_STORAGE_UNSAFE');
  if(path.dirname(current)===current)break;
 }
}
async function closurePath(directory,requestId,create){
 if(!token(requestId))fail('NATIVE_PRESENTER_DISPLAY_INVALID');
 await safeDirectories(path.dirname(directory));
 if(create){try{await mkdir(directory);}catch(error){if(error.code!=='EEXIST')throw error;}}
 await safeDirectories(directory);return path.join(directory,bytesHash(requestId)+'.json');
}
async function readClosure(directory,requestId,executableDigest){
 if(!directory)return null;
 let file;try{file=await closurePath(directory,requestId,false);}catch(error){if(error.code==='ENOENT')return null;throw error;}
 let info;try{info=await lstat(file,{bigint:true});}catch(error){if(error.code==='ENOENT')return null;throw error;}
 if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1n||info.size===0n||info.size>4096n)fail('NATIVE_PRESENTER_CLOSURE_STORAGE_UNSAFE');
 const handle=await open(file,'r');let text;
 const same=value=>['dev','ino','size','mtimeNs','ctimeNs'].every(key=>value[key]===info[key]);
 try{
  if(!same(await handle.stat({bigint:true})))fail('NATIVE_PRESENTER_CLOSURE_STORAGE_CHANGED');
  const buffer=Buffer.alloc(Number(info.size)+1);let offset=0;
  while(offset<buffer.length){const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,null);if(!bytesRead)break;offset+=bytesRead;}
  if(offset!==Number(info.size)||!same(await handle.stat({bigint:true}))||!same(await lstat(file,{bigint:true})))fail('NATIVE_PRESENTER_CLOSURE_STORAGE_CHANGED');
  text=buffer.subarray(0,offset).toString('utf8');
 }finally{await handle.close();}
 await safeDirectories(directory);
 let value;try{value=JSON.parse(text);}catch{fail('NATIVE_PRESENTER_CLOSURE_STORAGE_INVALID');}
 if(!exact(value,['schemaVersion','executableDigest','receipt','cleanupComplete','recordDigest']))fail('NATIVE_PRESENTER_CLOSURE_STORAGE_INVALID');
 const {recordDigest,...body}=value,r=value.receipt;
 if(value.schemaVersion!==1||value.executableDigest!==executableDigest||value.cleanupComplete!==true||recordDigest!==bytesHash(JSON.stringify(body))
  ||!exact(r,['version','requestId','proposalDigest','checkContractDigest','displayDigest','instanceId','decision','destroyed','humanVerified'])||r.version!==1||r.requestId!==requestId||![r.proposalDigest,r.checkContractDigest,r.displayDigest].every(digest)||!token(r.instanceId)||!['approved','rejected','cancelled'].includes(r.decision)||r.destroyed!==true||r.humanVerified!==false)fail('NATIVE_PRESENTER_CLOSURE_STORAGE_INVALID');
 return Object.freeze(r);
}
async function retainClosure(directory,receipt,executableDigest){
 if(!directory)return;
 const file=await closurePath(directory,receipt.requestId,true),body={schemaVersion:1,executableDigest,receipt,cleanupComplete:true};
 const data=JSON.stringify({...body,recordDigest:bytesHash(JSON.stringify(body))});
 if(Buffer.byteLength(data)>4096)fail('NATIVE_PRESENTER_CLOSURE_STORAGE_INVALID');
 const handle=await open(file,'wx',0o600);
 try{await handle.writeFile(data);await handle.sync();if((await handle.stat()).nlink!==1)fail('NATIVE_PRESENTER_CLOSURE_STORAGE_UNSAFE');}finally{await handle.close();}
 if(JSON.stringify(await readClosure(directory,receipt.requestId,executableDigest))!==JSON.stringify(receipt))fail('NATIVE_PRESENTER_CLOSURE_STORAGE_CHANGED');
}
async function verifyFile(file,expected){
 const before=await lstat(file);
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>128*1024*1024||path.relative(file,await realpath(file))!=='')fail('NATIVE_PRESENTER_RESOURCE_INVALID');
 const handle=await open(file,'r');
 try{
  const opened=await handle.stat();
  if(opened.ino!==before.ino||opened.dev!==before.dev)fail('NATIVE_PRESENTER_RESOURCE_CHANGED');
  const hash=createHash('sha256'),buffer=Buffer.alloc(65536);let count=0;
  for(;;){const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;count+=bytesRead;if(count>before.size)fail('NATIVE_PRESENTER_RESOURCE_CHANGED');hash.update(buffer.subarray(0,bytesRead));}
  const after=await lstat(file);
  if(count!==before.size||['ino','dev','size','mtimeMs','ctimeMs'].some(key=>after[key]!==before[key])||hash.digest('hex')!==expected)fail('NATIVE_PRESENTER_RESOURCE_CHANGED');
 }finally{await handle.close();}
}

// Factory configuration belongs to the installed host, never renderer/MCP data.
// Hash checks do not establish an exclusive filesystem lease. Packaged resource
// ownership must additionally prevent replacement between verification/launch.
export function createNativeReviewPresenterAdapter({executable,executableDigest,cwd,compilationTempRoot,closureDirectory,execute=runBoundedProcess,timeoutMs=120000}){
 if(closureDirectory!==undefined&&(typeof closureDirectory!=='string'||!path.isAbsolute(closureDirectory)||path.normalize(closureDirectory)!==closureDirectory||closureDirectory.includes('\0')))fail('NATIVE_PRESENTER_CONFIG_INVALID');
 if(typeof compilationTempRoot!=='string'||!path.isAbsolute(compilationTempRoot)||path.normalize(compilationTempRoot)!==compilationTempRoot||compilationTempRoot.includes('\0'))fail('NATIVE_PRESENTER_CONFIG_INVALID');
 if(typeof executable!=='string'||!path.isAbsolute(executable)||path.resolve(executable)!==executable||!digest(executableDigest)||typeof cwd!=='string'||!path.isAbsolute(cwd)||path.resolve(cwd)!==cwd||typeof execute!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)fail('NATIVE_PRESENTER_CONFIG_INVALID');
 let busy=false,unresolved=false;const records=new Map(),closures=new Map(),attempted=new Set();
 return Object.freeze({
  async presentNativeReview(display,{signal}={}){
   if(busy)fail('NATIVE_PRESENTER_BUSY');
   if(unresolved)fail('NATIVE_PRESENTER_CLOSURE_UNCONFIRMED');
   if(attempted.size>=128)fail('NATIVE_PRESENTER_SESSION_LIMIT');
   busy=true;let scratch,cleanupProven=false;
   try{
    const content=JSON.stringify(display);
    if(typeof content!=='string'||Buffer.byteLength(content)>2*1024*1024||!token(display?.requestId)||!digest(display?.subject?.proposalDigest)||!digest(display?.subject?.checkContractDigest))fail('NATIVE_PRESENTER_DISPLAY_INVALID');
    const requestId=display.requestId,proposalDigest=display.subject.proposalDigest,checkContractDigest=display.subject.checkContractDigest;
    if(attempted.has(requestId))fail('NATIVE_PRESENTER_REQUEST_REUSED');
    if(await readClosure(closureDirectory,requestId,executableDigest))fail('NATIVE_PRESENTER_REQUEST_REUSED');
    const displayDigest=createHash('sha256').update(content).digest('hex');
    if(path.relative(cwd,await realpath(cwd))!==''||!(await lstat(cwd)).isDirectory())fail('NATIVE_PRESENTER_DIRECTORY_INVALID');
    await verifyFile(executable,executableDigest);
    // Pre-launch capacity failure must not claim a window was attempted.
    scratch=await allocateCompilationTemp(compilationTempRoot);
    // From launch onward a missing receipt is unresolved, even when process
    // cleanup reports success. Only exact window destruction clears this latch.
    attempted.add(requestId);unresolved=true;
    const result=await execute(executable,['--presenter'],{cwd,env:{SystemRoot:'C:\\Windows',WINDIR:'C:\\Windows',TEMP:scratch.directory,TMP:scratch.directory},timeoutMs,maxBytes:16384,signal,input:JSON.stringify({version:1,requestId,proposalDigest,checkContractDigest,displayDigest,content})});
    cleanupProven=result?.cleanupComplete===true;
    if(result?.cleanupComplete!==true)throw Object.assign(Error('NATIVE_PRESENTER_CLEANUP_UNCERTAIN'),{cleanupComplete:false});
    if(result.exit!==0||result.reason||result.outputComplete!==true||typeof result.stdout!=='string'||Buffer.byteLength(result.stdout)>16384)fail('NATIVE_PRESENTER_PROCESS_FAILED');
    let receipt;try{receipt=JSON.parse(result.stdout);}catch{fail('NATIVE_PRESENTER_RECEIPT_INVALID');}
    if(!exact(receipt,['version','requestId','proposalDigest','checkContractDigest','displayDigest','instanceId','decision','destroyed','humanVerified'])||receipt.version!==1||receipt.requestId!==requestId||receipt.proposalDigest!==proposalDigest||receipt.checkContractDigest!==checkContractDigest||receipt.displayDigest!==displayDigest||!token(receipt.instanceId)||!['approved','rejected','cancelled'].includes(receipt.decision)||receipt.destroyed!==true||receipt.humanVerified!==false)fail('NATIVE_PRESENTER_RECEIPT_INVALID');
    await retainClosure(closureDirectory,receipt,executableDigest);
    closures.set(requestId,Object.freeze({...receipt}));
    unresolved=false;
    if(signal?.aborted||receipt.decision==='cancelled')return Object.freeze({decision:'cancelled'});
    const evidence=randomUUID();
    records.set(evidence,Object.freeze({requestId,displayDigest,decision:receipt.decision,eventId:receipt.instanceId,occurredAt:new Date().toISOString()}));
    return Object.freeze({decision:receipt.decision,rationale:'Decision received from the host-owned review window.',decisionEvidence:evidence});
   }finally{if(cleanupProven)await removeEmptyCompilationTemp(scratch);busy=false;}
  },
  async verifyNativeDecision(query){
   const record=records.get(query?.evidence);
   if(!record||['requestId','displayDigest','decision'].some(key=>query[key]!==record[key]))return {trusted:false};
   return Object.freeze({...record,trusted:true});
  },
  async verifyPresentationClosed(binding){
   const record=closures.get(binding?.requestId)??await readClosure(closureDirectory,binding?.requestId,executableDigest);
   return Object.freeze({requestId:binding?.requestId,closed:!!record&&record.proposalDigest===binding.proposalDigest&&record.checkContractDigest===binding.checkContractDigest});
  }
 });
}

