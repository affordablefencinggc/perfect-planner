import test from 'node:test';
import assert from 'node:assert/strict';
import {browserWorkspaceAdapter} from '../src/browser/workspaceCensus.js';
// Controlled browser-handle mocks: not real browser permission/drop proof.
function directory(name='mock-project'){
 const calls={entries:0,file:0,permission:0};
 const handle={kind:'directory',name,entries:async function*(){calls.entries++;},getFile:async()=>{calls.file++;throw Error('not a file');},requestPermission:async()=>{calls.permission++;return 'granted';},isSameEntry:async other=>other===handle};
 return {handle,calls};
}
test('drop retains opaque selection and repeats same handle identity without reads',async()=>{
 const f=directory();const first=await browserWorkspaceAdapter.selectDroppedWorkspaceFolder(f.handle),second=await browserWorkspaceAdapter.selectDroppedWorkspaceFolder(f.handle);
 assert.equal(first.selectionState,'selected');assert.match(first.selectedPath,/^browser:\/\//);assert.equal(first.selectedPath,second.selectedPath);assert.deepEqual(f.calls,{entries:0,file:0,permission:0});
});
test('different handles with identical names remain different selections',async()=>{
 const a=directory('same-name'),b=directory('same-name');const first=await browserWorkspaceAdapter.selectDroppedWorkspaceFolder(a.handle),second=await browserWorkspaceAdapter.selectDroppedWorkspaceFolder(b.handle);assert.notEqual(first.selectedPath,second.selectedPath);
});
test('invalid and file handles are refused by drop and picker',async()=>{
 for(const handle of [null,{}, {kind:'file',name:'file.txt'}, {kind:'directory',name:''}, {kind:'directory',name:'not-a-handle'}]){
  const result=await browserWorkspaceAdapter.selectDroppedWorkspaceFolder(handle);assert.notEqual(result.authoritative,true);assert.equal(result.selectedPath,undefined);
  const picked=await browserWorkspaceAdapter.selectWorkspaceFolder({runtime:{showDirectoryPicker:async()=>handle,isSecureContext:true,crypto:globalThis.crypto}});assert.notEqual(picked.authoritative,true);assert.equal(picked.reason,'browser-directory-handle-required');
 }
});
test('separate explicit approval gates registration and permission requests',async()=>{
 const f=directory(),selection=await browserWorkspaceAdapter.selectDroppedWorkspaceFolder(f.handle);
 const refused=await browserWorkspaceAdapter.registerWorkspaceReadOnly({workspaceId:'workspace-drop-fixture',rootPath:selection.selectedPath,explicitUserApproval:false});assert.notEqual(refused.authoritative,true);assert.deepEqual(f.calls,{entries:0,file:0,permission:0});
 const approved=await browserWorkspaceAdapter.registerWorkspaceReadOnly({workspaceId:'workspace-drop-fixture',rootPath:selection.selectedPath,explicitUserApproval:true});assert.equal(approved.rootIdentity.length,64);assert.equal(f.calls.permission,1);assert.equal(f.calls.entries,0);assert.equal(f.calls.file,0);
});
