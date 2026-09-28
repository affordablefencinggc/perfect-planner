import React from 'react';
import {afterEach,expect,test,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {ProjectContext} from '../src/project/ProjectProvider.jsx';
import {ComponentPlansWorkspace} from '../src/components/ComponentPlansWorkspace.jsx';

vi.mock('../src/components/ComponentDraftPanel.jsx',()=>({ComponentDraftPanel:({onPublished})=><button onClick={()=>{void onPublished({catalogHead:{revision:1,contractDigest:'saved-digest'}}).catch(()=>{});}}>Test verified publication callback</button>}));
afterEach(cleanup);
const project=id=>({projectId:id,kind:'imported',name:id,registration:{rootIdentity:id,rootLabel:id,adapter:'browser',registryRevision:1}});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const observed=()=>({status:'observed',receipt:{catalogState:'current',catalogHead:{revision:1,contractDigest:'saved-digest'}}});
function show(active,refresh,onToast){return <ProjectContext.Provider value={{activeProject:active,refreshComponent:refresh}}><ComponentPlansWorkspace activeProject={active} onToast={onToast}/></ProjectContext.Provider>;}

test('publication awaits matching checked Home refresh before announcing success',async()=>{const pending=deferred(),refresh=vi.fn(()=>pending.promise),toast=vi.fn();render(show(project('one'),refresh,toast));fireEvent.click(screen.getByText('Test verified publication callback'));expect(refresh).toHaveBeenCalledWith('one');expect(toast).not.toHaveBeenCalled();pending.resolve(observed());await waitFor(()=>expect(toast).toHaveBeenCalledTimes(1));});
test('checked absence or a different saved revision requires reconciliation',async()=>{for(const receipt of [{catalogState:'missing',catalogHead:null},{catalogState:'current',catalogHead:{revision:2,contractDigest:'new-digest'}}]){const refresh=vi.fn(async()=>({status:'observed',receipt})),toast=vi.fn();const view=render(show(project('one'),refresh,toast));fireEvent.click(screen.getByText('Test verified publication callback'));await waitFor(()=>expect(refresh).toHaveBeenCalledTimes(1));await Promise.resolve();expect(toast).not.toHaveBeenCalled();view.unmount();}});
test('failed summary refresh does not announce checked success',async()=>{const refresh=vi.fn(async()=>({status:'unavailable'})),toast=vi.fn();render(show(project('one'),refresh,toast));fireEvent.click(screen.getByText('Test verified publication callback'));await waitFor(()=>expect(refresh).toHaveBeenCalledTimes(1));await Promise.resolve();expect(toast).not.toHaveBeenCalled();});
test('late refresh cannot announce a previous project publication',async()=>{const pending=deferred(),refresh=vi.fn(()=>pending.promise),toast=vi.fn();const view=render(show(project('one'),refresh,toast));fireEvent.click(screen.getByText('Test verified publication callback'));view.rerender(show(project('two'),refresh,toast));pending.resolve(observed());await Promise.resolve();await Promise.resolve();expect(toast).not.toHaveBeenCalled();});
test('unmounted publication callback cannot announce stale success',async()=>{const pending=deferred(),refresh=vi.fn(()=>pending.promise),toast=vi.fn();const view=render(show(project('one'),refresh,toast));fireEvent.click(screen.getByText('Test verified publication callback'));view.unmount();pending.resolve(observed());await Promise.resolve();await Promise.resolve();expect(toast).not.toHaveBeenCalled();});
