import React from 'react';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,cleanup,within} from '@testing-library/react';
import {ArchitectureDraftPanel} from '../src/components/ArchitectureDraftPanel.jsx';
import {inspectArchitecture,publishArchitecture} from '../src/runtime/architectureClient.js';
vi.mock('../src/runtime/architectureClient.js',()=>({inspectArchitecture:vi.fn(),publishArchitecture:vi.fn()}));
beforeEach(()=>{localStorage.clear();vi.clearAllMocks();inspectArchitecture.mockResolvedValue({headDigest:null,actor:'Local owner',valid:true});});
afterEach(()=>{cleanup();vi.restoreAllMocks();});

const A04='Local JSON files on the user\'s computer; single user; no sign-in.';
const item=(id,title,state,findingIds,note)=>({id,title,questions:[],state,findingIds,findingCount:findingIds.length,needsDecision:state!=='observed',decision:note?{decision:'answered',note,decidedAt:'2026-09-04T11:00:00.000Z'}:null});
const review={state:'recorded',items:[
 item('A01','App identity','observed',['S001','S002']),
 item('A02','Runtime & framework','observed',['S010','S012','S013']),
 item('A03','Application layers','observed',['S020','S022'],'React UI in src, Rust commands in src-tauri.'),
 item('A04','Data, tenancy & auth','signal',['S031'],A04),
 item('A06','Credentials & security','signal',['S051'],'Tauri capabilities deny by default.'),
 item('A07','Tests, CI & deployment','observed',['S060','S062'],'npm start plus a signed Tauri installer.'),
]};

describe('fill the architecture draft from the scan and discovery answers',()=>{
 it('fills marked, editable suggestions, keeps typed and untouched fields, and still requires review to publish',()=>{
  render(<ArchitectureDraftPanel projectId="pp_seed" discoveryReview={review}/>);
  fireEvent.change(screen.getByLabelText('Data decision · Choice'),{target:{value:'SQLite file I picked'}});
  fireEvent.click(screen.getByRole('button',{name:'Fill from scan and your answers'}));

  expect(screen.getByLabelText('Architecture template').value).toBe('tauri-local-desktop');
  expect(screen.getByLabelText('Platform',{selector:'select'}).value).toBe('tauri');
  expect(screen.getByLabelText('Desktop distribution').checked).toBe(true);
  expect(screen.getByText(/Suggested template · From the folder scan: Tauri desktop shell \(S012\)/)).toBeTruthy();

  const identity=screen.getByLabelText('Identity auth decision · Choice');
  expect(identity.value).toBe(A04);
  expect(identity.closest('.architecture-draft-field-wrap').textContent).toContain('From your discovery answer A04 (Data, tenancy & auth)');
  expect(screen.getByLabelText('Capability policy').value).toBe('Tauri capabilities deny by default.');

  // The value the person typed is kept and not marked.
  const data=screen.getByLabelText('Data decision · Choice');
  expect(data.value).toBe('SQLite file I picked');
  expect(data.closest('.architecture-draft-field-wrap').textContent).not.toContain('From your discovery answer');
  // Fields the scan does not cover stay empty.
  expect(screen.getByLabelText('Data loss · Trigger').value).toBe('');
  expect(screen.getByLabelText('Performance budget').value).toBe('');

  const progress=screen.getByText(/answers filled from the scan/);
  const [,filled,total,missing]=progress.textContent.match(/(\d+) of (\d+) answers filled from the scan; (\d+) still need you/);
  expect(Number(total)).toBe(59);
  expect(Number(filled)).toBeGreaterThanOrEqual(7);
  expect(Number(missing)).toBe(Number(total)-Number(filled)-1);

  // Suggestions stay editable; an edited suggestion is the person's own answer.
  fireEvent.change(identity,{target:{value:'No sign-in in v1'}});
  expect(screen.getByLabelText('Identity auth decision · Choice').value).toBe('No sign-in in v1');
  expect(screen.getByLabelText('Identity auth decision · Choice').closest('.architecture-draft-field-wrap').textContent).not.toContain('From your discovery answer');
  expect(screen.getByText(/answers filled from the scan/).textContent).toContain(`${Number(filled)-1} of ${total}`);

  // Nothing is published: review still blocks and Publish stays off.
  fireEvent.click(screen.getByText('Review draft'));
  expect(within(screen.getByLabelText('Architecture review')).getByText(/missing answers/)).toBeTruthy();
  expect(screen.getByText('Publish architecture').disabled).toBe(true);
  expect(inspectArchitecture).not.toHaveBeenCalled();
  expect(publishArchitecture).not.toHaveBeenCalled();
 });

 it('keeps suggestion marks after reload',()=>{
  const view=render(<ArchitectureDraftPanel projectId="pp_seed_reload" discoveryReview={review}/>);
  fireEvent.click(screen.getByRole('button',{name:'Fill from scan and your answers'}));
  view.unmount();
  render(<ArchitectureDraftPanel projectId="pp_seed_reload" discoveryReview={review}/>);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByLabelText('Identity auth decision · Choice').closest('.architecture-draft-field-wrap').textContent).toContain('From your discovery answer A04');
 });

 it('explains why filling is unavailable without a scan',()=>{
  render(<ArchitectureDraftPanel projectId="pp_noscan"/>);
  const button=screen.getByRole('button',{name:'Fill from scan and your answers'});
  expect(button.disabled).toBe(true);
  expect(screen.getByText(/Scan the app folder in Structure first/)).toBeTruthy();
 });
});
