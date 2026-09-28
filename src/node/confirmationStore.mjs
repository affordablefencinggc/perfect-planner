import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, lstat, realpath, rename } from "node:fs/promises";
import {constants} from 'node:fs';
import path from "node:path";
import { withPlanLock } from "./planLock.mjs";
import { storeOpaqueSecret, useOpaqueSecret } from "./windowsDpapiSecretCustody.mjs";
import { isProjectId } from '../project/projectIds.js';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const trustedGestureBoundaries = new WeakSet();
const trustedGestureCommitters = new WeakMap();
export const TERMINAL_CONFIRMATION_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const secretDigest = (value) => createHash("sha256").update(value).digest("hex");
const redactRequest = ({ watcherToken, watcherHandle, watcherTokenDigest, decisionEvidenceDigest, ...request }) => request;

async function ownsWatcher(request, credentials, options) {
  if (request.watcherTokenDigest) {
    if (request.custodyMode === "legacy-ephemeral-token") return typeof credentials?.watcherToken === "string" && secretDigest(credentials.watcherToken) === request.watcherTokenDigest;
    const custody = options?.secretCustody; if (!credentials?.watcherHandle || !custody?.root || !custody?.dpapi) return false;
    try { return await useOpaqueSecret(custody.root, credentials.watcherHandle, { ownerId: request.requestedBy, purpose: `confirmation-watcher:${request.id}`, dpapi: custody.dpapi }, (secret) => secretDigest(secret) === request.watcherTokenDigest); } catch(error) { if(error?.cleanupComplete===false)throw error;return false; }
  }
  return request.watcherToken === credentials?.watcherToken;
}

export function createTrustedUserGestureBoundary(verify) {
  if (typeof verify !== "function") throw new Error("Trusted user-gesture boundary requires a verifier.");
  const boundary = Object.freeze({ verify }); trustedGestureBoundaries.add(boundary); return boundary;
}

export function createTrustedUserGestureProducer(options = {}) {
  const source = String(options.source ?? "").trim(); if (!source) throw new Error("Trusted gesture producer requires a named native source."); const pending = new Map();
  const boundary = createTrustedUserGestureBoundary(async (evidence, expected) => { const event = pending.get(evidence?.token); if (!event || event.eventId !== evidence?.eventId || hash(event.binding)!==hash(expected)) return { trusted: false }; return { trusted: true, source, eventId: event.eventId, occurredAt: event.occurredAt, actor: event.actor, binding:event.binding }; });
  trustedGestureCommitters.set(boundary,evidence=>pending.delete(evidence?.token));
  // Capture is host-only; isTrusted supplied by a renderer is not authentication.
  const capture = (nativeEvent, actor, scope) => { const namedActor = String(actor ?? "").trim(); if (nativeEvent?.isTrusted !== true || !namedActor) throw new Error("Gesture capture requires a trusted native event and named actor."); const binding=decisionBinding(scope?.request,scope?.decision); const eventId = randomUUID(); const token = randomUUID(); pending.set(token, { eventId, occurredAt: options.now?.() ?? new Date().toISOString(), actor: namedActor, binding }); return { token, eventId }; };
  return Object.freeze({ source, boundary, capture });
}

function decisionBinding(request,decision) {
  if(!request||!['approved','rejected'].includes(decision)||['id','planId','itemId','question','requestedBy','createdAt'].some(key=>typeof request[key]!=='string'||!request[key]))throw new Error('Gesture requires an exact request and decision.');
  const {id,planId,itemId,question,requestedBy,createdAt}=request;
  const subject=confirmationSubject(request.subject);
  return Object.freeze({requestId:id,decision,requestDigest:hash({id,planId,itemId,question,requestedBy,createdAt,subject})});
}

// This binds what was reviewed. The admission host must separately establish
// that the proposal exists and remains the current head under its own lock.
function confirmationSubject(value) {
  if(value===undefined||value===null)return null;
  const executionReview=value?.kind==='TASK_EXECUTION_REVIEW';
  const fields=['kind','projectId','rootIdentity','hostRevision','proposalDigest','ledgerDigest',...(executionReview?['checkContractDigest']:[])];
  if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('|')!==fields.sort().join('|')
    ||(!executionReview&&value.kind!=='TASK_LEDGER_PROPOSAL')||!isProjectId(value.projectId)||!Number.isSafeInteger(value.hostRevision)||value.hostRevision<1
    ||['rootIdentity','proposalDigest','ledgerDigest',...(executionReview?['checkContractDigest']:[])].some(key=>typeof value[key]!=='string'||!/^[a-f0-9]{64}$/.test(value[key])))throw new Error('Confirmation proposal subject is invalid.');
  const {kind,projectId,rootIdentity,hostRevision,proposalDigest,ledgerDigest}=value;
  return {kind,projectId,rootIdentity,hostRevision,proposalDigest,ledgerDigest,...(executionReview?{checkContractDigest:value.checkContractDigest}:{})};
}

