import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { inspectTaskDraft, sameTaskDraftBinding, taskDraftBinding, parseTaskDraftImport, importTaskDraft, updateTaskDraft, TASK_DRAFT_IMPORT_BYTES } from '../project/taskDraftLedger.js';
import { parseTaskList, taskListEntryToForm, TASK_LIST_PASTE_CHARS } from '../project/taskListImport.js';
import { createTaskDraftStore } from '../project/taskDraftStore.js';
import { readTaskDraftLink } from '../project/taskDraftMap.js';
import { TaskDraftDeliveryPanel } from './TaskDraftDeliveryPanel.jsx';
import { PlanApprovalPanel } from './PlanApprovalPanel.jsx';
import './TaskDraftLedger.css';
import {createTaskFormRecovery} from '../project/taskFormRecovery.js';
import {createTaskFormSession} from '../project/taskFormSession.js';
import {reconcileTaskFormSave} from '../project/taskFormSaveReconciliation.js';
import {reviewFailedTaskSave} from '../project/taskFormOperationReview.js';
import {taskFormOperations} from '../project/taskFormOperations.js';
import {canonicalArchitectureJson as recoveryWire} from '../engine/architectureContractVerification.js';
import {validateTaskSaveIntent} from '../project/taskFormSaveIntent.js';
import {reconcileTaskFormIntent} from '../project/taskFormIntentReconciliation.js';

// Unsaved forms survive SPA page/project switching. They are not saved records.
// A browser exit warns while any such form remains. Saving uses IndexedDB below.
const forms=new Map();
// Pasted task lists also survive SPA page/project switching until added or cleared.
const pastes=new Map();
// Retained SPA sessions share one app-lifetime connection, rather than opening
// a new connection per mount or closing a connection while its queue is active.
let sharedRecovery;
let sharedDraftStore;
let warnedWindow;
const blank=()=>({id:null,title:'',description:'',owner:'',acceptance:'',recovery:'',claims:'',dependsOn:'',archived:false});
const serializeTask=task=>({...task,claims:task.claims.map(c=>`${c.access} ${c.path}`).join('\n'),dependsOn:task.dependsOn.join(', ')});
const parseTask=form=>({...form,claims:form.claims.split('\n').filter(line=>line.trim()).map(line=>{const match=line.trim().match(/^(read|write)\s+(.+)$/);if(!match)throw new Error('Each file scope must start with read or write, followed by a relative path.');return {access:match[1],path:match[2]};}),dependsOn:form.dependsOn.split(/[\s,]+/).filter(Boolean)});

export function TaskDraftLedger({project,store:providedStore,recovery:providedRecovery}) {
  let binding;
  try{binding=taskDraftBinding(project);}catch{return <section className="task-draft-ledger"><h2>Task drafts</h2><p>Register your app folder and capture its census before adding project-bound tasks.</p></section>;}
  return <BoundTaskDraftLedger key={`${binding.projectId}:${binding.rootIdentity}:${binding.censusDigest}`} binding={binding} project={project} providedStore={providedStore} providedRecovery={providedRecovery}/>;
}

