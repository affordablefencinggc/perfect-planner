import "./helpers/hermetic-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assessComponentPlans, authorizeComponentEdit, compareComponentPlans, freezeComponentPlans, verifyComponentPlans } from "../src/engine/componentPlanEngine.js";

const identity = (id, name) => ({ id, name, scopeLabel: id === "C001" ? "component-registry" : "collision-assessor", definition: `${name} exact bounded context`, notThis: "Not the adjacent component", kind: "service", folderNodeId: id === "C001" ? "F001" : "F002" });
const component = (id, name, overrides = {}) => ({
  ...identity(id, name), purpose: `${name} owns one bounded capability`, definitiveOutcome: `${name} produces a deterministic verified result`, owner: "danie", reviewer: "mira", taskId: `B-${id}`, wave: "build", estimateHours: 8,
  responsibilities: ["Own the named capability", "Publish bounded status"], nonResponsibilities: ["Do not own unrelated storage"],
  interfaces: [{ id: "I01", direction: "output", name: "status", contract: "Versioned JSON status envelope", version: "1" }], dependencies: [],
  fileClaims: [{ path: `src/${id.toLowerCase()}-${id === "C001" ? "component-registry" : "collision-assessor"}.js`, access: "write", reason: "Component implementation" }],
  fileNaming: { allowedRoots: ["src"], requiredTerms: id === "C001" ? ["component", "registry"] : ["collision", "assessor"], forbiddenStems: ["audit", "utils"], newFileRule: "Amend, approve, rescan, and claim first", renameRule: "Freeze, approve rename, and rescan" },
  dataOwnership: { sourceOfTruth: "Durable local registry", classification: "internal", retention: "Until plan archival", deletion: "Explicit archive operation" },
  states: [{ name: "idle", entry: "No active claim", exit: "Valid request accepted" }, { name: "ready", entry: "Result verified", exit: "New revision requested" }],
  failureModes: [{ name: "invalid input", trigger: "Contract validation fails", detection: "Validator emits blocker", containment: "Refuse mutation", recovery: "Correct the contract", proof: "Negative test passes" }],
  security: { trustBoundary: "Same-origin local authority", capabilities: ["bounded filesystem write"], secrets: [], threats: ["tampering", "replay"], privacy: "No content leaves the local authority" },
  proof: { acceptanceCriteria: ["Valid input produces exact output", "Invalid input fails closed"], tests: ["node --test focused component suite"], diffRequired: true, screenshotRequired: false },
  decisions: [{ decision: "Use immutable revisions", reason: "Prevent memory drift", owner: "danie", evidence: "ADR-COMPONENTS-001" }], assumptions: [{ statement: "Local storage is available", validation: "Run startup probe", owner: "danie" }],
  handover: { summary: `${name} is contract-bound and unbuilt`, firstAction: "Read the frozen component contract", readFirst: ["Component plan", "Architecture contract"], doNotAssume: ["Do not infer missing requirements from chat"], openQuestions: [], updatedAt: "2026-09-02T00:00:00.000Z" }, ...overrides,
});
const valid = () => ({ schemaVersion: 1, planId: "PP-COMPONENTS", architectureDigest: "a".repeat(64), architectureRevision: 1, folderDigest: "b".repeat(64), folderRevision: 1, inventory: [identity("C001", "Registry authority"), identity("C002", "Collision assessor")], components: [component("C001", "Registry authority"), component("C002", "Collision assessor", { dependencies: [{ componentId: "C001", critical: true, reason: "Reads immutable revisions", fallback: "Lock planning until registry recovers" }] })] });

