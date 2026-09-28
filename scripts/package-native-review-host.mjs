import {constants} from 'node:fs';
import {lstat,realpath,mkdir,open} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

// Build-time copy only. Inputs/pins come from the trusted build definition, not
// repository intake. A matching hash is not publisher authentication or safety.
// No execution, downloading, PATH lookup, overwrite, or cleanup is performed.
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const spelling=value=>process.platform==='win32'?value.toLowerCase():value;
const identity=(a,b)=>['dev','ino','size','mtimeNs','ctimeNs'].every(key=>a[key]===b[key]);
async function directories(directory){
  const chain=[];let current=directory;
  while(true){chain.push(current);const parent=path.dirname(current);if(parent===current)break;current=parent;}
  for(const entry of chain.reverse()){
    const info=await lstat(entry);if(!info.isDirectory()||info.isSymbolicLink()||spelling(await realpath(entry))!==spelling(entry))throw Error('PACKAGE_DIRECTORY_UNSAFE');
  }
}
function absolute(value){if(typeof value!=='string'||!path.isAbsolute(value)||path.normalize(value)!==value||value.includes('\0'))throw Error('PACKAGE_PATH_INVALID');return value;}
function input(value){if(!exact(value,['sourcePath','sha256'])||!hash(value.sha256))throw Error('PACKAGE_INPUT_INVALID');return {sourcePath:absolute(value.sourcePath),sha256:value.sha256};}
async function copyPinned(source,destination,limit){
  await directories(path.dirname(source.sourcePath));await directories(path.dirname(destination));
  const before=await lstat(source.sourcePath,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink()||before.size>BigInt(limit)||spelling(await realpath(source.sourcePath))!==spelling(source.sourcePath))throw Error('PACKAGE_SOURCE_UNSAFE');
  // Cargo may hard-link its build artifact. Reading and independently copying
  // pinned bytes is allowed; the destination must be a new single-link file.
  const reader=await open(source.sourcePath,constants.O_RDONLY|(constants.O_NOFOLLOW??0));let writer;
  try{
    if(!identity(before,await reader.stat({bigint:true})))throw Error('PACKAGE_SOURCE_CHANGED');
    writer=await open(destination,'wx',0o600);
    const digest=createHash('sha256'),buffer=Buffer.alloc(65536);let bytes=0;
    while(true){const read=await reader.read(buffer,0,buffer.length,null);if(!read.bytesRead)break;bytes+=read.bytesRead;if(bytes>limit||BigInt(bytes)>before.size)throw Error('PACKAGE_SOURCE_CHANGED');const block=buffer.subarray(0,read.bytesRead);digest.update(block);let offset=0;while(offset<block.length){const written=await writer.write(block,offset,block.length-offset,null);if(!written.bytesWritten)throw Error('PACKAGE_WRITE_FAILED');offset+=written.bytesWritten;}}
    const after=await lstat(source.sourcePath,{bigint:true});
    if(!identity(before,after)||!identity(before,await reader.stat({bigint:true}))||BigInt(bytes)!==before.size||spelling(await realpath(source.sourcePath))!==spelling(source.sourcePath))throw Error('PACKAGE_SOURCE_CHANGED');
    if(digest.digest('hex')!==source.sha256)throw Error('PACKAGE_PIN_MISMATCH');
    await writer.sync();
    const output=await writer.stat({bigint:true});if(output.nlink!==1n||output.size!==before.size)throw Error('PACKAGE_OUTPUT_UNSAFE');
    return bytes;
  }finally{try{await writer?.close();}finally{await reader.close();}}
}
async function verify(destination,expected,bytes){
  await directories(path.dirname(destination));
  const handle=await open(destination,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{const before=await handle.stat({bigint:true});if(!before.isFile()||before.nlink!==1n||before.size!==BigInt(bytes))throw Error('PACKAGE_OUTPUT_UNSAFE');const digest=createHash('sha256'),buffer=Buffer.alloc(65536);let count=0;while(true){const read=await handle.read(buffer,0,buffer.length,null);if(!read.bytesRead)break;count+=read.bytesRead;if(count>bytes)throw Error('PACKAGE_OUTPUT_CHANGED');digest.update(buffer.subarray(0,read.bytesRead));}if(count!==bytes||digest.digest('hex')!==expected||!identity(before,await handle.stat({bigint:true}))||!identity(before,await lstat(destination,{bigint:true})))throw Error('PACKAGE_OUTPUT_CHANGED');}finally{await handle.close();}
}
export async function packageNativeReviewHost(config){
  config=structuredClone(config);
  const keys=['outputDir','hostExecutable','nodeExecutable','modules'];
  if(config&&Object.hasOwn(config,'agentHelperExecutable'))keys.push('agentHelperExecutable');
  if(!exact(config,keys)||!Array.isArray(config.modules)||config.modules.length<1||config.modules.length>512)throw Error('PACKAGE_CONFIG_INVALID');
  const outputDir=absolute(config.outputDir);
  const entries=[{...input(config.hostExecutable),relativePath:'native/native-review.exe',limit:128*1024*1024},{...input(config.nodeExecutable),relativePath:'runtime/node.exe',limit:128*1024*1024}];
  if(Object.hasOwn(config,'agentHelperExecutable'))entries.push({...input(config.agentHelperExecutable),relativePath:'native/planner-agent-helper.exe',limit:128*1024*1024});
  const names=new Set();
  for(const module of config.modules){
    if(!exact(module,['sourcePath','relativePath','sha256'])||typeof module.relativePath!=='string'||module.relativePath.length>240||!module.relativePath.split('/').every(part=>/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(part)&&!/[. ]$/.test(part)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))||! /\.(mjs|js|json)$/.test(module.relativePath))throw Error('PACKAGE_MODULE_INVALID');
    const relativePath='host/'+module.relativePath,key=relativePath.toLowerCase();if(names.has(key))throw Error('PACKAGE_DUPLICATE_MODULE');names.add(key);entries.push({...input({sourcePath:module.sourcePath,sha256:module.sha256}),relativePath,limit:8*1024*1024});
  }
  await directories(path.dirname(outputDir));
  // Exclusive root creation: preserve any pre-existing package or user work.
  await mkdir(outputDir);
  const manifest=[];let total=0;
  for(const entry of entries){
    const segments=entry.relativePath.split('/');let directory=outputDir;
    for(const segment of segments.slice(0,-1)){directory=path.join(directory,segment);try{await mkdir(directory);}catch(error){if(error.code!=='EEXIST')throw error;}await directories(directory);}
    const destination=path.join(outputDir,...segments);
    const bytes=await copyPinned(entry,destination,entry.limit);total+=bytes;if(total>512*1024*1024)throw Error('PACKAGE_TOTAL_LIMIT');
    await verify(destination,entry.sha256,bytes);manifest.push({path:entry.relativePath,sha256:entry.sha256,bytes});
  }
  // Recheck every file before publishing the manifest. No claim of an atomic
  // lease against hostile same-user writes after this observation.
  for(const entry of manifest)await verify(path.join(outputDir,...entry.path.split('/')),entry.sha256,entry.bytes);
  const result={schemaVersion:1,kind:'NATIVE_REVIEW_HOST_PACKAGE',files:manifest,totalBytes:total,executionAuthorized:false,publisherVerified:false};
  const file=await open(path.join(outputDir,'manifest.json'),'wx',0o600);try{await file.writeFile(JSON.stringify(result,null,2)+'\n');await file.sync();}finally{await file.close();}
  return result;
}
