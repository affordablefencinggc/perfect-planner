import { useEffect, useState } from 'react';
import { readTaskRunObservationsForDraft } from '../project/taskRunObservationClient.js';
import './OperationTaskRunObservations.css';

const labels={unresolved:'Completion unknown','failure-observed':'Check failure recorded','result-unverified':'Check returned — task not verified'};

export function OperationTaskRunObservations({ledger,read=readTaskRunObservationsForDraft}) {
  const [refresh,setRefresh]=useState(0);
  const [result,setResult]=useState({state:'loading',runs:[]});
  useEffect(()=>{
    const controller=new AbortController();let active=true;
    setResult({state:'loading',runs:[]});
    Promise.resolve().then(()=>read(ledger,{signal:controller.signal})).then(value=>{
      if(active)setResult({state:'ready',runs:value.runs});
    }).catch(()=>{if(active)setResult({state:'unavailable',runs:[]});});
    return()=>{active=false;controller.abort();};
  },[ledger,read,refresh]);
  const newestFirst=[...result.runs].sort((a,b)=>b.admittedAt.localeCompare(a.admittedAt)
    ||a.taskId.localeCompare(b.taskId)||a.checkId.localeCompare(b.checkId)
    ||b.attemptNumber-a.attemptNumber
    ||b.runId.localeCompare(a.runId));
  const failures=result.runs.filter(run=>run.state==='failure-observed').length;
  const unknown=result.runs.filter(run=>run.state==='unresolved').length;
  return <section className="retained-attempts" aria-label="Retained check attempts">
    <div className="retained-attempts-heading"><div><h4>Retained check attempts</h4><span>Newest observation first · earlier attempts stay available</span></div>
    <button type="button" onClick={()=>setRefresh(value=>value+1)}>Refresh check attempts</button></div>
    {result.state==='ready'&&result.runs.length>0&&<dl className="retained-attempts-counts" aria-label="Returned attempt summary">
      <div><dt>Attempts returned</dt><dd>{result.runs.length}</dd></div>
      <div data-attention={failures>0}><dt>Recorded failures</dt><dd>{failures}</dd></div>
      <div data-attention={unknown>0}><dt>Completion unknown</dt><dd>{unknown}</dd></div>
    </dl>}
    <p>These are retained observations, not approved task outcomes. Matching refers to this supplied draft; the host’s latest ledger and artifact contents are not verified.</p>
    {result.state==='loading'&&<p role="status">Reading retained check attempts…</p>}
    {result.state==='unavailable'&&<p role="status">Retained check attempts unavailable. The local host may not be connected or configured. No task results can be inferred.</p>}
    {result.state==='ready'&&result.runs.length===0&&<p>No retained attempts were returned for this project. This does not prove the work is complete.</p>}
    {newestFirst.map((run,index)=>{
      const task=ledger.tasks.find(task=>task.id===run.taskId);
      return <details key={run.runId} open={index===0||run.state==='failure-observed'||run.state==='unresolved'} data-attempt-state={run.state}>
        <summary>{index===0&&<span className="retained-attempt-latest">Most recent</span>}{run.taskId} · {run.checkId} · attempt {run.attemptNumber} — {labels[run.state]}</summary>
        <p>{task?.title||'Task is not in this draft'} · {run.ledgerMatch==='current-draft'?'Matches supplied draft':'Historical or changed task definition'}</p>
        <p>Observed exit: {run.exitCode??'not recorded'} · Timeout: {run.timedOut===null?'unknown':run.timedOut?'yes':'no'} · Output cut short: {run.outputTruncated===null?'unknown':run.outputTruncated?'yes':'no'}.</p>
        {run.failureStage&&<p>Failure stage: {run.failureStage}.</p>}
        <p>Process cleanup: {run.cleanup}. Cause: unknown. Current proposed owner: {task?.owner||'Unassigned'}.</p>
        <p>Next: {run.nextAction}</p>
        <p>Run: <code>{run.runId}</code> · Recorded {run.admittedAt}{run.terminalAt?` → ${run.terminalAt}`:''}</p>
        {run.artifactDigest&&<p>Retained artifact reference (contents not verified): <code>{run.artifactDigest}</code></p>}
      </details>;
    })}
  </section>;
}
