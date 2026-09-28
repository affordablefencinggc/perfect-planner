import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { materializationWave, verifyFolderContract } from "../engine/folderContractEngine.js";

const receiptHash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const relative = (value) => value.split(path.sep).join("/");

async function safeDirectory(target, allowCreate) {
  try { const stat = await lstat(target); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Structure target is not a safe directory: ${target}.`); return false; }
  catch (error) { if (error.code !== "ENOENT" || !allowCreate) throw error; await mkdir(target); const stat = await lstat(target); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Created structure target is not a safe directory: ${target}.`); return true; }
}

async function materializeDirectory(root, relativePath) {
  let current = root; let created = false;
  for (const segment of relativePath.split("/")) { current = path.join(current, segment); if (await safeDirectory(current, true)) created = true; }
  return created;
}

export async function materializeFolderContract(root, contract, stage, options = {}) {
  const actor = String(options.actor ?? "").trim(); if (!actor || actor !== contract?.approvedBy) throw new Error("Materialization requires the exact folder-contract approver.");
  if (!/^[a-f0-9]{64}$/.test(options?.architectureContractDigest ?? "") || !Number.isInteger(options?.architectureRevision) || options.architectureRevision < 1) throw new Error("Materialization requires the exact current architecture digest and revision.");
  if (contract?.architectureContractDigest !== options.architectureContractDigest || contract?.architectureRevision !== options.architectureRevision) throw new Error("Materialization architecture binding is stale or mismatched; refresh the exact architecture head.");
  const verification = await verifyFolderContract(contract); if (!verification.valid) throw new Error(`Folder contract verification failed: ${verification.reasons.join(" ")}`);
  const resolvedRoot = path.resolve(root); await safeDirectory(path.dirname(resolvedRoot), false); await safeDirectory(resolvedRoot, true);
  const input = { schemaVersion: 1, planId: contract.planId, architectureContractDigest: contract.architectureContractDigest, architectureRevision: contract.architectureRevision, workspaceMode: contract.workspaceMode, nodes: contract.nodes }; const wave = materializationWave(input, stage);
  const created = []; const existing = []; const deferredFiles = [];
  for (const node of wave) {
    const target = path.resolve(resolvedRoot, node.path); if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`Planned path escapes the workspace: ${node.path}.`);
    if (node.kind === "file") { deferredFiles.push(node.path); continue; }
    if (await materializeDirectory(resolvedRoot, node.path)) created.push(node.path); else existing.push(node.path);
  }
  const body = { schemaVersion: 1, planId: contract.planId, architectureContractDigest: contract.architectureContractDigest, architectureRevision: contract.architectureRevision, contractDigest: contract.digest, stage, actor, created, existing, deferredFiles, state: "MATERIALIZED" };
  return { ...body, receiptHash: receiptHash(body) };
}

export async function assessFolderContractContradictions(root, contract, options = {}) {
  const verification = await verifyFolderContract(contract); if (!verification.valid) throw new Error(`Folder contract verification failed: ${verification.reasons.join(" ")}`);
  const resolvedRoot = path.resolve(root); await safeDirectory(resolvedRoot, false); const allowed = new Set();
  for (const node of contract.nodes) { const parts = node.path.split("/"); for (let index = 1; index <= parts.length; index += 1) allowed.add(parts.slice(0, index).join("/")); }
  const contradictions = []; let visited = 0; const maxEntries = Number(options.maxEntries ?? 10_000);
  const walk = async (directory, prefix = "") => { for (const entry of await readdir(directory, { withFileTypes: true })) { if (++visited > maxEntries) throw new Error("Folder contradiction census exceeded its entry ceiling."); const item = prefix ? `${prefix}/${entry.name}` : entry.name; if (!allowed.has(item)) { contradictions.push({ path: item, kind: entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" }); continue; } if (entry.isSymbolicLink()) contradictions.push({ path: item, kind: "link", reason: "planned path is a link" }); else if (entry.isDirectory()) await walk(path.join(directory, entry.name), item); } };
  await walk(resolvedRoot); contradictions.sort((a, b) => a.path.localeCompare(b.path)); const body = { schemaVersion: 1, planId: contract.planId, contractDigest: contract.digest, root: resolvedRoot, contradictions, visited };
  return { ...body, state: contradictions.length ? "QUARANTINE_REQUIRED" : "CLEAR", assessmentHash: receiptHash(body) };
}

export async function quarantineFolderContractContradictions(root, contract, assessment, input, options = {}) {
  const operator = String(input?.operator ?? "").trim(); const reason = String(input?.reason ?? "").trim(); const approvalId = String(input?.approvalId ?? "").trim(); if (!operator || !reason || !approvalId || input?.collisionClear !== true) throw new Error("Quarantine requires a named operator, reason, approval id, and current collision clearance.");
  const current = await assessFolderContractContradictions(root, contract, options); if (current.assessmentHash !== assessment?.assessmentHash || current.state !== "QUARANTINE_REQUIRED") throw new Error("Quarantine requires the exact current contradiction assessment.");
  if (current.contradictions.some((item) => item.kind === "link" || item.kind === "other")) throw new Error("Link or special-object contradictions require manual containment and cannot be moved automatically.");
  const quarantineRoot = path.resolve(input?.quarantineRoot ?? ""); const resolvedRoot = path.resolve(root); if (!input?.quarantineRoot || quarantineRoot === resolvedRoot || quarantineRoot.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("Quarantine root must be an explicit location outside the workspace.");
  const batchId = randomUUID(); const batchRoot = path.join(quarantineRoot, contract.planId, batchId); const moved = [];
  for (const item of current.contradictions) { const source = path.resolve(resolvedRoot, item.path); const destination = path.resolve(batchRoot, item.path); if (!source.startsWith(`${resolvedRoot}${path.sep}`) || !destination.startsWith(`${batchRoot}${path.sep}`)) throw new Error("Quarantine path escaped its approved root."); await mkdir(path.dirname(destination), { recursive: true }); await rename(source, destination); moved.push({ path: relative(item.path), quarantinedPath: destination, kind: item.kind }); }
  const body = { schemaVersion: 1, state: "QUARANTINED", planId: contract.planId, contractDigest: contract.digest, assessmentHash: current.assessmentHash, operator, reason, approvalId, collisionClear: true, moved, quarantinedAt: options.timestamp ?? new Date().toISOString() };
  return { ...body, receiptHash: receiptHash(body) };
}

export async function restoreFolderContractQuarantine(root, receipt, input, options = {}) {
  const operator = String(input?.operator ?? "").trim(); const reason = String(input?.reason ?? "").trim(); if (!operator || !reason || receipt?.state !== "QUARANTINED" || receiptHash(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "receiptHash"))) !== receipt.receiptHash) throw new Error("Restoration requires a named operator, reason, and authentic quarantine receipt.");
  const resolvedRoot = path.resolve(root); const restored = [];
  for (const item of [...receipt.moved].reverse()) { const destination = path.resolve(resolvedRoot, item.path); if (!destination.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("Restoration path escaped its workspace."); try { await lstat(destination); throw new Error(`Restoration destination is occupied: ${item.path}.`); } catch (error) { if (error.code !== "ENOENT") throw error; } await mkdir(path.dirname(destination), { recursive: true }); await rename(item.quarantinedPath, destination); restored.push(item.path); }
  const body = { schemaVersion: 1, state: "RESTORED", planId: receipt.planId, quarantineReceiptHash: receipt.receiptHash, operator, reason, restored, restoredAt: options.timestamp ?? new Date().toISOString() }; return { ...body, receiptHash: receiptHash(body) };
}
