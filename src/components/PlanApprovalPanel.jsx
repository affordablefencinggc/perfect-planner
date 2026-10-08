import {useEffect,useMemo,useRef,useState} from 'react';
import {createPlanningClient} from '../runtime/planningClient.js';
import {createPlanningApprovalRecovery} from '../project/planningApprovalRecovery.js';
import {createPlanApprovalDraft} from '../project/planApprovalDraft.js';
import {sameTaskDraftBinding,inspectTaskDraft} from '../project/taskDraftLedger.js';
import {canonicalArchitectureJson as canonical} from '../engine/architectureContractVerification.js';
import './PlanApprovalPanel.css';
import {useOptionalProject} from '../project/ProjectProvider.jsx';
import {recordPlanApproval} from '../project/planApproval.js';

// Unsent mapping choices survive navigation only. Full requests enter durable
// recovery storage before any submission; this map is never an approval store.
const choices=new Map();
const keyOf=binding=>`${binding.projectId}:${binding.rootIdentity}:${binding.censusDigest}`;
const newId=()=>globalThis.crypto.randomUUID();
const same=(a,b)=>canonical(a)===canonical(b);
const sameOriginal=(a,b)=>Boolean(a&&b&&a.kind===b.kind&&a.requestId===b.requestId&&same(a.input,b.input));

