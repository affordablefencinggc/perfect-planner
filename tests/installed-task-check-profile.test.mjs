import test from 'node:test';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rename,link} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {prepareInstalledTaskCheckProfile,validateInstalledTaskCheckProfile,repositoryScriptRuns} from '../src/node/installedTaskCheckProfile.mjs';
import {createInstalledTaskCheckProfileEvidenceStore} from '../src/node/installedTaskCheckProfileEvidence.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');

test('repository npm preparation retains exact scripts without requiring Planner files or executing code',async()=>{
 assert.equal(os.hostname().toLowerCase(),'dans1');
 const f=await fixture();f.profile.profileId='npm-project-checks-v1';f.profile.assignments[0].categories=['tests','build'];
 const scripts={test:'node -e "throw new Error(\'must not execute\')"',build:'npm run compile',compile:'node custom-build.cjs'};
 await writeFile(path.join(f.root,'package.json'),JSON.stringify({name:'user-project',scripts}));
 await rename(path.join(f.root,'scripts'),path.join(f.root,'unused-planner-scripts'));
 await rename(path.join(f.root,'node_modules'),path.join(f.root,'unused-planner-deps'));
 const result=await prepareInstalledTaskCheckProfile(f);
 assert.equal(result.executionAuthorized,false);assert.equal(result.reviewEnabled,false);
 assert.deepEqual(result.evidence.scriptDefinitions,scripts);
 assert.deepEqual(result.evidence.files.map(f=>f.path),['package.json','package-lock.json']);
 assert.deepEqual(result.contract.tasks[0].checks.map(c=>c.checkId),['npm-tests','npm-build']);
 const store=createInstalledTaskCheckProfileEvidenceStore({directory:path.join(f.root,'retained-evidence')});
 await store.retain(result.evidence,result.contract.policyDigest);
 assert.deepEqual(await store.read(result.contract.policyDigest),result.evidence);
 await writeFile(path.join(f.root,'package.json'),JSON.stringify({name:'user-project',scripts:{...scripts,compile:'node changed-build.cjs'}}));
 const changed=await prepareInstalledTaskCheckProfile(f);assert.notEqual(changed.contract.policyDigest,result.contract.policyDigest);
 await assert.rejects(store.retain(changed.evidence,result.contract.policyDigest),/DIGEST_MISMATCH/);
});

