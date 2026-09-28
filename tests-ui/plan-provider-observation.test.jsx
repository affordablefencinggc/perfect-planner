import React from 'react';
import {afterEach,beforeEach,test,expect,vi} from 'vitest';
import {render,screen,fireEvent,waitFor,act,cleanup} from '@testing-library/react';
import {ProjectProvider,useProject} from '../src/project/ProjectProvider.jsx';
const mocked=vi.hoisted(()=>({refresh:null,getDirty:null}));
vi.mock('../src/project/planRefresh.js',()=>({createPlanRefresh:({getDirty})=>{mocked.getDirty=getDirty;return {refresh:id=>mocked.refresh(id),invalidate(){},subscribe(){return()=>{};},dispose(){}};}}));
vi.mock('../src/project/architectureRefresh.js',()=>({createArchitectureRefresh:()=>({refresh:async()=>({status:'observed',receipt:{head:{revision:1,contractDigest:'a'}}}),invalidate(){},dispose(){}})}));
vi.mock('../src/project/folderRefresh.js',()=>({createFolderRefresh:()=>({refresh:async()=>({status:'observed',receipt:{head:{revision:1,contractDigest:'f'}},architectureReceipt:{head:{revision:1,contractDigest:'a'}}}),invalidate(){},dispose(){}})}));
vi.mock('../src/project/componentRefresh.js',()=>({createComponentRefresh:()=>({refresh:async()=>({status:'observed',receipt:{catalogHead:{revision:1,contractDigest:'c'},architectureHead:{revision:1,contractDigest:'a'},folderHead:{revision:1,contractDigest:'f'}}}),invalidate(){},dispose(){}})}));
const parents={architecture:{revision:1,digest:'a'},folder:{revision:1,digest:'f'},component:{revision:1,digest:'c'}};
function registry(){
 const projects=['pp_alpha','pp_beta'].map((id,index)=>({projectId:id,kind:'imported',state:'generated',registration:{rootIdentity:String(index+1).repeat(64)},census:{digest:'b'.repeat(64)},view:{workspace:'home',phase:null},authorities:{...Object.fromEntries(Object.entries(parents).map(([key,value])=>[key,{...value,state:'authoritative'}])),plan:null},provenance:{}}));
 let activeProjectId=projects[0].projectId;const listeners=new Set();let snapshot;
 const rebuild=()=>{snapshot={state:'ready',health:{},projects,projectOrder:projects.map(p=>p.projectId),activeProjectId,activeProject:projects.find(p=>p.projectId===activeProjectId)};};rebuild();
 return {getSnapshot:()=>snapshot,subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},get:id=>projects.find(p=>p.projectId===id),setActive(id){if(activeProjectId!==id){activeProjectId=id;rebuild();listeners.forEach(fn=>fn());}return projects.find(p=>p.projectId===id);},updateView:id=>projects.find(p=>p.projectId===id)};
}
function Probe(){const value=useProject();return <><output data-testid="status">{JSON.stringify(value.planRefreshStatus)}</output><button onClick={()=>value.refreshPlan()}>Refresh</button><button onClick={()=>value.invalidatePlan(undefined,{dirty:true})}>Dirty</button><button onClick={()=>value.invalidatePlan(undefined,{dirty:false})}>Saved</button><button onClick={()=>value.selectProject('pp_beta')}>Beta</button><button onClick={()=>value.selectProject('pp_alpha')}>Alpha</button></>;}
let records;
beforeEach(()=>{records=registry();mocked.refresh=async id=>{const project=records.get(id);return {status:mocked.getDirty(id)?'stale':'observed',projectId:id,rootIdentity:project.registration.rootIdentity,censusDigest:project.census.digest,parents,revision:1,digest:'checked'};};});
afterEach(cleanup);
test('dirty state masks observations and survives project navigation until explicit saved notification',async()=>{
 render(<ProjectProvider registry={records} syncHistory={false}><Probe/></ProjectProvider>);
 await waitFor(()=>expect(screen.getByTestId('status').textContent).toContain('observed'));
 fireEvent.click(screen.getByText('Dirty'));expect(screen.getByTestId('status').textContent).toContain('stale');
 fireEvent.click(screen.getByText('Beta'));await waitFor(()=>expect(screen.getByTestId('status').textContent).toContain('pp_beta'));
 fireEvent.click(screen.getByText('Alpha'));await waitFor(()=>expect(screen.getByTestId('status').textContent).toContain('stale'));expect(mocked.getDirty('pp_alpha')).toBe(true);
 fireEvent.click(screen.getByText('Saved'));fireEvent.click(screen.getByText('Refresh'));await waitFor(()=>expect(screen.getByTestId('status').textContent).toContain('observed'));
});
test('late previous-project refresh cannot replace the active observation',async()=>{
 render(<ProjectProvider registry={records} syncHistory={false}><Probe/></ProjectProvider>);await waitFor(()=>expect(screen.getByTestId('status').textContent).toContain('observed'));
 const normal=mocked.refresh;let resolve;mocked.refresh=id=>id==='pp_alpha'?new Promise(done=>resolve=done):normal(id);
 fireEvent.click(screen.getByText('Refresh'));fireEvent.click(screen.getByText('Beta'));await waitFor(()=>expect(screen.getByTestId('status').textContent).toContain('observed'));
 await act(async()=>resolve({...(await normal('pp_alpha')),revision:99}));
 expect(screen.getByTestId('status').textContent).toContain('pp_beta');expect(screen.getByTestId('status').textContent).not.toContain('99');
});