export function PlanApprovalPanel({project,binding,ledger,store,dirty,disabled}){
 return <BoundPlanApprovalPanel key={keyOf(binding)} {...{project,binding,ledger,store,dirty,disabled}}/>;
}
function BoundPlanApprovalPanel({project,binding,ledger,store,dirty,disabled}){
 const projectContext=useOptionalProject(),invalidatePlan=projectContext?.invalidatePlan,refreshPlan=projectContext?.refreshPlan;
 const sharedStatus=projectContext?.planStatuses?.[binding.projectId]??projectContext?.planRefreshStatus;
 const sharedMatches=(status,checked)=>status?.state==='observed'&&status.projectId===binding.projectId&&status.rootIdentity===binding.rootIdentity&&status.censusDigest===binding.censusDigest&&status.revision===checked.observedApprovalHead.revision&&status.digest===checked.observedApprovalHead.headDigest&&status.checkedLedger&&same(status.checkedLedger,checked.record.proposal.ledger);
 async function checkShared(checked){if(!refreshPlan)return;const result=await refreshPlan(binding.projectId);if(!sharedMatches({...result,state:result?.status},checked))throw Error('Shared planning check is unavailable or changed. The saved approval remains historical until checked again.');}
 const client=useMemo(()=>createPlanningClient(),[]),recovery=useMemo(()=>createPlanningApprovalRecovery(),[]);
 const [context,setContext]=useState(null),[hostLedger,setHostLedger]=useState(null),[history,setHistory]=useState(null),[current,setCurrent]=useState(null);
 const [pending,setPending]=useState(null),[recoveryReady,setRecoveryReady]=useState(false),[mappings,setMappings]=useState(()=>choices.get(keyOf(binding))??{});
 const [review,setReview]=useState(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [withdrawConfirmed,setWithdrawConfirmed]=useState(false),[resolvedHistory,setResolvedHistory]=useState([]);
 const alive=useRef(true),generation=useRef(0),inflight=useRef(0),latest=useRef(null);
 const signature=canonical({binding,ledger,dirty,disabled});latest.current=signature;
 const pendingIdentity=pending?canonical({kind:pending.kind,requestId:pending.requestId,input:pending.input}):null;
 useEffect(()=>{setWithdrawConfirmed(false);},[pendingIdentity]);
 useEffect(()=>{setReview(null);setConfirmed(false);setWithdrawConfirmed(false);setCurrent(null);setNotice('');generation.current++;},[signature]);
 useEffect(()=>{if(refreshPlan&&current&&!sharedMatches(sharedStatus,current)){setCurrent(null);setNotice('Shared planning status changed. Previous approval is historical until checked again.');}},[sharedStatus,current,refreshPlan]);
 useEffect(()=>{invalidatePlan?.(binding.projectId,{dirty:Boolean(dirty),reason:'ledger-context-changed'});},[signature,invalidatePlan,binding.projectId]);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;};},[]);
 // A checked planning-ledger approval is also this project's saved plan approval.
 useEffect(()=>{if(current&&!blocked&&!pending&&(!refreshPlan||sharedMatches(sharedStatus,current)))void recordPlanApproval(binding.projectId,{tasks:current.record.proposal.ledger.tasks,censusDigest:binding.censusDigest,source:'planning-ledger',ledgerRevision:current.observedApprovalHead.revision}).catch(()=>{});},[current]);
 const blocked=disabled||dirty||!ledger||!sameTaskDraftBinding(ledger.binding,binding);
 const findings=useMemo(()=>ledger?inspectTaskDraft(ledger):null,[ledger]);
 const begin=()=>{invalidatePlan?.(binding.projectId,{reason:'planning-review-in-progress'});const number=++generation.current,operation=++inflight.current,captured=latest.current;setBusy(true);setError('');const valid=()=>alive.current&&generation.current===number&&latest.current===captured;valid.finish=()=>{if(alive.current&&inflight.current===operation)setBusy(false);};return valid;};
 const failure=(err,valid)=>{if(valid()){setError(err?.message??'Planning service unavailable. Original requests were kept.');setReview(null);setConfirmed(false);setCurrent(null);}};
 async function readSaved(expected){const saved=await store.read(binding);if(!sameTaskDraftBinding(saved.binding,binding)||!same(saved,expected))throw Error('The saved ledger changed. Refresh task drafts and review again; your original request was kept.');return saved;}
 async function loadRecovery(valid){const state=await recovery.inspect(binding);if(valid()){if(state.pending)invalidatePlan?.(binding.projectId,{reason:'pending-original'});setPending(state.pending);setResolvedHistory(state.completed.filter(item=>item.resolution));setRecoveryReady(true);}return state;}
 async function refresh(){
  if(!ledger)return;
  const valid=begin();setReview(null);setConfirmed(false);setWithdrawConfirmed(false);setCurrent(null);setContext(null);
  try{
   const recoveryState=await loadRecovery(valid);if(!valid())return;
   const nextContext=await client.readContext(binding.projectId);if(!valid())return;
   const nextLedger=await client.inspectLedger(binding);if(!valid())return;
   const nextHistory=nextLedger.observedHead.hostRevision>0?await client.inspectApprovals(binding):null;if(!valid())return;
   setContext(nextContext);setHostLedger(nextLedger);setHistory(nextHistory);
   if(recoveryState.pending){setNotice('Saved history is retained, but the original pending request must be reconciled before checking current approval.');}
   else if(blocked){setNotice('Saved history can be inspected, but unfinished edits or stale inventory prevent a current approval check.');}
   else if(nextHistory?.observedApprovalHead.revision>0){
    try{const checked=await client.inspectCurrent(binding,nextHistory.observedApprovalHead);if(!valid())return;await readSaved(ledger);if(!valid())return;if(!same(checked.record.proposal.ledger,ledger))throw Error('Local draft differs from saved approval');await checkShared(checked);if(!valid())return;setCurrent(checked);}
    catch{if(valid())setNotice('Saved approval history is retained, but its current planning references could not be verified.');}
   }else setNotice('No saved plan approval. Map the tasks and review before approving.');
  }catch(err){failure(err,valid);}finally{valid.finish();}
 }
 useEffect(()=>{const captured=latest.current,number=generation.current;const valid=()=>alive.current&&generation.current===number&&latest.current===captured;loadRecovery(valid).catch(err=>{if(valid()){setRecoveryReady(false);setError(`Recovery storage unavailable. Nothing can be sent. ${err.message}`);}});},[recovery]);
 function changeMapping(taskId,id,checked){const next={...mappings,[taskId]:checked?[...(mappings[taskId]??[]),id]:(mappings[taskId]??[]).filter(value=>value!==id)};choices.set(keyOf(binding),next);setMappings(next);generation.current++;setReview(null);setConfirmed(false);setCurrent(null);}
 async function reviewDraft(){
  if(blocked||busy||pending)return;const valid=begin();setReview(null);setConfirmed(false);setCurrent(null);
  try{
   const saved=await readSaved(ledger);if(!valid())return;
   const fresh=await client.readContext(binding.projectId);if(!valid())return;setContext(fresh);
   if(fresh.state!=='ready'||fresh.catalogState!=='current'||!fresh.catalog)throw Error('Approve current architecture, folders and components before reviewing this plan.');
   const packet=await createPlanApprovalDraft({ledger:saved,parents:{architecture:{digest:fresh.architectureHead.contractDigest,revision:fresh.architectureHead.revision},folder:{digest:fresh.folderHead.contractDigest,revision:fresh.folderHead.revision},component:{digest:fresh.catalogHead.contractDigest,revision:fresh.catalogHead.revision}},catalog:fresh.catalog,mappings:saved.tasks.filter(task=>!task.archived).map(task=>({taskId:task.id,componentIds:mappings[task.id]??[]}))});if(!valid())return;
   if(packet.dependencyReview.some(item=>item.status!=='ordered'))throw Error('Component dependency ordering still needs review in the Ledger. No approval was prepared.');
   setReview(packet);setNotice('Full saved ledger reviewed. Confirm below to retain and approve this exact plan.');
  }catch(err){failure(err,valid);}finally{valid.finish();}
 }
 async function sendOriginal(original,valid){
  if(original.resolution)throw Error('This request has withdrawal intent. Resume its resolution instead of publishing.');
  // Callers have already awaited durable prepare or loaded this exact original.
  const receipt=original.kind==='ledger'?await client.submitLedger(original.input):await client.publishApproval(original.input);
  await recovery.complete(binding,original.requestId,receipt);
  if(valid())await loadRecovery(valid);
  return receipt;
 }
 async function approve(){
  if(blocked||busy||!review||!confirmed||pending||!recoveryReady)return;
  const valid=begin(),packet=review;setCurrent(null);
  try{
   await readSaved(packet.ledger);if(!valid())return;
   const state=await loadRecovery(valid);if(!valid())return;if(state.pending)throw Error('Recover the original pending request before preparing another.');
   const observed=await client.inspectLedger(binding);if(!valid())return;
   const ledgerInput={ledger:packet.ledger,request:{requestId:newId(),expectedRevision:observed.observedHead.hostRevision,expectedHeadDigest:observed.observedHead.headDigest},expectedCensusDigest:observed.declaredBinding?.censusDigest??null};
   const original=await recovery.prepare(binding,{kind:'ledger',input:ledgerInput});if(!valid())return;setPending(original);
   const retained=await sendOriginal(original,valid);if(!valid())return;setHostLedger(retained);
   if(!retained.submittedMatchesObservedHead)throw Error('Your ledger was retained historically, but another revision is current. Review the latest state before approval.');
   await readSaved(packet.ledger);if(!valid())return;
   const approvals=await client.inspectApprovals(binding);if(!valid())return;
   const input={binding,proposal:packet,expectedProposalHead:retained.observedHead,request:{requestId:newId(),expectedRevision:approvals.observedApprovalHead.revision,expectedHeadDigest:approvals.observedApprovalHead.headDigest},confirmation:{proposalDigest:packet.digest,decision:'approve'}};
   const prepared=await recovery.prepare(binding,{kind:'approval',input});if(!valid())return;setPending(prepared);
   const published=await sendOriginal(prepared,valid);if(!valid())return;
   const checked=await client.inspectCurrent(binding,published.observedApprovalHead);if(!valid())return;
   if(!same(checked.record.proposal,packet)||!published.matchesObservedApprovalHead)throw Error('Approval was retained but current readback needs reconciliation. Refresh saved planning.');
   const savedHistory=await client.inspectApprovals(binding);if(!valid())return;await checkShared(checked);if(!valid())return;setCurrent(checked);setHistory(savedHistory);setReview(null);setConfirmed(false);setNotice('Plan approval saved and checked against its current references. No work was executed.');
  }catch(err){failure(err,valid);}finally{valid.finish();}
 }
 async function retry(){
  if(pending?.resolution){return resolvePending();}
  if(blocked||busy||!pending)return;const displayed=pending,valid=begin();setCurrent(null);setConfirmed(false);setReview(null);
  try{
   const state=await loadRecovery(valid);if(!valid())return;if(!state.pending)throw Error('No pending original remains. Refresh saved planning.');
   if(!sameOriginal(displayed,state.pending))throw Error('The pending original changed in another session. Review the displayed request before continuing.');
   const original=state.pending;
   if(original.kind==='approval'){
    const retained=await client.inspectApprovals(binding);if(!valid())return;
    const record=retained.records.find(item=>same(item.request,original.input.request)&&same(item.proposal,original.input.proposal)&&same(item.expectedProposalHead,original.input.expectedProposalHead)&&same(item.confirmation,original.input.confirmation));
    if(record){
     // A readable journal entry is not a durable mutation receipt. Re-send
     // the exact original so the host re-flushes its idempotent record.
     await sendOriginal(original,valid);if(!valid())return;setHistory(retained);setNotice('Original approval found in retained history. Reconciled only; it does not approve newer local edits.');return;
    }
    await readSaved(original.input.proposal.ledger);if(!valid())return;
   }
   const result=await sendOriginal(original,valid);if(!valid())return;
   setNotice(original.kind==='ledger'?'Original ledger request reconciled. Review again before approving.':'Original approval request reconciled. Its receipt is historical until refreshed and checked.');
   if(original.kind==='approval'){const savedHistory=await client.inspectApprovals(binding);if(valid())setHistory(savedHistory);}else setHostLedger(result);
  }catch(err){failure(err,valid);}finally{valid.finish();}
 }
 async function resolvePending(){
  if(busy||!recoveryReady||!['approval','ledger'].includes(pending?.kind)||(!pending.resolution&&!withdrawConfirmed))return;
  const displayed=pending,valid=begin();setCurrent(null);setConfirmed(false);setReview(null);setWithdrawConfirmed(false);
  try{
   const state=await loadRecovery(valid);if(!valid())return;if(!['approval','ledger'].includes(state.pending?.kind))throw Error('No original planning request remains to resolve.');
   if(!sameOriginal(displayed,state.pending))throw Error('The pending original changed in another session. Review the displayed request before continuing.');
   const original=state.pending.resolution?state.pending:await recovery.prepareResolution(binding,state.pending.requestId);if(!valid())return;setPending(original);
   const {binding:ignoredBinding,...publishInput}=original.input;
   const receipt=original.kind==='ledger'?await client.resolveLedger({original:original.input,confirmation:original.resolution}):await client.resolveApproval({binding,original:publishInput,confirmation:original.resolution});
   await recovery.completeResolution(binding,original.requestId,receipt);if(!valid())return;await loadRecovery(valid);if(!valid())return;
   setNotice(original.kind==='ledger'?(receipt.outcome==='withdrawn'?'Unpublished ledger request withdrawn. Its full history and your local draft are kept; review again before submitting.':'The original ledger was already submitted. Its durable historical receipt is kept; no plan was approved.'):(receipt.outcome==='withdrawn'?'Unpublished approval withdrawn. Its full history is kept; review your latest draft before approving again.':'The original approval was already published. Its durable historical receipt is kept; newer edits are not approved.'));
  }catch(err){failure(err,valid);}finally{valid.finish();}
 }
 const active=ledger?.tasks.filter(task=>!task.archived)??[],catalog=context?.catalog;
 return <section className="plan-approval-panel" aria-label="Review and approve saved plan">
  <header><div><h3>Review and approve the plan</h3><p>Your Ledger keeps every obligation. Approval records the exact saved tasks and planning references—not permission to run code.</p></div><button type="button" onClick={refresh} disabled={busy||!ledger}>Refresh saved planning</button></header>
  {blocked&&<p className="plan-approval-warning">Save unfinished edits and resolve stale folder inventory before continuing.</p>}
  {!ledger?<p>Opening saved tasks. Planning refresh will be available when the ledger has loaded.</p>:!context&&<p>Refresh to check saved architecture, folders, components and approval history.</p>}
  {error&&<p role="alert" className="plan-approval-error">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {current&&!blocked&&!pending&&(!refreshPlan||sharedMatches(sharedStatus,current))&&<p className="plan-approval-current">Checked plan approval revision {current.observedApprovalHead.revision}. Planning only; execution remains separate.</p>}
  {history?.records?.length>0&&<details><summary>Saved approval history · {history.records.length} records</summary><p>Retained history alone does not prove current references.</p>{history.records.map(record=><p key={record.recordHash}>Revision {record.revision} · saved {record.approvedAt} · ledger revision {record.proposal.ledger.revision}</p>)}</details>}
  {hostLedger&&<p>Retained host ledger revision {hostLedger.observedHead.hostRevision}. Browser-declared inventory; filesystem access is not verified.</p>}
  {pending&&<section className="plan-approval-warning" aria-label="Pending planning request"><h4>Original request needs reconciliation</h4><p>{pending.kind==='ledger'?'Ledger submission':'Plan approval'} · {pending.requestId}. The original request is retained; it will not be replaced.</p><button type="button" onClick={retry} disabled={busy||(!pending.resolution&&blocked)}>{pending.resolution?'Retry original withdrawal resolution':'Retry original planning request'}</button>{!pending.resolution&&<div><label><input type="checkbox" checked={withdrawConfirmed} disabled={busy||!recoveryReady} onChange={event=>setWithdrawConfirmed(event.target.checked)}/>{pending.kind==='ledger'?'Withdraw this unpublished ledger request; keep its history':'Withdraw this unpublished approval request; keep its history'}</label><button type="button" onClick={resolvePending} disabled={busy||!recoveryReady||!withdrawConfirmed}>{pending.kind==='ledger'?'Resolve ledger withdrawal':'Resolve approval withdrawal'}</button></div>}{pending.kind==='ledger'&&/STALE_HEAD|CENSUS|LOCAL_REVISION/.test(error)&&<p>The saved host version or folder inventory differs from this original request. Keep your local edits. Withdraw the unpublished original, then refresh and review again. The exact diagnostic above is retained.</p>}<details><summary>Original request — select and copy</summary><pre tabIndex={0}>{JSON.stringify(pending,null,2)}</pre></details></section>}
  {resolvedHistory.length>0&&<details><summary>Resolved request history · {resolvedHistory.length} records</summary><p>These retained outcomes do not approve newer edits or authorize execution.</p>{resolvedHistory.map(item=><details key={item.requestId}><summary>{item.requestId} · {item.receipt.outcome}</summary><pre tabIndex={0}>{JSON.stringify(item,null,2)}</pre></details>)}</details>}
  {findings?.findings.length>0&&<details><summary>{findings.findings.length} Ledger findings must be resolved</summary>{findings.findings.map((finding,index)=><p key={index}>{finding.detail}</p>)}</details>}
  {catalog&&<fieldset disabled={blocked||busy||Boolean(pending)}><legend>Connect each active task to its components</legend><p>No mappings are assumed. Every approved component and file obligation must be covered.</p>{active.map(task=><div className="plan-approval-mapping" key={task.id}><strong>{task.id} · {task.title}</strong><div>{catalog.components.map(component=><label key={component.id}><input type="checkbox" checked={(mappings[task.id]??[]).includes(component.id)} onChange={event=>changeMapping(task.id,component.id,event.target.checked)}/>{component.id} · {component.name}</label>)}</div></div>)}</fieldset>}
  <button type="button" onClick={reviewDraft} disabled={blocked||busy||Boolean(pending)||!recoveryReady||!catalog||!active.length||Boolean(findings?.findings.length)}>Review full saved plan</button>
  {review&&<section className="plan-approval-review" aria-label="Full plan approval review"><h4>Review saved ledger revision {review.ledger.revision}</h4><p>{review.ledger.tasks.length} tasks retained, including {review.ledger.tasks.filter(task=>task.archived).length} archived tasks.</p><dl>{Object.entries(review.parents).map(([kind,head])=><div key={kind}><dt>{kind} · revision {head.revision}</dt><dd>{head.digest}</dd></div>)}</dl>{review.ledger.tasks.map(task=><details key={task.id}><summary>{task.id} · {task.title}{task.archived?' · archived':''}</summary><p>{task.description}</p><p>Owner: {task.owner} · Dependencies: {task.dependsOn.join(', ')||'none'}</p><p>Mapped components: {review.mappings.find(mapping=>mapping.taskId===task.id)?.componentIds.join(', ')||'Archived — no active mapping'}</p><pre tabIndex={0}>{task.claims.map(claim=>`${claim.access} ${claim.path}`).join('\n')||'No file claims'}</pre><p>Acceptance: {task.acceptance}</p><p>Recovery: {task.recovery}</p></details>)}<label className="plan-approval-confirm"><input type="checkbox" checked={confirmed} disabled={busy||blocked} onChange={event=>setConfirmed(event.target.checked)}/>I reviewed these exact tasks, mappings and planning references. Record planning approval only.</label><button type="button" onClick={approve} disabled={!confirmed||busy||blocked||Boolean(pending)}>Approve saved plan</button></section>}
 </section>;
}
