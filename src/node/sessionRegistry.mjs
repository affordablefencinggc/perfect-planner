import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { withPlanLock } from "./planLock.mjs";
import { storeOpaqueSecret, useOpaqueSecret } from "./windowsDpapiSecretCustody.mjs";

const ACTIVE_MS = 10 * 60 * 1000;
const GONE_MS = 24 * 60 * 60 * 1000;
const secretDigest = (value) => createHash("sha256").update(value).digest("hex");
const redactSession = ({ token, tokenDigest, ...session }) => session;

async function ownsSession(session, credentials, options) {
  if (typeof credentials?.actor !== "string" || credentials.actor !== session.actor) return false;
  if (session.tokenDigest) {
    if (session.custodyMode === "legacy-ephemeral-token") return typeof credentials?.token === "string" && secretDigest(credentials.token) === session.tokenDigest;
    const custody = options?.secretCustody; if (!credentials?.tokenHandle || !custody?.root || !custody?.dpapi) return false;
    try { return await useOpaqueSecret(custody.root, credentials.tokenHandle, { ownerId: session.actor, purpose: `session-token:${session.id}`, dpapi: custody.dpapi }, (secret) => secretDigest(secret) === session.tokenDigest); } catch { return false; }
  }
  return typeof session.token === "string" && session.token.length > 0
    && typeof credentials?.token === "string" && session.token === credentials.token;
}

function timestampValue(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : NaN;
}

function requireTimestamp(value) {
  if (!Number.isFinite(timestampValue(value))) throw new Error("Session timestamp is invalid.");
}

function normalizeRegistry(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.sessions)) throw new Error("Session registry is malformed.");
  const ids = new Set();
  for (const session of value.sessions) {
    if (!session || typeof session.id !== "string" || !session.id || ids.has(session.id)
      || typeof session.actor !== "string" || !session.actor || typeof session.claim !== "string" || !session.claim) throw new Error("Session registry is malformed.");
    ids.add(session.id);
    requireTimestamp(session.createdAt);
    requireTimestamp(session.heartbeat);
    if (timestampValue(session.heartbeat) < timestampValue(session.createdAt)) throw new Error("Session registry time moves backwards.");
    if (session.releasedAt !== null) {
      requireTimestamp(session.releasedAt);
      if (timestampValue(session.releasedAt) < timestampValue(session.heartbeat)) throw new Error("Session registry time moves backwards.");
    }
  }
  return value;
}

export function classifyHeartbeat(heartbeat, now = Date.now()) {
  const age = typeof now === "number" && Number.isFinite(now) ? now - timestampValue(heartbeat) : NaN;
  if (!Number.isFinite(age) || age < 0) return "invalid";
  if (age <= ACTIVE_MS) return "active";
  if (age <= GONE_MS) return "stale";
  return "gone";
}

export async function readSessionRegistry(registryPath) {
  try { return normalizeRegistry(JSON.parse(await readFile(registryPath, "utf8"))); }
  catch (error) {
    if (error.code === "ENOENT") return { schemaVersion: 1, sessions: [] };
    throw error;
  }
}

