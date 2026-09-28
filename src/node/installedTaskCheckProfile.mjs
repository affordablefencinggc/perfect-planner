import path from 'node:path';
import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createTaskCheckContract} from './taskCheckContract.mjs';

const fail=code=>{throw Error(`INSTALLED_CHECK_PROFILE_${code}`);};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const absolute=v=>typeof v==='string'&&path.isAbsolute(v)&&path.normalize(v)===v&&!v.includes('\0');
// Rust canonical paths use the Windows extended-length spelling. Compare both
// sides in that spelling; retain all link, identity and stability checks.
const samePath=(a,b)=>path.relative(path.toNamespacedPath(a),path.toNamespacedPath(b))==='';
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>createHash('sha256').update(v).digest('hex');
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const scripts=Object.freeze({test:'node --test tests/*.test.mjs',build:'npm run build:client && node scripts/prepare-sites-build.mjs','build:client':'vite build && node scripts/generate-truth-report.mjs --release','verify:secrets':'node scripts/verify-secrets.mjs'});
const categories=Object.freeze({tests:'test',build:'build',secrets:'verify:secrets'});
const required=['package.json','package-lock.json','node_modules/vite/bin/vite.js','scripts/generate-truth-report.mjs','scripts/prepare-sites-build.mjs','scripts/verify-secrets.mjs'];
// Observation only. All definitions are retained because selected scripts may
// invoke other scripts. Native review must present these before enabling use.
export function validateRepositoryScriptDefinitions(value,assignments){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length<1||Object.keys(value).length>128)fail('SCRIPTS_MISMATCH');
 for(const [name,command]of Object.entries(value))if(!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(name)||typeof command!=='string'||!command.trim()||command.length>4096||/[\u0000-\u001f\u007f]/.test(command))fail('SCRIPTS_MISMATCH');
 if(Buffer.byteLength(JSON.stringify(value))>65536)fail('SCRIPTS_MISMATCH');
 for(const assignment of assignments)for(const category of assignment.categories){const name=categories[category];if(!name||!Object.hasOwn(value,name))fail('SCRIPTS_MISMATCH');}
 return freeze(structuredClone(value));
}
// Review data derived from the policy-bound definitions, never additional
// executable arguments. npm configuration can suppress hooks; nested commands
// are not expanded. All script definitions remain visible in the same review.
export function repositoryScriptRuns(definitions,assignments){
 const captured=validateRepositoryScriptDefinitions(definitions,assignments);
 return freeze(assignments.flatMap(task=>task.categories.map(category=>{
  const script=categories[category];
  return {taskId:task.taskId,checkId:`npm-${category}`,script,lifecycle:['pre'+script,script,'post'+script].filter(name=>Object.hasOwn(captured,name)).map(name=>({name,command:captured[name]}))};
 })));
}
async function directory(target){
 // Node's ancestor/drive-root handling for extended paths can yield C: (a
 // drive-relative path). Traverse the equivalent absolute drive spelling.
 if(process.platform==='win32'&&/^\\\\\?\\[A-Za-z]:\\/.test(target))target=target.slice(4);
 const root=path.parse(target).root,chain=[];for(let current=target;;){
  const stat=await lstat(current);if(!stat.isDirectory()||stat.isSymbolicLink()||!samePath(current,await realpath(current)))fail('UNSAFE_PATH');chain.push({path:current,dev:stat.dev,ino:stat.ino});if(current===root)break;
  const parent=path.dirname(current);current=parent.length<root.length?root:parent;
 }return chain;
}
async function recheck(chain){for(const entry of chain){const stat=await lstat(entry.path);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.dev!==entry.dev||stat.ino!==entry.ino||!samePath(entry.path,await realpath(entry.path)))fail('PATH_CHANGED');}}
async function observeFile(file,limit=8*1024*1024,collect=false){
 if(!absolute(file))fail('CONFIG_INVALID');const chain=await directory(path.dirname(file)),before=await lstat(file,{bigint:true});
 const same=stat=>stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1n&&['dev','ino','size','mtimeNs','ctimeNs'].every(k=>before[k]===stat[k]);
 if(!same(before)||before.size<1n||before.size>BigInt(limit)||!samePath(file,await realpath(file)))fail('FILE_UNSAFE');
 const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));const sha=createHash('sha256'),chunks=[];let size=0;
 try{if(!same(await handle.stat({bigint:true})))fail('FILE_CHANGED');const buffer=Buffer.alloc(65536);for(;;){const part=await handle.read(buffer,0,buffer.length,null);if(!part.bytesRead)break;size+=part.bytesRead;if(size>limit||BigInt(size)>before.size)fail('FILE_CHANGED');const bytes=buffer.subarray(0,part.bytesRead);sha.update(bytes);if(collect)chunks.push(Buffer.from(bytes));}if(BigInt(size)!==before.size||!same(await handle.stat({bigint:true})))fail('FILE_CHANGED');}finally{await handle.close();}
 if(!same(await lstat(file,{bigint:true})))fail('FILE_CHANGED');await recheck(chain);
 return {path:file,sha256:sha.digest('hex'),bytes:size,...(collect?{content:Buffer.concat(chunks).toString('utf8')}:{})};
}
export function validateInstalledTaskCheckProfile(value){
 value=structuredClone(value);
 if(!exact(value,['profileId','registeredRoot','npmCli','assignments','expectedProposal','request'])||!['perfect-planner-checks-v1','npm-project-checks-v1'].includes(value.profileId)||!absolute(value.registeredRoot)||!exact(value.npmCli,['path','sha256'])||!absolute(value.npmCli.path)||!digest(value.npmCli.sha256)||!exact(value.expectedProposal,['hostRevision','headDigest'])||!Number.isSafeInteger(value.expectedProposal.hostRevision)||value.expectedProposal.hostRevision<1||!digest(value.expectedProposal.headDigest)||!exact(value.request,['requestId','expectedRevision','expectedHeadDigest'])||typeof value.request.requestId!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.request.requestId)||!Number.isSafeInteger(value.request.expectedRevision)||value.request.expectedRevision<0||(value.request.expectedRevision===0?value.request.expectedHeadDigest!=='GENESIS':!digest(value.request.expectedHeadDigest))||!Array.isArray(value.assignments)||!value.assignments.length||value.assignments.length>256)fail('CONFIG_INVALID');
 const ids=new Set();for(const item of value.assignments){if(!exact(item,['taskId','categories'])||typeof item.taskId!=='string'||!/^T\d{4,6}$/.test(item.taskId)||ids.has(item.taskId)||!Array.isArray(item.categories)||!item.categories.length||item.categories.length>3||new Set(item.categories).size!==item.categories.length||item.categories.some(c=>!Object.hasOwn(categories,c)))fail('MAPPING_INVALID');ids.add(item.taskId);}
 return freeze(value);
}
export function validateInstalledTaskCheckProfileProvision(value){
 if(!exact(value,['profileId','registeredRoot','npmCli','assignments']))fail('CONFIG_INVALID');
 const validated=validateInstalledTaskCheckProfile({...structuredClone(value),expectedProposal:{hostRevision:1,headDigest:'0'.repeat(64)},request:{requestId:'validation-only',expectedRevision:0,expectedHeadDigest:'GENESIS'}});
 const {expectedProposal,request,...provision}=validated;return freeze(provision);
}
// Called only with native-provisioned root/profile and a verified installed
// package. File pins are observations, not transitive toolchain/candidate proof.
// This prepares review data only; it never runs npm, project code or deployment.
// registeredRoot must originate from native registration, not renderer input.
// npm configuration/environment and transitive imports remain unverified. Do
// not read .npmrc/credentials or treat an entrypoint pin as execution safety.
export async function prepareInstalledTaskCheckProfile({profile,installed,proposal}){
 profile=validateInstalledTaskCheckProfile(profile);proposal=structuredClone(proposal);installed=structuredClone(installed);
 if(proposal?.hostRevision!==profile.expectedProposal.hostRevision||proposal.recordHash!==profile.expectedProposal.headDigest)fail('STALE_PROPOSAL');
 const active=proposal.ledger.tasks.filter(t=>!t.archived).map(t=>t.id).sort();if(JSON.stringify(active)!==JSON.stringify(profile.assignments.map(t=>t.taskId).sort()))fail('MAPPING_INCOMPLETE');
 const node=installed.files?.find(file=>file.path==='runtime/node.exe');if(!node||!digest(node.sha256)||!digest(installed.manifestDigest)||!absolute(installed.nodeExecutable))fail('RUNTIME_UNAVAILABLE');
 const rootChain=await directory(profile.registeredRoot);let npm;try{npm=await observeFile(profile.npmCli.path);}catch(error){if(error.code==='ENOENT')fail('TOOLCHAIN_UNAVAILABLE');throw error;}if(npm.sha256!==profile.npmCli.sha256)fail('TOOL_PIN_MISMATCH');
 const repositoryProfile=profile.profileId==='npm-project-checks-v1';const requiredFiles=repositoryProfile?['package.json','package-lock.json']:required;
 const observations=[];let manifest;for(const relative of requiredFiles){let observed;try{observed=await observeFile(path.join(profile.registeredRoot,...relative.split('/')),8*1024*1024,relative==='package.json');}catch(error){if(error.code==='ENOENT')fail('REQUIRED_FILE_UNAVAILABLE');throw error;}if(relative==='package.json'){try{manifest=JSON.parse(observed.content);}catch{fail('MANIFEST_INVALID');}}delete observed.content;observations.push({...observed,path:relative});}
 if(!repositoryProfile&&(manifest?.name!=='perfect-planner-cleanroom'||!manifest.scripts||Object.entries(scripts).some(([name,value])=>manifest.scripts[name]!==value)||Object.keys(scripts).some(name=>Object.hasOwn(manifest.scripts,'pre'+name)||Object.hasOwn(manifest.scripts,'post'+name))))fail('SCRIPTS_MISMATCH');
 const scriptDefinitions=repositoryProfile?validateRepositoryScriptDefinitions(manifest?.scripts,profile.assignments):scripts;
 // Observe pins a second time before retaining them. No lock/lease is implied.
 if((await observeFile(profile.npmCli.path)).sha256!==npm.sha256)fail('FILE_CHANGED');for(const expected of observations){const current=await observeFile(path.join(profile.registeredRoot,...expected.path.split('/')));if(current.sha256!==expected.sha256||current.bytes!==expected.bytes)fail('FILE_CHANGED');}await recheck(rootChain);
 const evidence={profileId:profile.profileId,packageManifestDigest:installed.manifestDigest,registeredRoot:profile.registeredRoot,npmCli:npm,files:observations,assignments:profile.assignments,scriptDefinitions};
 const contract=createTaskCheckContract({schemaVersion:1,kind:'TASK_CHECK_CONTRACT',projectId:proposal.ledger.binding.projectId,rootIdentity:proposal.ledger.binding.rootIdentity,policyVersion:1,policyDigest:hash(JSON.stringify(canonical(evidence))),tasks:profile.assignments.map(task=>({taskId:task.taskId,checks:task.categories.map(category=>({checkId:`${repositoryProfile?'npm':'pp'}-${category}`,executablePath:installed.nodeExecutable,executableDigest:node.sha256,args:[profile.npmCli.path,'run',categories[category]],cwd:'.',timeoutMs:category==='secrets'?90000:300000,outputLimits:{stdoutBytes:1024*1024,stderrBytes:1024*1024,combinedBytes:2*1024*1024}}))}))});
 return freeze({contract,evidence,reviewEnabled:false,toolsVerified:false,toolchainVerified:false,transitiveToolchainVerified:false,candidateVerified:false,executionAuthorized:false,registrationLeaseHeld:false});
}

