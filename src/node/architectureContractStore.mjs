import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { verifyArchitectureContract } from "../engine/architectureContractVerification.js";
import { withPlanLock } from "./planLock.mjs";
import { freezeArchitectureContract } from "../engine/rulebookEngine.js";
import { isSameOriginLoopbackRequest } from "./loopbackRequestHttp.mjs";

async function verifyRulebookSemantics(contract) {
  const rebuilt = await freezeArchitectureContract(contract.input, { planId: contract.planId, actor: contract.actor, approvedAt: contract.approvedAt });
  if (rebuilt.digest !== contract.digest || JSON.stringify(canonical(rebuilt)) !== JSON.stringify(canonical(contract))) throw new Error("Architecture contract does not match the current rulebook-derived assessment.");
}

const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const recordHash = (value) => hash(JSON.stringify(canonical(value)));
const planKey = (planId) => hash(`perfect-planner-architecture:${planId}`);
const revisionName = (revision) => `${String(revision).padStart(8, "0")}.json`;

function locations(root, planId) {
  const resolvedRoot = path.resolve(root); const directory = path.join(resolvedRoot, "contracts", planKey(planId));
  return { root: resolvedRoot, directory, lock: path.join(directory, "registry") };
}

async function assertDirectory(directory, create) {
  if (create) await mkdir(directory, { recursive: true });
  let stat; try { stat = await lstat(directory); } catch (error) { if (!create && error.code === "ENOENT") return false; throw error; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Architecture registry directory is not a safe regular directory: ${directory}.`);
  return true;
}

async function assertStorePath(target, create) {
  if (!await assertDirectory(target.root, create)) return false;
  const contracts = path.join(target.root, "contracts"); if (!await assertDirectory(contracts, create)) return false;
  return assertDirectory(target.directory, create);
}

async function atomicExclusive(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try { await writeFile(filePath, await readFile(temporary), { flag: "wx", mode: 0o600 }); }
  finally { await rm(temporary, { force: true }); }
}

function validateRegistrationShape(registration, expectedPlanId, expectedRevision) {
  if (registration?.schemaVersion !== 1) throw new Error("Unsupported architecture registration schema.");
  if (registration.planId !== expectedPlanId || registration.revision !== expectedRevision) throw new Error("Architecture registration identity or revision is invalid.");
  if (!registration.registeredBy || !Number.isFinite(Date.parse(registration.registeredAt))) throw new Error("Architecture registration requires a named actor and valid time.");
  if (registration.contractDigest !== registration.contract?.digest) throw new Error("Architecture registration digest does not match its contract.");
  const { hash: storedHash, ...body } = registration;
  if (!/^[a-f0-9]{64}$/.test(storedHash ?? "") || recordHash(body) !== storedHash) throw new Error("Architecture registration record hash is invalid.");
}

export async function inspectArchitectureContracts(root, planId, options = {}) {
  const id = String(planId ?? "").trim(); if (!id) throw new Error("Architecture registry inspection requires a plan identity.");
  const target = locations(root, id); if (!await assertStorePath(target, false)) return { valid: true, planId: id, count: 0, head: null, registrations: [] };
  const { directory } = target; const names = await readdir(directory);
  const candidates = names.filter((name) => /^\d{8}\.json$/.test(name)).sort();
  if (candidates.length > Number(options.maxRevisions ?? 1000)) throw new Error("Architecture registry exceeds its bounded revision limit.");
  const registrations = []; let previousDigest = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const revision = index + 1; const expectedName = revisionName(revision);
    if (candidates[index] !== expectedName) throw new Error(`Architecture revision sequence is broken at ${revision}.`);
    const filePath = path.join(directory, candidates[index]); const stat = await lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Architecture registration ${candidates[index]} is not a regular file.`);
    if (stat.size > Number(options.maxContractBytes ?? 1_000_000)) throw new Error(`Architecture registration ${candidates[index]} exceeds its byte limit.`);
    const registration = JSON.parse(await readFile(filePath, "utf8")); validateRegistrationShape(registration, id, revision);
    const verification = await verifyArchitectureContract(registration.contract);
    if (!verification.valid) throw new Error(`Architecture contract revision ${revision} failed verification: ${verification.reasons.join(" ")}`);
    await verifyRulebookSemantics(registration.contract);
    if (revision === 1 && registration.supersedes !== null) throw new Error("The first architecture revision cannot supersede another contract.");
    if (revision > 1 && registration.supersedes !== previousDigest) throw new Error(`Architecture revision ${revision} does not supersede the exact prior digest.`);
    previousDigest = registration.contractDigest;
    registrations.push({ revision, registeredAt: registration.registeredAt, registeredBy: registration.registeredBy, contractDigest: registration.contractDigest, supersedes: registration.supersedes, policyVersion: registration.contract.policyVersion, template: registration.contract.template, stages: registration.contract.executionMap.nodes.length, recordHash: registration.hash });
  }
  return { valid: true, planId: id, count: registrations.length, head: registrations.at(-1) ?? null, registrations };
}

