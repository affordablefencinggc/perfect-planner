import {useEffect,useRef,useState} from 'react';
import {planSharedTaskReconciliation} from '../project/sharedTaskReconciliation.js';
import {submissionWire} from '../project/taskDraftSubmission.js';

export function SharedReconciliationControls({ledger,snapshot,rows,store,host,disabled,dirty,onBusyChange,onRefresh}){
 const [stale,setStale]=useState(false);
 const [choices,setChoices]=useState({}),[preview,setPreview]=useState(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState('');
 const working=useRef(false),alive=useRef(true),latest=useRef();latest.current={ledger,disabled,dirty};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const unchanged=preview&&submissionWire(preview.localBase)===submissionWire(ledger);
 const blocked=disabled||dirty||busy||stale;
 async function perform(action){if(working.current||disabled||dirty)return;working.current=true;setBusy(true);onBusyChange?.(true);setError('');setNotice('');try{await action();}catch{if(alive.current)setError('The review action was not confirmed. Both original plans were kept. Check Operations and saved review history before retrying the same review.');}finally{working.current=false;onBusyChange?.(false);if(alive.current)setBusy(false);}}
 async function prepare(){if(stale||rows.some(row=>!choices[row.id]))return;return perform(async()=>{const result=await planSharedTaskReconciliation(ledger,snapshot,rows.map(row=>({taskId:row.id,version:choices[row.id]})));if(alive.current){setPreview(result);setConfirmed(false);}});}
 async function save(){if(stale||!preview||!unchanged||!confirmed)return;const original=preview;return perform(async()=>{
  const current=await host.readSnapshot();
  if(!alive.current||latest.current.disabled||latest.current.dirty||submissionWire(latest.current.ledger)!==submissionWire(original.localBase))throw Error('Editor changed');
  if(submissionWire(current)!==submissionWire(original.sharedSnapshot)){setStale(true);setConfirmed(false);return;}
  const saved=await store.commitSharedReview(original);
  if(submissionWire(saved)!==submissionWire(original))throw Error('Unexpected persisted review');
  if(alive.current){setNotice(`Saved local revision ${saved.ledger.revision}. Both original plans are retained. Nothing was sent, approved or executed.`);setPreview(null);setConfirmed(false);setChoices({});}
 });}
 return <section aria-label="Combine reviewed tasks">
  <h4>Choose the tasks to keep in your local plan</h4>
  <p>Choose a version for every task. Saving retains both original plans in local review history. Tasks are not deleted, and archived does not mean completed.</p>
  {(dirty||disabled)&&<p role="note">Finish or resolve the current editor action before combining plans. Your unfinished text is untouched.</p>}
  <div style={{display:'grid',gap:16}}>{rows.map(row=><fieldset key={row.id} disabled={blocked} style={{minWidth:0,border:'1px solid #aab6b5',borderRadius:8,padding:12}}><legend>{row.id} · {row.label}</legend>{[['local','Keep saved local',row.local],['shared','Use shared',row.shared]].map(([version,label,task])=>task&&<label key={version} style={{display:'block',padding:8,overflowWrap:'anywhere'}}><input type="radio" name={`reconciliation-${row.id}`} value={version} checked={choices[row.id]===version} onChange={()=>{setChoices({...choices,[row.id]:version});setPreview(null);setConfirmed(false);setNotice('');}}/> {label}: {task.title}{task.archived?' (archived)':''}</label>)}</fieldset>)}</div>
  <button type="button" onClick={prepare} disabled={blocked||rows.some(row=>!choices[row.id])}>Preview combined plan</button>
  {preview&&<div aria-label="Combined plan preview"><h4>{preview.ledger.tasks.length} tasks · proposed local revision {preview.ledger.revision}</h4><ul>{preview.ledger.tasks.map(task=><li key={task.id}>{task.id} · {task.title}{task.archived?' · archived':''}</li>)}</ul><p>{preview.findings.length} planning findings. These remain unresolved; saving does not clear conflicts.</p>{preview.findings.length>0&&<details><summary>Review planning findings</summary><ul>{preview.findings.map((finding,index)=><li key={index}>{finding.detail}</li>)}</ul></details>}{!unchanged&&<p role="alert">The local plan changed. Preview the current tasks again before saving.</p>}<label style={{display:'block',padding:12}}><input type="checkbox" checked={confirmed} disabled={blocked||!unchanged} onChange={e=>setConfirmed(e.target.checked)}/> I reviewed these choices. Keep both originals and save this as an unapproved local plan.</label><button type="button" onClick={save} disabled={blocked||!unchanged||!confirmed}>Save reviewed local plan</button></div>}
  {stale&&<div role="alert"><p>The shared plan changed after this preview. This review was not saved. Your local plan is unchanged by this review. Read the latest shared plan, choose the versions you want, and review again.</p>{typeof onRefresh==='function'&&<button type="button" disabled={busy||disabled} onClick={onRefresh}>Read latest shared plan</button>}</div>}
  {busy&&<p role="status">Checking and retaining the reviewed plan…</p>}{notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}
 </section>;
}
