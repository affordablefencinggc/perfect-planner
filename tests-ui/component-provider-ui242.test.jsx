import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ProjectProvider, useProject } from '../src/project/ProjectProvider.jsx';
const mocks=vi.hoisted(()=>({architecture:vi.fn(),folder:vi.fn(),component:vi.fn()}));
vi.mock('../src/project/architectureRefresh.js',()=>({createArchitectureRefresh:()=>({refresh:mocks.architecture,invalidate:vi.fn(),dispose:vi.fn()})}));
vi.mock('../src/project/folderRefresh.js',()=>({createFolderRefresh:()=>({refresh:mocks.folder,invalidate:vi.fn(),dispose:vi.fn()})}));
vi.mock('../src/project/componentRefresh.js',()=>({createComponentRefresh:()=>({refresh:mocks.component,invalidate:vi.fn(),dispose:vi.fn()})}));
const head=(digest)=>({contractDigest:digest,revision:1});
let value;
function Probe(){value=useProject();return <output data-testid="state">{value.activeProject.authorities.component.state}</output>;}
function fixture(){
 const project={projectId:'pp_test',kind:'imported',registration:{rootIdentity:'root'},view:{workspace:'home'},authorities:{architecture:{state:'authoritative',digest:'a',revision:1},folder:{state:'authoritative',digest:'f',revision:1},component:{state:'authoritative',digest:'c',revision:1},plan:{state:'authoritative',digest:'p',revision:9,recordedAt:'2026-09-13T01:00:00.000Z'}},provenance:{'authority.component':{state:'authoritative'},'authority.plan':{state:'authoritative'}}};
 const snapshot={projects:[project],activeProject:project,activeProjectId:project.projectId,state:'ready',health:{}};
 const registry={get:()=>project,getSnapshot:()=>snapshot,subscribe:()=>()=>{},setActive:()=>project,updateView:()=>project};
 return render(<ProjectProvider registry={registry} initialUrl="/?project=pp_test&workspace=home" syncHistory={false}><Probe/></ProjectProvider>);
}
beforeEach(()=>{vi.clearAllMocks();mocks.architecture.mockResolvedValue({status:'observed',receipt:{head:head('a')}});mocks.folder.mockResolvedValue({status:'observed',receipt:{head:head('f')},architectureReceipt:{head:head('a')}});mocks.component.mockResolvedValue({status:'observed',receipt:{catalogHead:head('c'),architectureHead:head('a'),folderHead:head('f')}});});
afterEach(cleanup);
test('cached component stays stale until all three observations finish in sequence',async()=>{
 let resolve;const pending=new Promise(r=>resolve=r);mocks.component.mockReturnValue(pending);fixture();
 expect(screen.getByTestId('state').textContent).toBe('stale');await waitFor(()=>expect(mocks.component).toHaveBeenCalledTimes(1));
 expect(value.activeProject.authorities.plan.state).toBe('stale');expect(value.activeProject.provenance['authority.plan'].reason).toBe('planning-parent-unverified');
 expect(screen.getByTestId('state').textContent).toBe('stale');
 await act(async()=>resolve({status:'observed',receipt:{catalogHead:head('c'),architectureHead:head('a'),folderHead:head('f')}}));
 expect(screen.getByTestId('state').textContent).toBe('authoritative');
 // Checked parents cannot certify the cached Plan without its complete Ledger.
 expect(value.activeProject.authorities.plan).toEqual({state:'stale',digest:'p',revision:9,recordedAt:'2026-09-13T01:00:00.000Z'});
 expect(value.activeProject.provenance['authority.plan'].reason).toBe('planning-parent-unverified');
 expect(mocks.architecture.mock.invocationCallOrder[0]).toBeLessThan(mocks.folder.mock.invocationCallOrder[0]);expect(mocks.folder.mock.invocationCallOrder[0]).toBeLessThan(mocks.component.mock.invocationCallOrder[0]);
});
test('checked component alone cannot overcome an unavailable independent parent',async()=>{mocks.folder.mockResolvedValue({status:'unavailable'});fixture();await waitFor(()=>expect(value.componentStatuses.pp_test.state).toBe('observed'));expect(screen.getByTestId('state').textContent).toBe('stale');expect(value.componentRefreshStatus.state).toBe('stale');});
test('parent digest mismatch remains stale even when catalog digest matches',async()=>{mocks.component.mockResolvedValue({status:'observed',receipt:{catalogHead:head('c'),architectureHead:head('a'),folderHead:head('different')}});fixture();await waitFor(()=>expect(value.componentStatuses.pp_test.state).toBe('observed'));expect(screen.getByTestId('state').textContent).toBe('stale');});
test('manual component refresh hides previous success while request is pending',async()=>{fixture();await waitFor(()=>expect(screen.getByTestId('state').textContent).toBe('authoritative'));let resolve;const pending=new Promise(r=>resolve=r);mocks.component.mockReturnValue(pending);let work;act(()=>{work=value.refreshComponent('pp_test');});expect(screen.getByTestId('state').textContent).toBe('stale');await act(async()=>{resolve({status:'unavailable'});await work;});expect(screen.getByTestId('state').textContent).toBe('stale');expect(value.componentRefreshStatus.state).toBe('unavailable');});
test('offline component observation masks Plan without changing its saved metadata',async()=>{mocks.component.mockResolvedValue({status:'unavailable'});fixture();await waitFor(()=>expect(value.componentRefreshStatus.state).toBe('unavailable'));expect(value.activeProject.authorities.plan).toEqual({state:'stale',digest:'p',revision:9,recordedAt:'2026-09-13T01:00:00.000Z'});expect(value.activeProject.provenance['authority.plan']).toEqual({state:'stale',reason:'planning-parent-unverified'});});
