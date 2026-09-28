import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { freezeComponentPlans, verifyComponentPlans } from "../engine/componentPlanEngine.js";
import { assessComponentFolderScope } from "../engine/componentFolderScope.js";
import { withPlanLock } from "./planLock.mjs";
import { inspectArchitectureContracts, withCurrentArchitectureContract } from "./architectureContractStore.mjs";
import { inspectFolderContracts, withCurrentFolderContract } from "./folderContractStore.mjs";

const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const hash = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(canonical(value))).digest("hex");
const planKey = (planId) => hash(`perfect-planner-components:${planId}`);
const revisionName = (revision) => `${String(revision).padStart(8, "0")}.json`;
const MAX_REGISTRATION_BYTES = 4_000_000;
const MAX_REVISIONS = 1000;
function assertRegistrationIdentity(registration, id) {
  const contract = registration.contract;
  if (contract?.planId !== id || registration.registeredBy !== contract.approvedBy || registration.registeredAt !== contract.approvedAt || !String(contract.approvedBy ?? "").trim() || !Number.isFinite(Date.parse(contract.approvedAt))) throw new Error("Component registration contract identity or approval is invalid.");
}
function assertFolderScope(input, folder) {
  if (folder.planId !== input.planId || folder.architectureContractDigest !== input.architectureDigest || folder.architectureRevision !== input.architectureRevision || folder.digest !== input.folderDigest) throw new Error("Component folder parent does not match the exact architecture.");
  const assessment = assessComponentFolderScope(input, folder.nodes);
  if (!assessment.ready) throw new Error(assessment.blockers.join(" "));
}
function sameFile(left, right) { return right.isFile() && !right.isSymbolicLink() && right.nlink === 1 && left.ino === right.ino && left.dev === right.dev && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs; }
async function directorySnapshot(directory, allowMissing = false) {
  const names = []; let cursor = path.resolve(directory);
  for (;;) { names.unshift(cursor); const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent; }
  const snapshot = [];
  for (const name of names) {
    let info; try { info = await lstat(name); } catch (error) { if (allowMissing && error.code === "ENOENT") return null; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Component registry path is redirected or not a safe directory.");
    snapshot.push({ name, ino: info.ino, dev: info.dev });
  }
  if (path.relative(path.resolve(directory), await realpath(directory))) throw new Error("Component registry path is redirected.");
  return snapshot;
}
async function assertDirectories(snapshot) {
  for (const expected of snapshot) { const info = await lstat(expected.name); if (!info.isDirectory() || info.isSymbolicLink() || info.ino !== expected.ino || info.dev !== expected.dev) throw new Error("Component registry directory changed."); }
}
async function readRegistration(file, maxBytes, directories) {
  await assertDirectories(directories);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxBytes) throw new Error("Component registration is not a bounded regular file.");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!sameFile(info, await handle.stat())) throw new Error("Component registration changed before read.");
    // One extra byte detects growth without following an unbounded readFile.
    const bytes = Buffer.alloc(info.size + 1); let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, Math.min(64 * 1024, bytes.length - length), length);
      if (!result.bytesRead) break; length += result.bytesRead;
    }
    if (length !== info.size || !sameFile(info, await handle.stat()) || !sameFile(info, await lstat(file))) throw new Error("Component registration changed during read.");
    await assertDirectories(directories);
    return { registration: JSON.parse(bytes.subarray(0, length).toString("utf8")), file, info };
  } finally { await handle.close(); }
}
function target(root, planId) { const base = path.resolve(root); const directory = path.join(base, "component-catalogs", planKey(planId)); return { base, directory, lock: path.join(directory, "registry") }; }
async function safeDirectory(directory, create) { if (create) await mkdir(directory, { recursive: true }); try { const stat = await lstat(directory); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Component registry path is not a safe directory: ${directory}.`); return true; } catch (error) { if (!create && error.code === "ENOENT") return false; throw error; } }
async function safePath(location, create) {
  await directorySnapshot(location.directory, true); // Check existing ancestors before any mkdir.
  if (!await safeDirectory(location.base, create)) return false;
  if (!await safeDirectory(path.join(location.base, "component-catalogs"), create)) return false;
  if (!await safeDirectory(location.directory, create)) return false;
  await directorySnapshot(location.directory); return true;
}
async function exclusiveWrite(file, value, maxBytes) {
  const encoded = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(encoded) > maxBytes) throw new Error("Component publication exceeds its byte limit; prior history was kept.");
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, encoded, { flag: "wx", mode: 0o600 });
  try { await writeFile(file, encoded, { flag: "wx", mode: 0o600 }); }
  finally { await rm(temporary, { force: true }); }
}

export async function inspectComponentPlans(root, planId, options = {}) {
  const id = String(planId ?? "").trim(); if (!id) throw new Error("Component registry inspection requires planId.");
  const maxBytes = options.maxBytes ?? MAX_REGISTRATION_BYTES, maxRevisions = options.maxRevisions ?? MAX_REVISIONS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_REGISTRATION_BYTES || !Number.isSafeInteger(maxRevisions) || maxRevisions < 1 || maxRevisions > MAX_REVISIONS) throw new Error("Component inspection limits are invalid.");
  const location = target(root, id);
  if (!await safePath(location, false)) return { valid: true, planId: id, revision: 0, head: null, registrations: [] };
  const directories = await directorySnapshot(location.directory);
  const revisionNames = async () => (await readdir(location.directory)).filter(name => /^\d{8}\.json$/.test(name)).sort();
  const names = await revisionNames();
  if (names.length > maxRevisions) throw new Error("Component registry exceeds its revision limit.");
  const registrations = [], reads = []; let prior = null;
  for (const [index, name] of names.entries()) {
    const revision = index + 1;
    if (name !== revisionName(revision)) throw new Error(`Component revision sequence is broken at ${revision}.`);
    const read = await readRegistration(path.join(location.directory, name), maxBytes, directories); reads.push({ file: read.file, info: read.info });
    const registration = read.registration, { recordHash, ...body } = registration;
    if (registration.planId !== id || registration.revision !== revision || hash(body) !== recordHash) throw new Error(`Component registration ${revision} identity or hash is invalid.`);
    assertRegistrationIdentity(registration, id);
    const verification = await verifyComponentPlans(registration.contract);
    if (!verification.valid) throw new Error(`Component contract ${revision} failed verification: ${verification.reasons.join(" ")}`);
    if (registration.supersedes !== prior) throw new Error(`Component revision ${revision} does not supersede the exact prior digest.`);
    prior = registration.contract.digest;
    registrations.push({ revision, registeredAt: registration.registeredAt, registeredBy: registration.registeredBy, contractDigest: registration.contract.digest, catalogDigest: registration.contract.catalogDigest, architectureDigest: registration.contract.architectureDigest, architectureRevision: registration.contract.architectureRevision, folderDigest: registration.contract.folderDigest, folderRevision: registration.contract.folderRevision, componentCount: registration.contract.components.length, claimCount: registration.contract.components.reduce((sum, component) => sum + component.fileClaims.length, 0), supersedes: registration.supersedes, recordHash });
  }
  // Earlier records and the set of revisions must still match at the end of
  // verification; a later read cannot mask replacement of an earlier record.
  for (const read of reads) if (!sameFile(read.info, await lstat(read.file))) throw new Error("Component registration changed during history verification.");
  if (JSON.stringify(names) !== JSON.stringify(await revisionNames())) throw new Error("Component revision inventory changed during verification.");
  await assertDirectories(directories);
  return { valid: true, planId: id, revision: registrations.length, head: registrations.at(-1) ?? null, registrations };
}

export async function publishComponentPlans(root, input, request, options = {}) {
  input = structuredClone(input); request = structuredClone(request); options = { ...options };
  const actor = typeof options.actor === "string" ? options.actor.trim() : ""; if (!actor || input?.planId !== request?.planId) throw new Error("Component publication requires exact plan and actor.");
  if (!/^[a-f0-9]{64}$/.test(input.architectureDigest ?? "") || !/^[a-f0-9]{64}$/.test(input.folderDigest ?? "") || !Number.isSafeInteger(input.architectureRevision) || input.architectureRevision < 1 || !Number.isSafeInteger(input.folderRevision) || input.folderRevision < 1) throw new Error("Component publication requires exact architecture and folder parents.");
  return withCurrentArchitectureContract(root, input.planId, { revision: input.architectureRevision, contractDigest: input.architectureDigest }, () => withCurrentFolderContract(root, input.planId, { revision: input.folderRevision, contractDigest: input.folderDigest }, async folder => {
  assertFolderScope(input, folder);
  const location = target(root, input.planId); await safePath(location, true);
  const limits = { maxBytes: options.maxBytes ?? MAX_REGISTRATION_BYTES, maxRevisions: options.maxRevisions ?? MAX_REVISIONS };
  return withPlanLock(location.lock, { actor, timeoutMs: options.timeoutMs ?? 5000, retryMs: 10 }, async () => {
    const current = await inspectComponentPlans(root, input.planId, limits);
    if (current.revision !== request.expectedRevision || (current.head?.contractDigest ?? "GENESIS") !== request.expectedHeadDigest) throw new Error("Component registry compare-and-swap failed; refresh required.");
    if (current.revision >= limits.maxRevisions) throw new Error("Component publication exceeds its revision limit; prior history was kept.");
    const contract = await freezeComponentPlans(input, { planId: input.planId, actor, approvedAt: options.timestamp ?? new Date().toISOString() });
    if (current.registrations.some(item => item.catalogDigest === contract.catalogDigest)) throw new Error("Identical component catalog is already registered.");
    const body = { schemaVersion: 1, planId: input.planId, revision: current.revision + 1, registeredAt: contract.approvedAt, registeredBy: actor, supersedes: current.head?.contractDigest ?? null, contract };
    const registration = { ...body, recordHash: hash(body) };
    await exclusiveWrite(path.join(location.directory, revisionName(body.revision)), registration, limits.maxBytes);
    return { revision: body.revision, head: { revision: body.revision, registeredAt: body.registeredAt, registeredBy: actor, contractDigest: contract.digest, catalogDigest: contract.catalogDigest, architectureDigest: contract.architectureDigest, architectureRevision: contract.architectureRevision, folderDigest: contract.folderDigest, folderRevision: contract.folderRevision, supersedes: body.supersedes, componentCount: contract.components.length, claimCount: contract.components.reduce((sum, component) => sum + component.fileClaims.length, 0), recordHash: registration.recordHash } };
  });
  }, { actor, timeoutMs: options.timeoutMs }), { actor, timeoutMs: options.timeoutMs });
}

async function readVerifiedCatalogPayload(root, id, state) {
  if (!state.head) return null;
  const location = target(root, id), directories = await directorySnapshot(location.directory);
  const file = path.join(location.directory, revisionName(state.revision));
  const read = await readRegistration(file, MAX_REGISTRATION_BYTES, directories);
  const registration = read.registration, { recordHash, ...body } = registration;
  assertRegistrationIdentity(registration, id);
  if (registration.planId !== id || registration.revision !== state.revision || recordHash !== state.head.recordHash || hash(body) !== recordHash || registration.contract.digest !== state.head.contractDigest || !(await verifyComponentPlans(registration.contract)).valid) throw new Error("Stored component payload is invalid.");
  if (!sameFile(read.info, await lstat(file))) throw new Error("Stored component file changed during verification.");
  await assertDirectories(directories);
  return structuredClone(registration.contract);
}

// Read-only authoring material, never permission to publish or execute. Ready
// parents remain cooperatively locked through the catalog read. Missing parent
// observations are rechecked, not presented as an exclusive absence lease.
export async function inspectComponentAuthoringContext(root, planId, options = {}) {
  const id = typeof planId === "string" ? planId.trim() : "";
  if (!id || id.length > 128 || /[\u0000-\u001f]/.test(id)) throw new Error("Component authoring context requires a valid planId.");
  const actor = typeof options.actor === "string" && options.actor.trim() ? options.actor.trim() : "component-authoring-context";
  const lockOptions = { actor, timeoutMs: options.timeoutMs ?? 5000 };
  const initialArchitecture = await inspectArchitectureContracts(root, id);
  const catalogContext = async (state, architectureHead, folderHead, folderNodes) => {
    const location = target(root, id);
    const read = async (requireAbsent = false) => {
      const summary = await inspectComponentPlans(root, id);
      if (requireAbsent && summary.head) throw new Error("Component catalog appeared during context observation; refresh required.");
      const catalog = await readVerifiedCatalogPayload(root, id, summary);
      const matches = state === "ready" && catalog && catalog.architectureDigest === architectureHead.contractDigest && catalog.architectureRevision === architectureHead.revision && catalog.folderDigest === folderHead.contractDigest && catalog.folderRevision === folderHead.revision;
      return { schemaVersion: 1, planId: id, state, ready: state === "ready", architectureHead, folderHead, folderNodes: structuredClone(folderNodes), catalogHead: summary.head, catalog, catalogState: !catalog ? "missing" : matches ? "current" : "stale", publicationAuthorized: false, executionAuthorized: false };
    };
    // No records/parent directories are created merely to display an empty context.
    if (!await safePath(location, false)) return read(true);
    return withPlanLock(location.lock, { ...lockOptions, retryMs: 10 }, () => read());
  };
  if (!initialArchitecture.head) {
    const result = await catalogContext("architecture-missing", null, null, []);
    if ((await inspectArchitectureContracts(root, id)).head) throw new Error("Architecture appeared during context observation; refresh required.");
    return result;
  }
  return withCurrentArchitectureContract(root, id, { revision: initialArchitecture.head.revision, contractDigest: initialArchitecture.head.contractDigest }, async architectureHead => {
    const initialFolder = await inspectFolderContracts(root, id);
    if (!initialFolder.head) {
      const result = await catalogContext("folder-missing", architectureHead, null, []);
      if ((await inspectFolderContracts(root, id)).head) throw new Error("Folder appeared during context observation; refresh required.");
      return result;
    }
    return withCurrentFolderContract(root, id, { revision: initialFolder.head.revision, contractDigest: initialFolder.head.contractDigest }, async folder => {
      const parentMatches = folder.architectureContractDigest === architectureHead.contractDigest && folder.architectureRevision === architectureHead.revision;
      return catalogContext(parentMatches ? "ready" : "folder-stale", architectureHead, initialFolder.head, folder.nodes);
    }, lockOptions);
  }, lockOptions);
}

// Trusted runtime only: keep publication serialized through the consuming
// operation, not just through a metadata inspection followed by an unchecked read.
// This is historical catalog context only: parent heads are not leased/rechecked
// here, and this callback cannot be used as a live execution approval.
export async function withStoredComponentPlans(root, expected, operation) {
  expected = structuredClone(expected);
  if (!expected || typeof expected.planId !== "string" || !expected.planId.trim()
    || !Number.isSafeInteger(expected.catalogRevision) || expected.catalogRevision < 1
    || typeof expected.contractDigest !== "string" || !/^[a-f0-9]{64}$/.test(expected.contractDigest)
    || typeof operation !== "function") throw new Error("Stored component binding is invalid.");
  const location = target(root, expected.planId);
  if (!await safePath(location, false)) throw new Error("Stored component catalog is missing.");
  return withPlanLock(location.lock, { actor: "stored-worker-brief", timeoutMs: 5000, retryMs: 10 }, async () => {
    const state = await inspectComponentPlans(root, expected.planId);
    if (state.revision !== expected.catalogRevision || state.head?.contractDigest !== expected.contractDigest) throw new Error("Stored component catalog changed; refresh the assignment.");
    const file = path.join(location.directory, revisionName(state.revision));
    const directories = await directorySnapshot(location.directory);
    const read = await readRegistration(file, MAX_REGISTRATION_BYTES, directories);
    const registration = read.registration;
    assertRegistrationIdentity(registration, expected.planId);
    const { recordHash, ...body } = registration;
    if (recordHash !== state.head.recordHash || hash(body) !== recordHash || registration.planId !== expected.planId
      || registration.revision !== expected.catalogRevision || registration.contract?.digest !== expected.contractDigest
      || !(await verifyComponentPlans(registration.contract)).valid) throw new Error("Stored component payload is invalid.");
    if (!sameFile(read.info, await lstat(file))) throw new Error("Stored component file changed during verification.");
    await assertDirectories(directories);
    // This lock coordinates planner writers, not arbitrary processes editing files.
    return operation(registration.contract);
  });
}