const MAX_CONFIRMATION_BYTES=8*1024*1024;
async function checkStoreParent(storePath) {
  if(typeof storePath!=='string'||!path.isAbsolute(storePath)||path.resolve(storePath)!==storePath)throw Error('Confirmation path is invalid.');
  const parent=path.dirname(storePath);
  if(path.relative(parent,await realpath(parent))!=='')throw Error('Confirmation parent is redirected.');
}
async function readStore(storePath) {
  try {
    await checkStoreParent(storePath);
    let before;
    try{before=await lstat(storePath);}catch(error){if(error.code==='ENOENT')return {schemaVersion:1,requests:[],retentionReceipts:[]};throw error;}
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>MAX_CONFIRMATION_BYTES)throw Error('Confirmation file is unsafe or oversized.');
    const handle=await open(storePath,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
    let bytes;
    try {
      const opened=await handle.stat();
      if(!opened.isFile()||opened.nlink!==1||opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size)throw Error('Confirmation file changed.');
      bytes=Buffer.alloc(before.size);let offset=0;
      while(offset<bytes.length){const part=await handle.read(bytes,offset,Math.min(65536,bytes.length-offset),offset);if(!part.bytesRead)break;offset+=part.bytesRead;}
      const after=await handle.stat(),current=await lstat(storePath);
      await checkStoreParent(storePath);
      if(offset!==before.size||[after,current].some(info=>!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.dev!==before.dev||info.ino!==before.ino||info.size!==before.size||info.mtimeMs!==before.mtimeMs||info.ctimeMs!==before.ctimeMs))throw Error('Confirmation file changed.');
    } finally {await handle.close();}
    const value = JSON.parse(bytes.toString('utf8'));
    if (value?.schemaVersion !== 1 || !Array.isArray(value.requests) || (value.retentionReceipts !== undefined && !Array.isArray(value.retentionReceipts))) throw new Error("Confirmation store is malformed.");
    value.retentionReceipts ??= [];
    return value;
  } catch (error) {
    throw error;
  }
}

async function atomicWrite(storePath, value) {
  const body=`${JSON.stringify(value,null,2)}\n`;
  if(Buffer.byteLength(body)>MAX_CONFIRMATION_BYTES)throw Error('Confirmation store exceeds byte limit.');
  await checkStoreParent(storePath);
  const temporary = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle=await open(temporary,'wx',0o600);
  try{await handle.writeFile(body);await handle.sync();}
  finally{await handle.close();}
  // File contents are flushed before publication; directory-entry power-loss
  // durability and protection against hostile path replacement remain unproved.
  await checkStoreParent(storePath);
  await rename(temporary, storePath);
}

async function mutate(storePath, actor, operation) {
  if(typeof storePath!=='string'||!path.isAbsolute(storePath)||path.resolve(storePath)!==storePath)throw Error('Confirmation path is invalid.');
  const parent=path.dirname(storePath);let cursor=path.parse(parent).root;
  for(const part of path.relative(cursor,parent).split(path.sep).filter(Boolean)){
    if(path.relative(cursor,await realpath(cursor))!=='')throw Error('Confirmation parent is redirected.');
    cursor=path.join(cursor,part);
    try{await mkdir(cursor);}catch(error){if(error.code!=='EEXIST')throw error;}
    const info=await lstat(cursor);
    if(!info.isDirectory()||info.isSymbolicLink()||path.relative(cursor,await realpath(cursor))!=='')throw Error('Confirmation parent is redirected.');
  }
  await checkStoreParent(storePath);
  return withPlanLock(storePath, { actor, timeoutMs: 5000, retryMs: 10 }, async () => {
    const store = await readStore(storePath);
    const result = await operation(store);
    await atomicWrite(storePath, store);
    return result;
  });
}

