import "./helpers/hermetic-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { freezeArchitectureContract } from "../src/engine/rulebookEngine.js";
import { createArchitectureContractArchive, inspectArchitectureContracts, publishArchitectureContract, readArchitectureContract, verifyArchitectureContractArchive } from "../src/node/architectureContractStore.mjs";

const scenario = (kind) => ({ kind, trigger: "named threshold", detection: "machine signal", owner: "danie", immediateAction: "stop", recovery: "fallback", verification: "proof rerun" });
const decision = (kind) => ({ kind, choice: `${kind} choice`, rationale: "evidence-backed fit", evidence: "ADR source", alternatives: [{ choice: "other", rejectionReason: "fails a stated constraint" }] });
const complete = (costCeiling = "$5/run") => ({ templateId: "ai-autopilot-control-plane", templateVersion: 1, platform: "tauri", brief: { autopilot: true, localFirst: true }, useCases: ["ai-autopilot", "desktop-distribution"], answers: { collisionPolicy: "fail closed", proofPolicy: "paired proof", rollbackPolicy: "restore checkpoint", capabilityPolicy: "deny by default", humanStopPolicy: "explicit gate", costCeiling, osTargets: ["windows"], updateSigning: "signed", rollbackChannel: "stable previous" }, capabilities: [{ id: "native-process", necessity: "mandatory", mitigation: "reviewed bounded sidecar", proof: "capability test" }], scenarios: ["security-breach", "data-loss", "critical-dependency-failure", "vendor-exit"].map(scenario), dependencies: [{ name: "Tauri", purpose: "desktop shell", license: "MIT/Apache-2.0", pinnedVersion: "2.x exact lock", maintenanceEvidence: "release history", securityEvidence: "advisory review", critical: true, fallback: "PWA reduced mode", switchTrigger: "native proof fails", dependsOn: [] }], decisions: ["platform", "data", "identity-auth", "state-sync", "deployment-distribution"].map(decision), nonFunctional: { performanceBudget: "startup P80 <2s", securityTarget: "zero critical", accessibilityTarget: "WCAG 2.2 AA", operatingCostCeiling: "$100/month", recoveryTarget: "RPO 0 local ledger", observabilityProof: "hashed run report" } });
const approval = (approvedAt = "2026-09-02T00:00:00.000Z") => ({ planId: "PP-014", actor: "danie", approvedAt });
const fixture = () => mkdtemp(path.join(os.tmpdir(), "pp-architecture-registry-"));

test("an approved architecture contract publishes as immutable revision one", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); const contract = await freezeArchitectureContract(complete(), approval());
  const published = await publishArchitectureContract(root, contract, { actor: "danie", timestamp: "2026-09-02T00:01:00.000Z" }); const state = await inspectArchitectureContracts(root, "PP-014");
  assert.equal(published.revision, 1); assert.equal(published.supersedes, null); assert.equal(state.valid, true); assert.equal(state.count, 1); assert.equal(state.head.contractDigest, contract.digest);
});

test("registration summaries expose hashes and structure without returning the full answer set", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); const contract = await freezeArchitectureContract(complete(), approval()); await publishArchitectureContract(root, contract, { actor: "danie" });
  const state = await inspectArchitectureContracts(root, "PP-014"); assert.equal(JSON.stringify(state).includes("costCeiling"), false); const read = await readArchitectureContract(root, "PP-014", 1); assert.equal(read.contract.input.answers.costCeiling, "$5/run"); assert.equal(read.registration.contractDigest, contract.digest);
});

test("wrong actors, invalid contracts, duplicates, and missing supersession are refused", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); const first = await freezeArchitectureContract(complete(), approval());
  await assert.rejects(() => publishArchitectureContract(root, first, { actor: "mira" }), /exact plan approver/); await publishArchitectureContract(root, first, { actor: "danie" });
  await assert.rejects(() => publishArchitectureContract(root, first, { actor: "danie", supersedes: first.digest }), /exact current digest|already registered/);
  const forged = structuredClone(first); forged.input.answers.costCeiling = "$500/run"; await assert.rejects(() => publishArchitectureContract(root, forged, { actor: "danie", supersedes: first.digest }), /changed after approval/);
  const second = await freezeArchitectureContract(complete("$6/run"), approval("2026-09-02T00:02:00.000Z")); await assert.rejects(() => publishArchitectureContract(root, second, { actor: "danie" }), /supersede/);
});

