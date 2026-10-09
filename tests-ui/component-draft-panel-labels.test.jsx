import React from 'react';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import axe from 'axe-core';
import {computeAccessibleName} from 'dom-accessibility-api';
import {ComponentDraftPanel,plainComponentBlocker} from '../src/components/ComponentDraftPanel.jsx';
import {ViewModeContext} from '../src/project/viewMode.js';
import {readComponentContext} from '../src/runtime/componentClient.js';
vi.mock('../src/runtime/componentClient.js',()=>({readComponentContext:vi.fn(),publishComponentDraft:vi.fn()}));

const base={schemaVersion:1,planId:'one',ready:false,actor:'owner',catalogHead:null,catalog:null,catalogState:'missing',publicationAuthorized:false,executionAuthorized:false,folderNodes:[]};
const noArchitecture={...base,state:'architecture-missing',architectureHead:null,folderHead:null};
const noFolder={...base,state:'folder-missing',architectureHead:{contractDigest:'a'.repeat(64),revision:1},folderHead:null};

beforeEach(()=>{vi.clearAllMocks();localStorage.clear();});
afterEach(()=>{cleanup();vi.restoreAllMocks();});

async function openForm(context){
 readComponentContext.mockResolvedValue(context);
 render(<ComponentDraftPanel projectId="one"/>);
 await screen.findByText(/Saved planning: /);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Refresh saved planning'}).disabled).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Add component'}));
 fireEvent.click(screen.getByRole('button',{name:'Add component'}));
 // Open every section so all controls are rendered and inspectable.
 for(const details of document.querySelectorAll('details'))details.open=true;
}

function controls(){return [...document.querySelectorAll('input,textarea,select,button')];}
function disabledActions(){return controls().filter(control=>control.disabled||control.closest('fieldset:disabled'));}
function reasonFor(control){
 const ids=(control.getAttribute('aria-describedby')??'').split(/\s+/).filter(Boolean);
 return ids.map(id=>document.getElementById(id)?.textContent?.trim()??'').filter(Boolean).join(' ');
}

test('with no architecture every form control has an accessible name derived from its field',async()=>{
 await openForm(noArchitecture);
 const unnamed=controls().filter(control=>!computeAccessibleName(control).trim());
 expect(unnamed.map(control=>control.outerHTML.slice(0,120))).toEqual([]);
 const result=await axe.run(document.body,{runOnly:{type:'rule',values:['label','button-name','select-name','aria-input-field-name']}});
 expect(result.violations.map(v=>`${v.id}: ${v.nodes.length}`)).toEqual([]);
 // Names say which component and which field they belong to.
 const responsibilities=document.querySelector('[data-component-field="responsibilities"]');
 expect(computeAccessibleName(responsibilities)).toBe('Component 2 · Responsibilities');
 const interfaceName=document.querySelector('[data-component-field="interfaces.0.name"]');
 expect(interfaceName).toBe(null);
 fireEvent.click(screen.getByRole('button',{name:'Add interfaces'}));
 expect(computeAccessibleName(document.querySelector('[data-component-field="interfaces.0.name"]'))).toBe('Component 2 · Interfaces 1 · Name');
});

test('with no architecture every disabled action shows the real missing prerequisite next to it',async()=>{
 await openForm(noArchitecture);
 const disabled=disabledActions();
 expect(disabled.length).toBeGreaterThan(0);
 for(const control of disabled){
  const reason=reasonFor(control);
  expect(reason,`${computeAccessibleName(control)} has no visible reason`).not.toBe('');
  const holder=document.getElementById(control.getAttribute('aria-describedby').split(/\s+/)[0]);
  expect(holder.hidden).toBe(false);
 }
 expect(reasonFor(screen.getByRole('button',{name:'Rebind to current saved parents'}))).toMatch(/Publish the Blueprint architecture first/);
 expect(reasonFor(screen.getByRole('button',{name:'Load saved catalog'}))).toMatch(/No component catalog has been published/);
 expect(reasonFor(screen.getByRole('button',{name:'Publish component catalog'}))).toMatch(/Publish the Blueprint architecture first/);
});

test('reviewing with no architecture names the missing architecture instead of asking to rebind',async()=>{
 await openForm(noArchitecture);
 fireEvent.click(screen.getByRole('button',{name:'Review component draft'}));
 const alert=await screen.findByRole('alert');
 expect(alert.textContent).toMatch(/Publish the Blueprint architecture first/);
 expect(alert.textContent).not.toMatch(/rebind/i);
});

