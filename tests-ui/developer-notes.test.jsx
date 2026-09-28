import React from 'react';
import {afterEach,expect,test} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {DeveloperNotes} from '../src/components/DeveloperNotes.jsx';
import {createRuntimeEventSession} from '../src/runtime/runtimeEventSession.js';
import {createRuntimeEventCodec} from '../src/runtime/runtimeEventLedger.js';
import {appendDeveloperNote} from '../src/runtime/developerNotes.js';
afterEach(cleanup);
const project={projectId:'pp_notes',generation:1};
function fixture(fail=false){const codec=createRuntimeEventCodec();let envelope=codec.empty();const store={read:async()=>({envelope,legacyStatus:'snapshot-matches'}),subscribe:()=>()=>{},appendCaptured:async()=>{throw Error('controlled unavailable');}};const events=createRuntimeEventSession({codec,store});return events;}
const note={turn:'Exchange 1',request:'Inspect selected task',response:'Read task',error:'CHECK_FAILED',solution:'Proposed retry',evidence:''};
test('native reports are displayed separately and a read failure is not a successful refresh',async()=>{
 const binding={projectId:project.projectId,workspaceId:'notes',registryRevision:1,rootIdentity:'a'.repeat(64)};
 const nativeProject={...project,registration:{...binding,adapter:'native'}};
 let failed=false;
 const invoke=async(command)=>{expect(command).toBe('read_agent_exchange_notes');if(failed)throw Error('controlled read failure');return {projectId:project.projectId,generation:1,data:{binding,executionAuthorized:false,coverage:'reported-exchanges-only',total:1,nextOffset:null,records:[{binding,exchangeId:'agent-1',summary:{turn:'Agent exchange',request:'Inspect',response:'Read receipt',observed:'Task observed',error:'',explanation:'',solution:'Review',evidence:''},sessionId:'b'.repeat(32),digest:'c'.repeat(64),receivedAt:'2026-09-14T00:00:00.000Z',origin:'authenticated-agent-report',verification:'not-verified'}]}};};
 render(<DeveloperNotes project={nativeProject} events={fixture()} invoke={invoke}/>);fireEvent.click(screen.getByRole('button',{name:'Developer notes'}));await screen.findByText('Agent exchange · recorded by Planner');expect(screen.getByText(/agent-reported, not verified/)).toBeTruthy();failed=true;fireEvent.click(screen.getByText('Refresh latest report'));await screen.findByText(/Report refresh failed/);expect(screen.getByText('Agent exchange · recorded by Planner')).toBeTruthy();
});
test('closed by default; opens, focuses, closes with Escape',()=>{render(<DeveloperNotes project={project} events={fixture()}/>);expect(screen.queryByLabelText('Developer notes')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Developer notes'}));expect(screen.getByText(/Automatic IDE exchange capture is not connected/)).toBeTruthy();expect(document.activeElement.textContent.trim()).toBe('Developer notes');fireEvent.keyDown(screen.getByLabelText('Developer notes'),{key:'Escape'});expect(screen.queryByLabelText('Developer notes')).toBeNull();expect(document.activeElement.textContent.trim()).toBe('Developer notes');});
test('captured note is explicitly unsaved if storage fails',async()=>{const events=fixture();render(<DeveloperNotes project={project} events={events}/>);fireEvent.click(screen.getByRole('button',{name:'Developer notes'}));fireEvent.click(screen.getByText('Add exchange note'));for(const [label,value]of [['Exchange reference','Exchange 1'],['Request summary','Inspect selected task'],['Reply / actions summary','Read task']])fireEvent.change(screen.getByLabelText(label),{target:{value}});fireEvent.click(screen.getByText('Save reviewed summary'));await screen.findByText('Exchange 1 · unsaved');expect(screen.getByText(/Local reviewed summary · not verified/)).toBeTruthy();expect(screen.getAllByText('Not supplied / unknown').length).toBeGreaterThan(0);});
test('project switch clears drawer and does not expose other project notes',async()=>{const events=fixture();await act(async()=>{appendDeveloperNote(project,note,events);await events.settled();});const view=render(<DeveloperNotes project={project} events={events}/>);fireEvent.click(screen.getByRole('button',{name:'Developer notes (1)'}));expect(screen.getByText('CHECK_FAILED')).toBeTruthy();view.rerender(<DeveloperNotes project={{projectId:'pp_other',generation:1}} events={events}/>);fireEvent.click(screen.getByRole('button',{name:'Developer notes'}));expect(screen.queryByText('CHECK_FAILED')).toBeNull();});
test('invalid input is refused and known secret patterns are redacted',async()=>{const events=fixture();expect(()=>appendDeveloperNote(project,{...note,approved:true},events)).toThrow();expect(()=>appendDeveloperNote(project,{...note,turn:''},events)).toThrow();expect(()=>appendDeveloperNote(project,{...note,response:'a'.repeat(2001)},events)).toThrow();appendDeveloperNote(project,{...note,response:'password=hunter22'},events);await events.settled();const saved=events.getSnapshot(project.projectId).events;expect(JSON.stringify(saved)).not.toContain('hunter22');expect(saved[0].payload.verification).toBe('not-verified');});

test('unknown owner count remains unknown during loading and failed first read',async()=>{
 let rejectRead;const binding={projectId:project.projectId,workspaceId:'notes',registryRevision:1,rootIdentity:'a'.repeat(64)};
 const invoke=()=>new Promise((resolve,reject)=>{rejectRead=reject;});
 render(<DeveloperNotes project={{...project,registration:{...binding,adapter:'native'}}} events={fixture()} invoke={invoke}/>);
 fireEvent.click(screen.getByRole('button',{name:'Developer notes'}));
 expect(screen.getByText('Agent reports · count not checked')).toBeTruthy();
 expect(screen.getByText('Reading owner reports…')).toBeTruthy();
 expect(screen.getByText('Refresh latest report').disabled).toBe(true);
 await act(async()=>rejectRead(Error('offline')));
 expect(screen.getByText('Agent reports · count not checked')).toBeTruthy();
 expect(screen.getByText('Refresh latest report').disabled).toBe(false);
 expect(screen.queryByText('Agent reports · 0 recorded')).toBeNull();
});
test('successful empty read establishes zero and history browsing discloses paused refresh',async()=>{
 const binding={projectId:project.projectId,workspaceId:'notes',registryRevision:1,rootIdentity:'a'.repeat(64)};
 let empty=false;
 const invoke=async(command,{offset})=>({projectId:project.projectId,generation:1,data:{binding,executionAuthorized:false,coverage:'reported-exchanges-only',total:empty?0:2,nextOffset:empty||offset===1?null:1,records:empty?[]:[{binding,exchangeId:'entry-'+offset,summary:{turn:'Report '+offset,request:'Read',response:'Observed',observed:'',error:'',explanation:'',solution:'',evidence:''},sessionId:'b'.repeat(32),digest:'c'.repeat(64),receivedAt:'2026-09-14T00:00:00.000Z',origin:'authenticated-agent-report',verification:'not-verified'}]}});
 render(<DeveloperNotes project={{...project,registration:{...binding,adapter:'native'}}} events={fixture()} invoke={invoke}/>);
 fireEvent.click(screen.getByRole('button',{name:'Developer notes'}));await screen.findByText('Report 0 · recorded by Planner');
 fireEvent.click(screen.getByText('Load older report'));await screen.findByText('Report 1 · recorded by Planner');
 expect(screen.getByText(/Automatic refresh is paused/)).toBeTruthy();
 empty=true;fireEvent.click(screen.getByText('Refresh latest report'));await screen.findByText('Agent reports · 0 recorded');
 expect(screen.queryByText(/Automatic refresh is paused/)).toBeNull();
 expect(screen.queryByText('Report 0 · recorded by Planner')).toBeNull();
});
