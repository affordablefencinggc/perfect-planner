import {assertProjectId} from '../project/projectIds.js';
import {getRuntimeEventSession} from './runtimeEventSession.js';

export const noteFields = Object.freeze({turn:'Exchange reference',request:'Request summary',response:'Reply / actions summary',observed:'Observed result',explanation:'Explanation / suspected cause',error:'Error observed',solution:'Proposed solution / next action',evidence:'Verification evidence reference'});
export function appendDeveloperNote(project,input,events=getRuntimeEventSession()) {
  assertProjectId(project?.projectId);
  if(!Number.isSafeInteger(project.generation)||project.generation<0)throw Error('Select a current project.');
  if(!input||Object.keys(input).some(k=>!Object.hasOwn(noteFields,k)))throw Error('Invalid note fields.');
  const note={};
  for(const field of Object.keys(noteFields)){
    const value=input[field]??'';
    if(typeof value!=='string'||value.length>2000)throw Error('Each note field must be text of at most 2,000 characters.');
    note[field]=value.trim();
  }
  if(!note.turn||!note.request||!note.response)throw Error('Add an exchange reference, request and reply summary.');
  // Local reviewed summaries are claims, never authenticated agent events or proof.
  return events.append({projectId:project.projectId,generation:project.generation,adapter:'developer-notes',source:'developer-notes',severity:note.error?'warning':'info',message:'Developer exchange note',runId:null,taskId:null,payload:{...note,origin:'local-reviewed-summary',verification:'not-verified'}});
}
export function developerNotes(snapshot){
  return [...(snapshot?.events??[])].filter(e=>e.source==='developer-notes'&&e.payload?.origin==='local-reviewed-summary').sort((a,b)=>b.timestamp.localeCompare(a.timestamp)||b.eventId.localeCompare(a.eventId));
}