export async function publishArchitectureContract(root, contract, options = {}) {
  contract = structuredClone(contract); options = { ...options };
  const planId = String(contract?.planId ?? "").trim(); const actor = String(options.actor ?? "").trim(); const registeredAt = options.timestamp ?? new Date().toISOString();
  if (!planId || !actor || actor !== contract?.actor) throw new Error("Architecture publication requires the exact plan approver identity.");
  if (!Number.isFinite(Date.parse(registeredAt))) throw new Error("Architecture publication requires a valid registration time.");
  const verification = await verifyArchitectureContract(contract); if (!verification.valid) throw new Error(`Architecture publication refused: ${verification.reasons.join(" ")}`);
  await verifyRulebookSemantics(contract);
  const target = locations(root, planId); await assertStorePath(target, true);
  return withPlanLock(target.lock, { actor, timeoutMs: options.timeoutMs ?? 5000, retryMs: options.retryMs ?? 10 }, async () => {
    const current = await inspectArchitectureContracts(root, planId, options); const revision = current.count + 1; const expectedSupersedes = current.head?.contractDigest ?? null;
    if ((options.supersedes ?? null) !== expectedSupersedes) throw new Error(`Architecture publication must supersede the exact current digest ${expectedSupersedes ?? "GENESIS"}.`);
    if (current.registrations.some((item) => item.contractDigest === contract.digest)) throw new Error("Architecture contract is already registered; duplicate publication refused.");
    const body = { schemaVersion: 1, planId, revision, registeredAt, registeredBy: actor, contractDigest: contract.digest, supersedes: expectedSupersedes, contract };
    const registration = { ...body, hash: recordHash(body) }; const filePath = path.join(target.directory, revisionName(revision));
    await atomicExclusive(filePath, registration);
    return { revision, planId, contractDigest: contract.digest, supersedes: expectedSupersedes, registeredAt, registeredBy: actor, recordHash: registration.hash };
  });
}

// Cooperative lock order for downstream publication: architecture -> folder.
// The callback must not publish architecture or reenter this lock. This pins
// the current registry head against cooperating publishers, not hostile edits.
export async function withCurrentArchitectureContract(root, planId, expected, operation, options = {}) {
  expected = structuredClone(expected);
  const id = String(planId ?? "").trim(), actor = String(options.actor ?? "").trim();
  if (!id || !actor || !expected || Object.keys(expected).sort().join("|") !== "contractDigest|revision" || !Number.isInteger(expected.revision) || expected.revision < 1 || !/^[a-f0-9]{64}$/.test(expected.contractDigest ?? "") || typeof operation !== "function") throw new Error("Architecture head binding is invalid.");
  const location = locations(root, id);
  if (!await assertStorePath(location, false)) throw new Error("Current architecture head is unavailable; publish architecture first.");
  return withPlanLock(location.lock, { actor, timeoutMs: options.timeoutMs ?? 5000, retryMs: 10 }, async () => {
    const state = await inspectArchitectureContracts(root, id);
    if (!state.head || state.head.revision !== expected.revision || state.head.contractDigest !== expected.contractDigest) throw new Error("Current architecture head is stale or mismatched; refresh required.");
    return operation(Object.freeze({ ...state.head }));
  });
}

export async function readArchitectureContract(root, planId, revision) {
  if (!Number.isInteger(revision) || revision < 1) throw new Error("Architecture contract reads require a positive revision.");
  const state = await inspectArchitectureContracts(root, planId); if (revision > state.count) throw new Error(`Architecture revision ${revision} does not exist.`);
  const registration = JSON.parse(await readFile(path.join(locations(root, planId).directory, revisionName(revision)), "utf8"));
  return { contract: registration.contract, registration: state.registrations[revision - 1] };
}

