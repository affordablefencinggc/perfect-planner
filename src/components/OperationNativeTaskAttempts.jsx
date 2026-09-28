import {useEffect,useMemo,useRef,useState} from 'react';
import {createNativeTaskResultHost} from '../native/taskResultHost.js';
import {validateNativeTaskOutcomePage} from '../shared/nativeTaskOutcomePage.js';
import {nativeStorageFailure} from '../native/storageFailure.js';
import './OperationTaskRunObservations.css';

const initial=()=>({phase:'loading',page:null,outcomes:{},reading:false});
const lifecycle={issued:'Grant recorded — not proof of execution',revoked:'Grant revoked',consumed:'Admission recorded — execution unknown','intent-recorded':'Execution intent recorded — outcome unknown','result-recorded':'Result reference recorded'};
const reasonLabels={'nonzero-exit':'Nonzero exit','time-limit':'Time limit reached','cancellation-observed':'Cancellation observed','output-limit':'Output limit reached','cpu-limit':'CPU limit reached','cpu-observation-failed':'CPU observation failed','output-read-failed':'Output read failed'};

export function OperationNativeTaskAttempts({project,host:providedHost}){
 const key=JSON.stringify([project?.projectId,project?.registration?.workspaceId,project?.registration?.registryRevision,project?.registration?.rootIdentity,project?.census?.digest,project?.state]);
 return <NativeAttemptPage key={key} project={project} providedHost={providedHost}/>;
}
function NativeAttemptPage({project,providedHost}){
 const host=useMemo(()=>{try{return providedHost??createNativeTaskResultHost(project);}catch{return null;}},[project,providedHost]);
 const [request,setRequest]=useState({offset:0,expectedHeadDigest:null,refresh:0});
 const [state,setState]=useState(initial);const active=useRef(null);const panel=useRef(null);
 useEffect(()=>{
  const controller=new AbortController();active.current=controller;let alive=true;
  const current=()=>alive&&!controller.signal.aborted;
  setState(initial());
  (async()=>{
   try{
    if(!host?.available||['stale','unavailable'].includes(project.state))throw Error('unavailable');
    // One complete page, no per-result fallback or provisional totals.
    const reply=await host.readPage({offset:request.offset,expectedHeadDigest:request.expectedHeadDigest},{signal:controller.signal});if(!current())return;
    const {page,outcomes}=validateNativeTaskOutcomePage(reply,{offset:request.offset,expectedHeadDigest:request.expectedHeadDigest},{projectId:project.projectId,rootIdentity:project.registration.rootIdentity},value=>value);
    setState({phase:'ready',page,outcomes:Object.fromEntries(outcomes.map(outcome=>[outcome.grantId,outcome])),reading:false});
   }catch(error){if(current())setState({phase:error?.code==='NATIVE_TASK_INDEX_STALE'?'stale':'unavailable',page:null,outcomes:{},reading:false,storageMessage:nativeStorageFailure(error)?.message??null});}
  })();
  return()=>{alive=false;controller.abort();};
 },[host,request,project]);
 const refresh=()=>{active.current?.abort();setRequest(previous=>({offset:0,expectedHeadDigest:null,refresh:previous.refresh+1}));};
 const move=offset=>{active.current?.abort();setRequest(previous=>({offset,expectedHeadDigest:state.page.journalHead.headDigest,refresh:previous.refresh+1}));};
 const rows=state.page?.entries??[];
 const failures=rows.filter(row=>state.outcomes[row.grantId]?.value?.state==='failure-observed').length;
 const unknown=rows.filter(row=>['consumed','intent-recorded','result-recorded'].includes(row.lifecycleState)&&!state.outcomes[row.grantId]?.value).length;
 const showFailure=()=>{const row=panel.current?.querySelector('details[data-attempt-state="failure-observed"]');if(row){row.open=true;row.scrollIntoView?.({block:'center'});row.querySelector('summary')?.focus({preventScroll:true});}};
 return <section ref={panel} className="retained-attempts native-attempts" aria-label="Native check attempts" aria-busy={state.reading||state.phase==='loading'}>
  <div className="retained-attempts-heading"><div><h4>Native check attempts</h4><span>Newest recorded activity first · earlier attempts remain available</span></div><button type="button" onClick={refresh}>Refresh native attempts</button></div>
  <p>Recorded checks are separate from approved task outcomes. A successful exit alone does not complete a task.</p>
  {state.phase==='loading'&&<p role="status">Reading native attempt references…</p>}
  {state.phase==='unavailable'&&<p role="alert">{state.storageMessage??'Native attempts unavailable. Check the selected project and installed host.'} No success or failure totals can be inferred.</p>}
  {state.phase==='stale'&&<p role="alert">Recorded activity changed between pages. Refresh native attempts to read a consistent snapshot.</p>}
  {state.page&&<>
   <dl className="retained-attempts-counts" aria-label="This page only"><div><dt>References on this page</dt><dd>{rows.length}</dd></div><div data-attention={failures>0}><dt>Check failures observed</dt><dd>{failures}</dd></div><div data-attention={unknown>0}><dt>Outcomes still unknown</dt><dd>{unknown}</dd></div></dl>
   {failures>0&&<button type="button" className="native-attempts-jump" onClick={showFailure}>Show failed check</button>}
   {state.reading&&<p role="status">Reading recorded outcomes… Counts are provisional until this page finishes loading.</p>}
   <p className="native-attempts-snapshot">Snapshot revision {state.page.journalHead.revision} · {state.page.totalGrants} total references. Counts above cover this page only, not all tasks or live workers.</p>
   {rows.length===0&&<p>No native attempt references recorded for this project. This does not mean all work is finished.</p>}
   {rows.map(row=>{
    const outcome=state.outcomes[row.grantId],value=outcome?.value;
    const label=value?(value.state==='failure-observed'?'Check failed':'Check returned — task unverified'):row.runId?(outcome?.phase==='unavailable'?'Result unavailable — outcome unknown':'Reading result — outcome unknown'):lifecycle[row.lifecycleState];
    return <details key={row.grantId} open data-attempt-state={value?.state??'unresolved'}>
     <summary><span>{row.taskId} · {row.checkId} · attempt {row.attemptNumber}</span><span className="native-attempts-label">{label}</span></summary>
     <p>Worker: {row.workerId} · Recorded {new Date(row.recordedAt).toLocaleString()}</p>
     {value?<><p><strong>Observed exit: {value.exitCode??'not recorded'}.</strong> {value.failureReasons.map(reason=>reasonLabels[reason]??'Unclassified failure').join(' · ')}</p><p>{value.state==='failure-observed'?'Cause: unknown. ':''}Task cleanup: {value.cleanup}. Next: {value.state==='failure-observed'?'Review the failed check before deciding on a new attempt.':'Verify all required evidence before completing the task.'}</p></>:<p>Next: {row.runId?'Resolve the missing outcome before retrying or claiming completion.':'Review the recorded grant state; no execution is inferred.'}</p>}
     <details className="native-attempts-reference"><summary>Recorded references</summary><p>Grant: <code>{row.grantId}</code>{row.runId&&<> · Run: <code>{row.runId}</code></>}</p><p>Journal revision {row.journalRevision} · {lifecycle[row.lifecycleState]}</p>{value&&<p>Artifact: <code>{value.artifactDigest}</code> · Journal linked: {value.journalLinked?'yes':'no'}. This is not task approval.</p>}</details>
    </details>;
   })}
   <nav className="native-attempts-pages" aria-label="Native attempt pages"><button type="button" disabled={state.page.offset===0||state.reading} onClick={()=>move(Math.max(0,state.page.offset-20))}>Newer references</button><span>{rows.length?`${state.page.offset+1}–${state.page.offset+rows.length}`:'0'} of {state.page.totalGrants}</span><button type="button" disabled={state.page.nextOffset===null||state.reading} onClick={()=>move(state.page.nextOffset)}>Older references</button></nav>
  </>}
 </section>;
}
