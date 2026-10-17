import "./helpers/hermetic-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { folderDraftStructureDigest } from "../src/engine/folderContractEngine.js";
import { analyzeWorkspaceStructure, assessFolderContract, compareFolderContracts, freezeFolderContract, materializationWave, prepareFolderOrganizationReview, verifyFolderContract } from "../src/engine/folderContractEngine.js";

const node = (id, path, overrides = {}) => ({ id, kind: "folder", path, purpose: `${path} responsibility`, owner: "danie", taskId: "B01", createAtStage: "approval", allowedContents: "named project artifacts", changePolicy: "collision-review", renameFallback: "stop, assess imports, approve rename, and rescan collisions", dependsOn: [], ...overrides });
const architecture = { architectureContractDigest: "a".repeat(64), architectureRevision: 3 };
const valid = () => ({ schemaVersion: 1, planId: "PP-014", ...architecture, workspaceMode: "private", nodes: [node("F001", "src"), node("F002", "src/features", { dependsOn: ["F001"] }), node("F003", "src/features/quotes", { createAtStage: "architecture", dependsOn: ["F002"] }), node("F004", "tests")] });
const approval = () => ({ planId: "PP-014", actor: "danie", approvedAt: "2026-09-02T00:00:00.000Z", ...architecture });

test("saved-state fingerprint matches only the exact valid folder draft", async () => {
  const input = valid(); const frozen = await freezeFolderContract(input, approval());
  assert.equal(await folderDraftStructureDigest(input), frozen.structureDigest);
  input.nodes[0].purpose = "Changed responsibility";
  assert.notEqual(await folderDraftStructureDigest(input), frozen.structureDigest);
  input.nodes[0].owner = "";
  assert.equal(await folderDraftStructureDigest(input), null);
});

test("blank and legacy placeholder folder answers cannot freeze reservations", async () => {
  const placeholders = { purpose: "Define this boundary before approval", owner: "Unallocated", taskId: "UNASSIGNED", allowedContents: "Name allowed artifacts" };
  for (const [field, placeholder] of Object.entries(placeholders)) {
    for (const value of ["", ` ${placeholder.toUpperCase()} `]) {
      const input = valid(); input.nodes[0][field] = value;
      const result = assessFolderContract(input);
      assert.equal(result.ready, false, field);
      assert.deepEqual(result.reservations, []);
      await assert.rejects(() => freezeFolderContract(input, approval()), /cannot freeze/);
    }
  }
});