export async function requestConfirmation(storePath, input, options = {}) {
  input=structuredClone(input);
  const subject=confirmationSubject(input?.subject),timestamp=options.timestamp;
  const planId = String(input?.planId ?? "").trim();
  const itemId = String(input?.itemId ?? "").trim();
  const question = String(input?.question ?? "").trim();
  const requestedBy = String(input?.requestedBy ?? "").trim();
  if (!planId || !itemId || !question || !requestedBy) throw new Error("Confirmation requires plan, item, question, and requesting session.");
  const retainedDigest=options.retainedRequestDigest;
  if(retainedDigest!==undefined&&(typeof retainedDigest!=='string'||!/^[a-f0-9]{64}$/.test(retainedDigest)))throw Error('CONFIRMATION_ORIGINAL_INVALID');
  const id = retainedDigest===undefined?randomUUID():`review-${retainedDigest}`; let watcherToken = randomUUID(); let watcherHandle = null; let watcherTokenDigest = secretDigest(watcherToken); let custodyMode = "legacy-ephemeral-token";
  if (options.secretCustody) { const stored = await storeOpaqueSecret(options.secretCustody.root, { ownerId: requestedBy, purpose: `confirmation-watcher:${id}`, secret: watcherToken }, { dpapi: options.secretCustody.dpapi, timestamp: options.timestamp }); watcherHandle = stored.handle; custodyMode = "os-opaque-handle"; }
  return mutate(storePath, requestedBy, (store) => {
    // A stable original identifies recovery, never permission to redisplay.
    if(store.requests.some(request=>request.id===id))throw Error('CONFIRMATION_ORIGINAL_ALREADY_EXISTS');
    const existing = store.requests.find((request) => request.planId === planId && request.itemId === itemId && request.status === "pending");
    if (existing) throw new Error(`Confirmation already pending for ${planId}/${itemId}; resume its exact watcher.`);
    const request = { id, watcherToken: null, watcherTokenDigest, custodyMode, planId, itemId, question, requestedBy, subject, status: "pending", createdAt: timestamp ?? new Date().toISOString(), decidedAt: null, decision: null, decidedBy: null, rationale: null, gesture: null, cancelledAt: null, cancelledBy: null, cancellationReason: null };
    if(watcherHandle)request.watcherHandle=watcherHandle;
    store.requests.push(request);
    const { watcherTokenDigest: _digest, ...visible } = request; return watcherHandle ? { ...visible, watcherHandle } : { ...visible, watcherToken };
  });
}

export async function decideConfirmation(storePath, input, options = {}) {
  input=structuredClone(input);
  const timestamp=options.timestamp;
  const decision = String(input?.decision ?? "").toLowerCase();
  const decidedBy = String(input?.decidedBy ?? "").trim();
  const boundary = options.gestureBoundary;
  if (!new Set(["approved", "rejected"]).has(decision) || !decidedBy || !trustedGestureBoundaries.has(boundary)) throw new Error("A human confirmation decision requires a trusted user-gesture boundary, actor, and approved/rejected value.");
  return mutate(storePath, decidedBy, async (store) => {
    const request = store.requests.find((item) => item.id === input?.id);
    if (!request) throw new Error("Confirmation request does not exist.");
    const binding=decisionBinding(request,decision);
    const evidenceDigest=input?.userGestureEvidence===undefined?null:hash(input.userGestureEvidence);
    const rationale=String(input?.rationale??'').trim()||null;
    if (request.status !== "pending") {
      if(request.status===decision&&request.decision===decision&&request.decidedBy===decidedBy&&request.rationale===rationale
        &&evidenceDigest&&request.decisionEvidenceDigest===evidenceDigest&&request.gesture?.binding&&hash(request.gesture.binding)===hash(binding))return redactRequest(request);
      throw new Error("Confirmation decision is immutable once recorded.");
    }
    const gesture = await boundary.verify(input?.userGestureEvidence,binding);
    if (gesture?.trusted !== true || !String(gesture.source ?? "").trim() || !String(gesture.eventId ?? "").trim() || !Number.isFinite(Date.parse(gesture.occurredAt)) || !gesture.binding || hash(gesture.binding)!==hash(binding)) throw new Error("Trusted user-gesture boundary refused the decision evidence.");
    if (gesture.actor && gesture.actor !== decidedBy) throw new Error("Trusted user-gesture actor does not match the named decider.");
    request.status = decision;
    request.decision = decision;
    request.decidedAt = timestamp ?? new Date().toISOString();
    request.decidedBy = decidedBy;
    request.rationale = rationale;
    request.decisionEvidenceDigest=evidenceDigest;
    request.gesture = { source: String(gesture.source), eventId: String(gesture.eventId), occurredAt: gesture.occurredAt, actor: gesture.actor ?? decidedBy, binding };
    return redactRequest(request);
  }).then(result=>{trustedGestureCommitters.get(boundary)?.(input?.userGestureEvidence);return result;});
}