test("missing or malformed parent bindings cannot be published", async () => {
  for (const [key, values] of Object.entries({architectureRevision:[undefined,0,-1,1.5,"1",Number.MAX_SAFE_INTEGER+1],folderRevision:[undefined,0,-1,1.5,"1"],folderDigest:[undefined,"x",[],null]})) {
    for (const value of values) { const input=valid(); input[key]=value; assert.equal(assessComponentPlans(input).ready,false,key); await assert.rejects(freezeComponentPlans(input,{planId:input.planId,actor:"danie",approvedAt:"2026-09-02T00:00:00.000Z"})); }
  }
});
test("every exact parent field is included in both catalog and approval digests",async()=>{
  const input=valid(), approval={planId:input.planId,actor:"danie",approvedAt:"2026-09-02T00:00:00.000Z"};
  const original=await freezeComponentPlans(input,approval);
  for(const key of ['architectureDigest','architectureRevision','folderDigest','folderRevision']){
    const changed=structuredClone(input);changed[key]=key.endsWith('Revision')?2:'c'.repeat(64);
    const successor=await freezeComponentPlans(changed,approval);
    assert.notEqual(successor.catalogDigest,original.catalogDigest,key);assert.notEqual(successor.digest,original.digest,key);
    const tampered=structuredClone(original);tampered[key]=changed[key];assert.equal((await verifyComponentPlans(tampered)).valid,false,key);
  }
});
test("approval actor and timestamp require real strings and canonical ISO time",async()=>{
  for(const patch of [{actor:{}},{actor:[]},{actor:0},{actor:' '},{approvedAt:0},{approvedAt:'2026-09-02'},{approvedAt:'2026-02-30T00:00:00.000Z'}]){
    await assert.rejects(freezeComponentPlans(valid(),{planId:'PP-COMPONENTS',actor:'danie',approvedAt:'2026-09-02T00:00:00.000Z',...patch}),/approval|actor|ISO/);
  }
});
test("legacy unbound and malformed contracts verify refused without throwing",async()=>{
  const contract=await freezeComponentPlans(valid(),{planId:'PP-COMPONENTS',actor:'danie',approvedAt:'2026-09-02T00:00:00.000Z'});
  delete contract.folderDigest;delete contract.folderRevision;delete contract.architectureRevision;
  assert.equal((await verifyComponentPlans(contract)).valid,false);
  assert.equal((await verifyComponentPlans({digest:'a',components:[null]})).valid,false);
});
test("rehashing an invalid approval does not make its semantics valid",async()=>{
  const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`:JSON.stringify(value);
  const original=await freezeComponentPlans(valid(),{planId:'PP-COMPONENTS',actor:'danie',approvedAt:'2026-09-02T00:00:00.000Z'});
  for(const patch of [{approvedBy:{}},{approvedBy:' '},{approvedAt:'tomorrow'},{approvedAt:0}]){
    const {digest,...body}={...original,...patch};const forged={...body,digest:createHash('sha256').update(canonical(body)).digest('hex')};
    const result=await verifyComponentPlans(forged);assert.equal(result.valid,false);assert.match(result.reasons.join(' '),/approval actor|timestamp/);
  }
});
test("freeze captures the reviewed input and approval before any digest await",async()=>{
  const input=valid(),approval={planId:input.planId,actor:'danie',approvedAt:'2026-09-02T00:00:00.000Z'};
  const pending=freezeComponentPlans(input,approval);
  input.folderDigest='c'.repeat(64);input.components[0].purpose='changed after click';
  approval.actor='different approver';approval.approvedAt='2026-09-03T00:00:00.000Z';
  const saved=await pending;
  assert.equal(saved.folderDigest,'b'.repeat(64));assert.notEqual(saved.components[0].purpose,input.components[0].purpose);
  assert.equal(saved.approvedBy,'danie');assert.equal(saved.approvedAt,'2026-09-02T00:00:00.000Z');assert.equal((await verifyComponentPlans(saved)).valid,true);
});
test("parent-only changes require fresh approvals and checks without inventing dossier edits",()=>{
  for(const key of ['architectureDigest','architectureRevision','folderDigest','folderRevision']){
    const before=valid(),after=valid();after[key]=key.endsWith('Revision')?2:'c'.repeat(64);
    const result=compareComponentPlans(before,after);assert.equal(result.parentBindingChanged,true,key);
    assert.equal(result.architectureApprovalRequired,true);assert.equal(result.collisionRescanRequired,true);assert.equal(result.proofPlanRefreshRequired,true);
    assert.deepEqual(result.changes,[]);assert.deepEqual(result.affectedComponentIds,[]);
  }
  const unchanged=compareComponentPlans(valid(),valid());assert.equal(unchanged.parentBindingChanged,false);assert.equal(unchanged.architectureApprovalRequired,false);
});

test("every architecture component requires one exact detailed plan", () => { const result = assessComponentPlans(valid()); assert.equal(result.ready, true); assert.equal(result.coverage.percentage, 100); assert.equal(result.coverage.required, 2); });
test("missing component dossiers block the whole plan", () => { const input = valid(); input.components.pop(); const result = assessComponentPlans(input); assert.equal(result.ready, false); assert.match(result.blockers.join(" "), /Missing component plan for C002/); });
test("vague plans cannot omit boundaries, failures, proof, or handover", () => { const input = valid(); input.components[0].responsibilities = []; input.components[0].failureModes = []; input.components[0].proof.tests = []; input.components[0].handover.summary = ""; const blockers = assessComponentPlans(input).blockers.join(" "); assert.match(blockers, /responsibilities/); assert.match(blockers, /failure-mode/); assert.match(blockers, /requires tests/); assert.match(blockers, /cold-start handover/); });
test("unresolved cold-start questions block catalog approval", () => { const input = valid(); input.components[0].handover.openQuestions = ["Which native authority owns identity?"]; const result = assessComponentPlans(input); assert.equal(result.ready, false); assert.match(result.blockers.join(" "), /C001 unresolved planning question/); });
test("inventory identity drift and unknown dependencies fail closed", () => { const input = valid(); input.components[0].name = "Relabelled"; input.components[1].dependencies[0].componentId = "C999"; const blockers = assessComponentPlans(input).blockers.join(" "); assert.match(blockers, /does not match its inventory identity/); assert.match(blockers, /dependencies\[0\] is invalid/); });
test("critical dependencies require written fallback paths", () => { const input = valid(); input.components[1].dependencies[0].fallback = ""; assert.match(assessComponentPlans(input).blockers.join(" "), /requires a fallback/); });
test("dependency cycles and overlapping write claims are explicit blockers", () => { const input = valid(); input.components[0].dependencies = [{ componentId: "C002", critical: false, reason: "status", fallback: "" }]; input.components[1].fileClaims[0].path = input.components[0].fileClaims[0].path; const blockers = assessComponentPlans(input).blockers.join(" "); assert.match(blockers, /dependency cycle/); assert.match(blockers, /Unresolved component file collision/); });
test("unsafe file claims are refused before workers receive them", () => { const input = valid(); input.components[0].fileClaims[0].path = "../escape"; assert.match(assessComponentPlans(input).blockers.join(" "), /safe path/); });
test("approved component catalogs are digest-bound and tamper evident", async () => { const contract = await freezeComponentPlans(valid(), { planId: "PP-COMPONENTS", actor: "danie", approvedAt: "2026-09-02T00:00:00.000Z" }); assert.equal((await verifyComponentPlans(contract)).valid, true); contract.components[0].purpose = "tampered"; assert.equal((await verifyComponentPlans(contract)).valid, false); });
test("component changes force architecture, collision, and proof-plan refresh", () => { const before = valid(); const after = valid(); after.components[0].interfaces[0].version = "2"; const result = compareComponentPlans(before, after); assert.deepEqual(result.affectedComponentIds, ["C001"]); assert.equal(result.architectureApprovalRequired, true); assert.equal(result.collisionRescanRequired, true); assert.equal(result.proofPlanRefreshRequired, true); });
test("exact component and task claims authorize only planned files", () => { const input = valid(); const base = { planId: input.planId, architectureDigest: input.architectureDigest, componentId: "C001", taskId: "B-C001" }; assert.equal(authorizeComponentEdit(input, { ...base, paths: [{ path: "src/c001-component-registry.js", access: "write" }] }).allowed, true); const refused = authorizeComponentEdit(input, { ...base, paths: [{ path: "src/c002-collision-assessor.js", access: "write" }] }); assert.equal(refused.allowed, false); assert.match(refused.requiredRecovery, /Amend the component contract/); });
