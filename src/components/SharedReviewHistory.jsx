import {useEffect,useRef,useState} from 'react';
import {validateSharedTaskReconciliation} from '../project/sharedTaskReconciliation.js';
import {sameTaskDraftBinding} from '../project/taskDraftLedger.js';
import {submissionWire} from '../project/taskDraftSubmission.js';

export function SharedReviewHistory({store,binding}){
 const [state,setState]=useState({busy:true,records:[]});const sequence=useRef(0),alive=useRef(false);
 async function refresh(){const token=++sequence.current;setState({busy:true,records:[]});try{
  const values=await store.reconciliationHistory(binding);if(!Array.isArray(values)||values.length>64)throw Error('History bound');
  const records=[],seen=new Set();
  for(const value of values){const record=await validateSharedTaskReconciliation(value);if(!sameTaskDraftBinding(record.localBase.binding,binding)||seen.has(record.ledger.revision))throw Error('History identity');seen.add(record.ledger.revision);const saved=await store.readRevision(binding,record.ledger.revision);if(submissionWire(saved)!==submissionWire(record.ledger))throw Error('Saved revision mismatch');records.push(record);}
  records.sort((a,b)=>b.ledger.revision-a.ledger.revision);
  if(alive.current&&token===sequence.current)setState({busy:false,records});
 }catch{if(alive.current&&token===sequence.current)setState({busy:false,records:[],error:true});}}
 useEffect(()=>{alive.current=true;void refresh();let stop;try{stop=store.subscribe?.(binding,()=>{void refresh();});}catch{}return()=>{alive.current=false;sequence.current++;stop?.();};},[store,binding.projectId,binding.rootIdentity,binding.censusDigest]);
 return <section aria-label="Saved review history" style={{marginTop:24}}><h4>Saved review history</h4><p>Check here after an interrupted or uncertain save. These are local records, not proof that an agent is connected or work was approved.</p><button type="button" onClick={refresh} disabled={state.busy}>Refresh saved reviews</button>
  <p role="status">{state.busy?'Checking saved reviews and their exact local revisions…':state.error?'Saved review status is unavailable.':`${state.records.length} saved review${state.records.length===1?'':'s'} verified against local revision history.`}</p>
  {state.error&&<p role="alert">Saved reviews could not be verified. Do not assume the save failed or repeat it as a new operation. Existing records were not removed.</p>}
  {state.records.length===0&&!state.busy&&!state.error&&<p>No saved review was found for this folder inventory. This does not establish the outcome of a save still in progress.</p>}
  {state.records.map(record=><details key={record.ledger.revision} style={{marginTop:16,border:'1px solid #aab6b5',borderRadius:8,padding:12,overflowWrap:'anywhere'}}><summary>Local revision {record.ledger.revision} · {record.ledger.tasks.length} tasks · originals retained</summary><p>Combined local revision {record.localBase.revision} with shared revision {record.sharedSnapshot.observedHead.hostRevision}. Saved {record.ledger.updatedAt}. Later work may exist.</p><h5>Recorded choices</h5><ul>{record.choices.map(choice=><li key={choice.taskId}>{choice.taskId} · {choice.version==='local'?'Kept local':'Used shared'} · {record.ledger.tasks.find(task=>task.id===choice.taskId)?.title}</li>)}</ul><p>{record.findings.length} planning findings at the time of review. Saving did not resolve these or send the plan.</p><details><summary>Advanced: complete originals and saved review</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',userSelect:'text',fontSize:14}}>{JSON.stringify(record,null,2)}</pre></details></details>)}
 </section>;
}
