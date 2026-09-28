import React from 'react';
import {afterEach,expect,test,vi} from 'vitest';
import {render,screen,cleanup,act} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {AgentSessionsPanel} from '../src/components/AgentSessionsPanel.jsx';
const project={projectId:'pp_fixture',generation:1,state:'ready',registration:{adapter:'native',workspaceId:'fixture',registryRevision:1,rootIdentity:'a'.repeat(64)}};
afterEach(()=>{cleanup();delete window.__TAURI_INTERNALS__;});
const scanned={...project,census:{digest:'b'.repeat(64)}};
const pairingReply=(request,extra={})=>({...request,pairingState:'waiting',expiresAt:Date.now()+30000,executionAuthorized:false,mcpConfig:{mcpServers:{'perfect-planner-agent':{command:'C:/Planner/helper.exe',args:['--connection-config','C:/Planner/connection.json']}}},...extra});
test('proposal access uses separate native consent with exact census and no renderer grant flags',async()=>{
 window.__TAURI_INTERNALS__={};const invoke=vi.fn(async(command,{request})=>pairingReply(request.identity,{planReadPermission:'approved',proposalWritePermission:'approved'}));
 render(<AgentSessionsPanel project={scanned} invoke={invoke}/>);const user=userEvent.setup();
 await user.click(screen.getByRole('radio',{name:'Read, propose tasks and report exchanges'}));await user.click(screen.getByRole('button',{name:'Connect an IDE agent'}));
 expect(await screen.findByRole('textbox',{name:'IDE MCP configuration'})).toBeTruthy();
 expect(invoke.mock.calls[0][0]).toBe('prepare_agent_proposal_pairing');expect(Object.keys(invoke.mock.calls[0][1].request).sort()).toEqual(['censusDigest','identity']);expect(invoke.mock.calls[0][1].request.censusDigest).toBe(scanned.census.digest);
 expect(screen.getByText(/Work is not approved, and your IDE connection is not yet verified/)).toBeTruthy();
});
test.each(['plan','proposals'])('refuses missing or unexpected proposal authority for %s choice',async(access)=>{
 window.__TAURI_INTERNALS__={};const recordFailure=vi.fn();
 const invoke=vi.fn(async(command,{request})=>pairingReply(request.identity,{planReadPermission:'approved',...(access==='plan'?{proposalWritePermission:'approved'}:{})}));
 render(<AgentSessionsPanel project={scanned} invoke={invoke} recordFailure={recordFailure}/>);const user=userEvent.setup();
 await user.click(screen.getByRole('radio',{name:access==='plan'?'Read my submitted plan':'Read, propose tasks and report exchanges'}));await user.click(screen.getByRole('button',{name:'Connect an IDE agent'}));
 expect(await screen.findByText(/Pairing setup failed/)).toBeTruthy();expect(screen.queryByRole('textbox')).toBeNull();expect(recordFailure).toHaveBeenCalledTimes(1);
});
test('read-only choice remains read-only and returning to a project resets permission selection',async()=>{
 window.__TAURI_INTERNALS__={};const invoke=vi.fn(async(command,{request})=>pairingReply(request.identity,{planReadPermission:'approved'}));
 const view=render(<AgentSessionsPanel project={scanned} invoke={invoke}/>);const user=userEvent.setup();
 await user.click(screen.getByRole('radio',{name:'Read my submitted plan'}));await user.click(screen.getByRole('button',{name:'Connect an IDE agent'}));expect(await screen.findByRole('textbox')).toBeTruthy();expect(invoke.mock.calls[0][0]).toBe('prepare_agent_plan_pairing');
 await user.click(screen.getByRole('radio',{name:'Read, propose tasks and report exchanges'}));
 view.rerender(<AgentSessionsPanel project={{...scanned,projectId:'pp_other'}} invoke={invoke}/>);view.rerender(<AgentSessionsPanel project={scanned} invoke={invoke}/>);
 expect(screen.getByRole('radio',{name:'Connection status only'}).checked).toBe(true);expect(screen.queryByRole('textbox')).toBeNull();
});
test('unscanned projects cannot select plan or task proposal access',()=>{
 window.__TAURI_INTERNALS__={};render(<AgentSessionsPanel project={project}/>);
 expect(screen.getByRole('radio',{name:'Read my submitted plan'}).disabled).toBe(true);expect(screen.getByRole('radio',{name:'Read, propose tasks and report exchanges'}).disabled).toBe(true);
});
test('worker errors are readable and repeated checks do not duplicate logs in the mounted panel',async()=>{
 window.__TAURI_INTERNALS__={};const recordWorkerFailure=vi.fn(()=>({id:'stored'}));const workers={poolId:'a'.repeat(64),activeWorkers:0,outcomes:[{workerId:1,state:'failed',code:'AGENT_PLAN_CHANNEL_REFUSED',workVerified:false}],omittedOutcomes:2,durable:false,workVerified:false};
 const invoke=vi.fn(async(command,{request})=>({...request,workers,sessions:[],stopped:false,executionAuthorized:false,externalEndpointAvailable:false}));
 render(<AgentSessionsPanel project={project} invoke={invoke} recordWorkerFailure={recordWorkerFailure}/>);const user=userEvent.setup();
 await user.click(screen.getByRole('button',{name:'Check agent sessions'}));expect(await screen.findByText('AGENT_PLAN_CHANNEL_REFUSED')).toBeTruthy();
 await user.click(screen.getByRole('button',{name:'Check agent sessions'}));expect(recordWorkerFailure).toHaveBeenCalledTimes(1);expect(screen.getByText(/2 older outcomes omitted/)).toBeTruthy();
});
test('approved pairing displays selectable configuration without claiming connection',async()=>{
 window.__TAURI_INTERNALS__={};const invoke=vi.fn(async(command,{request})=>({...request,pairingState:'waiting',expiresAt:Date.now()+30000,executionAuthorized:false,mcpConfig:{mcpServers:{'perfect-planner-agent':{command:'C:\\Planner\\helper.exe',args:['--connection-config','C:\\Planner\\connection.json']}}}}));
 render(<AgentSessionsPanel project={project} invoke={invoke}/>);
 await userEvent.setup().click(screen.getByRole('button',{name:'Connect an IDE agent'}));
 const config=await screen.findByRole('textbox',{name:'IDE MCP configuration'});expect(config.readOnly).toBe(true);expect(config.value).toContain('--connection-config');
 expect(invoke.mock.calls[0][0]).toBe('prepare_agent_pairing');expect(screen.getByText(/Configuration is not connection proof/)).toBeTruthy();expect(screen.getByText('Not checked.')).toBeTruthy();
});
test('cancelled native approval does not publish a configuration or record failure',async()=>{
 window.__TAURI_INTERNALS__={};const recordFailure=vi.fn();render(<AgentSessionsPanel project={project} invoke={async()=>{throw 'AGENT_PAIRING_CANCELLED';}} recordFailure={recordFailure}/>);
 await userEvent.setup().click(screen.getByRole('button',{name:'Connect an IDE agent'}));expect(await screen.findByText(/Pairing cancelled/)).toBeTruthy();expect(screen.queryByRole('textbox')).toBeNull();expect(recordFailure).not.toHaveBeenCalled();
});
test('failed diagnostic capture stays visible and never claims a saved log',async()=>{
 window.__TAURI_INTERNALS__={};const recordFailure=vi.fn(()=>null);
 const invoke=vi.fn(async()=>{throw 'AGENT_BROKER_BUSY';});
 render(<AgentSessionsPanel project={project} invoke={invoke} recordFailure={recordFailure}/>);
 await userEvent.setup().click(screen.getByRole('button',{name:'Check agent sessions'}));
 expect(await screen.findByRole('alert')).toHaveProperty('textContent',expect.stringContaining('Operations could not capture'));
 expect(recordFailure.mock.calls[0][1].projectId).toBe('pp_fixture');
 expect(recordFailure.mock.calls[0][1].generation).toBe(1);
 expect(screen.queryByText(/saved locally/)).toBeNull();
});
test('delayed failure logs its original scope without contaminating the new project view',async()=>{
 window.__TAURI_INTERNALS__={};let reject;
 const invoke=vi.fn(()=>new Promise((_,r)=>{reject=r;}));const recordFailure=vi.fn(()=>({eventId:'evt_test'}));
 const view=render(<AgentSessionsPanel project={project} invoke={invoke} recordFailure={recordFailure}/>);
 await userEvent.setup().click(screen.getByRole('button',{name:'Check agent sessions'}));
 view.rerender(<AgentSessionsPanel project={{...project,projectId:'pp_other'}} invoke={invoke} recordFailure={recordFailure}/>);
 await act(async()=>reject('AGENT_BROKER_BUSY'));
 expect(recordFailure.mock.calls[0][1].projectId).toBe('pp_fixture');
 expect(screen.getByText('Not checked.')).toBeTruthy();expect(screen.queryByRole('alert')).toBeNull();
});
test('native check and stop are distinct from external connectivity',async()=>{
 window.__TAURI_INTERNALS__={};const invoke=vi.fn(async(command,{request})=>({...request,sessions:[],stopped:command.startsWith('stop'),executionAuthorized:false,externalEndpointAvailable:false}));
 render(<AgentSessionsPanel project={project} invoke={invoke}/>);const user=userEvent.setup();
 await user.click(screen.getByRole('button',{name:'Check agent sessions'}));expect(await screen.findByText(/No paired sessions returned/)).toBeTruthy();
 expect(invoke.mock.calls[0][0]).toBe('inspect_agent_sessions');
 await user.click(screen.getByRole('button',{name:'Stop this project broker'}));expect(await screen.findByText(/This project broker was stopped/)).toBeTruthy();
 expect(invoke.mock.calls[1][0]).toBe('stop_project_agent_broker');
});
test('foreign response and unexpected authority are refused',async()=>{
 window.__TAURI_INTERNALS__={};const invoke=vi.fn(async(command,{request})=>({...request,projectId:'pp_other',sessions:[],stopped:false,executionAuthorized:true,externalEndpointAvailable:false}));
 render(<AgentSessionsPanel project={project} invoke={invoke}/>);await userEvent.setup().click(screen.getByRole('button',{name:'Check agent sessions'}));
 expect(await screen.findByText(/Session inspection failed/)).toBeTruthy();
});
test('leaving and returning to the project rejects the earlier view response',async()=>{
 window.__TAURI_INTERNALS__={};let resolve;
 const invoke=vi.fn((command,{request})=>new Promise(r=>{resolve=()=>r({...request,sessions:[],stopped:false,executionAuthorized:false,externalEndpointAvailable:false});}));
 const view=render(<AgentSessionsPanel project={project} invoke={invoke}/>);
 await userEvent.setup().click(screen.getByRole('button',{name:'Check agent sessions'}));
 view.rerender(<AgentSessionsPanel project={{...project,projectId:'pp_other'}} invoke={invoke}/>);
 view.rerender(<AgentSessionsPanel project={project} invoke={invoke}/>);
 await act(async()=>resolve());
 expect(screen.queryByText(/No paired sessions returned/)).toBeNull();
 expect(screen.getByText('Not checked.')).toBeTruthy();
});

