import React from 'react';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import axe from 'axe-core';
import {computeAccessibleName} from 'dom-accessibility-api';
import {ComponentDraftPanel} from '../src/components/ComponentDraftPanel.jsx';
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
 fireEvent.click(screen.getByRole('button',{name:'Add Interfaces'}));
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
