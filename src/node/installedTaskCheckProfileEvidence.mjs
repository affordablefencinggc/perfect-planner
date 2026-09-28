import path from 'node:path';
import {constants} from 'node:fs';
import {lstat,mkdir,open,opendir,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {withPlanLock} from './planLock.mjs';
import {validateRepositoryScriptDefinitions} from './installedTaskCheckProfile.mjs';

const MAX_FILE=1024*1024,MAX_FILES=128,MAX_TOTAL=16*1024*1024;
const fail=code=>{throw Error(`PROFILE_EVIDENCE_${code}`);};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const absolute=v=>typeof v==='string'&&path.isAbsolute(v)&&path.normalize(v)===v&&!/[\u0000-\u001f]/.test(v);
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const wire=v=>JSON.stringify(canonical(v));
const hash=v=>createHash('sha256').update(wire(v)).digest('hex');
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const required=['package.json','package-lock.json','node_modules/vite/bin/vite.js','scripts/generate-truth-report.mjs','scripts/prepare-sites-build.mjs','scripts/verify-secrets.mjs'];
const scripts={test:'node --test tests/*.test.mjs',build:'npm run build:client && node scripts/prepare-sites-build.mjs','build:client':'vite build && node scripts/generate-truth-report.mjs --release','verify:secrets':'node scripts/verify-secrets.mjs'};
function validate(value,expected){
 value=structuredClone(value);
 const repositoryProfile=value?.profileId==='npm-project-checks-v1';
 if(!digest(expected)||!exact(value,['profileId','packageManifestDigest','registeredRoot','npmCli','files','assignments','scriptDefinitions'])||(!repositoryProfile&&value.profileId!=='perfect-planner-checks-v1')||!digest(value.packageManifestDigest)||!absolute(value.registeredRoot)||(!repositoryProfile&&wire(value.scriptDefinitions)!==wire(scripts)))fail('INVALID');
 const requiredFiles=repositoryProfile?['package.json','package-lock.json']:required;
 const file=v=>exact(v,['path','sha256','bytes'])&&digest(v.sha256)&&Number.isSafeInteger(v.bytes)&&v.bytes>0&&v.bytes<=8*1024*1024;
 if(!file(value.npmCli)||!absolute(value.npmCli.path)||!Array.isArray(value.files)||value.files.length!==requiredFiles.length||value.files.some((v,i)=>!file(v)||v.path!==requiredFiles[i]))fail('INVALID');
 const ids=new Set();if(!Array.isArray(value.assignments)||value.assignments.length<1||value.assignments.length>256)fail('INVALID');
 for(const a of value.assignments){if(!exact(a,['taskId','categories'])||typeof a.taskId!=='string'||!/^T\d{4,6}$/.test(a.taskId)||Number(a.taskId.slice(1))<1||a.taskId!==`T${String(Number(a.taskId.slice(1))).padStart(4,'0')}`||ids.has(a.taskId)||!Array.isArray(a.categories)||!a.categories.length||a.categories.length>3||new Set(a.categories).size!==a.categories.length||a.categories.some(v=>!['tests','build','secrets'].includes(v)))fail('INVALID');ids.add(a.taskId);}
 if(repositoryProfile){try{validateRepositoryScriptDefinitions(value.scriptDefinitions,value.assignments);}catch{fail('INVALID');}}
 if(hash(value)!==expected)fail('DIGEST_MISMATCH');if(Buffer.byteLength(wire(value))+1>MAX_FILE)fail('QUOTA');return freeze(value);
}
export function validateInstalledTaskCheckProfileEvidence(value,policyDigest){return validate(value,policyDigest);}
async function chain(directory){const entries=[];for(let p=directory;;p=path.dirname(p)){const s=await lstat(p);if(!s.isDirectory()||s.isSymbolicLink()||path.relative(p,await realpath(p)))fail('UNSAFE_PATH');entries.push({path:p,dev:s.dev,ino:s.ino});if(path.dirname(p)===p)break;}return entries;}
async function recheck(entries){for(const e of entries){const s=await lstat(e.path);if(!s.isDirectory()||s.isSymbolicLink()||s.dev!==e.dev||s.ino!==e.ino||path.relative(e.path,await realpath(e.path)))fail('PATH_CHANGED');}}
const regular=s=>s.isFile()&&!s.isSymbolicLink()&&s.nlink===1;
const same=(a,b)=>regular(b)&&['dev','ino','size','mtimeMs','ctimeMs'].every(k=>a[k]===b[k]);

// Native-owned immutable sidecars; not approval, execution or authenticated
// authorship. Cooperative checks cannot defeat arbitrary same-user replacement
// or rollback. Data is synced, but first-directory power-loss durability is not
// portable. Partial writes and unreferenced evidence are retained, never repaired.
export function createInstalledTaskCheckProfileEvidenceStore({directory,maxFiles=MAX_FILES,maxBytes=MAX_TOTAL}={}){
 if(!absolute(directory)||directory===path.parse(directory).root||!Number.isSafeInteger(maxFiles)||maxFiles<1||maxFiles>MAX_FILES||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MAX_TOTAL)fail('CONFIG_INVALID');
 async function locked(operation){
  const parents=await chain(path.dirname(directory));try{await mkdir(directory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}await recheck(parents);const dirs=await chain(directory);
  const capacity=directory+'.capacity';try{const s=await lstat(capacity+'.pp-lock');if(!s.isDirectory()||s.isSymbolicLink())fail('UNSAFE_PATH');const holder=await lstat(path.join(capacity+'.pp-lock','holder.json'));if(!regular(holder)||holder.size>4096)fail('UNSAFE_FILE');}catch(error){if(error.code!=='ENOENT')throw error;}
  return withPlanLock(capacity,{actor:'profile-evidence',timeoutMs:5000,retryMs:10},async()=>{await recheck(dirs);return operation(dirs);});
 }
 async function inventory(){
  const names=[];let bytes=0;
  for await(const entry of await opendir(directory)){const name=entry.name;if(names.length>=maxFiles)fail('QUOTA');names.push(name);if(!/^[a-f0-9]{64}\.json$/.test(name))fail('UNEXPECTED_FILE');const s=await lstat(path.join(directory,name));if(!regular(s))fail('UNSAFE_FILE');if(s.size>MAX_FILE||(bytes+=s.size)>maxBytes)fail('QUOTA');}
  return {names,bytes};
 }
 async function read(expected,dirs){
  const file=path.join(directory,expected+'.json'),before=await lstat(file);if(!regular(before)||before.size<1||before.size>MAX_FILE)fail('UNSAFE_FILE');
  const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));let bytes;
  try{if(!same(before,await handle.stat()))fail('FILE_CHANGED');bytes=Buffer.alloc(before.size+1);let offset=0;while(offset<bytes.length){const p=await handle.read(bytes,offset,bytes.length-offset,offset);if(!p.bytesRead)break;offset+=p.bytesRead;}if(offset!==before.size||!same(before,await handle.stat()))fail('FILE_CHANGED');bytes=bytes.subarray(0,offset);}finally{await handle.close();}
  if(!same(before,await lstat(file)))fail('FILE_CHANGED');await recheck(dirs);let text,value;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);value=JSON.parse(text);}catch{fail('CORRUPT');}const evidence=validate(value,expected);if(text!==wire(evidence)+'\n')fail('CORRUPT');return evidence;
 }
 return Object.freeze({
  async read(policyDigest){if(!digest(policyDigest))fail('INVALID');return locked(async dirs=>{await inventory();return read(policyDigest,dirs);});},
  async retain(evidence,policyDigest){
   evidence=validate(evidence,policyDigest);const bytes=Buffer.from(wire(evidence)+'\n');
   return locked(async dirs=>{const state=await inventory(),name=policyDigest+'.json';
    if(state.names.includes(name)){
     const prior=await read(policyDigest,dirs);if(wire(prior)!==wire(evidence))fail('COLLISION');
     // Retry must actually flush even if a previous sync failed after writing.
     const file=path.join(directory,name),before=await lstat(file),handle=await open(file,constants.O_WRONLY|(constants.O_NOFOLLOW??0));
     try{if(!same(before,await handle.stat()))fail('FILE_CHANGED');await handle.sync();}finally{await handle.close();}
     const saved=await read(policyDigest,dirs);if(wire(saved)!==wire(evidence))fail('PUBLICATION_UNCERTAIN');return freeze({policyDigest,evidence:saved,idempotent:true,observationEvidencePersisted:true,executionAuthorized:false});
    }
    if(state.names.length>=maxFiles||state.bytes+bytes.length>maxBytes)fail('QUOTA');await recheck(dirs);
    const handle=await open(path.join(directory,name),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
    try{const s=await handle.stat();if(!regular(s)||s.size!==0)fail('UNSAFE_FILE');await recheck(dirs);await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
    const saved=await read(policyDigest,dirs);if(wire(saved)!==wire(evidence))fail('PUBLICATION_UNCERTAIN');return freeze({policyDigest,evidence:saved,idempotent:false,observationEvidencePersisted:true,executionAuthorized:false});
   });
  },
 });
}
