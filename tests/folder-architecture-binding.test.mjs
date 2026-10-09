import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {freezeArchitectureContract} from '../src/engine/rulebookEngine.js';
import {publishArchitectureContract,withCurrentArchitectureContract} from '../src/node/architectureContractStore.mjs';
import {publishFolderContract,inspectFolderContracts} from '../src/node/folderContractStore.mjs';
const scenario = (kind) => ({ kind, trigger: "named threshold", detection: "machine signal", owner: "danie", immediateAction: "stop", recovery: "fallback", verification: "proof rerun" });
const decision = (kind) => ({ kind, choice: `${kind} choice`, rationale: "evidence-backed fit", evidence: "ADR source", alternatives: [{ choice: "other", rejectionReason: "fails a stated constraint" }] });
const complete = (costCeiling = "$5/run") => ({ templateId: "ai-autopilot-control-plane", templateVersion: 1, platform: "tauri", brief: { autopilot: true, localFirst: true }, useCases: ["ai-autopilot", "desktop-distribution"], answers: { collisionPolicy: "fail closed", proofPolicy: "paired proof", rollbackPolicy: "restore checkpoint", capabilityPolicy: "deny by default", humanStopPolicy: "explicit gate", costCeiling, osTargets: ["windows"], updateSigning: "signed", rollbackChannel: "stable previous" }, capabilities: [{ id: "native-process", necessity: "mandatory", mitigation: "reviewed bounded sidecar", proof: "capability test" }], scenarios: ["security-breach", "data-loss", "critical-dependency-failure", "vendor-exit"].map(scenario), dependencies: [{ name: "Tauri", purpose: "desktop shell", license: "MIT/Apache-2.0", pinnedVersion: "2.x exact lock", maintenanceEvidence: "release history", securityEvidence: "advisory review", critical: true, fallback: "PWA reduced mode", switchTrigger: "native proof fails", dependsOn: [] }], decisions: ["platform", "data", "identity-auth", "state-sync", "deployment-distribution"].map(decision), nonFunctional: { performanceBudget: "startup P80 <2s", securityTarget: "zero critical", accessibilityTarget: "WCAG 2.2 AA", operatingCostCeiling: "$100/month", recoveryTarget: "RPO 0 local ledger", observabilityProof: "hashed run report" } });
const freeze=(planId,cost)=>freezeArchitectureContract(complete(cost),{planId,actor:'danie',approvedAt:'2026-09-02T00:00:00.000Z'});
const folder=(planId,binding)=>({schemaVersion:1,planId,...binding,workspaceMode:'private',nodes:[{id:'F001',kind:'folder',path:'src',purpose:'source',owner:'danie',taskId:'B01',createAtStage:'approval',allowedContents:'source',changePolicy:'collision-review',renameFallback:'stop',dependsOn:[]}]});
const request=(planId,binding)=>({planId,...binding,expectedRevision:0,expectedHeadDigest:'GENESIS'});
test('client-matching fabricated and other-plan architecture bindings are refused',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'pp-folder-binding-')),contract=await freeze('PLAN-A'),binding={architectureContractDigest:contract.digest,architectureRevision:1};
 await assert.rejects(publishFolderContract(root,folder('PLAN-A',binding),request('PLAN-A',binding),{actor:'danie'}),/architecture head is unavailable/);
 await publishArchitectureContract(root,contract,{actor:'danie'});
 await assert.rejects(publishFolderContract(root,folder('PLAN-B',binding),request('PLAN-B',binding),{actor:'danie'}),/architecture head is unavailable/);
 const forged={...binding,architectureContractDigest:'f'.repeat(64)};
 await assert.rejects(publishFolderContract(root,folder('PLAN-A',forged),request('PLAN-A',forged),{actor:'danie'}),/architecture head is stale/);
 assert.equal((await inspectFolderContracts(root,'PLAN-A')).revision,0);
});
test('superseded genuine architecture cannot publish a new folder revision',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'pp-folder-stale-')),first=await freeze('PLAN-A'),second=await freeze('PLAN-A','$8/run');
 await publishArchitectureContract(root,first,{actor:'danie'});await publishArchitectureContract(root,second,{actor:'danie',supersedes:first.digest});
 const binding={architectureContractDigest:first.digest,architectureRevision:1};await assert.rejects(publishFolderContract(root,folder('PLAN-A',binding),request('PLAN-A',binding),{actor:'danie'}),/architecture head is stale/);
});
test('architecture head lock excludes a cooperating superseding publisher',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'pp-folder-lock-')),first=await freeze('PLAN-A'),second=await freeze('PLAN-A','$9/run');await publishArchitectureContract(root,first,{actor:'danie'});
 await withCurrentArchitectureContract(root,'PLAN-A',{revision:1,contractDigest:first.digest},async head=>{
  assert.equal(head.contractDigest,first.digest);await assert.rejects(publishArchitectureContract(root,second,{actor:'danie',supersedes:first.digest,timeoutMs:30,retryMs:5}));
 },{actor:'danie'});
 assert.equal((await publishArchitectureContract(root,second,{actor:'danie',supersedes:first.digest})).revision,2);
});
