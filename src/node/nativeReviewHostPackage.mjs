import {constants} from 'node:fs';
import {lstat,realpath,open} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

// The expected digest belongs to the installed host/build, never repository or
// renderer input. This verifies bytes; it neither authenticates a publisher nor
// holds an exclusive lease against subsequent same-user filesystem changes.
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const spelling=v=>process.platform==='win32'?v.toLowerCase():v;
const same=(a,b)=>['dev','ino','size','mtimeNs','ctimeNs'].every(k=>a[k]===b[k]);
async function directoryChain(dir){
  const entries=[];for(let p=dir;;){entries.push(p);const next=path.dirname(p);if(next===p)break;p=next;}
  for(const p of entries){const s=await lstat(p);if(!s.isDirectory()||s.isSymbolicLink()||spelling(await realpath(p))!==spelling(p))throw Error('HOST_PACKAGE_DIRECTORY_UNSAFE');}
}
async function pinnedFile(file,pin,limit,expectedBytes,collect=false){
  await directoryChain(path.dirname(file));
  const before=await lstat(file,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>BigInt(limit)||(expectedBytes!==undefined&&before.size!==BigInt(expectedBytes))||spelling(await realpath(file))!==spelling(file))throw Error('HOST_PACKAGE_FILE_UNSAFE');
  const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
    if(!same(before,await handle.stat({bigint:true})))throw Error('HOST_PACKAGE_CHANGED');
    const digest=createHash('sha256'),buffer=Buffer.alloc(65536),chunks=[];let count=0;
    while(true){const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;count+=bytesRead;if(count>limit||BigInt(count)>before.size)throw Error('HOST_PACKAGE_CHANGED');const bytes=buffer.subarray(0,bytesRead);digest.update(bytes);if(collect)chunks.push(Buffer.from(bytes));}
    if(BigInt(count)!==before.size||digest.digest('hex')!==pin||!same(before,await handle.stat({bigint:true}))||!same(before,await lstat(file,{bigint:true}))||spelling(await realpath(file))!==spelling(file))throw Error('HOST_PACKAGE_PIN_MISMATCH');
    return collect?Buffer.concat(chunks).toString('utf8'):undefined;
  }finally{await handle.close();}
}
function validModule(p){return p.startsWith('host/')&&p.length<=245&&/\.(mjs|js|json)$/.test(p)&&p.split('/').every(s=>/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(s)&&!/[. ]$/.test(s)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s));}
export async function verifyNativeReviewHostPackage(config){
  if(!exact(config,['packageRoot','manifestDigest'])||typeof config.packageRoot!=='string'||!path.isAbsolute(config.packageRoot)||path.normalize(config.packageRoot)!==config.packageRoot||config.packageRoot.includes('\0')||!hash(config.manifestDigest))throw Error('HOST_PACKAGE_CONFIG_INVALID');
  const {packageRoot,manifestDigest}=config;
  const manifestPath=path.join(packageRoot,'manifest.json');
  const raw=await pinnedFile(manifestPath,manifestDigest,256*1024,undefined,true);
  let manifest;try{manifest=JSON.parse(raw);}catch{throw Error('HOST_PACKAGE_MANIFEST_INVALID');}
  if(!exact(manifest,['schemaVersion','kind','files','totalBytes','executionAuthorized','publisherVerified'])||manifest.schemaVersion!==1||manifest.kind!=='NATIVE_REVIEW_HOST_PACKAGE'||manifest.executionAuthorized!==false||manifest.publisherVerified!==false||!Array.isArray(manifest.files)||manifest.files.length<3||manifest.files.length>515||!Number.isSafeInteger(manifest.totalBytes)||manifest.totalBytes<0||manifest.totalBytes>512*1024*1024)throw Error('HOST_PACKAGE_MANIFEST_INVALID');
  const names=new Set();let total=0;
  for(const f of manifest.files){
    if(!exact(f,['path','sha256','bytes'])||typeof f.path!=='string'||!hash(f.sha256)||!Number.isSafeInteger(f.bytes)||f.bytes<0)throw Error('HOST_PACKAGE_MANIFEST_INVALID');
    const executable=['native/native-review.exe','runtime/node.exe','native/planner-agent-helper.exe'].includes(f.path);
    if(!executable&&!validModule(f.path))throw Error('HOST_PACKAGE_PATH_INVALID');
    const key=f.path.toLowerCase();if(names.has(key))throw Error('HOST_PACKAGE_DUPLICATE');names.add(key);
    const limit=executable?128*1024*1024:8*1024*1024;if(f.bytes>limit)throw Error('HOST_PACKAGE_SIZE_INVALID');
    total+=f.bytes;
  }
  if(total!==manifest.totalBytes||!names.has('native/native-review.exe')||!names.has('runtime/node.exe'))throw Error('HOST_PACKAGE_MANIFEST_INVALID');
  for(const f of manifest.files)await pinnedFile(path.join(packageRoot,...f.path.split('/')),f.sha256,f.bytes,f.bytes);
  // Detect manifest replacement during the observation as well.
  await pinnedFile(manifestPath,manifestDigest,256*1024,Buffer.byteLength(raw));
  return Object.freeze({packageRoot,manifestDigest,nativeExecutable:path.join(packageRoot,'native','native-review.exe'),nodeExecutable:path.join(packageRoot,'runtime','node.exe'),files:Object.freeze(manifest.files.map(f=>Object.freeze({...f}))),executionAuthorized:false,publisherVerified:false});
}
