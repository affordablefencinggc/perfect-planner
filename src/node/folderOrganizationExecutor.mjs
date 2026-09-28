import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { inspectCollisionAuthority } from "./collisionAuthorityStore.mjs";
import { withPlanLock } from "./planLock.mjs";

const HEX = /^[a-f0-9]{64}$/;
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const digest = (value) => createHash("sha256").update(typeof value === "string" || value instanceof Uint8Array ? value : canonical(value)).digest("hex");
const slash = (value) => value.split(path.sep).join("/");
const relativePath = (value, label) => { const normalized = slash(path.normalize(String(value ?? ""))).replace(/^\.\//, ""); if (!normalized || path.isAbsolute(value) || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../") || normalized.includes("\0")) throw new Error(`${label} must be a safe relative path.`); return normalized; };
const key = (value) => digest(value);

function locations(storeRoot, planId, workspaceId, approvalId = null) {
  const directory = path.join(path.resolve(storeRoot), "folder-organization", key(`plan:${planId}:workspace:${workspaceId}`));
  return { directory, approvals: path.join(directory, "approvals"), receipts: path.join(directory, "receipts"), rollbacks: path.join(directory, "rollbacks"), lock: path.join(directory, "execution"), approval: approvalId ? path.join(directory, "approvals", `${approvalId}.json`) : null, receipt: approvalId ? path.join(directory, "receipts", `${approvalId}.json`) : null, rollback: approvalId ? path.join(directory, "rollbacks", `${approvalId}.json`) : null };
}

async function safeDirectory(directory, create = false) {
  if (create) await mkdir(directory, { recursive: true });
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe organization directory: ${directory}.`);
}

async function exclusiveJson(file, value) {
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
}

async function readBoundedJson(file, label) {
  const stat = await lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1_000_000) throw new Error(`${label} is not a bounded regular file.`);
  return JSON.parse(await readFile(file, "utf8"));
}

async function fileDigest(file) {
  const stat = await lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Source is not a regular file: ${file}.`);
  return { sha256: digest(await readFile(file)), size: stat.size };
}

function authentic(record, field, label) {
  const { [field]: stored, ...body } = record ?? {};
  if (!HEX.test(stored ?? "") || digest(body) !== stored) throw new Error(`${label} hash is invalid.`);
  return record;
}

function exactProposal(review, proposalId) {
  if (review?.schemaVersion !== 1 || !HEX.test(review?.censusDigest ?? "") || review.executionAllowed !== false || review.collisionAuthorityRequired !== true) throw new Error("Approval requires the exact locked organization review.");
  const proposal = review.proposals?.find((item) => item.proposalId === proposalId);
  if (!proposal || proposal.action !== "move" || proposal.internalCollision || proposal.previewState !== "AUTHORITY_REQUIRED" || proposal.executionAllowed !== false || proposal.readClaims?.length !== 1 || proposal.writeClaims?.length !== 2) throw new Error("Approval requires one collision-free, non-executable move proposal.");
  const from = relativePath(proposal.readClaims[0], "Source claim");
  const writes = proposal.writeClaims.map((item) => relativePath(item, "Write claim"));
  if (!writes.includes(from)) throw new Error("Move proposal must claim its source as both read and write.");
  const to = writes.find((item) => item !== from);
  if (!to) throw new Error("Move proposal requires one exact destination.");
  return { proposal, from, to, surfaces: [`read:${from}`, `write:${from}`, `write:${to}`].sort() };
}

function validateWorkspace(workspace) {
  const canonicalRoot = slash(path.resolve(workspace?.canonicalRoot ?? ""));
  if (!workspace?.workspaceId || !HEX.test(workspace?.rootIdentity ?? "") || digest(canonicalRoot) !== workspace.rootIdentity || !Number.isSafeInteger(workspace.registryRevision) || workspace.registryRevision < 1) throw new Error("Approval requires the exact registered workspace identity.");
  return { workspaceId: workspace.workspaceId, canonicalRoot, rootIdentity: workspace.rootIdentity, registryRevision: workspace.registryRevision };
}

export async function approveFolderOrganizationProposal(storeRoot, request, options = {}) {
  const actor = String(request?.actor ?? "").trim(); const reason = String(request?.reason ?? "").trim();
  if (!actor || reason.length < 8 || request?.explicitUserApproval !== true) throw new Error("Organization approval requires a named actor, explicit gesture, and meaningful reason.");
  const workspace = validateWorkspace(request.workspace); const { proposal, from, to, surfaces } = exactProposal(request.review, request.proposalId);
  const census = request.census;
  if (census?.workspaceId !== workspace.workspaceId || census?.rootIdentity !== workspace.rootIdentity || census?.registryRevision !== workspace.registryRevision || census?.digest !== request.review.censusDigest || census?.contentReturned !== false) throw new Error("Organization approval requires the exact current metadata-only census.");
  const source = census.files?.find((item) => item.path === from);
  if (!source || !HEX.test(source.sha256 ?? "") || census.files?.some((item) => item.path === to)) throw new Error("Census must identify the exact source hash and an unoccupied destination.");
  const authority = await inspectCollisionAuthority(storeRoot, { planId: request.review.planId, censusDigest: census.digest });
  const committed = authority.ledger.at(-1);
  if (authority.headHash !== request.authorityHeadHash || committed?.type !== "collision.assessment-committed" || committed.payload?.censusDigest !== census.digest || canonical(committed.payload.surfaces) !== canonical(surfaces)) throw new Error("Exact collision authority clearance is missing, stale, or covers different surfaces.");
  const approvalId = `FOA-${randomUUID()}`; const location = locations(storeRoot, request.review.planId, workspace.workspaceId, approvalId);
  await safeDirectory(path.resolve(storeRoot), true); await safeDirectory(path.join(path.resolve(storeRoot), "folder-organization"), true); await safeDirectory(location.directory, true); await safeDirectory(location.approvals, true); await safeDirectory(location.receipts, true); await safeDirectory(location.rollbacks, true);
  const body = { schemaVersion: 1, state: "APPROVED", approvalId, planId: request.review.planId, workspace, censusDigest: census.digest, proposalId: proposal.proposalId, nodeId: proposal.nodeId, action: "move", from, to, sourceSha256: source.sha256, sourceSize: source.size, surfaces, collisionAuthorityHeadHash: authority.headHash, actor, reason, explicitUserApproval: true, rollbackReceiptRequired: true, approvedAt: options.timestamp ?? new Date().toISOString() };
  const approval = { ...body, approvalHash: digest(body) }; await exclusiveJson(location.approval, approval); return approval;
}

async function loadApproval(storeRoot, supplied) {
  if (!/^FOA-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(supplied?.approvalId ?? "")) throw new Error("Organization approval identity is invalid.");
  const location = locations(storeRoot, supplied?.planId, supplied?.workspace?.workspaceId, supplied?.approvalId);
  const stored = authentic(await readBoundedJson(location.approval, "Organization approval"), "approvalHash", "Organization approval");
  if (stored.approvalHash !== supplied?.approvalHash) throw new Error("Supplied approval does not match durable authority.");
  return { approval: stored, location };
}

async function ensureSafeParents(root, relative, created) {
  let current = root; const segments = relative.split("/").slice(0, -1);
  for (const segment of segments) {
    current = path.join(current, segment);
    try { await safeDirectory(current); }
    catch (error) { if (error.code !== "ENOENT") throw error; await mkdir(current); await safeDirectory(current); created.push(current); }
  }
}

async function absent(file, label) { try { await lstat(file); throw new Error(`${label} is occupied.`); } catch (error) { if (error.code !== "ENOENT") throw error; } }

export async function executeApprovedFolderMove(storeRoot, suppliedApproval, options = {}) {
  const { approval, location } = await loadApproval(storeRoot, suppliedApproval); const actor = String(options.actor ?? "").trim();
  if (!actor || actor !== approval.actor) throw new Error("Execution requires the exact named approver.");
  return withPlanLock(location.lock, { actor, timeoutMs: options.timeoutMs ?? 5000, retryMs: 10 }, async () => {
    await absent(location.receipt, "Execution receipt"); await absent(location.rollback, "Rollback receipt");
    const authority = await inspectCollisionAuthority(storeRoot, { planId: approval.planId, censusDigest: approval.censusDigest });
    if (authority.headHash !== approval.collisionAuthorityHeadHash || authority.ledger.at(-1)?.type !== "collision.assessment-committed") throw new Error("Collision authority changed after approval; execution requires a fresh approval.");
    const root = path.resolve(approval.workspace.canonicalRoot); await safeDirectory(root);
    if (slash(root) !== approval.workspace.canonicalRoot || digest(slash(root)) !== approval.workspace.rootIdentity) throw new Error("Registered workspace root identity changed.");
    const source = path.resolve(root, approval.from); const destination = path.resolve(root, approval.to);
    if (!source.startsWith(`${root}${path.sep}`) || !destination.startsWith(`${root}${path.sep}`)) throw new Error("Approved move escaped the registered workspace.");
    const before = await fileDigest(source); if (before.sha256 !== approval.sourceSha256 || before.size !== approval.sourceSize) throw new Error("Source changed after approval; refresh census and approval.");
    await absent(destination, "Approved destination"); const created = []; await ensureSafeParents(root, approval.to, created);
    let moved = false;
    try {
      await rename(source, destination); moved = true;
      const after = await fileDigest(destination); if (after.sha256 !== approval.sourceSha256 || after.size !== approval.sourceSize) throw new Error("Moved file did not preserve its approved identity.");
      const body = { schemaVersion: 1, state: "MOVED", approvalId: approval.approvalId, approvalHash: approval.approvalHash, planId: approval.planId, workspaceId: approval.workspace.workspaceId, rootIdentity: approval.workspace.rootIdentity, from: approval.from, to: approval.to, sha256: after.sha256, size: after.size, actor, rollbackAvailable: true, movedAt: options.timestamp ?? new Date().toISOString() };
      const receipt = { ...body, receiptHash: digest(body) }; await (options.writeReceipt ?? exclusiveJson)(location.receipt, receipt); return receipt;
    } catch (error) {
      if (moved) { try { await absent(source, "Rollback source"); await rename(destination, source); } catch (rollbackError) { throw new AggregateError([error, rollbackError], "Move failed and automatic rollback also failed; manual containment required."); } }
      for (const directory of created.reverse()) await rm(directory, { recursive: false, force: false }).catch(() => {});
      throw error;
    }
  });
}

export async function rollbackApprovedFolderMove(storeRoot, suppliedApproval, request, options = {}) {
  const { approval, location } = await loadApproval(storeRoot, suppliedApproval); const actor = String(request?.actor ?? "").trim(); const reason = String(request?.reason ?? "").trim();
  if (!actor || reason.length < 8 || request?.explicitUserApproval !== true) throw new Error("Rollback requires a named actor, explicit gesture, and meaningful reason.");
  return withPlanLock(location.lock, { actor, timeoutMs: options.timeoutMs ?? 5000, retryMs: 10 }, async () => {
    await absent(location.rollback, "Rollback receipt"); const receipt = authentic(await readBoundedJson(location.receipt, "Execution receipt"), "receiptHash", "Execution receipt");
    if (receipt.approvalHash !== approval.approvalHash || receipt.state !== "MOVED") throw new Error("Execution receipt is not bound to this approval.");
    const root = path.resolve(approval.workspace.canonicalRoot); await safeDirectory(root); const source = path.resolve(root, approval.from); const destination = path.resolve(root, approval.to);
    await absent(source, "Original source"); const current = await fileDigest(destination); if (current.sha256 !== receipt.sha256 || current.size !== receipt.size) throw new Error("Moved file changed after execution; automatic rollback is refused.");
    await rename(destination, source); let restored;
    try {
      restored = await fileDigest(source);
      if (restored.sha256 !== receipt.sha256 || restored.size !== receipt.size) throw new Error("Rollback did not restore the recorded file identity.");
      const body = { schemaVersion: 1, state: "ROLLED_BACK", approvalId: approval.approvalId, approvalHash: approval.approvalHash, executionReceiptHash: receipt.receiptHash, planId: approval.planId, workspaceId: approval.workspace.workspaceId, from: approval.to, to: approval.from, sha256: restored.sha256, size: restored.size, actor, reason, explicitUserApproval: true, rolledBackAt: options.timestamp ?? new Date().toISOString() };
      const rollback = { ...body, rollbackHash: digest(body) }; await (options.writeRollbackReceipt ?? exclusiveJson)(location.rollback, rollback); return rollback;
    } catch (error) {
      try { await absent(destination, "Rollback recovery destination"); await rename(source, destination); }
      catch (recoveryError) { throw new AggregateError([error, recoveryError], "Rollback receipt failed and the moved state could not be restored; manual containment required."); }
      throw error;
    }
  });
}