test("a new approved contract must name and chain to the exact prior digest", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); const first = await freezeArchitectureContract(complete(), approval()); const second = await freezeArchitectureContract(complete("$6/run"), approval("2026-09-02T00:02:00.000Z"));
  await publishArchitectureContract(root, first, { actor: "danie" }); const next = await publishArchitectureContract(root, second, { actor: "danie", supersedes: first.digest }); const state = await inspectArchitectureContracts(root, "PP-014");
  assert.equal(next.revision, 2); assert.equal(state.count, 2); assert.equal(state.registrations[1].supersedes, first.digest); assert.equal(state.head.contractDigest, second.digest);
});

test("contract or registration metadata tampering breaks every later read and append", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); const first = await freezeArchitectureContract(complete(), approval()); await publishArchitectureContract(root, first, { actor: "danie" });
  const directories = await readdir(path.join(root, "contracts")); const file = path.join(root, "contracts", directories[0], "00000001.json"); const stored = JSON.parse(await readFile(file, "utf8")); stored.registeredBy = "attacker"; await writeFile(file, JSON.stringify(stored));
  await assert.rejects(() => inspectArchitectureContracts(root, "PP-014"), /record hash/); const second = await freezeArchitectureContract(complete("$6/run"), approval("2026-09-02T00:02:00.000Z")); await assert.rejects(() => publishArchitectureContract(root, second, { actor: "danie", supersedes: first.digest }), /record hash/);
});

test("concurrent successors produce one winner and preserve a linear chain", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); const first = await freezeArchitectureContract(complete(), approval()); await publishArchitectureContract(root, first, { actor: "danie" });
  const candidates = await Promise.all(["$6/run", "$7/run", "$8/run"].map((cost, index) => freezeArchitectureContract(complete(cost), approval(`2026-09-02T00:0${index + 2}:00.000Z`))));
  const results = await Promise.allSettled(candidates.map((contract) => publishArchitectureContract(root, contract, { actor: "danie", supersedes: first.digest })));
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1); assert.equal(results.filter((item) => item.status === "rejected").length, 2); assert.equal((await inspectArchitectureContracts(root, "PP-014")).count, 2);
});

test("revision listing is bounded and non-regular registration paths are refused", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); const first = await freezeArchitectureContract(complete(), approval()); await publishArchitectureContract(root, first, { actor: "danie" });
  await assert.rejects(() => inspectArchitectureContracts(root, "PP-014", { maxRevisions: 0 }), /bounded revision limit/);
  const directories = await readdir(path.join(root, "contracts")); const target = path.join(root, "contracts", directories[0], "00000002.json");
  await mkdir(target);
  await assert.rejects(() => inspectArchitectureContracts(root, "PP-014"), /not a regular file/);
});

test("store directories cannot be replaced by files and followed outside the registry", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); await writeFile(path.join(root, "contracts"), "not a directory"); const contract = await freezeArchitectureContract(complete(), approval());
  await assert.rejects(() => publishArchitectureContract(root, contract, { actor: "danie" }), /EEXIST|safe regular directory/); await assert.rejects(() => inspectArchitectureContracts(root, "PP-014"), /safe regular directory/);
});

test("an immutable archive preserves and re-verifies the complete chain", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true })); const first = await freezeArchitectureContract(complete(), approval()); const second = await freezeArchitectureContract(complete("$6/run"), approval("2026-09-02T00:02:00.000Z"));
  await publishArchitectureContract(root, first, { actor: "danie" }); await publishArchitectureContract(root, second, { actor: "danie", supersedes: first.digest }); const archivePath = path.join(root, "backup", "PP-014.architecture.json");
  const receipt = await createArchitectureContractArchive(root, "PP-014", archivePath, { actor: "danie", timestamp: "2026-09-02T01:00:00.000Z" }); assert.equal(receipt.revisionCount, 2); assert.equal((await verifyArchitectureContractArchive(archivePath)).valid, true);
  await assert.rejects(() => createArchitectureContractArchive(root, "PP-014", archivePath, { actor: "danie" }), /EEXIST/); const archive = JSON.parse(await readFile(archivePath, "utf8")); archive.registrations[0].registeredBy = "attacker"; await writeFile(archivePath, JSON.stringify(archive)); await assert.rejects(() => verifyArchitectureContractArchive(archivePath), /tampered|invalid/);
});