export async function cancelConfirmation(storePath, credentials, options = {}) {
  const cancelledBy = String(options.cancelledBy ?? credentials?.requestedBy ?? "").trim(); const reason = String(options.reason ?? "").trim();
  if (!cancelledBy || !reason) throw new Error("Confirmation cancellation requires the exact watcher, named actor, and reason.");
  return mutate(storePath, cancelledBy, async (store) => {
    const request = store.requests.find((item) => item.id === credentials?.id);
    if (!request || !await ownsWatcher(request, credentials, options) || request.requestedBy !== credentials?.requestedBy || cancelledBy !== request.requestedBy) throw new Error("Confirmation cancellation refused: exact request ownership does not match.");
    if (request.status !== "pending") throw new Error("Only a pending confirmation may be cancelled.");
    request.status = "cancelled"; request.cancelledAt = options.timestamp ?? new Date().toISOString(); request.cancelledBy = cancelledBy; request.cancellationReason = reason;
    return redactRequest(request);
  });
}

// Private host operation for newly app-generated opaque watchers. It cannot
// approve, replace a lost legacy token, or accept a caller-selected handle.
export async function recoverPendingConfirmation(storePath,input,options={}) {
  input=structuredClone(input);const subject=confirmationSubject(input?.subject);
  const custody=options.secretCustody?{...options.secretCustody}:null;
  if(!subject||typeof input?.id!=='string'||!input.id||typeof input?.requestedBy!=='string'||!input.requestedBy||!custody?.root||!custody?.dpapi)throw Error('CONFIRMATION_RECOVERY_AUTHORITY_REQUIRED');
  return mutate(storePath,input.requestedBy,async store=>{
    const request=store.requests.find(item=>item.id===input.id);
    if(!request||request.requestedBy!==input.requestedBy||hash(confirmationSubject(request.subject))!==hash(subject)||request.custodyMode!=='os-opaque-handle'||!request.watcherHandle)throw Error('CONFIRMATION_RECOVERY_BINDING_REFUSED');
    if(!await ownsWatcher(request,{watcherHandle:request.watcherHandle},{secretCustody:custody}))throw Error('CONFIRMATION_RECOVERY_CUSTODY_REFUSED');
    if(!['pending','cancelled','approved','rejected'].includes(request.status))throw Error('CONFIRMATION_RECOVERY_STATE_REFUSED');
    if(request.status==='pending'){
      request.status='cancelled';request.cancelledAt=new Date().toISOString();request.cancelledBy=input.requestedBy;request.cancellationReason='Host recovered interrupted approval; fresh review required.';
    }
    return {...redactRequest(request),executionAuthorized:false};
  });
}

export async function applyConfirmationRetention(storePath, input, options = {}) {
  const actor = String(input?.actor ?? "").trim(); const before = String(input?.before ?? ""); const beforeMs = Date.parse(before);
  if (!actor || !Number.isFinite(beforeMs)) throw new Error("Confirmation retention requires a named actor and valid exclusive cutoff.");
  return mutate(storePath, actor, (store) => {
    const removed = []; const retained = [];
    for (const request of store.requests) {
      const terminalAt = request.decidedAt ?? request.cancelledAt; const terminal = new Set(["approved", "rejected", "cancelled"]).has(request.status);
      if (terminal && Number.isFinite(Date.parse(terminalAt)) && Date.parse(terminalAt) < beforeMs) removed.push({ id: request.id, planId: request.planId, itemId: request.itemId, status: request.status, terminalAt }); else retained.push(request);
    }
    const body = { id: randomUUID(), actor, before, appliedAt: options.timestamp ?? new Date().toISOString(), removed };
    const receipt = { ...body, hash: hash(body) }; store.requests = retained; store.retentionReceipts.push(receipt); return receipt;
  });
}

