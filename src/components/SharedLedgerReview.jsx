import {useEffect,useMemo,useRef,useState} from 'react';
import {createNativeTaskDraftHost} from '../native/taskDraftHost.js';
import {submissionWire} from '../project/taskDraftSubmission.js';
import {SharedReconciliationControls} from './SharedReconciliationControls.jsx';
import {SharedReviewHistory} from './SharedReviewHistory.jsx';
import {NativeCheckSetupPanel} from './NativeCheckSetupPanel.jsx';

function TaskDetails({task}) {
 if (!task) return <p>Not present in this version.</p>;
 const fields = [
  ['Title', task.title], ['Description', task.description], ['Owner', task.owner],
  ['Success criteria', task.acceptance], ['Recovery plan', task.recovery],
  ['Plan status', task.archived ? 'Archived—not a completion receipt' : 'Active draft—not approved'],
 ];
 return <>
  <dl style={{overflowWrap:'anywhere',userSelect:'text'}}>{fields.map(([label,value])=><div key={label} style={{marginBottom:16}}><dt style={{fontWeight:600}}>{label}</dt><dd style={{margin:0,whiteSpace:'pre-wrap'}}>{value || 'Not recorded'}</dd></div>)}</dl>
  <h5>Planned file access</h5>
  {task.claims?.length ? <ul>{task.claims.map(claim=><li key={claim.path} style={{overflowWrap:'anywhere'}}>{claim.access==='write'?'Change':'Read'}: {claim.path}</li>)}</ul> : <p>No file scope recorded.</p>}
  <h5>Depends on</h5>
  {task.dependsOn?.length ? <ul>{task.dependsOn.map(id=><li key={id}>{id}</li>)}</ul> : <p>No dependencies recorded.</p>}
  <details><summary>Advanced: exact task record</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:14,userSelect:'text'}}>{JSON.stringify(task,null,2)}</pre></details>
 </>;
}

export function SharedLedgerReview({project,ledger,dirty,disabled,store,onBusyChange,host:providedHost}){
 const key=JSON.stringify([project?.projectId,project?.generation,project?.registration,project?.census?.digest]);
 const current=useRef({key,epoch:0});if(current.current.key!==key)current.current={key,epoch:current.current.epoch+1};
 const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const host=useMemo(()=>{try{return providedHost??createNativeTaskDraftHost(project);}catch{return null;}},[key,providedHost]);
 const [state,setState]=useState(null);const view=state?.key===key&&state.epoch===current.current.epoch?state:null;
 async function read(){
  if(!host?.available||view?.busy)return;const epoch=current.current.epoch;setState({key,epoch,busy:true});
  try{const snapshot=await host.readSnapshot();if(alive.current&&current.current.key===key&&current.current.epoch===epoch)setState({key,epoch,snapshot});}
  catch{if(alive.current&&current.current.key===key&&current.current.epoch===epoch)setState({key,epoch,error:true});}
 }
 const shared=view?.snapshot?.ledger;const local=new Map((ledger?.tasks??[]).map(task=>[task.id,task]));
 const remote=new Map((shared?.tasks??[]).map(task=>[task.id,task]));
 const rows=[...new Set([...local.keys(),...remote.keys()])].map(id=>{const a=local.get(id),b=remote.get(id);return{id,local:a,shared:b,label:!a?'Shared only':!b?'Local only':submissionWire(a)===submissionWire(b)?'Same task':'Different details'};});
 return <section className="task-draft-delivery" aria-label="Review shared plan">
  <div className="task-draft-delivery-heading"><div><h3>Review shared plan</h3><p>Compare the native host’s saved proposal with your saved local draft. Reading does not replace either version or approve work.</p></div><button type="button" onClick={read} disabled={!host?.available||view?.busy}>{view?.busy?'Reading shared plan…':'Read shared plan'}</button></div>
  {dirty&&<p className="task-draft-delivery-note">Your unsaved editor text is untouched and is not included in this comparison.</p>}
  {!host?.available&&<p>Open this registered project in the desktop app to read its shared plan.</p>}
  {view?.error&&<p role="alert">The shared plan could not be verified. Local work was kept. Refresh after checking Operations; no comparison is being presented as current.</p>}
  <p role="status">{view?.busy?'Reading a complete revision; no local changes are being made.':view?.snapshot?`Read shared revision ${view.snapshot.observedHead.hostRevision}. This is a point-in-time snapshot, not a live connection or approval.`:'Shared plan not read yet.'}</p>
  {view?.snapshot&&(shared===null?<p>No submitted shared plan was found. Your local tasks have not been removed.</p>:<><p>{rows.filter(row=>row.label!=='Same task').length} task differences · {shared.tasks.length} shared tasks, including archived tasks. Reading alone does not change your local plan.</p><ul className="task-draft-delivery-records">{rows.map(row=><li key={row.id}><details><summary>{row.id} · {row.shared?.title??row.local?.title} · {row.label}</summary><div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(min(280px,100%),1fr))',gap:16}}>{[['Saved local task',row.local],['Shared task',row.shared]].map(([title,task])=><div key={title}><h4>{title}</h4><TaskDetails task={task}/></div>)}</div></details></li>)}</ul></>)}
 {shared&&typeof store?.commitSharedReview==='function'&&<SharedReconciliationControls key={`${key}:${current.current.epoch}:${view.snapshot.snapshotDigest}`} ledger={ledger} snapshot={view.snapshot} rows={rows} store={store} host={host} dirty={dirty} disabled={disabled||view?.busy} onBusyChange={onBusyChange} onRefresh={read}/>}
 {view?.snapshot?.ledger&&<NativeCheckSetupPanel project={project} snapshot={view.snapshot} disabled={disabled||view?.busy}/>}
 {ledger?.binding&&typeof store?.reconciliationHistory==='function'&&typeof store?.readRevision==='function'&&<SharedReviewHistory key={`${key}:${current.current.epoch}`} store={store} binding={ledger.binding}/>}
 </section>;
}
