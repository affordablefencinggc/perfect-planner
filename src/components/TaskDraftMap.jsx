import { useEffect, useMemo, useRef, useState } from 'react';
import { sameTaskDraftBinding, taskDraftBinding } from '../project/taskDraftLedger.js';
import { projectTaskDraftMap, taskDraftLink, taskDraftConnectionPoints } from '../project/taskDraftMap.js';
import { createTaskDraftStore } from '../project/taskDraftStore.js';
import {useOptionalProject} from '../project/ProjectProvider.jsx';
import {canonicalArchitectureJson as canonical} from '../engine/architectureContractVerification.js';
import {digestPlanTasks, planApprovalStatus, savedPlanCheckText} from '../project/planApproval.js';
import {useProjectWorkRecords} from '../project/useProjectWorkRecords.js';
import './TaskDraftMap.css';

export function TaskDraftMap({project,records,onWorkspace,store}){
  let binding;try{binding=taskDraftBinding(project);}catch{return <section className="draft-map-panel"><h2>Plan at a glance</h2><p>Import your app folder before planning its work.</p></section>;}
  return <BoundMap key={`${binding.projectId}:${binding.rootIdentity}:${binding.censusDigest}`} binding={binding} project={project} onWorkspace={onWorkspace} providedStore={store} records={records}/>;
}
function BoundMap({binding,project,records:providedRecords,onWorkspace,providedStore}){
  // Read saved work records when the caller doesn't pass them, so the map still sees a Plan-page approval.
  const storedRecords=useProjectWorkRecords(binding.projectId),records=providedRecords??storedRecords;
  const projectContext=useOptionalProject(),planStatus=projectContext?.planStatuses?.[binding.projectId]??projectContext?.planRefreshStatus;
  const store=useMemo(()=>providedStore??createTaskDraftStore(),[providedStore]);
  const viewport=useRef(null),sequence=useRef(0),alive=useRef(false);
  const [width,setWidth]=useState(1100),[ledger,setLedger]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(true),[selected,setSelected]=useState(null);
  const model=useMemo(()=>ledger?projectTaskDraftMap(ledger,width):null,[ledger,width]);
  const stale=ledger&&!sameTaskDraftBinding(ledger.binding,binding);
  const planChecked=!busy&&!error&&!stale&&project.state!=='stale'&&project.state!=='unavailable'&&planStatus?.state==='observed'&&planStatus.projectId===binding.projectId&&planStatus.rootIdentity===binding.rootIdentity&&planStatus.censusDigest===binding.censusDigest&&planStatus.checkedLedger&&ledger&&canonical(planStatus.checkedLedger)===canonical(ledger);
  // The plan approved on the Plan page (a device-local work record) counts too, so the map
  // agrees with the Approved banner below it when no native planning check is available.
  const localApproval=planApprovalStatus(project,records),[ledgerDigest,setLedgerDigest]=useState(null);
  useEffect(()=>{let current=true;setLedgerDigest(null);if(ledger)digestPlanTasks(ledger.tasks).then(d=>{if(current)setLedgerDigest(d);}).catch(()=>{});return()=>{current=false;};},[ledger]);
  const localRecorded=!planChecked&&!busy&&!error&&!stale&&ledger&&localApproval?.state==='recorded'&&ledgerDigest!==null;
  const localApproved=localRecorded&&ledgerDigest===localApproval.record.planDigest;
  const localChanged=!planChecked&&ledger&&!stale&&(localApproval?.state==='review'||localApproval?.state==='stale'||(localRecorded&&!localApproved));
  const approvedIds=planChecked?null:localApproved?new Set(localApproval.record.taskIds):null;
  const isApproved=(id)=>planChecked||Boolean(approvedIds?.has(id));
  async function refresh(){const request=++sequence.current;setBusy(true);setError('');try{const next=await store.read(binding);if(alive.current&&request===sequence.current)setLedger(next);}catch(e){if(alive.current&&request===sequence.current)setError(e.message);}finally{if(alive.current&&request===sequence.current)setBusy(false);}}
  useEffect(()=>{alive.current=true;refresh();const unsubscribe=store.subscribe?.(binding,refresh);const onFocus=()=>refresh();window.addEventListener('focus',onFocus);return()=>{alive.current=false;sequence.current++;unsubscribe?.();window.removeEventListener('focus',onFocus);if(!providedStore)store.close().catch(()=>{});};},[store]);
  useEffect(()=>{const element=viewport.current;if(!element)return;const measure=()=>setWidth(Math.floor(element.clientWidth));measure();if(typeof ResizeObserver==='undefined')return;const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();},[]);
  function openTask(id){if(!ledger||stale)return;onWorkspace?.('ledger');if(typeof window!=='undefined')window.history.replaceState(window.history.state,'',taskDraftLink(window.location.href,binding,id));}
  const related=new Set(selected?[selected,...(model?.edges??[]).filter(e=>e.from===selected||e.to===selected).flatMap(e=>[e.from,e.to])]:[]);
  const byId=new Map(model?.nodes.map(node=>[node.id,node])??[]);
  const visibleEdges=model?(model.edges.length>800?model.edges.filter(edge=>edge.from===selected||edge.to===selected):model.edges):[];
  const pathFor=(from,to)=>taskDraftConnectionPoints(model,from,to).map((point,index)=>`${index?'L':'M'} ${point.x} ${point.y}`).join(' ');
  return <section className="draft-map-panel" aria-label="Project draft mind map">
    <header><div><h2>Plan at a glance</h2><p>Saved Ledger revision {model?.revision??'—'} · {model?.nodes.length??0} active drafts{model?.archived?` · ${model.archived} archived in Ledger`:''}</p></div><div className="draft-map-tools"><button type="button" onClick={refresh} disabled={busy}>Refresh map</button><button type="button" onClick={()=>onWorkspace?.('ledger')}>Open Ledger</button></div></header>
    <details className="draft-map-note"><summary>How to read this map</summary><p>Lines show recorded dependencies, not progress or permission to execute. Click a task for its full Ledger record. File conflicts and incomplete details still need review.</p></details>
    <p role="status">{busy?'Reading the saved draft…':error?'Map refresh failed; any displayed map is the last loaded revision.':`${model?.reviewCount??0} planning review findings · ${planChecked?'saved-plan check passed; no work executed or completed':localApproved?'plan approved on this device; saved-plan check not passed yet; no work executed or completed':localChanged?'tasks changed since the plan was approved; no work completed':localApproval?.state==='recorded'?'plan approved by you; saved-plan check not passed yet; no work completed':'no plan approved yet; no work completed'}`}</p>
    {(()=>{const copy=savedPlanCheckText({check:planStatus,approval:localApproval,checked:planChecked});const text=planChecked?copy.text:localChanged?'Tasks changed since the plan was approved. Approve the current tasks below.':localApproved?`Plan approved: ${localApproval.detail}. Run the saved-plan check to lock it to this exact Ledger.`:copy.text;return <div aria-label="Map planning approval"><p>{text}</p><p><small>{copy.explainer}</small></p><button type="button" disabled={!projectContext?.refreshPlan||busy||planStatus?.state==='refreshing'} onClick={()=>{void projectContext?.refreshPlan(binding.projectId);}}>{copy.action}</button></div>;})()}
    {error&&<p role="alert" className="draft-map-error">{error}</p>}
    {stale&&<p role="alert" className="draft-map-error">This draft belongs to an older folder census. It is shown for reference only. Review it in the Ledger.</p>}
    {model?.edges.length>800&&<p>Dense dependency map: focus or hover a task to show its connections. All {model.nodes.length} active tasks remain visible; full dependency lists are in the Ledger.</p>}
    <div ref={viewport} className="draft-map-viewport" tabIndex={0} role="region" aria-label="Scrollable task dependency map">
      {!busy&&model&&!model.nodes.length?<div className="draft-map-empty"><p>No active task drafts yet.</p><button type="button" onClick={()=>onWorkspace?.('ledger')}>Plan the first task in Ledger</button></div>:model&&<div className="draft-map-surface" style={{width:model.width,height:model.height}}>
        <div className="draft-map-root"><strong>{project.name}</strong><span>Local draft plan</span></div>
        <svg width={model.width} height={model.height} aria-hidden="true" className="draft-map-connectors">
          {model.nodes.filter(n=>!n.dependsOn.length).map(n=><path key={`root-${n.id}`} data-from="root" data-to={n.id} d={pathFor(null,n)} />)}
          {visibleEdges.map(edge=><path key={`${edge.from}-${edge.to}`} data-from={edge.from} data-to={edge.to} className={`${edge.blocked?'blocked ':''}${selected&&(edge.from===selected||edge.to===selected)?'selected':''}`} d={pathFor(byId.get(edge.from),byId.get(edge.to))} />)}
        </svg>
        {model.nodes.map(node=><button key={node.id} type="button" className={`draft-map-node ${node.blocked?'blocked':''} ${related.has(node.id)?'related':''}`} style={{left:node.x,top:node.y,width:node.width,height:node.height}} onFocus={()=>setSelected(node.id)} onBlur={()=>setSelected(null)} onMouseEnter={()=>setSelected(node.id)} onMouseLeave={()=>setSelected(null)} onClick={()=>openTask(node.id)} disabled={Boolean(stale)} aria-label={`Open ${node.id}: ${node.title} in Ledger`} title={`${node.title}\nDepends on: ${node.dependsOn.join(', ')||'none recorded'}`}>
          <span className="draft-map-node-meta"><code>{node.id}</code><span>{node.blocked?'Dependency order blocked':isApproved(node.id)?'Approved':'Draft'}</span></span><strong>{node.title}</strong><span className="draft-map-owner">{node.owner||'Owner unanswered'}</span><span className="draft-map-node-meta"><span>{node.findings.length?`${node.findings.length} review findings`:'No draft findings'}</span><span>Ledger →</span></span>
        </button>)}
      </div>}
    </div>
    {model?.nodes.some(node=>node.blocked)&&<p className="draft-map-error">Some tasks form a dependency cycle or depend on one. Their position does not imply a valid execution order.</p>}
  </section>;
}