async function atomicWrite(registryPath, registry) {
  await mkdir(path.dirname(path.resolve(registryPath)), { recursive: true });
  const temporary = `${registryPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, registryPath);
}

async function mutateRegistry(registryPath, actor, operation) {
  await mkdir(path.dirname(path.resolve(registryPath)), { recursive: true });
  return withPlanLock(registryPath, { actor, timeoutMs: 5000, retryMs: 10 }, async () => {
    const registry = await readSessionRegistry(registryPath);
    const result = await operation(registry);
    await atomicWrite(registryPath, registry);
    return result;
  });
}

export async function createSession(registryPath, input, options = {}) {
  const actor = String(input?.actor ?? "").trim();
  const claim = String(input?.claim ?? "").trim();
  if (!actor || !claim) throw new Error("A session requires a non-empty actor and claim.");
  const timestamp = options.timestamp ?? new Date().toISOString();
  requireTimestamp(timestamp);
  const id = randomUUID(); let token = randomUUID(); let tokenHandle = null; let tokenDigest = secretDigest(token); let custodyMode = "legacy-ephemeral-token";
  if (options.secretCustody) { const stored = await storeOpaqueSecret(options.secretCustody.root, { ownerId: actor, purpose: `session-token:${id}`, secret: token }, { dpapi: options.secretCustody.dpapi, timestamp }); tokenHandle = stored.handle; custodyMode = "os-opaque-handle"; }
  return mutateRegistry(registryPath, actor, (registry) => {
    const session = {
      id, token: null, tokenDigest, custodyMode, actor, claim,
      createdAt: timestamp, heartbeat: timestamp, releasedAt: null, releaseReason: null,
    };
    registry.sessions.push(session);
    const { tokenDigest: _digest, ...visible } = session; return tokenHandle ? { ...visible, tokenHandle } : { ...visible, token };
  });
}

export async function heartbeatSession(registryPath, credentials, options = {}) {
  const timestamp = options.timestamp ?? new Date().toISOString();
  requireTimestamp(timestamp);
  return mutateRegistry(registryPath, credentials?.actor, async (registry) => {
    const session = registry.sessions.find((item) => item.id === credentials?.id);
    if (!session || !await ownsSession(session, credentials, options)) throw new Error("Session heartbeat refused: credentials do not own this session.");
    if (session.releasedAt) throw new Error("Session heartbeat refused: claim is already released.");
    if (Date.parse(timestamp) < Date.parse(session.heartbeat)) throw new Error("Session heartbeat refused: time cannot move backwards.");
    session.heartbeat = timestamp;
    return redactSession(session);
  });
}

export async function releaseSession(registryPath, credentials, options = {}) {
  const timestamp = options.timestamp ?? new Date().toISOString();
  requireTimestamp(timestamp);
  const reason = String(options.reason ?? "completed");
  return mutateRegistry(registryPath, credentials?.actor, async (registry) => {
    const session = registry.sessions.find((item) => item.id === credentials?.id);
    if (!session || !await ownsSession(session, credentials, options)) throw new Error("Session release refused: credentials do not own this session.");
    if (session.releasedAt) throw new Error("Session release refused: claim is already released.");
    if (Date.parse(timestamp) < Date.parse(session.heartbeat)) throw new Error("Session release refused: time cannot move backwards.");
    session.releasedAt = timestamp;
    session.releaseReason = reason;
    return redactSession(session);
  });
}

export async function inspectSessions(registryPath, options = {}) {
  const now = options.now ?? Date.now();
  const registry = await readSessionRegistry(registryPath);
  return registry.sessions.map(({ token, tokenDigest, ...session }) => ({
    ...session,
    state: session.releasedAt ? "released" : classifyHeartbeat(session.heartbeat, now),
  }));
}

// Authentication must never manufacture a heartbeat. Enrollment (project,
// policy, epoch and assignment) is checked separately by the trusted runtime.
async function readAuthenticationRegistry(registryPath) {
  if (typeof registryPath !== "string" || !path.isAbsolute(registryPath)) throw new Error("Session authentication path refused.");
  const parent = path.dirname(registryPath);
  const safeParent = async () => {
    let cursor = parent;
    for (;;) { const info = await lstat(cursor); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Session authentication path refused."); const next = path.dirname(cursor); if (next === cursor) break; cursor = next; }
    if (path.relative(path.resolve(parent), await realpath(parent))) throw new Error("Session authentication path refused.");
  };
  await safeParent(); const info = await lstat(registryPath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024) throw new Error("Session authentication file refused.");
  const handle = await open(registryPath, "r");
  try {
    const opened = await handle.stat();
    if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== info.size) throw new Error("Session authentication file changed.");
    const bytes = Buffer.alloc(info.size + 1); let length = 0;
    while (length < bytes.length) { const result = await handle.read(bytes, length, bytes.length - length); if (!result.bytesRead) break; length += result.bytesRead; }
    const after = await handle.stat(); const current = await lstat(registryPath); await safeParent();
    if (length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || current.ino !== info.ino || current.dev !== info.dev || current.isSymbolicLink() || current.nlink !== 1 || current.size !== info.size || current.mtimeMs !== info.mtimeMs) throw new Error("Session authentication file changed.");
    return normalizeRegistry(JSON.parse(bytes.subarray(0, length).toString("utf8")));
  } finally { await handle.close(); }
}

export async function inspectReleasedSession(registryPath, expected) {
  if (!expected || typeof expected.id !== 'string' || !expected.id || typeof expected.actor !== 'string' || !expected.actor) throw Error('Session release identity refused.');
  const registry = await readAuthenticationRegistry(registryPath);
  const session = registry.sessions.find(item => item.id === expected.id);
  return Boolean(session && session.actor === expected.actor && session.releasedAt !== null);
}

export async function authenticateSession(registryPath, credentials, expected, options = {}) {
  credentials = structuredClone(credentials); expected = structuredClone(expected);
  if (!expected || typeof expected.id !== "string" || !expected.id || typeof expected.actor !== "string" || !expected.actor
    || credentials?.id !== expected.id || credentials?.actor !== expected.actor) throw new Error("Session authentication refused.");
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Session authentication refused.");
  const check = async () => {
    const registry = await readAuthenticationRegistry(registryPath);
    const session = registry.sessions.find(item => item.id === expected.id);
    if (!session || session.actor !== expected.actor || session.releasedAt || classifyHeartbeat(session.heartbeat, now) !== "active"
      || !await ownsSession(session, credentials, options)) throw new Error("Session authentication refused.");
    return session;
  };
  const first = await check();
  const second = await check();
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error("Session changed during authentication.");
  return Object.freeze({ id: second.id, actor: second.actor, heartbeat: second.heartbeat, authenticated: true });
}

// Host-only short admission transaction. Lock order for the future broker is
// proposal -> confirmation -> session -> grant. Never run the worker command
// inside this callback or recursively mutate the same session registry.
// This closes cooperating release/heartbeat races, not arbitrary file edits.
export async function withAuthenticatedSession(registryPath,credentials,expected,operation,options={}) {
  credentials=structuredClone(credentials);expected=structuredClone(expected);
  const authenticationOptions={...options,secretCustody:options.secretCustody?{...options.secretCustody}:undefined};
  if(typeof operation!=='function')throw Error('Session admission callback refused.');
  await readAuthenticationRegistry(registryPath);
  return withPlanLock(registryPath,{actor:'session-admission',timeoutMs:5000,retryMs:10},async()=>{
    const session=await authenticateSession(registryPath,credentials,expected,authenticationOptions);
    return operation(Object.freeze({...session,executionAuthorized:false}));
  });
}
