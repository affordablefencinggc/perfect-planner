import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {freezeArchitectureContract} from '../src/engine/rulebookEngine.js';
import {publishArchitectureContract,inspectArchitectureContracts} from '../src/node/architectureContractStore.mjs';
const scenario = (kind) => ({ kind, trigger: "named threshold", detection: "machine signal", owner: "danie", immediateAction: "stop", recovery: "fallback", verification: "proof rerun" });
const decision = (kind) => ({ kind, choice: `${kind} choice`, rationale: "evidence-backed fit", evidence: "ADR source", alternatives: [{ choice: "other", rejectionReason: "fails a stated constraint" }] });
const complete = (costCeiling = "$5/run") => ({ templateId: "ai-autopilot-control-plane", templateVersion: 1, platform: "tauri", brief: { autopilot: true, localFirst: true }, useCases: ["ai-autopilot", "desktop-distribution"], answers: { collisionPolicy: "fail closed", proofPolicy: "paired proof", rollbackPolicy: "restore checkpoint", capabilityPolicy: "deny by default", humanStopPolicy: "explicit gate", costCeiling, osTargets: ["windows"], updateSigning: "signed", rollbackChannel: "stable previous" }, capabilities: [{ id: "native-process", necessity: "mandatory", mitigation: "reviewed bounded sidecar", proof: "capability test" }], scenarios: ["security-breach", "data-loss", "critical-dependency-failure", "vendor-exit"].map(scenario), dependencies: [{ name: "Tauri", purpose: "desktop shell", license: "MIT/Apache-2.0", pinnedVersion: "2.x exact lock", maintenanceEvidence: "release history", securityEvidence: "advisory review", critical: true, fallback: "PWA reduced mode", switchTrigger: "native proof fails", dependsOn: [] }], decisions: ["platform", "data", "identity-auth", "state-sync", "deployment-distribution"].map(decision), nonFunctional: { performanceBudget: "startup P80 <2s", securityTarget: "zero critical", accessibilityTarget: "WCAG 2.2 AA", operatingCostCeiling: "$100/month", recoveryTarget: "RPO 0 local ledger", observabilityProof: "hashed run report" } });
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const rehash=contract=>{const {digest,...body}=contract;return {...body,digest:hash(body)};};
const valid=()=>freezeArchitectureContract(complete(),{planId:'SEMANTICS',actor:'danie',approvedAt:'2026-09-02T00:00:00.000Z'});
test('self-hashed incomplete input and forged derived map cannot publish',async()=>{
 for(const mode of ['input','map']){const root=await mkdtemp(path.join(os.tmpdir(),'pp-arch-semantics-')),contract=structuredClone(await valid());if(mode==='input')contract.input.answers={};else contract.executionMap.nodes=[];await assert.rejects(publishArchitectureContract(root,rehash(contract),{actor:'danie'}),/cannot freeze|rulebook-derived/);assert.equal((await inspectArchitectureContracts(root,'SEMANTICS')).count,0);}
});
test('saved self-hashed fabrication is refused during authoritative head inspection',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'pp-arch-saved-'));await publishArchitectureContract(root,await valid(),{actor:'danie'});
 const directory=path.join(root,'contracts',(await readdir(path.join(root,'contracts')))[0]),file=path.join(directory,'00000001.json'),registration=JSON.parse(await readFile(file,'utf8'));
 registration.contract.executionMap.nodes=[];registration.contract=rehash(registration.contract);registration.contractDigest=registration.contract.digest;const {hash:old,...body}=registration;registration.hash=hash(body);await writeFile(file,JSON.stringify(registration));
 await assert.rejects(inspectArchitectureContracts(root,'SEMANTICS'),/rulebook-derived/);assert.equal(JSON.parse(await readFile(file,'utf8')).hash,registration.hash);
});
test('publication captures immutable contract before asynchronous verification',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'pp-arch-clone-')),contract=structuredClone(await valid()),digest=contract.digest,pending=publishArchitectureContract(root,contract,{actor:'danie'});contract.input.answers={};const result=await pending;assert.equal(result.contractDigest,digest);assert.equal((await inspectArchitectureContracts(root,'SEMANTICS')).head.contractDigest,digest);
});