function BoundTaskDraftLedger({binding,project,providedStore,providedRecovery}) {
  const formKey=`${binding.projectId}:${binding.rootIdentity}:${binding.censusDigest}`;
  const store=useMemo(()=>providedStore??(sharedDraftStore??=createTaskDraftStore()),[providedStore]);
  const recovery=useMemo(()=>providedRecovery??(sharedRecovery??=createTaskFormRecovery()),[providedRecovery]);
  const operationSubscribe=useMemo(()=>listener=>taskFormOperations.subscribe(binding,listener),[formKey]);
  const operationRead=useMemo(()=>()=>taskFormOperations.read(binding),[formKey]);
  const operation=useSyncExternalStore(operationSubscribe,operationRead,operationRead);
  const intentCapable=['listSaveIntents','readSaveIntent','prepareSaveIntent','commitSaveIntent','withdrawSaveIntent','acknowledgeSaveIntent'].every(name=>typeof store[name]==='function');
  const [saveIntents,setSaveIntents]=useState([]),[intentsReady,setIntentsReady]=useState(false),[intentError,setIntentError]=useState('');
  const intentSequence=useRef(0);
  const intentBlocked=!intentCapable||!intentsReady||Boolean(intentError)||saveIntents.some(record=>record.acknowledgment===null);
  const [recoveryRows,setRecoveryRows]=useState([]),[recoveryReady,setRecoveryReady]=useState(false),[recoveryError,setRecoveryError]=useState(''),[checkpointing,setCheckpointing]=useState(()=>Boolean(forms.get(formKey)?.session)),[committedPending,setCommittedPending]=useState(()=>forms.get(formKey)?.committed??null);
  const checkpointTimer=useRef(null),recoverySequence=useRef(0),textVersion=useRef(0);
  const session=useRef(forms.get(formKey)?.session??null);
  const [sessionClosed,setSessionClosed]=useState(false);
  const closedSession=useRef(false);
  const alive=useRef(true), sequence=useRef(0);
  const [ledger,setLedger]=useState(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[showArchived,setShowArchived]=useState(false),[history,setHistory]=useState(null),[historical,setHistorical]=useState(null);
  const [form,setForm]=useState(()=>forms.get(formKey)?.form??blank());
  const [dirty,setDirty]=useState(()=>forms.has(formKey));
  const editingRevision=useRef(forms.get(formKey)?.revision??null);
  const [linkedTask,setLinkedTask]=useState(null);
  const [reviewedTasks,setReviewedTasks]=useState([]),[inventoryReviewed,setInventoryReviewed]=useState(false);
  const [pendingImport,setPendingImport]=useState(null),[importReviewed,setImportReviewed]=useState(false);
  const handledLink=useRef(null);
  const [pasteText,setPasteText]=useState(()=>pastes.get(formKey)??''),[pastePreview,setPastePreview]=useState(null),[pasteResult,setPasteResult]=useState(null);
  const earlierForms=[...forms].filter(([key])=>key.startsWith(`${binding.projectId}:${binding.rootIdentity}:`)&&key!==formKey);
  const findings=useMemo(()=>ledger?inspectTaskDraft(ledger):null,[ledger]);
  const stale=Boolean(ledger&&!sameTaskDraftBinding(ledger.binding,binding));
  const recoveryMismatch=Boolean(forms.get(formKey)?.session&&forms.get(formKey)?.recovery!==recovery);
  const operationMismatch=Boolean(operation&&(operation.recovery!==recovery||operation.store!==store));
  const cannotEdit=intentBlocked||busy||Boolean(operation)||sessionClosed||recoveryMismatch||Boolean(committedPending)||!ledger||stale||['stale','unavailable'].includes(project.state);
  const recoveryBlocked=intentBlocked||!recoveryReady||Boolean(recoveryError)||checkpointing||recoveryRows.some(row=>row.status==='unfinished')||Boolean(committedPending);
  async function inspectIntents(){const number=++intentSequence.current;if(alive.current)setIntentsReady(false);try{if(!intentCapable)throw Error('Durable Save recovery is unavailable. Saving is disabled; export your work.');const rows=await store.listSaveIntents(binding);if(!Array.isArray(rows))throw Error('Save recovery returned invalid history.');const checked=rows.map(record=>validateTaskSaveIntent(structuredClone(record)));if(checked.some(record=>record.original.binding.projectId!==binding.projectId||record.original.binding.rootIdentity!==binding.rootIdentity))throw Error('Save history belongs to another folder.');if(alive.current&&number===intentSequence.current){setSaveIntents(checked);setIntentError('');setIntentsReady(true);}return checked;}catch(e){if(alive.current&&number===intentSequence.current){setIntentError(e.message);setIntentsReady(false);}throw e;}}
  async function noUnresolvedIntents(){const records=await inspectIntents();if(records.some(record=>record.acknowledgment===null))throw Error('Reconcile the retained original Save before changing this plan.');}
  useEffect(()=>{void inspectIntents().catch(()=>{});const stop=store.subscribe?.(binding,()=>{void inspectIntents().catch(()=>{});});return()=>{intentSequence.current++;stop?.();};},[store]);
  useEffect(()=>{if(!operation)return;if(operationMismatch){setRecoveryError('The retained operation uses a different storage connection. Keep or export your text.');return;}if(operation.committed){setCommittedPending(operation.committed);setLedger(current=>!current||current.revision<operation.committed.revision?operation.committed.savedLedger:current);}if(operation.error)setError(`${operation.error} The outcome must be checked; your text was kept.`);},[operation,operationMismatch]);
  async function inspectRecovery(){const number=++recoverySequence.current;try{const value=await recovery.list(binding);if(alive.current&&number===recoverySequence.current){const own=value.records.find(row=>row.editorId===session.current?.editorId);closedSession.current=own?.status==='resolved';setSessionClosed(closedSession.current);if(closedSession.current){clearTimeout(checkpointTimer.current);setCheckpointing(false);}setRecoveryRows(value.records);setRecoveryReady(true);setRecoveryError('');}}catch(e){if(alive.current&&number===recoverySequence.current){setRecoveryReady(false);setRecoveryError(e.message);}}}
  async function flushRecovery(){clearTimeout(checkpointTimer.current);if(closedSession.current)throw Error('This editor session was closed. Continue in a new editor or export your text.');if(recoveryMismatch)throw Error('Retained editor recovery connection differs. Export your text.');const activeSession=session.current;if(!activeSession)return null;const version=textVersion.current;setCheckpointing(true);try{const saved=await activeSession.flush();if(alive.current&&session.current===activeSession){setRecoveryError('');await inspectRecovery();}return saved;}catch(e){if(alive.current&&session.current===activeSession)setRecoveryError(e.message);throw e;}finally{if(alive.current&&session.current===activeSession&&textVersion.current===version)setCheckpointing(false);}}
  function checkpoint(next,base){textVersion.current++;if(!session.current)session.current=createTaskFormSession(recovery,binding);session.current.update(next,base);forms.set(formKey,{form:next,revision:base,session:session.current,recovery});if(sessionClosed)return;setCheckpointing(true);clearTimeout(checkpointTimer.current);checkpointTimer.current=setTimeout(()=>{void flushRecovery().catch(()=>{});},250);}
  useEffect(()=>{const retained=forms.get(formKey);if(retained?.session&&retained.recovery!==recovery){setRecoveryError('The retained editor belongs to a different recovery connection. Export its text before continuing.');setRecoveryReady(false);return;}void inspectRecovery().then(()=>{if(alive.current&&retained?.session&&!closedSession.current)void flushRecovery().catch(()=>{});});const stop=recovery.subscribe?.(binding,()=>{void inspectRecovery();});return()=>{stop?.();recoverySequence.current++;clearTimeout(checkpointTimer.current);if(session.current&&!closedSession.current)void session.current.flush().catch(()=>{});};},[recovery]);
  const canReview=stale&&ledger.binding.projectId===binding.projectId&&ledger.binding.rootIdentity===binding.rootIdentity&&!['stale','unavailable'].includes(project.state)&&typeof store.rebind==='function';

  async function refresh(){
    const request=++sequence.current;setBusy(true);setError('');setReviewedTasks([]);setInventoryReviewed(false);setPendingImport(null);setImportReviewed(false);
    try{const value=await store.read(binding);if(alive.current&&sequence.current===request){setLedger(value);setNotice('Latest saved draft loaded. Unsaved form text is unchanged.');}}
    catch(e){if(alive.current&&sequence.current===request)setError(e.message);}
    finally{if(alive.current&&sequence.current===request)setBusy(false);}
  }
  useEffect(()=>{
    alive.current=true;refresh();
    // Shared-plan reconciliation and peer saves use this same store. Refresh
    // only saved Ledger state; refresh never clears the unfinished form or its
    // captured base revision. A changed base therefore requires explicit review.
    let backgroundRead=0;
    const stop=store.subscribe?.(binding,()=>{
      const read=++backgroundRead,foreground=sequence.current;
      // A store notification is not an explicit editor refresh. In particular,
      // Save-intent acknowledgments must not erase an operation-review receipt
      // or release another operation's busy state.
      void store.read(binding).then(value=>{
        if(!alive.current||read!==backgroundRead||foreground!==sequence.current)return;
        setLedger(current=>!current||value.revision>=current.revision?value:current);
        setReviewedTasks([]);setInventoryReviewed(false);setImportReviewed(false);
      }).catch(e=>{if(alive.current&&read===backgroundRead&&foreground===sequence.current)setError(e.message);});
    });
    if(typeof window!=='undefined'&&warnedWindow!==window){warnedWindow=window;window.addEventListener('beforeunload',event=>{if(forms.size||[...pastes.values()].some(Boolean)){event.preventDefault();event.returnValue='';}});}
    return()=>{alive.current=false;sequence.current++;stop?.();};
  },[store]);

  useEffect(()=>{
    if(!ledger||typeof window==='undefined')return;
    const reveal=()=>{
      const id=readTaskDraftLink(window.location.href,binding);
      if(!id||handledLink.current===window.location.hash)return;
      handledLink.current=window.location.hash;
      const task=ledger.tasks.find(item=>item.id===id);
      if(!task){setError('The linked task is not in this saved draft. No task was substituted.');return;}
      setLinkedTask(id);if(task.archived)setShowArchived(true);
    };
    reveal();window.addEventListener('hashchange',reveal);window.addEventListener('popstate',reveal);
    return()=>{window.removeEventListener('hashchange',reveal);window.removeEventListener('popstate',reveal);};
  },[ledger,binding]);
  useEffect(()=>{
    if(!linkedTask)return;
    const node=document.getElementById(`draft-task-${linkedTask}`);
    node?.scrollIntoView?.({block:'center'});node?.focus({preventScroll:true});
  },[linkedTask,showArchived]);

  function change(key,value){
    const next={...form,[key]:value};if(editingRevision.current==null)editingRevision.current=ledger?.revision??0;
    checkpoint(next,editingRevision.current);setForm(next);setDirty(true);setNotice('Unfinished edits — checkpointing for recovery. This is not a saved task.');
  }
  async function discard(){if(intentBlocked||busy||committedPending||taskFormOperations.read(binding))return;if(!dirty&&!session.current){setForm(blank());editingRevision.current=null;setNotice('Editor selection closed. Saved tasks are unchanged.');return;}const original=forms.get(formKey),originalSession=session.current,op=taskFormOperations.begin(binding,{kind:'discard',formEntry:original,session:originalSession,recovery,store});setBusy(true);try{await noUnresolvedIntents();const saved=await flushRecovery();taskFormOperations.update(binding,op.token,{checkpoint:saved});if(forms.get(formKey)!==original)throw Error('Newer editor text exists. Review it before discarding.');taskFormOperations.update(binding,op.token,{dispatched:true});await originalSession?.resolve('discarded',saved);taskFormOperations.update(binding,op.token,{status:'settled',discarded:true});if(!alive.current)return;if(forms.get(formKey)!==original)throw Error('Newer editor text was kept. Review the completed disposition.');forms.delete(formKey);session.current=null;setForm(blank());setDirty(false);editingRevision.current=null;taskFormOperations.clear(binding,op.token);await inspectRecovery();setNotice('Unfinished editor disposition retained. Saved revisions are unchanged.');}catch(e){taskFormOperations.update(binding,op.token,{status:'settled',error:e.message});if(alive.current)setRecoveryError(e.message);}finally{if(alive.current)setBusy(false);}}
  async function finishDurableIntent(record,captured,token,normal=false){
    const acknowledged=await reconcileTaskFormIntent({binding:record.original.binding,requestId:record.original.requestId,store,recovery});
    if(recoveryWire(acknowledged.original)!==recoveryWire(record.original)||recoveryWire(acknowledged.outcome)!==recoveryWire(record.outcome))throw Error('Acknowledged Save differs from the reviewed original. Your text was kept.');
    const latestLedger=await store.read(binding);if(!alive.current)return acknowledged;
    const newer=Boolean(acknowledged.acknowledgment?.newerEditorPreserved);
    if(!newer&&captured&&forms.get(formKey)===captured&&captured.session?.editorId===record.original.checkpoint.editorId&&recoveryWire(captured.form)===recoveryWire(record.original.checkpoint.form)){forms.delete(formKey);session.current=null;setForm(blank());setDirty(false);editingRevision.current=null;}
    if(token)taskFormOperations.clear(binding,token);setCommittedPending(null);setLedger(latestLedger);await inspectRecovery();await inspectIntents();
    if(alive.current)setNotice(newer?'Original Save reconciled. Newer editor text was preserved; inspect recovery for its current state.':normal&&record.outcome?.kind==='committed'?`Saved local draft revision ${record.outcome.ledger.revision}. No work was approved or executed.`:'Original Save reconciled. Its receipt and editor history were retained; no task was submitted again.');
    return acknowledged;
  }
  async function save(event){
    event.preventDefault();if(cannotEdit||taskFormOperations.read(binding))return;
    if(!dirty){setNotice('No editor changes to save. The saved Ledger is unchanged.');return;}
    if(editingRevision.current!==ledger.revision){setError('Another window saved a newer revision. Your unsaved form is kept; refresh before saving.');return;}
    const pendingForm=forms.get(formKey),op=taskFormOperations.begin(binding,{kind:'save',formEntry:pendingForm,session:session.current,recovery,store,baseLedger:structuredClone(ledger),requestId:crypto.randomUUID()});setBusy(true);setError('');
    try{
      await noUnresolvedIntents();if(!alive.current||forms.get(formKey)!==pendingForm)throw Error('Editor changed before preparation. Its text was kept.');
      const taskInput=parseTask(pendingForm.form),checkpoint=await flushRecovery();
      if(forms.get(formKey)!==pendingForm)throw Error('Newer editor text exists. Review before saving.');
      const original={requestId:op.requestId,binding:{...binding},baseLedger:structuredClone(ledger),taskInput,checkpoint};
      taskFormOperations.update(binding,op.token,{original,checkpoint,taskInput});
      const prepared=validateTaskSaveIntent(await store.prepareSaveIntent(original));if(recoveryWire(prepared.original)!==recoveryWire(original))throw Error('Prepared Save differs from its original. Nothing was dispatched.');
      const record=validateTaskSaveIntent(await store.commitSaveIntent(binding,original.requestId));
      if(record.original.requestId!==original.requestId||recoveryWire(record.original)!==recoveryWire(original)||record.outcome?.kind!=='committed')throw Error('Original Save receipt did not match. Keep the retained request.');
      const committed={revision:record.outcome.ledger.revision,savedLedger:record.outcome.ledger,session:session.current,checkpoint,pendingForm,requestId:original.requestId};pendingForm.committed=committed;
      taskFormOperations.update(binding,op.token,{committed});
      if(alive.current){setLedger(record.outcome.ledger);setCommittedPending(committed);}
      await finishDurableIntent(record,pendingForm,op.token,true);
      if(!alive.current)taskFormOperations.update(binding,op.token,{status:'settled'});
    }catch(e){taskFormOperations.update(binding,op.token,{status:'settled',error:e.message});if(alive.current){setError(e.message);void inspectIntents().catch(()=>{});}}
    finally{if(alive.current)setBusy(false);}
  }
  function edit(task){if(cannotEdit||taskFormOperations.read(binding))return;if(dirty){setError('Save or discard the current unsaved form before opening another task.');return;}const next=serializeTask(task);editingRevision.current=ledger.revision;setForm(next);setNotice(`Editing ${task.id}. Changes are not saved yet.`);}
  async function reapply(){
    if(cannotEdit||taskFormOperations.read(binding))return;
    const captured=forms.get(formKey);setBusy(true);try{await noUnresolvedIntents();if(!alive.current||forms.get(formKey)!==captured)return;editingRevision.current=ledger.revision;checkpoint(form,ledger.revision);setDirty(true);setError('');setNotice('Your form is now based on the displayed revision. Review it, then save explicitly.');}catch(e){if(alive.current)setError(e.message);}finally{if(alive.current)setBusy(false);}
  }
  function exportDraft(value=ledger){
    if(!value)return;
    const blob=new Blob([JSON.stringify(value,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download=`${binding.projectId}-draft-r${value.revision}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function exportEarlierForm(key,value){
    const [projectId,rootIdentity,censusDigest]=key.split(':');
    const data={kind:'UNSAVED_FORM_RECOVERY',binding:{projectId,rootIdentity,censusDigest},startedAtRevision:value.revision,form:value.form};
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),link=document.createElement('a');
    link.href=url;link.download=`${projectId}-unsaved-form-${censusDigest.slice(0,12)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function readImport(event){
    const file=event.target.files?.[0];event.target.value='';
    if(!file||cannotEdit||dirty||taskFormOperations.read(binding))return;
    const request=++sequence.current;setBusy(true);setError('');setPendingImport(null);setImportReviewed(false);
    try{
      await noUnresolvedIntents();if(!alive.current)return;
      if(file.size>TASK_DRAFT_IMPORT_BYTES)throw new Error('Choose a draft JSON file no larger than 8 MiB.');
      const source=parseTaskDraftImport(await file.text()),preview=importTaskDraft(ledger,source);
      if(alive.current&&sequence.current===request)setPendingImport({source,preview,expectedRevision:ledger.revision,targetTaskCount:ledger.tasks.length});
    }catch(e){if(alive.current&&sequence.current===request)setError(e.message);}
    finally{if(alive.current&&sequence.current===request)setBusy(false);}
  }
  async function confirmImport(){
    if(cannotEdit||dirty||!pendingImport||!importReviewed||taskFormOperations.read(binding))return;
    setBusy(true);setError('');
    try{
      await noUnresolvedIntents();if(!alive.current)return;
      const next=await store.importDraft(binding,pendingImport.expectedRevision,pendingImport.source);
      if(!alive.current)return;
      setLedger(next);setPendingImport(null);setImportReviewed(false);setHistory(null);setHistorical(null);
      setNotice(`Imported task copies into local draft revision ${next.revision}. Existing tasks and earlier revisions were kept. No work was approved or executed.`);
    }catch(e){if(alive.current){setError(e.message);setPendingImport(null);setImportReviewed(false);}}
    finally{if(alive.current)setBusy(false);}
  }
  // Paste a task list. Each pasted task is turned into the exact text the
  // "Add a task" form holds, then goes through the same form parser, Ledger
  // validator and durable Save intent (prepare, commit, acknowledge) as a
  // typed task. Nothing here writes the Ledger any other way.
  function changePaste(value){setPasteText(value);if(value)pastes.set(formKey,value);else pastes.delete(formKey);setPastePreview(null);}
  function checkPasted(base,rows){
    // Cumulative dry run with the real validator, so the preview shows the
    // numbers tasks would get and every refusal reason before anything is saved.
    let next=base;
    return rows.map(row=>{try{const taskInput=parseTask(row.form);next=updateTaskDraft(next,taskInput);return {...row,taskId:next.tasks.at(-1).id,reason:null};}catch(e){return {...row,taskId:null,reason:e.message};}});
  }
  function previewPaste(){
    if(!ledger)return;
    const parsed=parseTaskList(pasteText);
    setPasteResult(null);
    setPastePreview({text:pasteText,parsed,rows:checkPasted(ledger,parsed.tasks.map(entry=>({entry,form:taskListEntryToForm(entry)})))});
  }
  async function savePastedTask(form,base){
    await noUnresolvedIntents();
    const taskInput=parseTask(form);
    try{updateTaskDraft(base,taskInput);}catch(e){e.pasteValidation=true;throw e;}
    const pasteSession=createTaskFormSession(recovery,binding);pasteSession.update(form,base.revision);
    const checkpoint=await pasteSession.flush();
    const original={requestId:crypto.randomUUID(),binding:{...binding},baseLedger:structuredClone(base),taskInput,checkpoint};
    let prepared;
    try{prepared=validateTaskSaveIntent(await store.prepareSaveIntent(original));}
    catch(e){
      // Only close this task's editor checkpoint when no Save request was kept;
      // a retained request stays under Original Save recovery for retry or withdrawal.
      const kept=await store.readSaveIntent(binding,original.requestId).catch(()=>undefined);
      if(kept===null)await pasteSession.resolve('discarded',checkpoint).catch(()=>{});
      if(kept===undefined)throw Error(`${e?.message??e} Whether a Save request was kept could not be checked; look under Original Save recovery before adding more.`);
      if(kept!==null)throw Error(`${e?.message??e} Its Save request is kept under Original Save recovery; retry or withdraw it there.`);
      throw e;
    }
    if(recoveryWire(prepared.original)!==recoveryWire(original))throw Error('Prepared Save differs from its original. Nothing was dispatched.');
    let record;
    try{record=validateTaskSaveIntent(await store.commitSaveIntent(binding,original.requestId));if(record.outcome?.kind!=='committed'||recoveryWire(record.original)!==recoveryWire(original))throw Error('Original Save receipt did not match.');}
    catch(e){throw Error(`${e?.message??e} Its Save request is kept under Original Save recovery; retry or withdraw it there.`);}
    await reconcileTaskFormIntent({binding,requestId:original.requestId,store,recovery});
    return record.outcome.ledger;
  }
  async function addPasted(){
    if(cannotEdit||dirty||!pastePreview||pastePreview.text!==pasteText||taskFormOperations.read(binding))return;
    const {rows,parsed,text}=pastePreview,results=[];
    setBusy(true);setError('');setPasteResult(null);
    let current=ledger,stopped=false;
    try{
      for(const [index,row] of rows.entries()){
        const label={line:row.entry.line,title:row.entry.title};
        if(row.reason){results.push({...label,status:'refused',reason:row.reason});continue;}
        if(stopped){results.push({...label,status:'skipped'});continue;}
        if(alive.current)setNotice(`Adding pasted task ${index+1} of ${rows.length}… Nothing is approved or executed.`);
        try{current=await savePastedTask(row.form,current);results.push({...label,status:'added',taskId:current.tasks.at(-1).id});}
        catch(e){results.push({...label,status:'refused',reason:e?.message??String(e)});if(!e?.pasteValidation)stopped=true;}
      }
    }finally{
      const added=results.filter(r=>r.status==='added').length;
      if(alive.current){
        if(added)setLedger(value=>!value||current.revision>value.revision?current:value);
        setPastePreview(null);
        setPasteResult({results,total:rows.length,unreadable:parsed.errors,stopped});
        if(added===rows.length&&!parsed.errors.length&&pasteText===text)changePaste('');
        setNotice(added?`Added ${added} pasted task${added===1?'':'s'} as local drafts (revision ${current.revision}). No work was approved or executed.`:'No pasted tasks were added. Your pasted text is kept.');
        setBusy(false);
        void inspectRecovery();void inspectIntents().catch(()=>{});
      }
    }
  }
  async function continueWithInventory(){
    if(!canReview||busy||!inventoryReviewed||reviewedTasks.length!==ledger.tasks.length||taskFormOperations.read(binding))return;
    setBusy(true);setError('');
    try{
      await noUnresolvedIntents();if(!alive.current)return;
      const next=await store.rebind(binding,{fromBinding:ledger.binding,expectedRevision:ledger.revision,reviewedTaskIds:reviewedTasks});
      if(!alive.current)return;
      setLedger(next);setHistory(null);setHistorical(null);setReviewedTasks([]);setInventoryReviewed(false);
      setNotice(`Saved local draft revision ${next.revision} for the current inventory. Previous revisions and earlier unsaved forms were kept. No work was approved or executed.`);
    }catch(e){if(alive.current){setError(e.message);setReviewedTasks([]);setInventoryReviewed(false);}}
    finally{if(alive.current)setBusy(false);}
  }
  async function showHistory(){try{setError('');const value=await store.history(binding);if(alive.current)setHistory(value);}catch(e){if(alive.current)setError(e.message);}}
  async function viewRevision(revision){try{const value=await store.readRevision(binding,revision);if(alive.current)setHistorical(value);}catch(e){if(alive.current)setError(e.message);}}
  function exportForm(value){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})),anchor=document.createElement('a');anchor.href=url;anchor.download=`${binding.projectId}-unfinished-editor.json`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  async function restoreForm(row){if(intentBlocked||taskFormOperations.read(binding)||busy||dirty||committedPending||!sameTaskDraftBinding(row.binding,binding))return;setBusy(true);try{await noUnresolvedIntents();if(!alive.current)return;const current=await recovery.read(row.binding,row.editorId);if(JSON.stringify(current)!==JSON.stringify(row))throw Error('Retained editor changed. Refresh recovery and review again.');const fork=createTaskFormSession(recovery,binding);fork.update(row.form,row.baseLedgerRevision);await fork.flush();if(!alive.current)return;session.current=fork;forms.set(formKey,{form:row.form,revision:row.baseLedgerRevision,session:fork,recovery});setForm(row.form);editingRevision.current=row.baseLedgerRevision;setSessionClosed(false);setDirty(true);await inspectRecovery();setNotice('Restored a separate unfinished editor. The source remains unfinished and may still be open in another tab.');}catch(e){if(alive.current){setRecoveryError(e.message);await inspectRecovery();setRecoveryError(e.message);}}finally{if(alive.current)setBusy(false);}}
  async function continueEditor(){if(intentBlocked||taskFormOperations.read(binding)||busy||committedPending||!ledger||stale||recoveryMismatch)return;setBusy(true);const original=forms.get(formKey),visible=form,base=editingRevision.current??ledger.revision;try{await noUnresolvedIntents();if(!alive.current)return;const fork=createTaskFormSession(recovery,binding);fork.update(visible,base);await fork.flush();if(!alive.current)return;if(forms.get(formKey)!==original)throw Error('Visible text changed. The separate checkpoint was kept; review recovery.');session.current=fork;forms.set(formKey,{form:visible,revision:base,session:fork,recovery});setSessionClosed(false);setCheckpointing(false);setDirty(true);await inspectRecovery();setNotice('Continued in a new editor at the same Ledger base revision. Original history was kept.');}catch(e){if(alive.current){await inspectRecovery();setRecoveryError(e.message);}}finally{if(alive.current)setBusy(false);}}
  async function disposeForm(row){if(intentBlocked||busy||taskFormOperations.read(binding))return;setBusy(true);try{await noUnresolvedIntents();if(!alive.current)return;await recovery.resolve({binding:row.binding,editorId:row.editorId,expectedRevision:row.revision,reason:'discarded'});await inspectRecovery();}catch(e){if(alive.current)setRecoveryError(e.message);}finally{if(alive.current)setBusy(false);}}
  async function reconcileSaved(){const active=taskFormOperations.read(binding);if(committedPending?.requestId&&active?.original){return runIntentAction({original:active.original},'reconcile');}if(!committedPending||busy||active?.status==='pending'||operationMismatch)return;setBusy(true);try{if(forms.get(formKey)!==committedPending.pendingForm)throw Error('Newer text exists. Export it and review retained sessions; it has not been cleared.');const checked=await reconcileTaskFormSave({binding,savedLedger:committedPending.savedLedger,checkpoint:committedPending.checkpoint,store,recovery,session:committedPending.session});if(!alive.current)return;if(forms.get(formKey)!==committedPending.pendingForm)throw Error('Newer text was retained. Refresh recovery and review it.');forms.delete(formKey);if(active)taskFormOperations.clear(binding,active.token);session.current=null;setForm(blank());setDirty(false);editingRevision.current=null;setCommittedPending(null);await inspectRecovery();setError('');setNotice(`Verified saved Ledger revision ${checked.ledgerRevision}. Editor disposition remains ${checked.resolution}; its history was not rewritten. Refresh the Ledger before planning further changes.`);}catch(e){if(alive.current)setRecoveryError(e.message);}finally{if(alive.current)setBusy(false);}}
  async function runIntentAction(displayed,action){
    if(!intentCapable||busy||operationMismatch)return;
    const original=structuredClone(displayed.original),existing=taskFormOperations.read(binding);
    if(original.binding.projectId!==binding.projectId||original.binding.rootIdentity!==binding.rootIdentity||existing?.status==='pending')return;
    if(action==='retry'&&!sameTaskDraftBinding(original.binding,binding)){setIntentError('An earlier inventory request cannot be retried here. Withdraw or inspect the exact original instead.');return;}
    if(existing&&!existing.original){setIntentError('Another editor operation is retained. Review it first.');return;}
    if(existing?.original&&recoveryWire(existing.original)!==recoveryWire(original)){setIntentError('Another original operation is retained. Review it first.');return;}
    const captured=forms.get(formKey),op=existing??taskFormOperations.begin(binding,{kind:'save',original,formEntry:captured,session:session.current,recovery,store});taskFormOperations.update(binding,op.token,{status:'pending'});setBusy(true);setError('');
    try{
      let record=await store.readSaveIntent(original.binding,original.requestId);
      if(!record&&action==='retry')record=await store.prepareSaveIntent(original);
      if(!record&&action==='withdraw')record=await store.withdrawSaveIntent(original.binding,original.requestId,original);
      record=validateTaskSaveIntent(record);if(recoveryWire(record.original)!==recoveryWire(original))throw Error('Retained original changed. Nothing was substituted.');
      if(action==='retry'&&record.outcome===null)record=validateTaskSaveIntent(await store.commitSaveIntent(original.binding,original.requestId));
      if(action==='withdraw'&&record.outcome?.kind!=='withdrawn')record=validateTaskSaveIntent(await store.withdrawSaveIntent(original.binding,original.requestId));
      if(recoveryWire(record.original)!==recoveryWire(original))throw Error('Save outcome differs from its original. Your text was kept.');
      if(record.outcome===null)throw Error('Original Save has no outcome. Retry or withdraw it first.');
      await finishDurableIntent(record,captured,op.token);
      if(!alive.current)taskFormOperations.update(binding,op.token,{status:'settled'});
    }catch(e){taskFormOperations.update(binding,op.token,{status:'settled',error:e.message});if(alive.current){setIntentError(e.message);void inspectIntents().catch(()=>{});}}
    finally{if(alive.current)setBusy(false);}
  }
  async function reviewOperation(){
    const active=taskFormOperations.read(binding);if(!active||active.status==='pending'||busy||operationMismatch)return;if(active.original)return runIntentAction({original:active.original},'retry');setBusy(true);
    try{
      if(forms.get(formKey)!==active.formEntry)throw Error('Newer editor text exists. Keep it and review the retained operation separately.');
      const stillCurrent=()=>alive.current&&taskFormOperations.read(binding)?.token===active.token&&forms.get(formKey)===active.formEntry;
      if(active.kind==='save'){
        const checked=await reviewFailedTaskSave(active,binding);if(!stillCurrent())return;
        if(checked.outcome==='saved'){
          const committed={revision:checked.savedLedger.revision,savedLedger:checked.savedLedger,session:active.session,checkpoint:active.checkpoint,pendingForm:active.formEntry};
          if(active.formEntry)active.formEntry.committed=committed;taskFormOperations.update(binding,active.token,{committed,error:null});setCommittedPending(committed);setNotice('A matching saved result was found. This does not identify which call wrote it. Reconcile its editor before another save.');return;
        }
        setLedger(checked.current);taskFormOperations.clear(binding,active.token);setError('Operation reviewed. Your form remains unfinished; compare the displayed Ledger before retrying.');return;
      }
      if(!active.dispatched){if(!stillCurrent())return;taskFormOperations.clear(binding,active.token);setRecoveryError('The disposition was not sent. Your text remains unfinished; retry when storage is available.');return;}
      const checkpoint=active.checkpoint;if(!checkpoint)throw Error('No acknowledged editor checkpoint is available. Keep or export your text.');
      const record=await recovery.read(binding,checkpoint.editorId);if(!stillCurrent())return;
      const same=record&&record.schemaVersion===1&&record.kind==='TASK_FORM_RECOVERY'&&recoveryWire(record.binding)===recoveryWire(binding)&&record.editorId===checkpoint.editorId&&record.baseLedgerRevision===checkpoint.baseLedgerRevision&&recoveryWire(record.form)===recoveryWire(checkpoint.form);
      if(!same)throw Error('Editor disposition does not match. Nothing was cleared.');
      if(record.status==='unfinished'&&record.resolution===null&&record.revision===checkpoint.revision){taskFormOperations.clear(binding,active.token);setRecoveryError('Editor remains unfinished. Review before retrying the disposition.');return;}
      if(record.status!=='resolved'||record.revision!==checkpoint.revision+1||record.resolution!=='discarded')throw Error('A different editor disposition was retained. Nothing was changed.');
      forms.delete(formKey);taskFormOperations.clear(binding,active.token);session.current=null;setForm(blank());setDirty(false);editingRevision.current=null;await inspectRecovery();setError('');setNotice('Verified discarded editor. Its history was retained; saved tasks are unchanged.');
    }catch(e){if(alive.current)setRecoveryError(e.message);}finally{if(alive.current)setBusy(false);}
  }
  return <section className="task-draft-ledger" aria-label="Project task drafts">
    <header><div><h2>Plan the work</h2><p>Local draft · {ledger?`${ledger.tasks.length} tasks · revision ${ledger.revision}`:'Opening saved tasks…'}</p></div><div className="task-draft-tools"><button type="button" onClick={refresh} disabled={busy}>Refresh draft</button><button type="button" onClick={()=>exportDraft()} disabled={!ledger}>Export draft</button><button type="button" onClick={showHistory} disabled={!ledger}>Revision history</button></div></header>
    <p className="task-draft-boundary">Saved on this device for this project and folder census. Browser storage is not a backup or shared authority: export important drafts. Tasks, owners and file scopes are proposals—not approval, worker grants or completion. Do not enter credentials.</p>
    {error&&<p role="alert" className="task-draft-error">{error}</p>}
    {stale&&<p role="alert" className="task-draft-error">The folder census changed. Your previous draft remains readable and exportable. Review it against the new inventory before resuming draft editing.</p>}
    <p role="status" aria-label="Draft editing status">{notice}</p>
    <section aria-label="Original Save recovery"><h3>Original Save recovery</h3><p>{!intentsReady?'Checking original Save requests before further changes…':'Save request history inspected. Requests and receipts are retained; they do not authorize execution.'}</p>{intentError&&<p role="alert">{intentError}</p>}<button type="button" onClick={()=>{void inspectIntents().catch(()=>{});}}>Refresh original Saves</button><button type="button" onClick={()=>exportForm({kind:'SAVE_INTENT_HISTORY_EXPORT',records:saveIntents})}>Export original Saves</button>{saveIntents.filter(record=>record.acknowledgment===null).map(record=><article key={record.original.requestId}><h4>Original Save {record.original.requestId}</h4><p>{record.outcome?.kind==='committed'?`Saved Ledger revision ${record.outcome.ledger.revision} — editor acknowledgment required`:record.outcome?.kind==='withdrawn'?'Withdrawn — editor acknowledgment required':'Prepared — outcome not recorded'}</p><p>{sameTaskDraftBinding(record.original.binding,binding)?'Current inventory':'Earlier inventory — exact original only; no rebinding'}</p>{record.outcome===null?<><button type="button" disabled={busy||operation?.status==='pending'||operationMismatch} onClick={()=>{void runIntentAction(record,'retry');}}>Retry original Save</button><button type="button" disabled={busy||operation?.status==='pending'||operationMismatch} onClick={()=>{void runIntentAction(record,'withdraw');}}>Withdraw original Save</button></>:<button type="button" disabled={busy||operation?.status==='pending'||operationMismatch} onClick={()=>{void runIntentAction(record,'reconcile');}}>Reconcile original Save</button>}<details><summary>Original request and receipt</summary><pre>{JSON.stringify(record,null,2)}</pre></details></article>)}</section>
    {operation&&<section aria-label="Retained editor operation"><p>{operation.status==='pending'?'Editor operation is still pending. Do not submit it again.':'Editor operation finished or was interrupted. Review its retained outcome before continuing.'}</p>{operation.status!=='pending'&&!operation.committed&&<button type="button" disabled={busy||operationMismatch} onClick={reviewOperation}>{operation.kind==='discard'?'Review discarded editor outcome':'Review editor operation outcome'}</button>}{operation.original&&operation.status!=='pending'&&!saveIntents.some(record=>record.original.requestId===operation.original.requestId)&&<button type="button" disabled={busy||operationMismatch} onClick={()=>{void runIntentAction({original:operation.original},'withdraw');}}>Withdraw original Save</button>}</section>}
    {sessionClosed&&<p role="alert">This editor session was closed. Your visible text is kept; export it or continue in a new editor.</p>}
    {(sessionClosed||Boolean(recoveryError))&&<button type="button" disabled={intentBlocked||busy||Boolean(operation)||Boolean(committedPending)||!ledger||stale||recoveryMismatch} onClick={continueEditor}>Continue in a new editor</button>}
    <p>Restoring copies a retained editor; it does not close the source. Marking a retained editor discarded closes that exact session, including another tab still using it.</p>
    <section className="task-form-recovery" aria-label="Unfinished editor recovery"><h3>Unfinished editor recovery</h3><p>{!recoveryReady?'Checking retained unfinished editors…':checkpointing?'Checkpointing current text… not yet acknowledged.':'Recovery inspected. Checkpoints are unfinished text, not saved tasks or backups.'}</p>{recoveryError&&<p role="alert">{recoveryError} Keep or export your visible text.</p>}<button type="button" onClick={()=>{void inspectRecovery();}}>Refresh editor recovery</button><button type="button" onClick={()=>exportForm({binding,baseLedgerRevision:editingRevision.current,form})}>Export current editor text</button>{committedPending&&<div role="alert">Ledger revision {committedPending.revision} was saved, but editor recovery is unresolved. Do not save the task again.<button type="button" disabled={busy||operation?.status==='pending'||operationMismatch} onClick={reconcileSaved}>Reconcile saved editor</button></div>}{recoveryRows.filter(row=>row.status==='unfinished'&&row.editorId!==session.current?.editorId).map(row=><details key={row.editorId}><summary>{row.form.title||'Untitled editor'} · base Ledger {row.baseLedgerRevision} · {row.editorId}</summary><p>{saveIntents.some(record=>record.original.checkpoint.editorId===row.editorId)?'Original Save request retained — reconcile it before further changes.':'Editor checkpoint only — no Save request has been inferred.'}</p><p>{sameTaskDraftBinding(row.binding,binding)?'Current inventory':'Earlier inventory — read or export only; no automatic rebinding'}</p><pre>{JSON.stringify(row,null,2)}</pre><button type="button" onClick={()=>exportForm(row)}>Export retained editor</button><button type="button" disabled={intentBlocked||busy||Boolean(operation)||dirty||Boolean(committedPending)||!sameTaskDraftBinding(row.binding,binding)} onClick={()=>{void restoreForm(row);}}>Restore as separate editor</button><button type="button" disabled={intentBlocked||busy||Boolean(operation)} onClick={()=>{void disposeForm(row);}}>Mark this retained editor discarded</button></details>)}</section>
    <TaskDraftDeliveryPanel project={project} binding={binding} ledger={ledger} store={store} disabled={cannotEdit} dirty={dirty||recoveryBlocked}/>
    <PlanApprovalPanel project={project} binding={binding} ledger={ledger} store={store} disabled={cannotEdit} dirty={dirty||recoveryBlocked}/>
    {typeof store.importDraft==='function'&&<details className="task-draft-rebind"><summary>Import an exported draft</summary><section aria-label="Import planning draft"><h3>Recover tasks from an exported draft</h3><p>Choose an exported LOCAL_DRAFT JSON file for this exact project, folder and inventory. Existing tasks are never replaced. Imported tasks receive new numbers when this ledger already has history; dependencies between imported tasks follow the displayed mapping. Importing the same file again creates another set of task copies. This is local draft recovery, not approval or a backup of revision history.</p><label>Draft JSON file <input type="file" accept=".json,application/json" onChange={readImport} disabled={cannotEdit||dirty}/></label>{dirty&&<p>Save or discard the current unsaved form before importing. Your text has been kept.</p>}{pendingImport&&<div><h4>Review {pendingImport.source.tasks.length} task copies</h4><p>Source revision {pendingImport.source.revision} → new local revision {pendingImport.preview.ledger.revision}. Existing tasks: {pendingImport.targetTaskCount}; tasks after import: {pendingImport.preview.ledger.tasks.length}.</p>{pendingImport.source.tasks.map((task,index)=><details key={task.id}><summary>{task.id} → {pendingImport.preview.references[index].taskId} · {task.title}{task.archived?' · archived':''}</summary><p>{task.description||'Description unanswered'}</p><p>Proposed owner: {task.owner||'unanswered'}</p><p>Imported dependencies: {pendingImport.preview.ledger.tasks[pendingImport.targetTaskCount+index].dependsOn.join(', ')||'none recorded'}</p><pre tabIndex={0}>{task.claims.map(claim=>`${claim.access} ${claim.path}`).join('\n')||'File scope unanswered'}</pre><p>Acceptance: {task.acceptance||'unanswered'}</p><p>Recovery: {task.recovery||'unanswered'}</p></details>)}<p>{inspectTaskDraft(pendingImport.preview.ledger).findings.length} planning findings after import. Import does not clear conflicts or verify files.</p><label className="task-draft-archived"><input type="checkbox" checked={importReviewed} disabled={cannotEdit||dirty} onChange={e=>setImportReviewed(e.target.checked)}/> I reviewed the task copies and number mapping; keep them unapproved</label><button type="button" disabled={cannotEdit||dirty||!importReviewed} onClick={confirmImport}>Import reviewed task copies</button><button type="button" disabled={busy} onClick={()=>{setPendingImport(null);setImportReviewed(false);}}>Cancel import</button></div>}</section></details>}
    <details className="task-draft-rebind"><summary>Paste a task list{pasteText?' · your pasted text is kept':''}</summary><section aria-label="Paste a task list">
      <h3>Add several tasks at once</h3>
      <p>Paste one task per line starting with "- " or "1.", or a "## heading" per task. Under a task you can add lines such as <code>owner: Sam</code>, <code>write: src/app.js</code>, <code>read: package.json</code>, <code>done when: it works</code> or <code>description: …</code>. A CSV or TSV table with a header row also works (columns: title, description, write, read, done_when, owner; other columns are ignored). Each task is checked and saved exactly like the form. Nothing is approved or run.</p>
      <label>Task list<textarea rows={8} maxLength={TASK_LIST_PASTE_CHARS} value={pasteText} onChange={e=>changePaste(e.target.value)} spellCheck={false}/></label>
      <div className="task-draft-tools"><button type="button" onClick={previewPaste} disabled={!ledger||busy||!pasteText.trim()}>Preview</button>{pastePreview&&<button type="button" className="primary-button" onClick={addPasted} disabled={cannotEdit||dirty||!pastePreview.rows.some(row=>!row.reason)}>Add {pastePreview.rows.filter(row=>!row.reason).length} task{pastePreview.rows.filter(row=>!row.reason).length===1?'':'s'}</button>}{(pasteText||pastePreview)&&<button type="button" disabled={busy} onClick={()=>{changePaste('');setPasteResult(null);}}>Clear pasted text</button>}</div>
      {pastePreview&&(dirty?<p>Save or discard the task you are typing in the form before adding pasted tasks. Your pasted text is kept.</p>:cannotEdit&&!busy?<p>Adding is paused: {!ledger?'saved tasks are still opening.':stale?'the folder census changed; review the draft above first.':['stale','unavailable'].includes(project.state)?'the project folder is unavailable right now.':intentBlocked?'an earlier Save must be finished under Original Save recovery first.':'an editor operation above needs review first.'} Your pasted text is kept.</p>:null)}
      {pastePreview&&<section aria-label="Paste preview"><h4>Preview ({pastePreview.parsed.format==='markdown'?'Markdown list':pastePreview.parsed.format.toUpperCase()+' table'})</h4>
        {pastePreview.rows.length>0?<ol>{pastePreview.rows.map(row=><li key={row.entry.line}><b>{row.reason?'Will not be added':`Will be ${row.taskId}`}</b> · {row.entry.title} <small>(line {row.entry.line})</small>{row.reason?<p role="note">Refused: {row.reason}</p>:<small> · owner: {row.entry.owner||'unanswered'} · files: {[...row.entry.write.map(path=>`write ${path}`),...row.entry.read.map(path=>`read ${path}`)].join(', ')||'none'} · done when: {row.entry.acceptance||'unanswered'}</small>}</li>)}</ol>:<p>No tasks were found in the pasted text.</p>}
        {pastePreview.parsed.errors.length>0&&<><h4>Lines that could not be read</h4><ul>{pastePreview.parsed.errors.map((item,index)=><li key={index}>Line {item.line}{item.text?<> <code>{item.text}</code></>:null}: {item.reason}</li>)}</ul></>}
        {pastePreview.parsed.notes.length>0&&<ul>{pastePreview.parsed.notes.map((item,index)=><li key={index}>Line {item.line} <code>{item.text}</code>: {item.reason}</li>)}</ul>}
        {pastePreview.parsed.ignoredColumns.length>0&&<p>Ignored columns: {pastePreview.parsed.ignoredColumns.join(', ')}.</p>}
      </section>}
      {pasteResult&&<section aria-label="Paste result"><h4>Added {pasteResult.results.filter(r=>r.status==='added').length} of {pasteResult.total} pasted tasks</h4><ul>{pasteResult.results.map((r,index)=><li key={index}>{r.status==='added'?`Added ${r.taskId} · ${r.title}`:r.status==='refused'?`Refused · ${r.title} (line ${r.line}): ${r.reason}`:`Not tried · ${r.title} (line ${r.line}): adding stopped after an earlier task was refused.`}</li>)}</ul>{pasteResult.unreadable.length>0&&<p>{pasteResult.unreadable.length} line{pasteResult.unreadable.length===1?'':'s'} could not be read and {pasteResult.unreadable.length===1?'was':'were'} not used.</p>}{pasteResult.results.some(r=>r.status!=='added')&&<p>Your pasted text is kept. Fix the refused tasks, refresh the draft if another window saved, then Preview again. Tasks already added are listed above, so remove them from the text before adding again.</p>}</section>}
    </section></details>
    {canReview&&<section aria-label="Review changed folder inventory" className="task-draft-rebind"><h3>Continue planning after a folder change</h3><p>This keeps every task and records a new device-local draft revision. Earlier revisions keep their original inventory. This does not verify files, approve work, resolve conflicts or enable workers.</p><dl><dt>Saved draft inventory</dt><dd><code>{ledger.binding.censusDigest}</code></dd><dt>Current project inventory</dt><dd><code>{binding.censusDigest}</code></dd></dl><p>Review each task's full details and file scope against your current app. File existence and contents are not checked here. Keep outdated obligations as drafts to revise after continuing; do not treat them as verified.</p><fieldset disabled={intentBlocked||busy||Boolean(operation)}><legend>Tasks in saved revision {ledger.revision}</legend>{ledger.tasks.map(task=><details key={task.id}><summary>{task.id} · {task.title}{task.archived?' · archived':''}</summary><p>{task.description||'Description unanswered'}</p><p>Owner: {task.owner||'unanswered'} · Dependencies: {task.dependsOn.join(', ')||'none recorded'}</p><pre tabIndex={0}>{task.claims.map(claim=>`${claim.access} ${claim.path}`).join('\n')||'File scope unanswered'}</pre><p>Acceptance: {task.acceptance||'unanswered'}</p><p>Recovery: {task.recovery||'unanswered'}</p><label className="task-draft-archived"><input type="checkbox" checked={reviewedTasks.includes(task.id)} onChange={e=>setReviewedTasks(ids=>e.target.checked?[...ids,task.id]:ids.filter(id=>id!==task.id))}/> I reviewed {task.id} for continued draft planning</label></details>)}<label className="task-draft-archived"><input type="checkbox" checked={inventoryReviewed} onChange={e=>setInventoryReviewed(e.target.checked)}/> Keep these tasks as unapproved drafts for the current inventory</label><button type="button" onClick={continueWithInventory} disabled={!inventoryReviewed||reviewedTasks.length!==ledger.tasks.length}>Continue drafts with current inventory</button></fieldset></section>}
    {earlierForms.length>0&&<section aria-label="Recover earlier unsaved forms" className="task-draft-error"><h3>Unsaved text from an earlier folder census</h3><p>Your text has not been rebound or discarded. Review or export it before closing the app. The recovery file is an unsaved form, not an approved task ledger.</p>{earlierForms.map(([key,value])=><details key={key}><summary>{value.form.title||'Untitled task'} · earlier census {key.split(':')[2].slice(0,12)}</summary><pre tabIndex={0}>{JSON.stringify(value.form,null,2)}</pre><button type="button" onClick={()=>exportEarlierForm(key,value)}>Export this unsaved form</button></details>)}</section>}
    <div className="task-draft-layout">
      <div>
        <label className="task-draft-archived"><input type="checkbox" checked={showArchived} onChange={e=>setShowArchived(e.target.checked)}/> Show archived tasks</label>
        <div className="task-draft-list">
          {ledger?.tasks.filter(t=>showArchived||!t.archived).map(task=><article key={task.id} id={`draft-task-${task.id}`} tabIndex={-1} data-linked={linkedTask===task.id}><header><code>{task.id}</code><h3>{task.title}</h3><button type="button" onClick={()=>edit(task)} disabled={cannotEdit}>Edit {task.id}</button></header><p>{task.description||'Description unanswered'}</p><small>{task.archived?'Archived draft':'Draft'} · {task.owner||'Owner unanswered'} · Depends on: {task.dependsOn.join(', ')||'none recorded'}</small><details open={linkedTask===task.id?true:undefined}><summary>Scope, acceptance and recovery</summary><pre tabIndex={0}>{task.claims.map(c=>`${c.access} ${c.path}`).join('\n')||'File scope unanswered'}</pre><p><b>Acceptance:</b> {task.acceptance||'Unanswered'}</p><p><b>Recovery:</b> {task.recovery||'Unanswered'}</p></details></article>)}
          {ledger&&!ledger.tasks.length&&<p>No task drafts yet. Add the first task using the form.</p>}
        </div>
        <details className="task-draft-findings" open={Boolean(findings?.findings.length)}><summary>{findings?.findings.length??0} planning review findings</summary><p>These are draft checks, not a collision-clearance receipt. Read/read sharing is allowed; overlapping writes and dependency problems need review.</p><ul>{findings?.findings.slice(0,100).map((finding,index)=><li key={index}>{finding.detail}</li>)}</ul>{findings?.findings.length>100&&<p>Showing the first 100 findings. Narrow the plan and resolve overlaps before approval.</p>}</details>
      </div>
      <form onSubmit={save} aria-label="Task draft editor">
        <h3>{form.id?`Edit ${form.id}`:'Add a task'}</h3>
        <fieldset disabled={cannotEdit}>
          <label>Task title<input maxLength={160} required value={form.title} onChange={e=>change('title',e.target.value)}/></label>
          <label>Full description<textarea maxLength={8000} rows={3} value={form.description} onChange={e=>change('description',e.target.value)}/></label>
          <label>Proposed owner<input maxLength={120} value={form.owner} onChange={e=>change('owner',e.target.value)}/></label>
          <label>Acceptance criteria<textarea maxLength={8000} rows={3} value={form.acceptance} onChange={e=>change('acceptance',e.target.value)}/></label>
          <label>Recovery plan<textarea maxLength={8000} rows={2} value={form.recovery} onChange={e=>change('recovery',e.target.value)}/></label>
          <label>File scope <small>One per line: write src/app.js or read package.json</small><textarea maxLength={16000} rows={3} value={form.claims} onChange={e=>change('claims',e.target.value)}/></label>
          <label>Depends on task IDs <small>For example: T0001, T0002</small><input maxLength={512} value={form.dependsOn} onChange={e=>change('dependsOn',e.target.value)}/></label>
          {form.id&&<label className="task-draft-archived"><input type="checkbox" checked={form.archived} onChange={e=>change('archived',e.target.checked)}/> Archive task (keep history)</label>}
          <button type="submit" className="primary-button">{busy?'Saving…':'Save task draft'}</button>
        </fieldset>
        <button type="button" onClick={discard} disabled={intentBlocked||busy||Boolean(operation)||(!dirty&&!form.id)}>Discard unsaved edits</button>
        {dirty&&ledger&&editingRevision.current!==ledger.revision&&<section aria-label="Review concurrent changes"><p>Another revision exists. Your form has not replaced it. Compare the latest saved task below with your form before reapplying.</p><pre tabIndex={0}>{JSON.stringify(ledger.tasks.find(task=>task.id===form.id)??{note:'New task; no existing task will be replaced.'},null,2)}</pre><button type="button" onClick={reapply} disabled={cannotEdit}>I reviewed the latest revision — reapply my form</button></section>}
      </form>
    </div>
    {history&&<section aria-label="Draft revision history"><h3>Latest saved revisions (up to 50)</h3><div className="task-draft-tools">{history.map(item=><button type="button" key={item.revision} onClick={()=>viewRevision(item.revision)}>Revision {item.revision} · {item.taskCount} tasks</button>)}</div></section>}
    {historical&&<section aria-label="Historical draft"><h3>Read-only revision {historical.revision}</h3><button type="button" onClick={()=>exportDraft(historical)}>Export this revision</button><pre tabIndex={0}>{JSON.stringify(historical,null,2)}</pre></section>}
  </section>;
}