test.each(['other-project','return-to-project','new-generation'])('delayed success cannot publish a parent observation after %s',async(change)=>{
 window.__TAURI_INTERNALS__={};let finish;
 const invoke=vi.fn((command,{request})=>new Promise(resolve=>{finish=()=>resolve({...request,sessions:[],stopped:false,executionAuthorized:false,externalEndpointAvailable:false});})),onObservation=vi.fn(),recordFailure=vi.fn();
 const view=render(<AgentSessionsPanel project={project} invoke={invoke} onObservation={onObservation} recordFailure={recordFailure}/>);
 await userEvent.setup().click(screen.getByRole('button',{name:'Check agent sessions'}));
 const next=change==='new-generation'?{...project,generation:2}:{...project,projectId:'pp_other'};
 view.rerender(<AgentSessionsPanel project={next} invoke={invoke} onObservation={onObservation} recordFailure={recordFailure}/>);
 if(change==='return-to-project')view.rerender(<AgentSessionsPanel project={project} invoke={invoke} onObservation={onObservation} recordFailure={recordFailure}/>);
 await act(async()=>finish());expect(recordFailure).not.toHaveBeenCalled();expect(onObservation).not.toHaveBeenCalled();expect(screen.getByText('Not checked.')).toBeTruthy();
 invoke.mockImplementation(async(command,{request})=>({...request,sessions:[],stopped:false,executionAuthorized:false,externalEndpointAvailable:false}));
 await userEvent.setup().click(screen.getByRole('button',{name:'Check agent sessions'}));expect(onObservation).toHaveBeenCalledTimes(1);
 expect(onObservation.mock.calls[0][0].projectId).toBe(change==='return-to-project'?project.projectId:next.projectId);
});
