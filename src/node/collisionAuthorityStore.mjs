import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { withPlanLock } from "./planLock.mjs";

const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const hash = (value) => createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
const validDigest = (value) => /^[a-f0-9]{64}$/.test(value ?? "");

function target(root, planId, censusDigest) {
  const directory = path.join(path.resolve(root), "collision-authority", hash(`plan:${planId}`));
  return { directory, file: path.join(directory, `${censusDigest}.json`), lock: path.join(directory, `${censusDigest}.authority`) };
}

async function safeDirectory(directory) {
  await mkdir(directory, { recursive: true }); const stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Collision authority directory is not safe.");
}

async function atomicWrite(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try { await rename(temporary, file); } finally { await rm(temporary, { force: true }); }
}

function empty(planId, censusDigest) { return { schemaVersion: 1, planId, censusDigest, authority: "native-journal", authoritative: true, revision: 0, headHash: "GENESIS", approvedIds: [], ledger: [] }; }

function verify(state, planId, censusDigest) {
  if (state?.schemaVersion !== 1 || state.planId !== planId || state.censusDigest !== censusDigest || state.authority !== "native-journal" || state.authoritative !== true) throw new Error("Collision authority identity is invalid.");
  let previousHash = "GENESIS"; const recorded = new Set();
  for (const [index, entry] of state.ledger.entries()) {
    const { hash: stored, ...body } = entry;
    if (body.sequence !== index + 1 || body.previousHash !== previousHash || hash(body) !== stored) throw new Error(`Collision authority ledger is broken at ${index + 1}.`);
    if (entry.type === "collision.order-approved" && entry.payload?.censusDigest === censusDigest) recorded.add(entry.payload.collisionId);
    previousHash = stored;
  }
  if (state.revision !== state.ledger.length || state.headHash !== previousHash || state.approvedIds.some((id) => !recorded.has(id))) throw new Error("Collision authority summary does not match its ledger.");
  return state;
}

export async function inspectCollisionAuthority(root, { planId, censusDigest }, options = {}) {
  if (!String(planId ?? "").trim() || !validDigest(censusDigest)) throw new Error("Exact planId and censusDigest are required.");
  const location = target(root, planId, censusDigest); await safeDirectory(location.directory);
  try { const stat = await lstat(location.file); if (stat.isSymbolicLink() || !stat.isFile() || stat.size > (options.maxBytes ?? 1_000_000)) throw new Error("Collision authority record is not a bounded regular file."); return verify(JSON.parse(await readFile(location.file, "utf8")), planId, censusDigest); }
  catch (error) { if (error.code === "ENOENT") return empty(planId, censusDigest); throw error; }
}

export async function approveCollisionOrder(root, request, options = {}) {
  const { planId, censusDigest, expectedRevision, expectedHeadHash, collision } = request; const actor = String(options.actor ?? "").trim();
  if (!actor || !/^COL-\d{3,}$/.test(collision?.id ?? "") || !collision?.surface || !collision?.first?.planId || !collision?.then?.planId) throw new Error("Approval requires a named actor and complete collision order.");
  const location = target(root, planId, censusDigest); await safeDirectory(location.directory);
  return withPlanLock(location.lock, { actor, timeoutMs: options.timeoutMs ?? 5000, retryMs: 10 }, async () => {
    const state = await inspectCollisionAuthority(root, { planId, censusDigest });
    if (state.revision !== expectedRevision || state.headHash !== expectedHeadHash) throw new Error("Collision authority compare-and-swap failed; refresh required.");
    if (state.ledger.some((entry) => entry.type === "collision.assessment-committed")) throw new Error("Collision assessment is already committed and cannot accept later orders.");
    if (state.approvedIds.includes(collision.id)) throw new Error("Collision order is already approved.");
    const body = { sequence: state.revision + 1, timestamp: options.timestamp ?? new Date().toISOString(), actor, type: "collision.order-approved", payload: { collisionId: collision.id, censusDigest, surface: collision.surface, severity: collision.severity, first: `${collision.first.planId}/${collision.first.taskId}`, then: `${collision.then.planId}/${collision.then.taskId}`, contingency: collision.contingency }, previousHash: state.headHash };
    const entry = { ...body, hash: hash(body) }; const next = { ...state, revision: body.sequence, headHash: entry.hash, approvedIds: [...state.approvedIds, collision.id].sort(), ledger: [...state.ledger, entry] };
    await atomicWrite(location.file, next); return next;
  });
}

export async function commitCollisionAssessment(root, request, options = {}) {
  const { planId, censusDigest, expectedRevision, expectedHeadHash, assessment } = request; const actor = String(options.actor ?? "").trim();
  const collisionIds = [...new Set(assessment?.collisionIds ?? [])].sort();
  const manifestIds = [...new Set(assessment?.manifestIds ?? [])].sort();
  const surfaces = [...new Set(assessment?.surfaces ?? [])].sort();
  const claims = Number(assessment?.claims ?? 0);
  if (!actor || manifestIds.length === 0 || !Number.isSafeInteger(claims) || claims < 1 || surfaces.length !== claims || surfaces.some((surface) => !/^(read|write):[^\0]+$/.test(surface))) throw new Error("Commit requires a named actor, manifest identities, and every exact typed claim surface.");
  const location = target(root, planId, censusDigest); await safeDirectory(location.directory);
  return withPlanLock(location.lock, { actor, timeoutMs: options.timeoutMs ?? 5000, retryMs: 10 }, async () => {
    const state = await inspectCollisionAuthority(root, { planId, censusDigest });
    if (state.revision !== expectedRevision || state.headHash !== expectedHeadHash) throw new Error("Collision authority compare-and-swap failed; refresh required.");
    if (collisionIds.length !== state.approvedIds.length || collisionIds.some((id, index) => id !== state.approvedIds[index])) throw new Error("Assessment cannot commit until every exact census collision is approved.");
    if (state.ledger.some((entry) => entry.type === "collision.assessment-committed")) throw new Error("Collision assessment is already committed.");
    const body = { sequence: state.revision + 1, timestamp: options.timestamp ?? new Date().toISOString(), actor, type: "collision.assessment-committed", payload: { censusDigest, collisionIds, manifestIds, claims, surfaces }, previousHash: state.headHash };
    const entry = { ...body, hash: hash(body) }; const next = { ...state, revision: body.sequence, headHash: entry.hash, ledger: [...state.ledger, entry] };
    await atomicWrite(location.file, next); return next;
  });
}