export async function createArchitectureContractArchive(root, planId, archivePath, options = {}) {
  const actor = String(options.actor ?? "").trim(); if (!actor) throw new Error("Architecture archive requires a named actor.");
  const state = await inspectArchitectureContracts(root, planId, options); if (!state.count) throw new Error("Architecture archive requires a non-empty verified chain.");
  const registrations = [];
  for (let revision = 1; revision <= state.count; revision += 1) registrations.push(JSON.parse(await readFile(path.join(locations(root, planId).directory, revisionName(revision)), "utf8")));
  const body = { schemaVersion: 1, kind: "perfect-planner-architecture-chain-archive", planId: state.planId, archivedAt: options.timestamp ?? new Date().toISOString(), archivedBy: actor, revisionCount: state.count, headDigest: state.head.contractDigest, headRecordHash: state.head.recordHash, registrations };
  const archive = { ...body, archiveHash: recordHash(body) }; const resolved = path.resolve(archivePath); await mkdir(path.dirname(resolved), { recursive: true });
  const handle = await open(resolved, "wx", 0o600); try { await handle.writeFile(`${JSON.stringify(archive, null, 2)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
  return { schemaVersion: 1, planId: state.planId, revisionCount: state.count, headDigest: state.head.contractDigest, archiveHash: archive.archiveHash, archivePath: resolved };
}

export async function verifyArchitectureContractArchive(archivePath, options = {}) {
  const resolved = path.resolve(archivePath); const stat = await lstat(resolved); if (stat.isSymbolicLink() || !stat.isFile() || stat.size > Number(options.maxArchiveBytes ?? 16_000_000)) throw new Error("Architecture archive is not a bounded regular file.");
  const archive = JSON.parse(await readFile(resolved, "utf8")); const { archiveHash, ...body } = archive;
  if (body.schemaVersion !== 1 || body.kind !== "perfect-planner-architecture-chain-archive" || recordHash(body) !== archiveHash || !Array.isArray(body.registrations) || body.registrations.length !== body.revisionCount) throw new Error("Architecture archive envelope is invalid or tampered.");
  let previousDigest = null;
  for (let index = 0; index < body.registrations.length; index += 1) { const registration = body.registrations[index]; validateRegistrationShape(registration, body.planId, index + 1); const verification = await verifyArchitectureContract(registration.contract); if (!verification.valid) throw new Error(`Architecture archive contract ${index + 1} is invalid.`); if (registration.supersedes !== previousDigest) throw new Error(`Architecture archive chain is broken at revision ${index + 1}.`); previousDigest = registration.contractDigest; }
  const head = body.registrations.at(-1); if (head.contractDigest !== body.headDigest || head.hash !== body.headRecordHash) throw new Error("Architecture archive head binding is invalid.");
  return { valid: true, planId: body.planId, revisionCount: body.revisionCount, headDigest: body.headDigest, archiveHash };
}

const httpJson = (res, status, value) => { res.statusCode = status; res.setHeader("content-type", "application/json; charset=utf-8"); res.setHeader("cache-control", "no-store"); res.setHeader("x-content-type-options", "nosniff"); res.end(JSON.stringify(value)); };
const sameOrigin = isSameOriginLoopbackRequest;
const sameToken = (provided, expected) => { const left = Buffer.from(provided ?? ""); const right = Buffer.from(expected); return left.length === right.length && timingSafeEqual(left, right); };
async function readHttpBody(req, limit = 1_100_000) { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error("Architecture request exceeds its byte limit."); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString("utf8")); }

export function createArchitectureContractMiddleware({ root, actor = "local-user", token = randomBytes(32).toString("hex") }) {
  return async (req, res, next = () => httpJson(res, 404, { error: "Not found." })) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    if (!url.pathname.startsWith("/api/architecture-contract/")) return next();
    if (!sameOrigin(req)) return httpJson(res, 403, { error: "Exact same-origin request required." });
    if (url.pathname === "/api/architecture-contract/session" && ["GET", "POST"].includes(req.method)) {
      if (req.method === "POST") { try { if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw Error(); const body = await readHttpBody(req, 1024); if (!body || Array.isArray(body) || typeof body !== "object" || Object.keys(body).length) throw Error(); } catch { return httpJson(res, 400, { error: "Empty JSON session request required." }); } }
      return httpJson(res, 200, { schemaVersion: 1, token, actor });
    }
    if (req.method !== "POST" || !String(req.headers["content-type"] ?? "").startsWith("application/json")) return httpJson(res, 415, { error: "JSON POST required." });
    if (!sameToken(req.headers["x-pp-architecture-token"], token)) return httpJson(res, 403, { error: "Architecture publication capability refused." });
    try {
      const request = await readHttpBody(req); let result;
      if (url.pathname.endsWith("/inspect")) result = await inspectArchitectureContracts(root, request.planId);
      else if (url.pathname.endsWith("/read")) result = await readArchitectureContract(root, request.planId, request.revision);
      else if (url.pathname.endsWith("/publish")) result = await publishArchitectureContract(root, request.contract, { actor, timestamp: request.timestamp, supersedes: request.supersedes ?? null });
      else return httpJson(res, 404, { error: "Unknown architecture operation." });
      return httpJson(res, 200, result);
    } catch (error) { return httpJson(res, /supersede|already registered/.test(error.message) ? 409 : 400, { error: error.message }); }
  };
}
