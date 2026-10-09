import "./helpers/hermetic-env.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commitCollisionAssessment, inspectCollisionAuthority } from "../src/node/collisionAuthorityStore.mjs";
import { approveFolderOrganizationProposal, executeApprovedFolderMove, rollbackApprovedFolderMove } from "../src/node/folderOrganizationExecutor.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const slash = (value) => value.split(path.sep).join("/");
const fixture = () => mkdtemp(path.join(os.tmpdir(), "pp-folder-organization-"));

async function setup() {
  const base = await fixture(); const store = path.join(base, "authority"); const root = path.join(base, "workspace");
  await mkdir(path.join(root, "legacy"), { recursive: true }); await mkdir(store, { recursive: true });
  const contents = "export const quote = true;\n"; await writeFile(path.join(root, "legacy", "QuoteEditor.jsx"), contents);
  const canonicalRoot = slash(path.resolve(root)); const rootIdentity = sha(canonicalRoot); const censusDigest = "c".repeat(64); const sourceSha256 = sha(contents);
  const workspace = { workspaceId: "planner-app", canonicalRoot, rootIdentity, registryRevision: 1 };
  const census = { schemaVersion: 1, workspaceId: workspace.workspaceId, rootIdentity, registryRevision: 1, digest: censusDigest, contentReturned: false, files: [{ path: "legacy/QuoteEditor.jsx", sha256: sourceSha256, size: Buffer.byteLength(contents) }] };
  const review = { schemaVersion: 1, planId: "PP-ORG", censusDigest, executionAllowed: false, collisionAuthorityRequired: true, proposals: [{ proposalId: "MOVE-F005", nodeId: "F005", action: "move", readClaims: ["legacy/QuoteEditor.jsx"], writeClaims: ["legacy/QuoteEditor.jsx", "src/features/quotes/QuoteEditor.jsx"], internalCollision: false, previewState: "AUTHORITY_REQUIRED", executionAllowed: false }] };
  const surfaces = ["read:legacy/QuoteEditor.jsx", "write:legacy/QuoteEditor.jsx", "write:src/features/quotes/QuoteEditor.jsx"].sort();
  const initial = await inspectCollisionAuthority(store, { planId: review.planId, censusDigest });
  const authority = await commitCollisionAssessment(store, { planId: review.planId, censusDigest, expectedRevision: initial.revision, expectedHeadHash: initial.headHash, assessment: { collisionIds: [], manifestIds: [review.planId], claims: surfaces.length, surfaces } }, { actor: "danie", timestamp: "2026-09-03T00:00:00.000Z" });
  const request = { workspace, census, review, proposalId: "MOVE-F005", authorityHeadHash: authority.headHash, actor: "danie", reason: "Place the approved quote editor in its contract path.", explicitUserApproval: true };
  return { base, store, root, request };
}

test("a named exact approval moves one file and creates a durable rollback receipt", async (t) => {
  const value = await setup(); t.after(() => rm(value.base, { recursive: true, force: true }));
  const approval = await approveFolderOrganizationProposal(value.store, value.request, { timestamp: "2026-09-03T00:01:00.000Z" });
  const receipt = await executeApprovedFolderMove(value.store, approval, { actor: "danie", timestamp: "2026-09-03T00:02:00.000Z" });
  assert.equal(receipt.state, "MOVED"); assert.equal(receipt.rollbackAvailable, true);
  assert.equal(await readFile(path.join(value.root, "src/features/quotes/QuoteEditor.jsx"), "utf8"), "export const quote = true;\n");
  await assert.rejects(() => lstat(path.join(value.root, "legacy/QuoteEditor.jsx")), /ENOENT/);
  const rollback = await rollbackApprovedFolderMove(value.store, approval, { actor: "danie", reason: "Restore the pre-organization workspace layout.", explicitUserApproval: true }, { timestamp: "2026-09-03T00:03:00.000Z" });
  assert.equal(rollback.state, "ROLLED_BACK"); assert.equal(await readFile(path.join(value.root, "legacy/QuoteEditor.jsx"), "utf8"), "export const quote = true;\n");
});

