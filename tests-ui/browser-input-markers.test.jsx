import React from 'react';
import {test,expect,afterEach} from 'vitest';
import {render,screen,cleanup,fireEvent} from '@testing-library/react';
import {BrowserInputMarkers,BrowserInputMarkerControl,useBrowserInputMarkerControl} from '../src/components/BrowserInputMarkers.jsx';
function Harness({project={projectId:'a',generation:1}}){const control=useBrowserInputMarkerControl(project);return <><BrowserInputMarkerControl control={control}/><BrowserInputMarkers key={control.scope} {...control} onDisable={()=>control.setEnabled(false)}/></>;}
afterEach(cleanup);
test('opt-in markers do not accept script-dispatched pointer events',()=>{
 render(<Harness/>);expect(screen.getByRole('checkbox').checked).toBe(false);
 fireEvent.click(screen.getByRole('checkbox'));
 fireEvent.pointerMove(document.body,{clientX:100,clientY:120});fireEvent.pointerDown(document.body,{clientX:100,clientY:120});
 expect(document.querySelector('[data-browser-input-marker]')).toBeNull();
 expect(screen.getByText(/browser cannot identify/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Hide input markers'}));expect(screen.getByRole('checkbox').checked).toBe(false);
});
test('switching projects and returning does not revive the old input permission',()=>{
 const a={projectId:'a',generation:1},view=render(<Harness project={a}/>);
 fireEvent.click(screen.getByRole('checkbox'));expect(screen.getByRole('checkbox').checked).toBe(true);
 view.rerender(<Harness project={{projectId:'b',generation:1}}/>);expect(screen.getByRole('checkbox').checked).toBe(false);
 view.rerender(<Harness project={a}/>);expect(screen.getByRole('checkbox').checked).toBe(false);
 fireEvent.click(screen.getByRole('checkbox'));view.rerender(<Harness project={{...a,generation:2}}/>);expect(screen.getByRole('checkbox').checked).toBe(false);
});
test('no project cannot enable observation',()=>{render(<Harness project={null}/>);expect(screen.getByRole('checkbox').disabled).toBe(true);});
