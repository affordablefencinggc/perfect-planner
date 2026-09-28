import {useEffect,useMemo,useRef,useState} from 'react';
import {createNativeCheckSetupHost} from '../native/checkSetupHost.js';
import {createNativeTaskResultHost} from '../native/taskResultHost.js';
import {readNativeTaskBatchOutcome,readNativeTaskAttemptProgress} from '../native/taskBatchOutcome.js';
const checkLabels={tests:'Tests',build:'Build',secrets:'Secret check'};
const scriptNames={tests:'test',build:'build',secrets:'verify:secrets'};

// The cached opaque reference is only a convenience. Every restored reference
// must be resolved and checked by native custody before preparation is enabled.
export function NativeCheckSetupPanel({project,snapshot,disabled=false}){
 const host=useMemo(()=>{try{return createNativeCheckSetupHost(project);}catch{return null;}},[project]);
 const results=useMemo(()=>{try{return createNativeTaskResultHost(project);}catch{return null;}},[project]);
 const identity=JSON.stringify([host?.binding??null,project?.generation,project?.registration?.workspaceId,project?.registration?.registryRevision,snapshot?.observedHead]);
 return <CheckSetup key={identity} host={host} results={results} snapshot={snapshot} disabled={disabled}/>;
}
function CheckSetup({host,results,snapshot,disabled}){
 const [reference,setReference]=useState(''),[state,setState]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[note,setNote]=useState('');
 const [cacheWarning,setCacheWarning]=useState(''),[savedReview,setSavedReview]=useState(null);
 const [approval,setApproval]=useState(null),[savedExecution,setSavedExecution]=useState(null),[executionReceipt,setExecutionReceipt]=useState(null),[outcome,setOutcome]=useState(null),[cacheBlocked,setCacheBlocked]=useState(false);
 const [taskId,setTaskId]=useState(snapshot?.ledger?.tasks.find(t=>!t.archived)?.id??''),[checkId,setCheckId]=useState('pp-tests');
 const [profileId,setProfileId]=useState('perfect-planner-checks-v1'),[categories,setCategories]=useState(['tests','build','secrets']);
 const [savedSetup,setSavedSetup]=useState(null);
 const [attemptProgress,setAttemptProgress]=useState(null),[progressError,setProgressError]=useState('');
 const executionOriginal=useRef(null);
 const alive=useRef(true),inflight=useRef(false),reviewOriginal=useRef(null),reviewCompleted=useRef(false);
 const cacheKey=host?`pp-check-setup-ref-v1:${host.binding.projectId}:${host.binding.rootIdentity}:${host.binding.censusDigest}`:null;
 useEffect(()=>{alive.current=true;try{const original=cacheKey&&localStorage.getItem(cacheKey+':review');if(original){const parsed=JSON.parse(original);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)){reviewOriginal.current=parsed;setSavedReview(parsed);}}const ref=cacheKey&&localStorage.getItem(cacheKey);if(ref&&/^[a-f0-9]{64}$/.test(ref)){setReference(ref);setNote('Saved reference restored. Refresh status to verify it.');}}catch{setNote('Reference cache unavailable. Your native setup has not been deleted.');}return()=>{alive.current=false;};},[cacheKey]);
 useEffect(()=>{try{const raw=cacheKey&&localStorage.getItem(cacheKey+':execution');if(raw){if(raw.length>16384)throw Error('invalid');const value=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid');executionOriginal.current=value;setSavedExecution(value);}}catch{setCacheBlocked(true);setCacheWarning('Saved execution reference is unavailable. Resolve it before starting another check; native work has not been cleared.');}},[cacheKey]);
 async function perform(action){if(inflight.current||disabled||!host?.available)return;inflight.current=true;setBusy(true);setError('');setNote('');try{await action();}catch(e){if(alive.current){setState(null);setApproval(null);setError(e.message);}}finally{inflight.current=false;if(alive.current)setBusy(false);}}
 const active=snapshot?.ledger?.tasks.filter(t=>!t.archived)??[];
 const ready=host?.available&&!busy&&!disabled;
 const pending=state?.retainedOriginal;
 const executionPending=Boolean(savedExecution&&!outcome&&executionReceipt?.receipt.state!=='not-started')||cacheBlocked;
 const checkOptions=(savedSetup?.assignments.find(a=>a.taskId===taskId)?.categories??[]).map(category=>({id:`${savedSetup.profileId==='npm-project-checks-v1'?'npm':'pp'}-${category}`,label:checkLabels[category]}));
 const selectedCheck=checkOptions.some(check=>check.id===checkId)?checkId:checkOptions[0]?.id??'';
 const selectionMatches=(value)=>value&&value.setupReference===reference&&value.expected?.hostRevision===snapshot?.observedHead?.hostRevision&&value.expected?.headDigest===snapshot?.observedHead?.headDigest&&value.contractHead?.revision===state?.contractHead?.revision&&value.contractHead?.headDigest===state?.contractHead?.headDigest;
 const approved=approval?.confirmation.status==='approved'&&selectionMatches(approval.original);
 function remember(ref){setReference(ref);try{localStorage.setItem(cacheKey,ref);setCacheWarning('');}catch{setCacheWarning('Setup saved natively, but its reference could not be cached. Copy the reference below before closing.');}}
 const inspect=()=>perform(async()=>{const value=await host.inspect(reference);if(alive.current){setState(value);setSavedSetup(value.setup);setNote('Status read from native storage. This is not approval or a live connection.');}});
 const choose=()=>perform(async()=>{setApproval(null);if(!categories.length)throw Error('Select at least one check to prepare.');const value=await host.choose(active.map(task=>({taskId:task.id,categories})),profileId);if(!alive.current)return;if(value.selectionState==='cancelled'){setNote('Selection cancelled. Existing setup unchanged.');return;}remember(value.setupReference);setSavedSetup(null);setState(null);setNote('Setup saved. Refresh status before preparing checks.');});
 const prepare=()=>perform(async()=>{
  const input=pending?{setupReference:pending.setupReference,expected:pending.expected,originalRequest:pending.originalRequest}:{setupReference:reference,expected:snapshot.observedHead,originalRequest:{requestId:crypto.randomUUID(),expectedRevision:state.contractHead.revision,expectedHeadDigest:state.contractHead.headDigest}};
  setState(null);setSavedSetup(null);setApproval(null);const receipt=await host.prepare(input);
  if(alive.current){remember(input.setupReference);setNote(`Checks prepared at revision ${receipt.contractHead.revision}${receipt.idempotent?' — original result recovered without duplication':''}. Not approved or executed. Refresh status to inspect again.`);}
 });
 async function requestReview(method){
  // A previous terminal answer cannot settle a later uncertain attempt.
  reviewCompleted.current=false;
  try{const receipt=await host[method](reviewOriginal.current);if(alive.current)reviewCompleted.current=true;return receipt;}
  catch(error){
   if(alive.current&&error.code==='NATIVE_CHECK_REVIEW_NOT_STARTED'&&error.requiresRecovery===false&&error.requestMayHaveCommitted===false)reviewCompleted.current=true;
   throw error;
  }
 }
 const review=()=>perform(async()=>{
  const selected={setupReference:reference,expected:snapshot.observedHead,contractHead:state.contractHead};
  const previous=reviewOriginal.current;
    const changed=previous&&JSON.stringify([previous.setupReference,previous.expected,previous.contractHead])!==JSON.stringify([selected.setupReference,selected.expected,selected.contractHead]);
  if(changed&&!reviewCompleted.current)throw Error('Recover the saved review before starting a different review. Its original request is preserved below.');
  if(!previous||changed){reviewOriginal.current={...selected,requestId:crypto.randomUUID()};reviewCompleted.current=false;setSavedReview(reviewOriginal.current);try{localStorage.setItem(cacheKey+':review',JSON.stringify(reviewOriginal.current));}catch{setCacheWarning('Review request cache is unavailable. Copy the saved review request below before closing.');}}
  setApproval(null);const receipt=await requestReview('review');
  if(alive.current){setApproval({original:reviewOriginal.current,confirmation:receipt.confirmation});setNote(`Native review ${receipt.confirmation.status}${receipt.retainedResult?' — retained original decision':''}. No task was executed.`);}
 });
 const recoverReview=()=>perform(async()=>{
  setApproval(null);const receipt=await requestReview('recoverReview');
  if(alive.current){setApproval({original:reviewOriginal.current,confirmation:receipt.confirmation});setNote(`Saved native review ${receipt.confirmation.status}. ${receipt.recoveredSession?'Interrupted session recovered. ':'Original decision read. '}No task was executed.`);}
 });
 async function readOutcome(receipt,original){
  if(alive.current){setAttemptProgress(null);setProgressError('');}
  if(receipt.receipt.state==='not-started'){if(alive.current){setOutcome(null);setNote('The saved check did not start. Its original request and recovery proof are retained. You can start a new approved attempt.');}return;}
  if(!results?.available)throw Error('Result reader unavailable. Keep the saved request and recover its result.');
  if(receipt.receipt.kind==='NATIVE_TASK_EXECUTION_RECEIPT'){
   const value=await readNativeTaskBatchOutcome(results,receipt.receipt,original);
   if(alive.current){setOutcome(value);setNote('All recorded check results match this saved task attempt. Review each outcome below; the task remains unverified.');}return;
  }
  const value=await results.read({grantId:receipt.receipt.grantId});
  if(value.runId!==receipt.receipt.runId||value.intentDigest!==receipt.receipt.intentDigest||value.artifactDigest!==receipt.receipt.artifactDigest||value.taskId!==original.taskId||value.checkId!==original.checkId||value.attemptId!==original.attemptId||value.attemptNumber!==original.attemptNumber)throw Error('Result does not match the saved check request. Keep the original for recovery.');
  if(alive.current){setOutcome(value);setNote(receipt.retainedResult?'Saved check result recovered. No check was started by recovery.':'Check result saved. Review the outcome below.');}
 }
 const execute=(batch=false)=>perform(async()=>{
  if(!approved||executionPending||pending||!selectedCheck||!active.some(t=>t.id===taskId))throw Error('Refresh the exact approval and resolve any saved check before running.');
  const previous=executionOriginal.current;
  const input={...approval.original,requestId:crypto.randomUUID(),confirmationId:approval.confirmation.id,taskId,...(batch?{}:{checkId:selectedCheck}),attemptId:crypto.randomUUID(),attemptNumber:previous?previous.attemptNumber+1:1};
  if(!Number.isSafeInteger(input.attemptNumber)||input.attemptNumber<1)throw Error('Attempt history is unavailable. Recover the original check.');
  try{localStorage.setItem(cacheKey+':execution',JSON.stringify(input));}catch{throw Error('Request reference could not be saved. The check was not started.');}
  executionOriginal.current=input;setSavedExecution(input);setExecutionReceipt(null);setOutcome(null);setAttemptProgress(null);setProgressError('');
  const receipt=await host[batch?'executeTask':'execute'](input);if(!alive.current)return;setExecutionReceipt(receipt);await readOutcome(receipt,input);
 });
 const recoverExecution=()=>perform(async()=>{
  setOutcome(null);setExecutionReceipt(null);const original=executionOriginal.current;
  const receipt=await host[Object.hasOwn(original??{},'checkId')?'recoverExecution':'recoverTaskExecution'](original);if(!alive.current)return;setExecutionReceipt(receipt);await readOutcome(receipt,original);
 });
 const inspectAttempt=()=>perform(async()=>{
  setAttemptProgress(null);setProgressError('');
  try{const value=await readNativeTaskAttemptProgress(results,executionOriginal.current);if(alive.current)setAttemptProgress(value);}
  catch{if(alive.current)setProgressError('Saved attempt history could not be read. The original request remains unresolved; no checks were restarted.');}
 });
 return <section className="task-draft-delivery" aria-label="Native check setup">
  <h3>Set up and run checks</h3><p>Choose the repository checks to prepare, review their exact scripts in the native dialog, then run an approved check.</p>
  {!host?.available&&<p>Available in the desktop app for a registered project.</p>}
  <p>{active.length} active shared tasks · setup is not approval</p>
  <fieldset disabled={!ready||Boolean(pending)||executionPending} style={{margin:'16px 0',padding:16,border:'1px solid #aaa',borderRadius:8}}>
   <legend>New check setup</legend>
   <label>Repository profile <select aria-label="Repository profile" value={profileId} onChange={e=>{setProfileId(e.target.value);setCategories(e.target.value==='npm-project-checks-v1'?['tests']:['tests','build','secrets']);}}><option value="perfect-planner-checks-v1">Perfect Planner checks</option><option value="npm-project-checks-v1">Repository npm scripts</option></select></label>
   <p>{profileId==='npm-project-checks-v1'?'Select scripts already defined in this repository’s package.json. A package-lock.json is required. Preparation records the scripts; it does not install dependencies or run them.':'Uses Perfect Planner’s exact script definitions.'}</p>
   {Object.keys(checkLabels).map(category=><label key={category} style={{display:'inline-block',marginRight:20}}><input type="checkbox" aria-label={`Prepare ${checkLabels[category].toLowerCase()}`} checked={categories.includes(category)} onChange={e=>setCategories(current=>e.target.checked?[...current,category]:current.filter(c=>c!==category))}/>{checkLabels[category]} · npm run {scriptNames[category]}</label>)}
   <p>These choices apply when you choose the npm tool. An existing saved setup keeps its original checks.</p>
  </fieldset>
  {savedSetup&&<p aria-label="Verified check setup">Saved setup: {savedSetup.profileId==='npm-project-checks-v1'?'Repository npm scripts':'Perfect Planner checks'} · read from native storage.</p>}
  <div className="task-draft-delivery-heading">
   <button type="button" disabled={!ready||!active.length||!categories.length||Boolean(pending)||executionPending} onClick={choose}>Choose npm tool…</button>
   <button type="button" disabled={!ready||!reference} onClick={inspect}>Refresh check status</button>
   <button type="button" disabled={!ready||!state||(!pending&&!active.length)||executionPending} onClick={prepare}>{pending?'Retry original preparation':'Prepare check definitions'}</button>
   <button type="button" disabled={!ready||!state||Boolean(pending)||!state.contractHead.revision||!snapshot?.observedHead?.hostRevision||executionPending} onClick={review}>Review prepared checks…</button>
   <button type="button" disabled={!ready||!savedReview} onClick={recoverReview}>Recover saved review</button>
  </div>
  <fieldset disabled={!ready} style={{margin:'16px 0',padding:16,border:'1px solid #aaa',borderRadius:8}}>
   <legend>Run an approved check</legend>
   <p>{executionPending?'A saved check needs recovery before another run.':approved?'Native approval matches these prepared checks. Run all approved checks for the task, or choose a single check.':'Refresh check status and obtain or recover native approval before running.'}</p>
   <div className="task-draft-delivery-heading">
    <label>Task <select aria-label="Check task" value={taskId} onChange={e=>setTaskId(e.target.value)} disabled={executionPending}>{active.map(t=><option key={t.id} value={t.id}>{t.id}{t.title?` — ${t.title}`:''}</option>)}</select></label>
    <label>Check <select aria-label="Check type" value={selectedCheck} onChange={e=>setCheckId(e.target.value)} disabled={executionPending||!checkOptions.length}>{!checkOptions.length&&<option value="">Refresh the saved setup</option>}{checkOptions.map(check=><option key={check.id} value={check.id}>{check.label}</option>)}</select></label>
    <button type="button" disabled={!approved||executionPending||Boolean(pending)||!taskId||!selectedCheck||!results?.available} onClick={()=>execute(true)}>Run all approved task checks</button>
    <button type="button" disabled={!approved||executionPending||Boolean(pending)||!taskId||!selectedCheck||!results?.available} onClick={()=>execute(false)}>{outcome?'Run a new check attempt':'Run selected check'}</button>
    <button type="button" disabled={!savedExecution||cacheBlocked} onClick={recoverExecution}>Recover saved check</button>
    <button type="button" disabled={!savedExecution||cacheBlocked||!results?.available} onClick={inspectAttempt}>Inspect saved attempt</button>
   </div>
   {savedExecution&&<p>{savedExecution.taskId} · {savedExecution.checkId??'All approved task checks'} · request attempt {savedExecution.attemptNumber}. {executionReceipt?(executionReceipt.receipt.state==='not-started'?'Native recovery confirms the check did not start.':'Native result receipt retained.'):'Execution outcome has not been confirmed in this view.'}</p>}
   {outcome?.batch&&<div aria-label="Task check results" role="status"><strong>{outcome.checks.length} check results recorded — task unverified</strong><ul>{outcome.checks.map(check=><li key={check.grantId}>{check.checkId}: {check.state==='failure-observed'?'Failed':'Returned'} · exit {check.exitCode??'unknown'}{check.failureReasons.length?` · ${check.failureReasons.join(' · ')}`:''}</li>)}</ul><p>Review failures and required evidence before completing this task.</p></div>}
   {attemptProgress&&<div aria-label="Saved attempt progress" role="status"><strong>Recorded attempt history — completion unconfirmed</strong><p>This is a saved observation, not live worker activity. Checks without a record may not have started. Recover the original request before another run.</p>{attemptProgress.checks.length?<ul>{attemptProgress.checks.map(check=><li key={check.grantId}>{check.checkId}: {check.outcome?`${check.outcome.state==='failure-observed'?'Failed':'Returned — unverified'} · exit ${check.outcome.exitCode??'unknown'}`:`${check.lifecycleState} — result unavailable`}</li>)}</ul>:<p>No check records were found for this attempt. This does not prove that execution never started.</p>}</div>}
   {progressError&&<p role="alert">{progressError}</p>}
   {outcome&&!outcome.batch&&<div aria-label="Selected check result" role="status"><strong>{outcome.state==='failure-observed'?'Check failed':'Check returned — task unverified'}</strong><p>Observed exit: {outcome.exitCode??'not recorded'}. {outcome.failureReasons.join(' · ')}</p><p>{outcome.state==='failure-observed'?'Review the failure before starting a new attempt.':'Verify the required evidence before completing the task.'} This result does not mark the task complete.</p></div>}
  </fieldset>
  {reference&&<details><summary>Saved setup reference</summary><p style={{overflowWrap:'anywhere',userSelect:'all'}}>{reference}</p><p>This identifier is not a key or permission. Native storage verifies it.</p></details>}
  {state&&<p>Read check revision {state.contractHead.revision}. {pending?'An original request is outstanding. Retry preserves its exact setup and revision.':'No outstanding preparation recorded.'}</p>}
  {savedReview&&<details><summary>Saved review request</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',userSelect:'all'}}>{JSON.stringify(savedReview,null,2)}</pre><p>This is a request reference, not approval or permission.</p></details>}
  {savedExecution&&<details><summary>Saved check request</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',userSelect:'all'}}>{JSON.stringify(savedExecution,null,2)}</pre><p>Keep this exact request if the outcome is unknown. Recovery does not start another check.</p>{executionReceipt&&<p>{executionReceipt.receipt.state==='not-started'?<>Recovery proof: {executionReceipt.receipt.proofDigest}</>:<>{executionReceipt.receipt.kind==='NATIVE_TASK_EXECUTION_RECEIPT'?<>Task check set: {executionReceipt.receipt.checkSetDigest}</>:<>Grant: {executionReceipt.receipt.grantId} · Run: {executionReceipt.receipt.runId}</>}</>}</p>}</details>}
  {busy&&<p role="status">Waiting for native check request… Running checks may take several minutes.</p>}
  {note&&<p role="status">{note}</p>}{error&&<p role="alert">{error} Refresh status before attempting another preparation.</p>}
  {cacheWarning&&<p role="alert">{cacheWarning}</p>}
 </section>;
}




