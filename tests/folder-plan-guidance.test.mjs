import "./helpers/hermetic-env.mjs";
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
test('an imported project with no proposed folders reads as optional, not blocked',async()=>{
 const {folderPlanHeadline}=await import('../src/engine/folderContractEngine.js');
 const empty=assessFolderContract({schemaVersion:1,planId:'imported',workspaceMode:'private',nodes:[]});
 assert.equal(folderPlanHeadline(empty,{imported:true}).tone,'optional');
 assert.equal(folderPlanHeadline(empty,{imported:false}).tone,'blocked');
 const named=assessFolderContract({schemaVersion:1,planId:'imported',workspaceMode:'private',nodes:[{id:'F001',kind:'folder',path:'src'}]});
 const headline=folderPlanHeadline(named,{imported:true});
 assert.equal(headline.tone,'blocked');assert.match(headline.detail,/blockers/);
});
