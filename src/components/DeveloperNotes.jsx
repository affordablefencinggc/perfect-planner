import {useEffect,useRef,useState} from 'react';
import {isProjectId} from '../project/projectIds.js';
import {getRuntimeEventSession} from '../runtime/runtimeEventSession.js';
import {appendDeveloperNote,developerNotes,noteFields} from '../runtime/developerNotes.js';
import './DeveloperNotes.css';
import {isTauriRuntime} from '../native/runtimeSnapshot.js';
import {validateExchangeReport} from '../runtime/agentExchangeReport.js';

export function DeveloperNotes({project,events=getRuntimeEventSession(),invoke}){
  if(!isProjectId(project?.projectId)||!Number.isSafeInteger(project?.generation))return null;
  return <Notes key={`${project.projectId}:${project.generation}`} project={project} events={events} invoke={invoke}/>;
}
function Notes({project,events,invoke}){
  const [open,setOpen]=useState(false),[snapshot,setSnapshot]=useState(()=>events.getSnapshot(project.projectId));
  const [form,setForm]=useState({}),[notice,setNotice]=useState(''),[editing,setEditing]=useState(false);
  const trigger=useRef(null),heading=useRef(null);
  const [agent,setAgent]=useState({records:[],total:null,nextOffset:null,status:'Not checked'});
  const [loading,setLoading]=useState(false),[browsingHistory,setBrowsingHistory]=useState(false);
  const alive=useRef(true),busy=useRef(false),following=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const registration=project.registration;
  const native=registration?.adapter==='native'&&(invoke||isTauriRuntime(globalThis));
  async function readReports(offset=0){
    if(!native||busy.current)return;
    following.current=offset===0;
    busy.current=true;setLoading(true);setBrowsingHistory(offset!==0);
    try{
      const binding={projectId:project.projectId,workspaceId:registration.workspaceId,registryRevision:registration.registryRevision,rootIdentity:registration.rootIdentity};
      const call=invoke??(await import('@tauri-apps/api/core')).invoke;
      const reply=await call('read_agent_exchange_notes',{request:{schemaVersion:1,...binding,generation:project.generation},offset});
      if(!alive.current)return;
      const data=reply?.data;
      if(reply.projectId!==project.projectId||reply.generation!==project.generation||Object.keys(binding).some(k=>data?.binding?.[k]!==binding[k])||data.executionAuthorized!==false||data.coverage!=='reported-exchanges-only'||!Array.isArray(data.records)||data.records.length>1||!Number.isSafeInteger(data.total)||data.total<0||data.total>1000||!(data.nextOffset===null||(Number.isSafeInteger(data.nextOffset)&&data.nextOffset===offset+1)))throw Error('Invalid report receipt');
      for(const r of data.records){validateExchangeReport({binding:r.binding,exchangeId:r.exchangeId,summary:r.summary},binding);if(r.origin!=='authenticated-agent-report'||r.verification!=='not-verified'||!/^[a-f0-9]{32}$/.test(r.sessionId)||!/^[a-f0-9]{64}$/.test(r.digest)||!Number.isFinite(Date.parse(r.receivedAt)))throw Error('Invalid report receipt');}
      setAgent(previous=>({records:offset===0?data.records:[...previous.records,...data.records.filter(r=>!previous.records.some(p=>p.exchangeId===r.exchangeId))],total:data.total,nextOffset:data.nextOffset,status:'Owner reports read. Agent summaries are not verified facts.'}));
    }catch{if(alive.current)setAgent(previous=>({...previous,status:'Report refresh failed. Displayed reports may be stale; no new save is confirmed.'}));}
    finally{busy.current=false;if(alive.current)setLoading(false);}
  }
  useEffect(()=>{
    if(!open||!native)return;
    following.current=true;void readReports();const timer=setInterval(()=>{if(following.current)void readReports();},5000);return()=>clearInterval(timer);
  },[open,native]);
  useEffect(()=>events.subscribe(project.projectId,()=>setSnapshot(events.getSnapshot(project.projectId))),[events,project.projectId]);
  useEffect(()=>{if(open)heading.current?.focus();},[open]);
  const notes=developerNotes(snapshot);
  function close(){setOpen(false);trigger.current?.focus();}
  function submit(event){event.preventDefault();try{appendDeveloperNote(project,form,events);setForm({});setEditing(false);setNotice('Captured locally. Check the save status below. This is not verification.');}catch(error){setNotice(error.message);}}
  return <>
    <button ref={trigger} className="developer-notes-toggle" type="button" aria-expanded={open} aria-controls="developer-notes-panel" onClick={()=>open?close():setOpen(true)}>Developer notes {notes.length>0&&`(${notes.length})`}</button>
    {open&&<aside id="developer-notes-panel" className="developer-notes-panel" aria-label="Developer notes" onKeyDown={e=>{if(e.key==='Escape')close();}}>
      <header><h2 ref={heading} tabIndex={-1}>Developer notes</h2><button type="button" onClick={close} aria-label="Close developer notes">Close</button></header>
      <p>Exchange summaries, errors and next actions—separate from the plan. Notes do not approve work.</p>
      <p className="developer-notes-warning">{native?'The latest agent report refreshes while this panel is open; browsing older reports pauses refresh. The agent must call planner_report_exchange after each exchange. Unreported IDE conversations are not captured.':'Automatic IDE exchange capture is not connected in this web view. Add a reviewed summary after each exchange.'} Do not paste secrets or private reasoning.</p>
      {native&&<section aria-label="Agent exchange reports"><h3>Agent reports · {agent.total===null?'count not checked':`${agent.total} recorded`}</h3><p role="status">{loading?'Reading owner reports…':agent.status}</p>{browsingHistory&&<p>Automatic refresh is paused while browsing older reports. Refresh latest report to resume.</p>}<button type="button" disabled={loading} onClick={()=>readReports()}>Refresh latest report</button><ol>{agent.records.map(r=><li key={r.exchangeId}><details open><summary>{r.summary.turn} · recorded by Planner</summary><p className="developer-notes-meta">Authenticated session {r.sessionId.slice(0,8)} · agent-reported, not verified · {r.receivedAt}</p><dl>{Object.entries(noteFields).filter(([key])=>key!=='turn').map(([key,label])=><div key={key}><dt>{label}</dt><dd>{r.summary[key]||'Not supplied / unknown'}</dd></div>)}</dl><small>Exchange {r.exchangeId} · receipt {r.digest.slice(0,12)}</small></details></li>)}</ol>{agent.nextOffset!==null&&<button type="button" disabled={loading} onClick={()=>readReports(agent.nextOffset)}>Load older report</button>}<p>Reports are retained separately from local manual notes. Session identity authenticates the sender, not the accuracy of its explanation.</p></section>}
      <p role="status">Storage: {snapshot.health.reason}. {notice}</p>
      <button type="button" onClick={()=>setEditing(!editing)} aria-expanded={editing}>Add exchange note</button>
      {editing&&<form onSubmit={submit}>{Object.entries(noteFields).map(([field,label])=><label key={field}>{label}<textarea aria-label={label} required={['turn','request','response'].includes(field)} maxLength={2000} rows={field==='turn'?1:2} value={form[field]??''} onChange={e=>setForm(previous=>({...previous,[field]:e.target.value}))}/></label>)}<button type="submit">Save reviewed summary</button></form>}
      {!notes.length&&<p>No exchange notes recorded. Missing notes do not mean no errors occurred.</p>}
      <ol>{notes.map(note=>{const pending=snapshot.pending.find(p=>p.eventId===note.eventId);return <li key={note.eventId}><details open><summary>{note.payload.turn} · {pending?pending.state:'saved locally'}</summary><p className="developer-notes-meta">Local reviewed summary · not verified · {note.timestamp}</p><dl>{Object.entries(noteFields).filter(([key])=>key!=='turn').map(([key,label])=><div key={key}><dt>{label}</dt><dd>{note.payload[key]||'Not supplied / unknown'}</dd></div>)}</dl></details></li>;})}</ol>
      <p>Known secret patterns are redacted. Review before sharing; redaction cannot guarantee all sensitive information is removed. History uses Operations storage and its capacity limits.</p>
    </aside>}
  </>;
}