test('repository profile refuses missing selected scripts and oversized definitions',async()=>{
 for(const scripts of [{build:'node build.cjs'},{test:'x'.repeat(4097)},{test:'node test.cjs\nnode extra.cjs'}]){
  const f=await fixture();f.profile.profileId='npm-project-checks-v1';f.profile.assignments[0].categories=['tests'];
  await writeFile(path.join(f.root,'package.json'),JSON.stringify({name:'user-project',scripts}));
  await assert.rejects(prepareInstalledTaskCheckProfile(f),/SCRIPTS_MISMATCH/);
 }
});
test('native extended-length Windows paths work while redirected roots still refuse',async()=>{
 assert.equal(os.hostname().toLowerCase(),'dans1');assert.equal(process.platform,'win32');
 const f=await fixture();f.profile.registeredRoot=path.toNamespacedPath(f.root);f.profile.npmCli.path=path.toNamespacedPath(f.profile.npmCli.path);
 assert.equal((await prepareInstalledTaskCheckProfile(f)).executionAuthorized,false);
 const alias=f.root+'-native-alias';await symlink(f.root,alias,'junction');
 await assert.rejects(prepareInstalledTaskCheckProfile({...f,profile:{...f.profile,registeredRoot:path.toNamespacedPath(alias)}}),/UNSAFE_PATH/);
 await link(f.profile.npmCli.path,path.join(f.root,'npm','second.js'));
 await assert.rejects(prepareInstalledTaskCheckProfile(f),/FILE_UNSAFE/);
});
async function fixture(){
 const root=await mkdtemp(path.join(os.tmpdir(),'pp-fixed-profile-'));const manifest={name:'perfect-planner-cleanroom',scripts:{test:'node --test tests/*.test.mjs',build:'npm run build:client && node scripts/prepare-sites-build.mjs','build:client':'vite build && node scripts/generate-truth-report.mjs --release','verify:secrets':'node scripts/verify-secrets.mjs'}};
 for(const [name,bytes] of Object.entries({'package.json':JSON.stringify(manifest),'package-lock.json':'{"lockfileVersion":3}','node_modules/vite/bin/vite.js':'// inert fixture','scripts/generate-truth-report.mjs':'// inert fixture','scripts/prepare-sites-build.mjs':'// inert fixture','scripts/verify-secrets.mjs':'// inert fixture','npm/npm-cli.js':'// inert npm fixture'})){const target=path.join(root,...name.split('/'));await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes);}
 const profile={profileId:'perfect-planner-checks-v1',registeredRoot:root,npmCli:{path:path.join(root,'npm','npm-cli.js'),sha256:hash('// inert npm fixture')},assignments:[{taskId:'T0001',categories:['tests','build','secrets']}],expectedProposal:{hostRevision:1,headDigest:'a'.repeat(64)},request:{requestId:'prepare-first',expectedRevision:0,expectedHeadDigest:'GENESIS'}};
 const installed={manifestDigest:'b'.repeat(64),nodeExecutable:process.execPath,files:[{path:'runtime/node.exe',sha256:'c'.repeat(64)}]};const proposal={hostRevision:1,recordHash:'a'.repeat(64),ledger:{binding:{projectId:'pp_profile_fixture',rootIdentity:'d'.repeat(64),censusDigest:'e'.repeat(64)},tasks:[{id:'T0001',archived:false}]}};
 return {root,manifest,profile,installed,proposal};
}
test('fixed profile preserves all three npm script semantics without execution authority',async()=>{
 const f=await fixture(),result=await prepareInstalledTaskCheckProfile(f);assert.deepEqual(result.contract.tasks[0].checks.map(c=>c.args),['test','build','verify:secrets'].map(script=>[f.profile.npmCli.path,'run',script]));assert.ok(result.contract.tasks[0].checks.every(c=>c.executablePath===process.execPath));assert.equal(result.reviewEnabled,false);assert.equal(result.executionAuthorized,false);assert.equal(result.candidateVerified,false);assert.equal(result.transitiveToolchainVerified,false);assert.equal(result.evidence.files.length,6);assert.ok(Object.isFrozen(result.contract.tasks));
});
test('unknown categories, injected argv and incomplete task mappings refuse',async()=>{
 const f=await fixture();assert.throws(()=>validateInstalledTaskCheckProfile({...f.profile,args:['--eval']}),/CONFIG_INVALID/);assert.throws(()=>validateInstalledTaskCheckProfile({...f.profile,assignments:[{taskId:'T0001',categories:['deploy']}]}),/MAPPING_INVALID/);await assert.rejects(prepareInstalledTaskCheckProfile({...f,proposal:{...f.proposal,ledger:{...f.proposal.ledger,tasks:[...f.proposal.ledger.tasks,{id:'T0002',archived:false}]}}}),/MAPPING_INCOMPLETE/);
});
test('changed lifecycle hooks or script definitions fail closed',async()=>{
 for(const scripts of [{prebuild:'arbitrary'},{posttest:'arbitrary'},{'preverify:secrets':'arbitrary'},{'postbuild:client':'arbitrary'},{build:'vite build'}]){const f=await fixture();await writeFile(path.join(f.root,'package.json'),JSON.stringify({...f.manifest,scripts:{...f.manifest.scripts,...scripts}}));await assert.rejects(prepareInstalledTaskCheckProfile(f),/SCRIPTS_MISMATCH/);}
});
test('stale proposal, unavailable npm and mismatched npm pin refuse',async()=>{
 const f=await fixture();await assert.rejects(prepareInstalledTaskCheckProfile({...f,proposal:{...f.proposal,hostRevision:2}}),/STALE_PROPOSAL/);await assert.rejects(prepareInstalledTaskCheckProfile({...f,profile:{...f.profile,npmCli:{...f.profile.npmCli,path:path.join(f.root,'npm','missing.js')}}}),/TOOLCHAIN_UNAVAILABLE/);await writeFile(f.profile.npmCli.path,'// changed');await assert.rejects(prepareInstalledTaskCheckProfile(f),/TOOL_PIN_MISMATCH/);
});
test('observed required bytes affect policy digest and redirected roots refuse',async()=>{
 const f=await fixture(),before=await prepareInstalledTaskCheckProfile(f);await writeFile(path.join(f.root,'package-lock.json'),'{"lockfileVersion":3,"changed":true}');const after=await prepareInstalledTaskCheckProfile(f);assert.notEqual(before.contract.policyDigest,after.contract.policyDigest);const alias=f.root+'-alias';await symlink(f.root,alias,process.platform==='win32'?'junction':'dir');await assert.rejects(prepareInstalledTaskCheckProfile({...f,profile:{...f.profile,registeredRoot:alias}}),/UNSAFE_PATH/);assert.equal(await readFile(f.profile.npmCli.path,'utf8'),'// inert npm fixture');
});
test('missing required file and linked tool bytes cannot become prepared policy',async()=>{
 const f=await fixture();await rename(path.join(f.root,'scripts','verify-secrets.mjs'),path.join(f.root,'scripts','retained-verify-secrets.mjs'));await assert.rejects(prepareInstalledTaskCheckProfile(f),/REQUIRED_FILE_UNAVAILABLE/);
 const g=await fixture();await link(g.profile.npmCli.path,path.join(g.root,'npm','alias.js'));await assert.rejects(prepareInstalledTaskCheckProfile(g),/FILE_UNSAFE/);
});


