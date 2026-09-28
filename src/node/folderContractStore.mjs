import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { freezeFolderContract, verifyFolderContract } from "../engine/folderContractEngine.js";
import { withPlanLock } from "./planLock.mjs";
import { withCurrentArchitectureContract } from "./architectureContractStore.mjs";

const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const hash = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(canonical(value))).digest("hex");
const planKey = (planId) => hash(`perfect-planner-folders:${planId}`); const revisionName = (revision) => `${String(revision).padStart(8, "0")}.json`;
function target(root, planId) { const base = path.resolve(root); const directory = path.join(base, "folder-contracts", planKey(planId)); return { base, directory, lock: path.join(directory, "registry") }; }
function assertRegistrationIdentity(registration, id) {
  const contract = registration.contract;
  if (contract?.planId !== id || registration.registeredBy !== contract.approvedBy || registration.registeredAt !== contract.approvedAt || typeof contract.approvedBy !== "string" || !contract.approvedBy.trim() || typeof contract.approvedAt !== "string" || !Number.isFinite(Date.parse(contract.approvedAt)) || new Date(contract.approvedAt).toISOString() !== contract.approvedAt) throw new Error("Folder registration contract identity or approval is invalid.");
}
async function captureDirectories(directory) {
  const entries = []; let cursor = directory;
  for (;;) { const info = await lstat(cursor); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Folder registry path is redirected."); entries.push({ path: cursor, ino: info.ino, dev: info.dev }); const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent; }
  return async () => { for (const entry of entries) { const info = await lstat(entry.path); if (!info.isDirectory() || info.isSymbolicLink() || info.ino !== entry.ino || info.dev !== entry.dev) throw new Error("Folder registry directory changed."); } };
}
async function readBoundedRegistration(file, limit) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) throw new Error("Folder registration is not a bounded regular file.");
  const same = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size && stat.mtimeMs === before.mtimeMs && stat.ctimeMs === before.ctimeMs;
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!same(await handle.stat())) throw new Error("Folder registration changed before read.");
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) { const result = await handle.read(bytes, length, Math.min(65536, bytes.length - length), length); if (!result.bytesRead) break; length += result.bytesRead; }
    if (length !== before.size || !same(await handle.stat()) || !same(await lstat(file))) throw new Error("Folder registration changed during read.");
    return { registration: JSON.parse(bytes.subarray(0, length).toString("utf8")), verify: async () => { if (!same(await lstat(file))) throw new Error("Folder registration changed during history verification."); } };
  } finally { await handle.close(); }
}
async function safeDirectory(directory, create) { if (create) await mkdir(directory, { recursive: true }); try { const stat = await lstat(directory); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Folder registry path is not a safe directory: ${directory}.`); return true; } catch (error) { if (!create && error.code === "ENOENT") return false; throw error; } }
async function safePath(location, create) { if (!await safeDirectory(location.base, create)) return false; if (!await safeDirectory(path.join(location.base, "folder-contracts"), create)) return false; return safeDirectory(location.directory, create); }
async function exclusiveWrite(file, value) { const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); try { await writeFile(file, await readFile(temporary), { flag: "wx", mode: 0o600 }); } finally { await rm(temporary, { force: true }); } }

export async function inspectFolderContracts(root, planId, options = {}) {
  if (!Number.isSafeInteger(options.maxBytes ?? 1_000_000) || (options.maxBytes ?? 1_000_000) < 1 || (options.maxBytes ?? 1_000_000) > 1_000_000 || !Number.isSafeInteger(options.maxRevisions ?? 1000) || (options.maxRevisions ?? 1000) < 1 || (options.maxRevisions ?? 1000) > 1000) throw new Error("Folder inspection limits are invalid.");
  const id = String(planId ?? "").trim(); if (!id) throw new Error("Folder registry inspection requires planId."); const location = target(root, id); if (!await safePath(location, false)) return { valid: true, planId: id, revision: 0, head: null, registrations: [] };
  const verifyDirectories = await captureDirectories(location.directory);
  const names = (await readdir(location.directory)).filter((name) => /^\d{8}\.json$/.test(name)).sort(); if (names.length > (options.maxRevisions ?? 1000)) throw new Error("Folder registry exceeds its revision limit."); const registrations = [], reads = []; let prior = null;
  for (let index = 0; index < names.length; index += 1) { const revision = index + 1; if (names[index] !== revisionName(revision)) throw new Error(`Folder revision sequence is broken at ${revision}.`); const file = path.join(location.directory, names[index]); await verifyDirectories(); const read = await readBoundedRegistration(file, Math.min(options.maxBytes ?? 1_000_000, 1_000_000)); reads.push(read); const registration = read.registration; const { recordHash, ...body } = registration; if (registration.planId !== id || registration.revision !== revision || hash(body) !== recordHash) throw new Error(`Folder registration ${revision} identity or hash is invalid.`); assertRegistrationIdentity(registration, id); const verification = await verifyFolderContract(registration.contract); if (!verification.valid) throw new Error(`Folder contract ${revision} failed verification: ${verification.reasons.join(" ")}`); if (registration.supersedes !== prior) throw new Error(`Folder revision ${revision} does not supersede the exact prior digest.`); prior = registration.contract.digest; registrations.push({ revision, registeredAt: registration.registeredAt, registeredBy: registration.registeredBy, contractDigest: registration.contract.digest, structureDigest: registration.contract.structureDigest, architectureContractDigest: registration.contract.architectureContractDigest, architectureRevision: registration.contract.architectureRevision, supersedes: registration.supersedes, nodeCount: registration.contract.nodes.length, recordHash }); }
  for (const read of reads) await read.verify();
  await verifyDirectories();
  const finalNames = (await readdir(location.directory)).filter(name => /^\d{8}\.json$/.test(name)).sort();
  if (JSON.stringify(names) !== JSON.stringify(finalNames)) throw new Error("Folder revision inventory changed during verification.");
  return { valid: true, planId: id, revision: registrations.length, head: registrations.at(-1) ?? null, registrations };
}

export async function publishFolderContract(root, input, request, options = {}) {
  input = structuredClone(input); request = structuredClone(request); options = { ...options };
  const actor = typeof options.actor === "string" ? options.actor.trim() : ""; if (!actor || input?.planId !== request?.planId) throw new Error("Folder publication requires exact plan and actor.");
  const timestamp = options.timestamp ?? new Date().toISOString();
  if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) throw new Error("Folder publication requires a canonical approval timestamp.");
  options.timestamp = timestamp;
  if (!/^[a-f0-9]{64}$/.test(request?.architectureContractDigest ?? "") || !Number.isInteger(request?.architectureRevision) || request.architectureRevision < 1) throw new Error("Folder publication requires the exact current architecture digest and revision.");
  if (input?.architectureContractDigest !== request.architectureContractDigest || input?.architectureRevision !== request.architectureRevision) throw new Error("Folder publication architecture binding is stale or mismatched; refresh the exact architecture head.");
  return withCurrentArchitectureContract(root, input.planId, { revision: request.architectureRevision, contractDigest: request.architectureContractDigest }, async () => {
  const location = target(root, input.planId); await safePath(location, true);
  return withPlanLock(location.lock, { actor, timeoutMs: options.timeoutMs ?? 5000, retryMs: 10 }, async () => { const current = await inspectFolderContracts(root, input.planId); if (current.revision !== request.expectedRevision || (current.head?.contractDigest ?? "GENESIS") !== request.expectedHeadDigest) throw new Error("Folder registry compare-and-swap failed; refresh required."); const contract = await freezeFolderContract(input, { planId: input.planId, actor, approvedAt: options.timestamp ?? new Date().toISOString(), architectureContractDigest: request.architectureContractDigest, architectureRevision: request.architectureRevision }); if (current.registrations.some((item) => item.structureDigest === contract.structureDigest)) throw new Error("Identical folder structure is already registered."); const body = { schemaVersion: 1, planId: input.planId, revision: current.revision + 1, registeredAt: contract.approvedAt, registeredBy: actor, supersedes: current.head?.contractDigest ?? null, contract }; const registration = { ...body, recordHash: hash(body) }; await exclusiveWrite(path.join(location.directory, revisionName(body.revision)), registration); return { revision: body.revision, head: { revision: body.revision, registeredAt: body.registeredAt, registeredBy: actor, contractDigest: contract.digest, structureDigest: contract.structureDigest, architectureContractDigest: contract.architectureContractDigest, architectureRevision: contract.architectureRevision, supersedes: body.supersedes, nodeCount: contract.nodes.length, recordHash: registration.recordHash } }; });
  }, { actor, timeoutMs: options.timeoutMs });
}

// Caller acquiring architecture authority must do so before this folder lock.
// The callback receives a verified payload, not merely renderer-supplied node IDs.
export async function withCurrentFolderContract(root, planId, expected, operation, options = {}) {
  expected = structuredClone(expected);
  const id = String(planId ?? "").trim();
  if (!id || !Number.isSafeInteger(expected?.revision) || expected.revision < 1 || !/^[a-f0-9]{64}$/.test(expected.contractDigest ?? "") || typeof operation !== "function") throw new Error("Current folder binding is invalid.");
  const location = target(root, id);
  const assertAncestors = async () => {
    let cursor = location.directory;
    for (;;) { const stat = await lstat(cursor); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Folder registry path is redirected."); const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent; }
  };
  if (!await safePath(location, false)) throw new Error("Current folder head is unavailable.");
  await assertAncestors();
  return withPlanLock(location.lock, { actor: options.actor ?? "component-publication", timeoutMs: options.timeoutMs ?? 5000, retryMs: 10 }, async () => {
    const current = await inspectFolderContracts(root, id);
    if (current.revision !== expected.revision || current.head?.contractDigest !== expected.contractDigest) throw new Error("Current folder head is stale.");
    const file = path.join(location.directory, revisionName(expected.revision));
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 1_000_000) throw new Error("Folder payload is not a bounded regular file.");
    const same = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size && stat.mtimeMs === before.mtimeMs && stat.ctimeMs === before.ctimeMs;
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let registration;
    try {
      if (!same(await handle.stat())) throw new Error("Folder payload changed before reading.");
      const bytes = Buffer.alloc(before.size + 1); let length = 0;
      while (length < bytes.length) { const result = await handle.read(bytes, length, Math.min(65536, bytes.length - length), length); if (!result.bytesRead) break; length += result.bytesRead; }
      if (length !== before.size || !same(await handle.stat()) || !same(await lstat(file))) throw new Error("Folder payload changed while reading.");
      registration = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    } finally { await handle.close(); }
    const { recordHash, ...body } = registration;
    const contract = registration.contract;
    if (hash(body) !== recordHash || recordHash !== current.head.recordHash || registration.planId !== id || contract?.planId !== id || registration.revision !== expected.revision || contract.digest !== expected.contractDigest || registration.registeredBy !== contract.approvedBy || registration.registeredAt !== contract.approvedAt || typeof contract.approvedBy !== "string" || !contract.approvedBy.trim() || typeof contract.approvedAt !== "string" || !Number.isFinite(Date.parse(contract.approvedAt)) || new Date(contract.approvedAt).toISOString() !== contract.approvedAt || !(await verifyFolderContract(contract)).valid) throw new Error("Stored folder payload identity or approval is invalid.");
    await assertAncestors();
    if (!same(await lstat(file))) throw new Error("Folder payload changed during verification.");
    return operation(structuredClone(contract));
  });
}