test('with no folder plan the reasons name the folder plan',async()=>{
 await openForm(noFolder);
 expect(reasonFor(screen.getByRole('button',{name:'Rebind to current saved parents'}))).toMatch(/folder plan/i);
 fireEvent.click(screen.getByRole('button',{name:'Review component draft'}));
 const alert=await screen.findByRole('alert');
 expect(alert.textContent).toMatch(/folder plan/i);
 expect(alert.textContent).not.toMatch(/rebind/i);
});

// Trial define-10/11/25.
const readyContext={...base,state:'ready',ready:true,architectureHead:{contractDigest:'a'.repeat(64),revision:3},folderHead:{contractDigest:'b'.repeat(64),revision:2},folderNodes:[{id:'F001',kind:'folder',path:'src'}]};
test('a review error appears right after the Review button, not only at the top of the page',async()=>{
 await openForm(noArchitecture);
 const button=screen.getByRole('button',{name:'Review component draft'});fireEvent.click(button);
 const alert=await screen.findByRole('alert');
 expect(button.closest('.component-draft-action').nextElementSibling).toBe(alert);
});
test('a brand-new draft binds itself on first review instead of demanding a rebind',async()=>{
 await openForm(readyContext);
 fireEvent.click(screen.getByRole('button',{name:'Review component draft'}));
 await screen.findByRole('region',{name:'Component review'});
 expect(screen.queryByText(/Explicitly rebind/i)).toBeNull();
 expect(screen.getByRole('status').textContent).toMatch(/bound to saved architecture revision 3 and folder plan revision 2/);
 expect(JSON.parse(localStorage.getItem('perfect-planner:component-draft:v1:one')??'null')?.folderRevision??2).toBe(2);
});
test('Simple view lists review issues as sentences; Advanced keeps the exact engine text',async()=>{
 await openForm(readyContext);
 fireEvent.click(screen.getByRole('button',{name:'Review component draft'}));
 const review=await screen.findByRole('region',{name:'Component review'});
 expect(review.textContent).not.toMatch(/inventory\[\d\]|definitiveOutcome|estimateHours|taskId/);
 expect(review.textContent).toMatch(/Component 1: give it a name\./);
 expect(review.textContent).toMatch(/fill in owner, reviewer and task ID/);
 cleanup();
 readComponentContext.mockResolvedValue(readyContext);
 render(<ViewModeContext.Provider value={{mode:'advanced',isAdvanced:true,setMode:()=>{}}}><ComponentDraftPanel projectId="one"/></ViewModeContext.Provider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Review component draft'}).disabled).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Review component draft'}));
 expect((await screen.findByRole('region',{name:'Component review'})).textContent).toMatch(/inventory\[0\]\.name is required\./);
});
test('form labels read as words and one-line answers use one-line inputs',async()=>{
 await openForm(noArchitecture);
 expect(screen.getByLabelText('Task ID').tagName).toBe('INPUT');
 expect(screen.getByLabelText('Name').tagName).toBe('INPUT');
 expect(screen.getByLabelText('Definition').tagName).toBe('TEXTAREA');
 expect(screen.getByRole('button',{name:'Add file claims'})).toBeTruthy();
 expect(screen.queryByText(/Task Id|File Claims/)).toBeNull();
});
test('plainComponentBlocker turns field paths into words and leaves known sentences alone',()=>{
 expect(plainComponentBlocker('inventory[2].folderNodeId must reference a stable F-number.')).toBe('Component 3: choose the approved folder it lives in.');
 expect(plainComponentBlocker('C001.fileClaims[0] requires a safe path, access, and reason.')).toBe('C001 file claim 1 requires a safe path, access, and reason.');
 expect(plainComponentBlocker('C001 requires purpose and definitiveOutcome.')).toBe('C001: fill in its purpose and definitive outcome.');
 expect(plainComponentBlocker('C001.fileNaming requires safe allowed roots.')).toBe('C001 file naming requires safe allowed roots.');
 expect(plainComponentBlocker('inventory[1] requires positive definition and notThis boundary.')).toBe('Component 2 requires positive definition and not this boundary.');
 expect(plainComponentBlocker('Component references an unknown approved folder.')).toBe('Component references an unknown approved folder.');
});