test("a complete named structure produces exact forward reservations", () => { const result = assessFolderContract(valid()); assert.equal(result.ready, true); assert.equal(result.verdict, "READY FOR APPROVAL"); assert.equal(result.reservations.length, 4); assert.deepEqual(result.reservations.map((item) => item.surface), ["src/**", "src/features/**", "src/features/quotes/**", "tests/**"]); });
test("a strict plan with no structure is blocked", () => { const result = assessFolderContract({ schemaVersion: 1, planId: "PP-014", workspaceMode: "private", nodes: [] }); assert.equal(result.ready, false); assert.match(result.blockers.join(" "), /At least one named/); });
test("unsafe, ambiguous, duplicate, and orphan paths are refused", () => { const input = valid(); input.nodes.push(node("F005", "../escape"), node("F006", "src"), node("F007", "missing/child")); const blockers = assessFolderContract(input).blockers.join(" "); assert.match(blockers, /safe relative/); assert.match(blockers, /Duplicate planned path src/); assert.match(blockers, /missing planned parent folder missing/); });
test("unknown dependencies and cycles block approval", () => { const input = valid(); input.nodes[0].dependsOn = ["F002"]; input.nodes[1].dependsOn = ["F001", "F999"]; const blockers = assessFolderContract(input).blockers.join(" "); assert.match(blockers, /unknown node F999/); assert.match(blockers, /cycle/); });
test("missing and mismatched architecture bindings fail closed", async () => { const missing = valid(); delete missing.architectureContractDigest; delete missing.architectureRevision; const blockers = assessFolderContract(missing).blockers.join(" "); assert.match(blockers, /architectureContractDigest/); assert.match(blockers, /architectureRevision/); await assert.rejects(() => freezeFolderContract(valid(), { ...approval(), architectureRevision: 4 }), /exact current architecture/); });
test("approved contracts are architecture-bound, digest-bound, and tamper detected", async () => { const contract = await freezeFolderContract(valid(), approval()); assert.equal(contract.architectureContractDigest, architecture.architectureContractDigest); assert.equal(contract.architectureRevision, architecture.architectureRevision); assert.equal((await verifyFolderContract(contract)).valid, true); contract.nodes[2].path = "src/features/invoices"; assert.equal((await verifyFolderContract(contract)).valid, false); });
test("materialization waves create parents first and do not jump stages", () => { const approval = materializationWave(valid(), "approval"); assert.deepEqual(approval.map((item) => item.id), ["F001", "F004", "F002"]); assert.equal(approval.some((item) => item.id === "F003"), false); assert.equal(materializationWave(valid(), "architecture").at(-1).id, "F003"); });
test("renames and contract changes force architecture approval and collision rescan", () => { const before = valid(); const after = valid(); after.nodes[2].path = "src/features/estimates"; const result = compareFolderContracts(before, after); assert.equal(result.changes[0].type, "renamed"); assert.equal(result.architectureApprovalRequired, true); assert.equal(result.collisionRescanRequired, true); assert.deepEqual(result.affectedNodeIds, ["F003"]); });
test("new paths cannot be slipped into an approved structure as cleanup", () => { const before = valid(); const after = valid(); after.nodes.push(node("F005", "evidence")); const result = compareFolderContracts(before, after); assert.deepEqual(result.changes.map((item) => item.type), ["added"]); assert.equal(result.collisionRescanRequired, true); });
test("architecture successors explicitly rebind the folder contract", () => { const before = valid(); const after = valid(); after.architectureRevision = 4; after.architectureContractDigest = "b".repeat(64); const result = compareFolderContracts(before, after); assert.deepEqual(result.changes.map((item) => item.type), ["architecture-rebound"]); assert.deepEqual(result.affectedNodeIds, ["ARCHITECTURE"]); });
test("metadata census reveals planned gaps and out-of-contract files without authorising mutation", () => { const contract = valid(); contract.nodes.push({ ...node("F005", "src/features/quotes/QuoteEditor.jsx"), kind: "file", dependsOn: ["F003"] }); const census = { schemaVersion: 1, digest: "c".repeat(64), contentReturned: false, fileCount: 2, files: [{ path: "src/app.js" }, { path: "legacy/QuoteEditor.jsx" }] }; const result = analyzeWorkspaceStructure(census, contract); assert.equal(result.verdict, "RESOLUTION_REQUIRED"); assert.equal(result.mutationAuthorized, false); assert.ok(result.gaps.some((gap) => gap.nodeId === "F005" && gap.state === "MISSING")); assert.deepEqual(result.unexpected.map((item) => item.path), ["legacy/QuoteEditor.jsx"]); assert.deepEqual(result.proposals, [{ proposalId: "MOVE-F005", action: "move", from: "legacy/QuoteEditor.jsx", to: "src/features/quotes/QuoteEditor.jsx", confidence: "basename-only", approvalRequired: true, executable: false, reason: "One out-of-contract file shares the exact planned basename; content meaning is not inferred." }]); });
test("ambiguous filenames force resolution and content-bearing census records are refused", () => { const contract = valid(); contract.nodes.push({ ...node("F005", "src/features/quotes/QuoteEditor.jsx"), kind: "file", dependsOn: ["F003"] }); const census = { schemaVersion: 1, digest: "d".repeat(64), contentReturned: false, fileCount: 2, files: [{ path: "old/QuoteEditor.jsx" }, { path: "backup/QuoteEditor.jsx" }] }; const result = analyzeWorkspaceStructure(census, contract); assert.equal(result.proposals.length, 0); assert.equal(result.gaps.find((gap) => gap.nodeId === "F005").candidates.length, 2); census.files[0].content = "untrusted"; assert.throws(() => analyzeWorkspaceStructure(census, contract), /content-bearing/); });