export async function applyArchivedPlanConfirmationRetention(storePath, input, options = {}) {
  const archive = input?.archiveDecision; const actor = String(input?.actor ?? "").trim(); const now = Date.parse(options.timestamp ?? new Date().toISOString());
  if (!actor || archive?.state !== "ARCHIVED" || !String(archive.planId ?? "").trim() || !String(archive.decidedBy ?? "").trim() || !/^[a-f0-9]{64}$/.test(archive.journalHash ?? "") || !Number.isFinite(Date.parse(archive.decidedAt)) || !Number.isFinite(now)) throw new Error("Plan retention requires an explicit journal-bound archive decision and named operator.");
  const beforeMs = now - TERMINAL_CONFIRMATION_RETENTION_MS; const before = new Date(beforeMs).toISOString();
  return mutate(storePath, actor, (store) => { const removed = []; const retained = []; for (const request of store.requests) { const terminalAt = request.decidedAt ?? request.cancelledAt; const eligible = request.planId === archive.planId && new Set(["approved", "rejected", "cancelled"]).has(request.status) && Number.isFinite(Date.parse(terminalAt)) && Date.parse(terminalAt) < beforeMs; if (eligible) removed.push({ id: request.id, planId: request.planId, itemId: request.itemId, status: request.status, terminalAt }); else retained.push(request); } const body = { id: randomUUID(), policy: "terminal-confirmations-365d-after-plan-archive-v1", actor, planId: archive.planId, archiveJournalHash: archive.journalHash, before, appliedAt: new Date(now).toISOString(), removed }; const receipt = { ...body, hash: hash(body) }; store.requests = retained; store.retentionReceipts.push(receipt); return receipt; });
}

export async function awaitConfirmation(storePath, credentials, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs ?? 30_000));
  const pollMs = Math.max(5, Number(options.pollMs ?? 50));
  const startedAt = Date.now();
  while (true) {
    const store = await readStore(storePath);
    const request = store.requests.find((item) => item.id === credentials?.id);
    if (!request || !await ownsWatcher(request, credentials, options) || request.requestedBy !== credentials?.requestedBy) throw new Error("Confirmation watcher refused: exact request ownership does not match.");
    if (request.status !== "pending") {
      return { state: request.status, request: redactRequest(request) };
    }
    if (Date.now() - startedAt >= timeoutMs) return { state: "waiting", request: { id: request.id, planId: request.planId, itemId: request.itemId, status: request.status } };
    await delay(pollMs);
  }
}

export async function inspectConfirmations(storePath) {
  const store = await readStore(storePath);
  return store.requests.map(redactRequest);
}

// Host-only consumption under the same confirmation lock as decision/retention.
// Consistency of a stored review is not authentication of an attacker-writable
// file, a native gesture, or permission to execute a command.
export async function withRecordedApproval(storePath, requestId, operation) {
  if(typeof requestId!=='string'||!requestId||typeof operation!=='function')throw Error('CONFIRMATION_APPROVAL_INVALID');
  return withPlanLock(storePath,{actor:'recorded-approval-reader',timeoutMs:5000,retryMs:10},async()=>{
    const store=await readStore(storePath),matches=store.requests.filter(item=>item.id===requestId);
    if(matches.length!==1)throw Error('CONFIRMATION_APPROVAL_UNAVAILABLE');
    const request=matches[0],gesture=request.gesture;
    if(request.status!=='approved'||request.decision!=='approved'||typeof request.decidedBy!=='string'||!request.decidedBy.trim()
      ||!Number.isFinite(Date.parse(request.decidedAt))||!gesture||gesture.actor!==request.decidedBy
      ||typeof gesture.source!=='string'||!gesture.source.trim()||typeof gesture.eventId!=='string'||!gesture.eventId.trim()
      ||!Number.isFinite(Date.parse(gesture.occurredAt))||!gesture.binding||hash(gesture.binding)!==hash(decisionBinding(request,'approved'))
      ||typeof request.decisionEvidenceDigest!=='string'||!/^[a-f0-9]{64}$/.test(request.decisionEvidenceDigest))throw Error('CONFIRMATION_APPROVAL_UNAVAILABLE');
    const approved=structuredClone(redactRequest(request));
    const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
    return operation(freeze(approved));
  });
}

export async function inspectConfirmationRetention(storePath) { return (await readStore(storePath)).retentionReceipts.map((receipt) => structuredClone(receipt)); }
