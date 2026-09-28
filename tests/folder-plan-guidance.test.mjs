import test from 'node:test';
import assert from 'node:assert/strict';
import {folderPlanGuidance} from '../src/engine/folderPlanGuidance.js';
import {assessFolderContract} from '../src/engine/folderContractEngine.js';
test('missing approval is one plain-language action without changing validation',()=>{
 const result=assessFolderContract({schemaVersion:1,planId:'imported',workspaceMode:'private',nodes:[]});
 assert.equal(result.ready,false);assert.equal(result.blockers.length,3);
 const guidance=folderPlanGuidance(result.blockers);
 assert.equal(guidance.length,2);assert.match(guidance[0],/Scanning and viewing/);assert.match(guidance[1],/does not mean.*empty/);
 assert.equal(result.blockers.length,3);assert.equal(result.ready,false);
});
test('other validation blockers are not hidden',()=>{assert.deepEqual(folderPlanGuidance(['Duplicate node id F001.']),['Duplicate node id F001.']);});
