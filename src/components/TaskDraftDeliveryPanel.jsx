import {useEffect,useMemo,useRef,useState} from 'react';
import {createNativeTaskDraftHost} from '../native/taskDraftHost.js';
import {createTaskDraftDelivery} from '../project/taskDraftDelivery.js';
import {validateTaskDraftSubmission} from '../project/taskDraftSubmission.js';
import {sameTaskDraftBinding} from '../project/taskDraftLedger.js';
import './TaskDraftDeliveryPanel.css';
import {SharedLedgerReview} from './SharedLedgerReview.jsx';

export function TaskDraftDeliveryPanel({project,binding,ledger,store,disabled,dirty}){
  const [reviewBusy,setReviewBusy]=useState(false);
  const connection=useMemo(()=>{
    try{const host=createNativeTaskDraftHost(project);return {available:host.available,delivery:createTaskDraftDelivery({store,host})};}
    catch{return {available:false,delivery:null};}
  },[store,binding.projectId,binding.rootIdentity,binding.censusDigest,project.registration?.workspaceId,project.registration?.registryRevision]);
  const [records,setRecords]=useState([]),[loaded,setLoaded]=useState(false),[historyError,setHistoryError]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[recovery,setRecovery]=useState(false),[nativeOriginalId,setNativeOriginalId]=useState(null);
  const alive=useRef(false),epoch=useRef(0),sequence=useRef(0),working=useRef(false);
  async function refresh(){
    const life=epoch.current,read=++sequence.current;
    if(alive.current){setLoaded(false);setHistoryError('');}
    try{
      if(typeof store?.submissionHistory!=='function')throw Error();
      const values=await store.submissionHistory(binding);
      if(!Array.isArray(values))throw Error();
      const next=values.map(value=>{const record=validateTaskDraftSubmission(value);if(!sameTaskDraftBinding(record.binding,binding))throw Error();return record;});
      next.sort((a,b)=>b.localRevision-a.localRevision||a.request.requestId.localeCompare(b.request.requestId));
      if(alive.current&&epoch.current===life&&sequence.current===read){setRecords(next);setLoaded(true);}
    }catch{if(alive.current&&epoch.current===life&&sequence.current===read)setHistoryError('Submission history could not be read. Nothing will be sent until it can be checked. Your saved drafts were kept.');}
  }
  useEffect(()=>{
    alive.current=true;epoch.current++;refresh();let unsubscribe;
    try{if(typeof store?.subscribe==='function')unsubscribe=store.subscribe(binding,()=>{refresh();});}catch{}
    return()=>{alive.current=false;epoch.current++;sequence.current++;unsubscribe?.();};
  },[store,binding.projectId,binding.rootIdentity,binding.censusDigest]);
  const pending=records.filter(record=>record.receipt===null);
  const acknowledgedCurrent=records.some(record=>record.localRevision===ledger?.revision&&record.receipt!==null);
  const canStart=connection.available&&connection.delivery&&loaded&&!historyError&&!disabled&&!dirty&&!busy&&!reviewBusy&&!recovery&&!nativeOriginalId&&ledger?.revision>0&&!pending.length&&!acknowledgedCurrent;
  async function send(requestId=null){
    if(working.current||reviewBusy||!connection.available||!connection.delivery||!loaded||historyError||disabled||recovery||(nativeOriginalId&&requestId!==nativeOriginalId)||(!requestId&&!canStart))return;
    working.current=true;const life=epoch.current;setBusy(true);setError('');setNotice('');
    try{
      // Delivery owns the durable receipt write. Do not cancel it or skip it
      // when a user navigates away; only view updates depend on this lifecycle.
      const result=requestId?await connection.delivery.retry(binding,requestId):await connection.delivery.start(binding,ledger.revision);
      if(alive.current&&epoch.current===life){
        if(requestId===nativeOriginalId&&result.status==='acknowledged')setNativeOriginalId(null);
        setNotice(result.status==='previously-acknowledged'?'This original submission was already acknowledged. It was not sent again.':`Native host acknowledged saved revision ${result.record.localRevision}. This is not approval or permission to run work.${result.registrationCurrent===false?' Folder registration changed during delivery; review it before continuing.':''}`);
      }
    }catch(cause){if(alive.current&&epoch.current===life){setError(cause.message||'Delivery was not confirmed. Keep the original submission.');setRecovery(cause.requiresRecovery===true);if(typeof cause.originalRequestId==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(cause.originalRequestId))setNativeOriginalId(cause.originalRequestId);}}
    finally{working.current=false;if(alive.current&&epoch.current===life){setBusy(false);await refresh();}}
  }
  return <><SharedLedgerReview project={project} ledger={ledger} dirty={dirty} store={store} disabled={disabled||busy||!loaded||Boolean(historyError)||recovery||Boolean(nativeOriginalId)||pending.length>0} onBusyChange={setReviewBusy}/><section className="task-draft-delivery" aria-label="Send saved planning draft">
    <div className="task-draft-delivery-heading"><div><h3>Send saved planning draft</h3><p>Keep the original submission until the native host acknowledges it. No approval or execution happens here.</p></div><button type="button" onClick={()=>send()} disabled={!canStart}>{busy?'Handling submission…':`Submit saved revision${ledger?.revision?` ${ledger.revision}`:''}`}</button></div>
    {!connection.available&&<p className="task-draft-delivery-note">Native delivery is unavailable in this view. Open this project in the installed desktop app to send it. Local drafts remain editable and exportable.</p>}
    {dirty&&<p>Unsaved editor text is not included. Save your edits before submitting a new revision; retrying an original submission does not change your text.</p>}
    {historyError&&<p role="alert" className="task-draft-delivery-error">{historyError}</p>}
    {error&&<p role="alert" className="task-draft-delivery-error">{error}</p>}
    {recovery&&<p className="task-draft-delivery-note">Native recovery is required: a previous session has not been confirmed stopped. Keep this original ID and do not create a replacement. Sending stays disabled in this view; after native recovery, reopen the project and retry the original.</p>}
    {nativeOriginalId&&<div className="task-draft-delivery-note"><p>Native host requires the original submission: <code>{nativeOriginalId}</code>. Do not send a replacement ID.</p>{!records.some(record=>record.request.requestId===nativeOriginalId)&&<p>This original is not listed for the current folder inventory. Recover its saved submission and original draft/inventory before continuing. Do not recreate it from the current draft or delete pending records.</p>}{records.some(record=>record.request.requestId===nativeOriginalId&&record.receipt)&&<p>A local acknowledgement already exists for that original. No automatic resend will occur. Its native outstanding state needs explicit reconciliation; a local receipt alone does not clear it.</p>}</div>}
    <p role="status" aria-label="Draft delivery status">{notice||(historyError?'Submission status is unavailable.':!loaded?'Opening saved submission history…':pending.length?`${pending.length} original submission${pending.length===1?'':'s'} awaiting acknowledgement.`:acknowledgedCurrent?'This saved revision was already acknowledged. Save a new draft revision before another submission.':'No pending submission for this folder inventory.')}</p>
    <button type="button" onClick={refresh} disabled={busy||typeof store?.submissionHistory!=='function'}>Refresh submission history</button>
    {records.length>0&&<ul className="task-draft-delivery-records" data-needs-attention={pending.length>0?'true':undefined}>{records.map(record=><li key={record.request.requestId}>
      <div><strong>Saved revision {record.localRevision} · {record.receipt?'Acknowledged, not approved':'Awaiting acknowledgement'}</strong><p>Original ID: <code>{record.request.requestId}</code></p>{record.receipt?<p>Retained host revision {record.receipt.submitted.hostRevision}. This receipt does not establish the current host head.</p>:<p>Retry sends the original saved revision, even if you have edited newer drafts.</p>}</div>
      {!record.receipt&&<button type="button" aria-label={`Retry original submission ${record.request.requestId}`} onClick={()=>send(record.request.requestId)} disabled={!connection.available||!connection.delivery||!loaded||Boolean(historyError)||disabled||busy||recovery||Boolean(nativeOriginalId&&record.request.requestId!==nativeOriginalId)}>Retry original</button>}
    </li>)}</ul>}
  </section></>;
}