test('repository hooks are retained, ordered and policy-bound; actual npm runs the declared lifecycle',async()=>{
 assert.equal(os.hostname().toLowerCase(),'dans1');const f=await fixture();f.profile.profileId='npm-project-checks-v1';f.profile.assignments[0].categories=['tests'];
 const scripts=Object.fromEntries(['pretest','test','posttest'].map(name=>[name,`node -e "require('node:fs').appendFileSync('order.txt','${name}|')"`]));
 await writeFile(path.join(f.root,'package.json'),JSON.stringify({name:'lifecycle-fixture',scripts}));
 const prepared=await prepareInstalledTaskCheckProfile(f);
 await assert.rejects(readFile(path.join(f.root,'order.txt')),error=>error.code==='ENOENT');
 const runs=repositoryScriptRuns(prepared.evidence.scriptDefinitions,prepared.evidence.assignments);
 assert.deepEqual(runs,[{taskId:'T0001',checkId:'npm-tests',script:'test',lifecycle:['pretest','test','posttest'].map(name=>({name,command:scripts[name]}))}]);assert.ok(Object.isFrozen(runs[0].lifecycle));
 const evidence=createInstalledTaskCheckProfileEvidenceStore({directory:path.join(f.root,'evidence-hooks')});await evidence.retain(prepared.evidence,prepared.contract.policyDigest);assert.deepEqual((await evidence.read(prepared.contract.policyDigest)).scriptDefinitions,scripts);
 const userconfig=path.join(f.root,'empty-user.npmrc'),globalconfig=path.join(f.root,'empty-global.npmrc');await writeFile(userconfig,'');await writeFile(globalconfig,'');
 const npm=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
 const result=spawnSync(process.execPath,[npm,'run','test','--offline','--ignore-scripts=false',`--userconfig=${userconfig}`,`--globalconfig=${globalconfig}`],{cwd:f.root,encoding:'utf8',timeout:20000,windowsHide:true,env:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,TEMP:f.root,TMP:f.root,USERPROFILE:f.root,PATH:`${path.dirname(process.execPath)};${process.env.SystemRoot}\\System32`}});
 assert.equal(result.status,0,`${result.error??''} ${result.stderr}`);assert.equal(await readFile(path.join(f.root,'order.txt'),'utf8'),'pretest|test|posttest|');
 await writeFile(path.join(f.root,'package.json'),JSON.stringify({name:'lifecycle-fixture',scripts:{...scripts,pretest:'node different-pretest.cjs'}}));
 const changed=await prepareInstalledTaskCheckProfile(f);assert.notEqual(changed.contract.policyDigest,prepared.contract.policyDigest);await assert.rejects(evidence.retain(changed.evidence,prepared.contract.policyDigest),/DIGEST_MISMATCH/);
});

