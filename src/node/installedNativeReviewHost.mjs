import path from 'node:path';
import {lstat,realpath} from 'node:fs/promises';
import {verifyNativeReviewHostPackage} from './nativeReviewHostPackage.mjs';
import {createNativeCensusBindingProvider} from './nativeCensusBindingProvider.mjs';
import {createNativeReviewHostComposition} from './nativeReviewHostComposition.mjs';
import {validateTaskDraftBinding} from '../project/taskDraftLedger.js';
import {createWindowsDpapiRunner} from './windowsDpapiSecretCustody.mjs';
import {validateInstalledTaskCheckProfileProvision} from './installedTaskCheckProfile.mjs';
import {createInstalledTaskCheckPreparation} from './installedTaskCheckPreparation.mjs';
import {createInstalledTaskExecutionCustody} from './installedTaskExecutionCustody.mjs';
import {createNativeTaskExecutionRequests} from './nativeTaskExecutionRequests.mjs';

const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const absolute=value=>typeof value==='string'&&path.isAbsolute(value)&&path.normalize(value)===value&&!value.includes('\0');
async function directory(value){if(!absolute(value))throw Error('INSTALLED_HOST_STATE_INVALID');for(let current=value;;){const info=await lstat(current);if(!info.isDirectory()||info.isSymbolicLink()||path.relative(current,await realpath(current))!=='')throw Error('INSTALLED_HOST_STATE_UNSAFE');const parent=path.dirname(current);if(parent===current)break;current=parent;}}

// Supervisor-owned factory. Never accept this configuration from a webview,
// JSON-line request, repository manifest, environment variable or MCP caller.
// Does not install packages or discover executables. It composes real adapters.
export async function createInstalledNativeReviewHost(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['packageConfig','metadataConfig','stateDirectory','actor','source','checkContract','checkProfileProvision','preparedCheckSelection'].includes(key))||!['packageConfig','metadataConfig','stateDirectory','actor','source'].every(key=>Object.hasOwn(input,key))||(Object.hasOwn(input,'checkContract')&&Object.hasOwn(input,'checkProfileProvision'))||(Object.hasOwn(input,'preparedCheckSelection')&&!Object.hasOwn(input,'checkProfileProvision')))throw Error('INSTALLED_HOST_CONFIG_INVALID');
  const config=structuredClone(input);
  if(Object.hasOwn(config,'checkProfileProvision'))config.checkProfileProvision=validateInstalledTaskCheckProfileProvision(config.checkProfileProvision);
  if(!exact(config.metadataConfig,['executable','executableDigest','registryRoot','workspaceId','registryRevision','rootIdentity'])||!absolute(config.stateDirectory)||typeof config.actor!=='string'||!config.actor.trim()||config.actor.length>256||typeof config.source!=='string'||!config.source.trim()||config.source.length>256)throw Error('INSTALLED_HOST_CONFIG_INVALID');
  await directory(config.stateDirectory);
  const installed=await verifyNativeReviewHostPackage(config.packageConfig);
  const relative=path.relative(installed.packageRoot,config.stateDirectory);
  if(relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)))throw Error('INSTALLED_HOST_STATE_INSIDE_PACKAGE');
  if(path.relative(await realpath(process.execPath),await realpath(installed.nodeExecutable))!=='')throw Error('INSTALLED_HOST_RUNTIME_MISMATCH');
  // Derived exclusively from native-owned state, never an IPC/config override.
  const registeredBinding=createNativeCensusBindingProvider({...config.metadataConfig,compilationTempRoot:path.join(config.stateDirectory,'metadata-compilation-temp')});
  // Native executable and retained registration/census are actually observed
  // before accessing project-specific authority files.
  const binding=validateTaskDraftBinding(await registeredBinding());
  await directory(config.stateDirectory);
  const presenterFile=installed.files.find(file=>file.path==='native/native-review.exe');
  const proposalConfig={journalPath:path.join(config.stateDirectory,`${binding.projectId}.proposals.jsonl`),projectId:binding.projectId,rootIdentity:binding.rootIdentity};
  // Constructor only captures configuration; prepare-checks dispatch owns all
  // profile observations and authority writes after supervisor READY.
  const checkPreparation=config.checkProfileProvision?createInstalledTaskCheckPreparation({provision:config.checkProfileProvision,installed,proposalConfig,registeredBinding,actor:config.actor,source:config.source,stateDirectory:config.stateDirectory}):undefined;
  const selected=Object.hasOwn(config,'preparedCheckSelection')?await checkPreparation.resolveReview(config.preparedCheckSelection):null;
  const checkContract=selected?.checkContract??config.checkContract;
  const secretCustody=checkContract?Object.freeze({root:path.join(config.stateDirectory,'confirmation-custody'),dpapi:createWindowsDpapiRunner({compilationTempRoot:path.join(config.stateDirectory,'confirmation-compilation-temp')})}):undefined;
  // Provision alone remains preparation-only. Explicit native selection binds
  // review and decision to the saved contract head; it never grants execution.
  const executionCustody=createInstalledTaskExecutionCustody({stateDirectory:config.stateDirectory,binding,observeBinding:registeredBinding});
  const taskExecution=selected?executionCustody.createExecution({proposalConfig,confirmationPath:path.join(config.stateDirectory,`${binding.projectId}.confirmations.json`),checkContract,contractCustody:selected.contractCustody,
    registeredRoot:config.checkProfileProvision.registeredRoot,actor:config.actor,secretCustody,
    nativeConfig:{executable:config.metadataConfig.executable,executableDigest:config.metadataConfig.executableDigest,cwd:installed.packageRoot,compilationTempRoot:path.join(config.stateDirectory,'task-execution-compilation-temp')}}):undefined;
  const executionRequests=taskExecution?createNativeTaskExecutionRequests({directory:path.join(config.stateDirectory,`${binding.projectId}.execution-requests`),binding,selection:config.preparedCheckSelection,owner:taskExecution}):undefined;
  const host=createNativeReviewHostComposition({proposalConfig,confirmationPath:path.join(config.stateDirectory,`${binding.projectId}.confirmations.json`),registeredBinding,checkContract,checkProfileEvidence:selected?.checkProfileEvidence,contractCustody:selected?.contractCustody,checkPreparation,taskResults:executionCustody.results,executionRequests:executionRequests?{execute:executionRequests.execute,recover:executionRequests.recover,shutdown:async()=>{const requests=await executionRequests.shutdown();const owner=await taskExecution.shutdown();return {cleanupComplete:requests.cleanupComplete===true&&owner.cleanupComplete===true};}}:undefined,presenterConfig:{executable:installed.nativeExecutable,executableDigest:presenterFile.sha256,cwd:installed.packageRoot},actor:config.actor,source:config.source,secretCustody});
  return Object.freeze({
    binding:Object.freeze({...binding}),packageManifestDigest:installed.manifestDigest,runtimeFromPackage:true,checkPreparationConfigured:Boolean(checkPreparation),
    packageEvidence:Object.freeze({manifestDigest:installed.manifestDigest,runtimeFromPackage:true,publisherVerified:false,executionAuthorized:false}),
    retainedObservation:true,liveFilesystemVerified:false,publisherVerified:false,executionAuthorized:false,
    limits:host.limits,dispatchLine:host.dispatchLine,attach:host.attach,shutdown:host.shutdown,readPlan:host.readPlan,proposeTaskChange:host.proposeTaskChange,
    ...(taskExecution?{taskExecution,executionRequests}:{}),
  });
}