test("organisation review exposes exact read/write claims but cannot authorise a move", () => { const contract = valid(); contract.nodes.push({ ...node("F005", "src/features/quotes/QuoteEditor.jsx"), kind: "file", dependsOn: ["F003"] }); contract.nodes.push({ ...node("F006", "src/features/quotes/screens"), dependsOn: ["F005"] }); const census = { schemaVersion: 1, digest: "e".repeat(64), contentReturned: false, fileCount: 1, files: [{ path: "legacy/QuoteEditor.jsx" }] }; const analysis = analyzeWorkspaceStructure(census, contract); const review = prepareFolderOrganizationReview(analysis, contract); assert.equal(review.executionAllowed, false); assert.equal(review.collisionAuthorityRequired, true); assert.deepEqual(review.proposals[0], { proposalId: "MOVE-F005", nodeId: "F005", action: "move", readClaims: ["legacy/QuoteEditor.jsx"], writeClaims: ["legacy/QuoteEditor.jsx", "src/features/quotes/QuoteEditor.jsx"], dependantNodeIds: ["F006"], previewState: "AUTHORITY_REQUIRED", internalCollision: false, approvalRequired: true, rollbackReceiptRequired: true, executionAllowed: false }); });

test("organisation review refuses relabelled targets and exposes internal proposal collisions", () => { const contract = valid(); contract.nodes.push({ ...node("F005", "src/features/quotes/QuoteEditor.jsx"), kind: "file", dependsOn: ["F003"] }); contract.nodes.push({ ...node("F006", "src/features/quotes/QuoteSummary.jsx"), kind: "file", dependsOn: ["F003"] }); const census = { schemaVersion: 1, digest: "f".repeat(64), contentReturned: false, fileCount: 1, files: [{ path: "legacy/QuoteEditor.jsx" }] }; const analysis = analyzeWorkspaceStructure(census, contract); const altered = { ...analysis, proposals: [{ ...analysis.proposals[0], to: "src/elsewhere/QuoteEditor.jsx" }] }; assert.throws(() => prepareFolderOrganizationReview(altered, contract), /exact contract node/); const colliding = { ...analysis, proposals: [...analysis.proposals, { ...analysis.proposals[0], proposalId: "MOVE-F006", to: "src/features/quotes/QuoteSummary.jsx" }] }; const review = prepareFolderOrganizationReview(colliding, contract); assert.equal(review.proposals.every((proposal) => proposal.previewState === "INTERNAL_COLLISION"), true); });

// Trial define-03: these used to freeze.
test("wildcards, markup, over-long paths and free-text task IDs block the contract", async () => {
  const withNode = (overrides) => ({ ...valid(), nodes: [node("F001", "src"), node("F002", "src/x", overrides)] });
  for (const path of ["src*", "src/**", "src/<script>", "src/a?b", "src/a:b", "src/a|b", `src/${"a".repeat(300)}`, "src/name.", "src/trailing "]) {
    const result = assessFolderContract(withNode({ path }));
    assert.equal(result.ready, false, path);
    await assert.rejects(freezeFolderContract(withNode({ path }), approval()), /cannot freeze/, path);
  }
  assert.match(assessFolderContract(withNode({ path: "src/**" })).blockers.join(" "), /wildcard/);
  assert.match(assessFolderContract(withNode({ path: `src/${"a".repeat(300)}` })).blockers.join(" "), /longer than 240/);
  for (const taskId of ["lol not a task", "<script>", "T 1", "-1"]) {
    const result = assessFolderContract(withNode({ taskId }));
    assert.equal(result.ready, false, taskId);
    assert.match(result.blockers.join(" "), /task number such as T0001/);
  }
  for (const taskId of ["T0001", "B01", "B-C001"]) assert.equal(assessFolderContract(withNode({ taskId })).ready, true, taskId);
  assert.equal(assessFolderContract(withNode({ path: "src/my app" })).ready, true);
});