test("changed sources, occupied destinations, wrong actors, and replay are refused", async (t) => {
  const value = await setup(); t.after(() => rm(value.base, { recursive: true, force: true }));
  const approval = await approveFolderOrganizationProposal(value.store, value.request);
  await assert.rejects(() => executeApprovedFolderMove(value.store, approval, { actor: "mira" }), /exact named approver/);
  await writeFile(path.join(value.root, "legacy/QuoteEditor.jsx"), "changed");
  await assert.rejects(() => executeApprovedFolderMove(value.store, approval, { actor: "danie" }), /changed after approval/);
  await writeFile(path.join(value.root, "legacy/QuoteEditor.jsx"), "export const quote = true;\n");
  await mkdir(path.join(value.root, "src/features/quotes"), { recursive: true }); await writeFile(path.join(value.root, "src/features/quotes/QuoteEditor.jsx"), "occupied");
  await assert.rejects(() => executeApprovedFolderMove(value.store, approval, { actor: "danie" }), /destination is occupied/);
  await rm(path.join(value.root, "src"), { recursive: true, force: true }); await executeApprovedFolderMove(value.store, approval, { actor: "danie" });
  await assert.rejects(() => executeApprovedFolderMove(value.store, approval, { actor: "danie" }), /receipt is occupied/);
});

test("receipt failure automatically puts the source back and leaves no false success", async (t) => {
  const value = await setup(); t.after(() => rm(value.base, { recursive: true, force: true }));
  const approval = await approveFolderOrganizationProposal(value.store, value.request);
  await assert.rejects(() => executeApprovedFolderMove(value.store, approval, { actor: "danie", writeReceipt: async () => { throw new Error("simulated durable receipt failure"); } }), /receipt failure/);
  assert.equal(await readFile(path.join(value.root, "legacy/QuoteEditor.jsx"), "utf8"), "export const quote = true;\n");
  await assert.rejects(() => lstat(path.join(value.root, "src/features/quotes/QuoteEditor.jsx")), /ENOENT/);
});

test("approval refuses stale or differently scoped collision clearance", async (t) => {
  const value = await setup(); t.after(() => rm(value.base, { recursive: true, force: true }));
  await assert.rejects(() => approveFolderOrganizationProposal(value.store, { ...value.request, authorityHeadHash: "d".repeat(64) }), /clearance is missing/);
  const altered = structuredClone(value.request); altered.review.proposals[0].writeClaims[1] = "src/elsewhere/QuoteEditor.jsx";
  await assert.rejects(() => approveFolderOrganizationProposal(value.store, altered), /different surfaces/);
});

test("rollback receipt failure restores the previously proven moved state", async (t) => {
  const value = await setup(); t.after(() => rm(value.base, { recursive: true, force: true }));
  const approval = await approveFolderOrganizationProposal(value.store, value.request); await executeApprovedFolderMove(value.store, approval, { actor: "danie" });
  await assert.rejects(() => rollbackApprovedFolderMove(value.store, approval, { actor: "danie", reason: "Test rollback receipt durability failure.", explicitUserApproval: true }, { writeRollbackReceipt: async () => { throw new Error("simulated rollback receipt failure"); } }), /receipt failure/);
  assert.equal(await readFile(path.join(value.root, "src/features/quotes/QuoteEditor.jsx"), "utf8"), "export const quote = true;\n");
  await assert.rejects(() => lstat(path.join(value.root, "legacy/QuoteEditor.jsx")), /ENOENT/);
});

test("execution rereads collision authority and refuses a missing or changed head", async (t) => {
  const value = await setup(); t.after(() => rm(value.base, { recursive: true, force: true }));
  const approval = await approveFolderOrganizationProposal(value.store, value.request);
  await rm(path.join(value.store, "collision-authority"), { recursive: true, force: true });
  await assert.rejects(() => executeApprovedFolderMove(value.store, approval, { actor: "danie" }), /changed after approval/);
  assert.equal(await readFile(path.join(value.root, "legacy/QuoteEditor.jsx"), "utf8"), "export const quote = true;\n");
});
