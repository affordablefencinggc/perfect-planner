import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { assertProjectId } from '../project/projectIds.js';
import { withPlanLock } from './planLock.mjs';

// Trusted host custody only; callers must perform approval, current enrollment,
// authenticated session, candidate and executable checks before consuming.
// launchAllowed reports ONLY the first durable consumption transition, never
// independent execution authorization. There is no process-launch API here.
// Lost consume responses fail closed: retries cannot permit another launch.
// The host must recheck expiry immediately before a later launch. Clock rollback
// is refused within this store instance; restart/OS clock rollback protection is
// not established by this journal or its timestamps.
// File sync does not guarantee first-file directory durability. Cooperative
// locks/hash chains cannot defeat hostile same-user rollback or replacement.
const MAX_BYTES = 8 * 1024 * 1024, MAX_RECORDS = 2048, MAX_RECORD_BYTES = 16384;
const fail = code => { throw new Error(`TASK_EXECUTION_GRANT_${code}`); };
const exact = (value, keys) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) fail('INVALID'); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const wire = value => JSON.stringify(canonical(value));
const hash = value => createHash('sha256').update(wire(value)).digest('hex');
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const same = (a, b) => b.isFile() && !b.isSymbolicLink() && b.nlink === 1 && a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const bindingKeys = ['proposalRevision', 'proposalDigest', 'checkContractDigest', 'enrollmentEpoch', 'taskId', 'checkId', 'attemptId', 'attemptNumber', 'workerId', 'sessionId', 'candidateSchemaVersion', 'candidateDigest', 'policyVersion', 'policyDigest'];
function validateBinding(value) {
  exact(value, bindingKeys);
  if (![value.proposalRevision, value.enrollmentEpoch, value.policyVersion, value.attemptNumber].every(positive)
      || ![value.proposalDigest, value.checkContractDigest, value.candidateDigest, value.policyDigest].every(isHash)
      || ![value.checkId, value.attemptId, value.workerId, value.sessionId].every(id) || value.candidateSchemaVersion !== 2
      || typeof value.taskId !== 'string' || !/^T\d{4,6}$/.test(value.taskId) || Number(value.taskId.slice(1)) < 1
      || value.taskId !== `T${String(Number(value.taskId.slice(1))).padStart(4, '0')}`) fail('BINDING_INVALID');
  return value;
}
function validateRequest(event, request) {
  exact(request, event === 'issued' ? ['requestId', 'expectedRevision', 'ttlMs'] : ['grantId', 'requestId', 'expectedRevision']);
  if (!id(request.requestId) || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0
      || (event === 'issued' ? !positive(request.ttlMs) || request.ttlMs > 300000 : !uuid(request.grantId))) fail('REQUEST_INVALID');
}
async function useHandle(handle, operation) {
  let failed = false;
  try { return await operation(handle); } catch (error) { failed = true; throw error; }
  finally { try { await handle.close(); } catch (error) { if (!failed) throw error; } }
}
async function directories(parent) {
  const result = [];
  for (let cursor = parent;;) {
    const info = await lstat(cursor); if (!info.isDirectory() || info.isSymbolicLink()) fail('UNSAFE_PATH');
    result.push({ name: cursor, ino: info.ino, dev: info.dev });
    const next = path.dirname(cursor); if (next === cursor) break; cursor = next;
  }
  if (path.relative(parent, await realpath(parent))) fail('UNSAFE_PATH');
  return result;
}
async function assertDirectories(parents) {
  for (const item of parents) { const info = await lstat(item.name); if (!info.isDirectory() || info.isSymbolicLink() || info.ino !== item.ino || info.dev !== item.dev) fail('PATH_CHANGED'); }
}
async function fileInfo(file) {
  try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('UNSAFE_FILE'); return info; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function assertLock(file) {
  try { const info = await lstat(`${file}.pp-lock`); if (!info.isDirectory() || info.isSymbolicLink()) fail('UNSAFE_LOCK');
    const holder = await fileInfo(path.join(`${file}.pp-lock`, 'holder.json')); if (holder && holder.size > 4096) fail('UNSAFE_LOCK');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export function createTaskExecutionGrantStore({ journalPath, projectId, rootIdentity, now = Date.now, maxBytes = MAX_BYTES, maxRecords = MAX_RECORDS } = {}) {
  assertProjectId(projectId);
  if (typeof journalPath !== 'string' || !path.isAbsolute(journalPath) || path.normalize(journalPath) !== journalPath
      || /[:\u0000]/.test(path.basename(journalPath)) || /[. ]$/.test(path.basename(journalPath)) || !isHash(rootIdentity) || typeof now !== 'function'
      || !positive(maxBytes) || maxBytes > MAX_BYTES || !positive(maxRecords) || maxRecords > MAX_RECORDS) fail('CONFIG_INVALID');
  const parent = path.dirname(journalPath);
  let highestObservedTime = -1;
  const clock = () => {
    const value = now(); if (!Number.isSafeInteger(value) || value < 0 || value > 253402300499999) fail('CLOCK_INVALID');
    if (value < highestObservedTime) fail('CLOCK_REVERSED');
    highestObservedTime = value; return value;
  };
  const makeRecord = (event, request, grant, revision, previousHash, recordedAt, executionIntent, executionObservation) => {
    const body = { schemaVersion: 1, kind: 'TASK_EXECUTION_GRANT_EVENT', projectId, rootIdentity, revision, previousHash,
      event, request, requestDigest: hash({ event, request, binding: grant.binding }), recordedAt, grant,
      ...(event === 'intent-recorded' ? {executionIntent} : {}),
      ...(event === 'result-recorded' ? {executionObservation} : {}) };
    return { ...body, recordHash: hash(body) };
  };
  function assertNewAttempt(grants, binding) {
    let existingAttempt = false, highestAttemptNumber = 0;
    for (const { grant } of grants.values()) {
      if (grant.binding.taskId !== binding.taskId) continue;
      highestAttemptNumber = Math.max(highestAttemptNumber, grant.binding.attemptNumber);
      if (grant.binding.attemptId !== binding.attemptId) continue;
      existingAttempt = true;
      if (bindingKeys.some(key => key !== 'checkId' && grant.binding[key] !== binding[key])) fail('ATTEMPT_BINDING_CONFLICT');
      if (grant.binding.checkId === binding.checkId) fail('CHECK_ALREADY_ISSUED');
    }
    // Attempt IDs are deliberately task-scoped, as are numbered retries. A
    // previously known attempt may add checks, but a new ID must move forward.
    if (!existingAttempt && binding.attemptNumber <= highestAttemptNumber) fail('ATTEMPT_NUMBER_REUSED');
  }
  function parseRecords(bytes) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text || !text.endsWith('\n')) fail('CORRUPT');
    const lines = text.slice(0, -1).split('\n'); if (lines.length > maxRecords) fail('QUOTA');
    const grants = new Map(), requests = new Map(), consumptions = new Map(), intents = new Map(), runIds = new Set(); let previousHash = 'GENESIS', lastTime = -1;
    const records = lines.map((line, index) => {
      if (!line || Buffer.byteLength(line) > MAX_RECORD_BYTES) fail('CORRUPT');
      const record = JSON.parse(line);
      exact(record, ['schemaVersion', 'kind', 'projectId', 'rootIdentity', 'revision', 'previousHash', 'event', 'request', 'requestDigest', 'recordedAt', 'grant', 'recordHash', ...(record.event === 'intent-recorded' ? ['executionIntent'] : []), ...(record.event === 'result-recorded' ? ['executionObservation'] : [])]);
      if (!['issued', 'consumed', 'revoked', 'intent-recorded', 'result-recorded'].includes(record.event)) fail('CORRUPT');
      validateRequest(record.event, record.request);
      exact(record.grant, ['grantId', 'binding', 'issuedAt', 'expiresAt']); validateBinding(record.grant.binding);
      const grant = record.grant, eventTime = Date.parse(record.recordedAt), issued = Date.parse(grant.issuedAt), expiry = Date.parse(grant.expiresAt);
      if (record.schemaVersion !== 1 || record.kind !== 'TASK_EXECUTION_GRANT_EVENT' || record.projectId !== projectId || record.rootIdentity !== rootIdentity
          || record.revision !== index + 1 || record.previousHash !== previousHash || record.request.expectedRevision !== index || requests.has(record.request.requestId)
          || !timestamp(record.recordedAt) || eventTime < lastTime || !uuid(grant.grantId) || !timestamp(grant.issuedAt) || !timestamp(grant.expiresAt)
          || expiry <= issued || expiry - issued > 300000 || record.requestDigest !== hash({ event: record.event, request: record.request, binding: grant.binding })) fail('CORRUPT');
      const { recordHash, ...body } = record; if (recordHash !== hash(body)) fail('CORRUPT');
      if (record.event === 'issued') {
        if (grants.has(grant.grantId) || issued !== eventTime || expiry - issued !== record.request.ttlMs) fail('CORRUPT');
        assertNewAttempt(grants, grant.binding);
      } else {
        const prior = grants.get(grant.grantId);
        if (!prior || prior.state !== (record.event === 'result-recorded' ? 'intent-recorded' : record.event === 'intent-recorded' ? 'consumed' : 'issued') || wire(prior.grant) !== wire(grant) || record.request.grantId !== grant.grantId
            || eventTime < issued || (['consumed','intent-recorded'].includes(record.event) && eventTime >= expiry)) fail('CORRUPT');
        if(record.event === 'intent-recorded') {
          exact(record.executionIntent,['runId','consumptionRevision','consumptionDigest']);
          const consumed=consumptions.get(grant.grantId), intent=record.executionIntent;
          if(!consumed||!uuid(intent.runId)||runIds.has(intent.runId)||intent.consumptionRevision!==consumed.revision||intent.consumptionDigest!==consumed.recordHash)fail('CORRUPT');
          runIds.add(intent.runId);
        }
        if(record.event==='result-recorded'){
          exact(record.executionObservation,['runId','intentRevision','intentDigest','artifactDigest']);
          const original=intents.get(grant.grantId),observed=record.executionObservation;
          if(!original||observed.runId!==original.executionIntent.runId||observed.intentRevision!==original.revision||observed.intentDigest!==original.recordHash||!isHash(observed.artifactDigest))fail('CORRUPT');
        }
      }
      if(record.event==='consumed')consumptions.set(grant.grantId,record);
      if(record.event==='intent-recorded')intents.set(grant.grantId,record);
      grants.set(grant.grantId, { grant, state: record.event, revision: record.revision });
      requests.set(record.request.requestId, record); previousHash = recordHash; lastTime = eventTime;
      return record;
    });
    return { records, grants, requests };
  }
  async function read(parents) {
    await assertDirectories(parents); const info = await fileInfo(journalPath);
    if (!info) return { records: [], grants: new Map(), requests: new Map(), info: null, size: 0 };
    if (!info.size) fail('CORRUPT'); if (info.size > maxBytes) fail('QUOTA');
    return useHandle(await open(journalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)), async handle => {
      if (!same(info, await handle.stat())) fail('FILE_CHANGED');
      const bytes = Buffer.alloc(info.size + 1); let length = 0;
      while (length < bytes.length) { const result = await handle.read(bytes, length, Math.min(65536, bytes.length - length), length); if (!result.bytesRead) break; length += result.bytesRead; }
      const current = await fileInfo(journalPath);
      if (length !== info.size || !same(info, await handle.stat()) || !current || !same(info, current)) fail('FILE_CHANGED');
      await assertDirectories(parents); return { ...parseRecords(bytes.subarray(0, length)), info, size: length };
    });
  }
  async function locked(operation) {
    const parents = await directories(parent); await assertLock(journalPath); let failed = false, firstError;
    try { return await withPlanLock(journalPath, { actor: 'task-execution-grant-store', timeoutMs: 5000, retryMs: 10 }, async () => {
      try { await assertDirectories(parents); return await operation(parents); } catch (error) { failed = true; firstError = error; throw error; }
    }); } catch (error) { throw failed ? firstError : error; }
  }
  function reservation(grant,state) {
    const request = { grantId: grant.grantId, requestId: 'r'.repeat(128), expectedRevision: Number.MAX_SAFE_INTEGER };
    const intent={runId:'ffffffff-ffff-ffff-ffff-ffffffffffff',consumptionRevision:Number.MAX_SAFE_INTEGER,consumptionDigest:'f'.repeat(64)};
    const observation={runId:intent.runId,intentRevision:Number.MAX_SAFE_INTEGER,intentDigest:'f'.repeat(64),artifactDigest:'f'.repeat(64)};
    const remaining=state==='issued'?['consumed','intent-recorded','result-recorded']:state==='consumed'?['intent-recorded','result-recorded']:state==='intent-recorded'?['result-recorded']:[];
    return {records:remaining.length,bytes:remaining.reduce((total,event)=>total+Buffer.byteLength(`${wire(makeRecord(event,request,grant,Number.MAX_SAFE_INTEGER,'f'.repeat(64),'9999-12-31T23:59:59.999Z',intent,observation))}\n`),0)};
  }
  async function persist(state, record, parents) {
    const bytes = record ? Buffer.from(`${wire(record)}\n`) : null;
    if (bytes) {
      const outstanding = [...state.grants.values()].filter(item=>item.grant.grantId!==record.grant.grantId);
      outstanding.push({grant:record.grant,state:record.event});
      const reserved=outstanding.map(item=>reservation(item.grant,item.state));
      if (bytes.length > MAX_RECORD_BYTES || state.records.length + 1 + reserved.reduce((total,r)=>total+r.records,0) > maxRecords
          || state.size + bytes.length + reserved.reduce((total,r)=>total+r.bytes,0) > maxBytes) fail('QUOTA');
    }
    await assertDirectories(parents);
    const flags = constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) | (state.info ? 0 : constants.O_CREAT | constants.O_EXCL);
    await useHandle(await open(journalPath, flags, 0o600), async handle => {
      const opened = await handle.stat(); if (!opened.isFile() || opened.nlink !== 1 || (state.info ? !same(state.info, opened) : opened.size !== 0)) fail('FILE_CHANGED');
      await assertDirectories(parents); if (bytes) await handle.writeFile(bytes); await handle.sync();
    });
    const after = await read(parents), head = record ?? state.records.at(-1);
    if (after.records.length !== state.records.length + (record ? 1 : 0) || after.records.at(-1)?.recordHash !== head.recordHash) fail('PUBLICATION_UNCERTAIN');
  }
  // Exact saved consumption identity, including on historical reads. This is
  // not a launch intent or proof a process ran. Never mint a new ID on retry.
  const consumptionReceipt = record => record?.event === 'consumed' ? {
    schemaVersion: 1, kind: 'TASK_GRANT_CONSUMPTION_RECEIPT', projectId, rootIdentity,
    grantId: record.grant.grantId, requestId: record.request.requestId,
    revision: record.revision, recordDigest: record.recordHash, consumedAt: record.recordedAt,
    expiresAt: record.grant.expiresAt, binding: record.grant.binding,
    executionAuthorized: false,
  } : null;
  const intentReceipt = record => record?.event === 'intent-recorded' ? {
    schemaVersion:1,kind:'TASK_EXECUTION_INTENT_RECEIPT',projectId,rootIdentity,
    grantId:record.grant.grantId,requestId:record.request.requestId,
    revision:record.revision,recordDigest:record.recordHash,recordedAt:record.recordedAt,
    ...record.executionIntent,binding:record.grant.binding,
    state:'launch-unresolved',executionAuthorized:false,
  } : null;
  const consumedRecord=(state,grantId)=>state.records.find(record=>record.event==='consumed'&&record.grant.grantId===grantId);
  const originalIntent=(state,grantId)=>state.records.find(record=>record.event==='intent-recorded'&&record.grant.grantId===grantId);
  const observedRecord=(state,grantId)=>state.records.find(record=>record.event==='result-recorded'&&record.grant.grantId===grantId);
  const observationLink=record=>record?.event==='result-recorded'?{
    schemaVersion:1,kind:'TASK_EXECUTION_OBSERVATION_LINK',projectId,rootIdentity,grantId:record.grant.grantId,
    revision:record.revision,recordDigest:record.recordHash,recordedAt:record.recordedAt,...record.executionObservation,
    state:'result-unverified',executionAuthorized:false,
  }:null;
  const consumedState=state=>['consumed','intent-recorded','result-recorded'].includes(state);
  const result = (record, retry) => freeze({ grant: record.grant, state: record.event, revision: record.revision, idempotent: retry,
    consumptionReceipt: consumptionReceipt(record),
    intentReceipt:intentReceipt(record),firstIntent:record.event==='intent-recorded'&&!retry,
    alreadyConsumed: consumedState(record.event) && (retry||record.event==='intent-recorded'), launchAllowed: record.event === 'consumed' && !retry, executionAuthorized: false });
  async function transition(event, binding, request, receipt) {
    if (event !== 'revoked') binding = freeze(validateBinding(structuredClone(binding)));
    request = structuredClone(request); validateRequest(event, request);
    if(event==='intent-recorded')receipt=structuredClone(receipt);
    return locked(async parents => {
      const state = await read(parents), retry = state.requests.get(request.requestId);
      const existing = event === 'issued' ? null : state.grants.get(request.grantId);
      const consumed=event==='intent-recorded'?consumedRecord(state,request.grantId):null;
      if(event==='intent-recorded'&&(!consumed||wire(receipt)!==wire(consumptionReceipt(consumed))))fail('CONSUMPTION_RECEIPT_MISMATCH');
      const effectiveBinding = event === 'revoked' ? existing?.grant.binding : binding;
      if (retry) {
        if (retry.requestDigest !== hash({ event, request, binding: effectiveBinding })) fail('REQUEST_CONFLICT');
        await persist(state, null, parents);
        if (event === 'issued') {
          const current = state.grants.get(retry.grant.grantId), currentState = current.state;
          return freeze({ ...result(retry, true), state: currentState,
            consumptionReceipt: consumptionReceipt(consumedRecord(state,retry.grant.grantId)),
            intentReceipt:intentReceipt(originalIntent(state,retry.grant.grantId)),observationLink:observationLink(observedRecord(state,retry.grant.grantId)),alreadyConsumed:consumedState(currentState) });
        }
        return freeze({...result(retry,true),...(event==='intent-recorded'?{consumptionReceipt:consumptionReceipt(consumed)}:{})});
      }
      if (request.expectedRevision !== state.records.length) fail('STALE_HEAD');
      const time = clock();
      if (state.records.length && time < Date.parse(state.records.at(-1).recordedAt)) fail('CLOCK_REVERSED');
      let grant;
      if (event === 'issued') {
        assertNewAttempt(state.grants, binding);
        grant = { grantId: randomUUID(), binding, issuedAt: new Date(time).toISOString(), expiresAt: new Date(time + request.ttlMs).toISOString() };
      } else {
        if (!existing) fail('NOT_FOUND'); if (existing.state !== (event==='intent-recorded'?'consumed':'issued')) fail('TERMINAL');
        grant = existing.grant;
        if (wire(effectiveBinding) !== wire(grant.binding)) fail('BINDING_MISMATCH');
        if (['consumed','intent-recorded'].includes(event) && time >= Date.parse(grant.expiresAt)) fail('EXPIRED');
      }
      const executionIntent=event==='intent-recorded'?{runId:randomUUID(),consumptionRevision:consumed.revision,consumptionDigest:consumed.recordHash}:undefined;
      const record = makeRecord(event, request, grant, state.records.length + 1, state.records.at(-1)?.recordHash ?? 'GENESIS', new Date(time).toISOString(),executionIntent);
      await persist(state, record, parents);
      if (['consumed','intent-recorded'].includes(event)) {
        const completedAt = clock();
        if (completedAt < time) fail('CLOCK_REVERSED');
        if (completedAt >= Date.parse(grant.expiresAt)) fail(event==='consumed'?'EXPIRED_AFTER_CONSUMPTION':'EXPIRED_AFTER_INTENT');
      }
      return freeze({...result(record,false),...(event==='intent-recorded'?{consumptionReceipt:consumptionReceipt(consumed)}:{})});
    });
  }
  return Object.freeze({
    issue: (binding, request) => transition('issued', binding, request),
    consume: (binding, request) => transition('consumed', binding, request),
    // Private host custody only: fresh authority/candidate checks are separate.
    // A durable unresolved intent is not proof of launch; replay never firstIntent.
    recordExecutionIntent: (receipt,request) => transition('intent-recorded',receipt?.binding,request,receipt),
    // Host custody only. Caller must read back actual retained output first;
    // linking its digest is NOT producer authentication or task acceptance.
    async recordObservationReceipt(original,observed,request){
      original=structuredClone(original);observed=structuredClone(observed);request=structuredClone(request);validateRequest('result-recorded',request);
      exact(observed,['schemaVersion','kind','projectId','rootIdentity','runId','intentDigest','artifactDigest','state','executionAuthorized']);
      if(observed.schemaVersion!==1||observed.kind!=='NATIVE_TASK_OBSERVATION_RECEIPT'||observed.projectId!==projectId||observed.rootIdentity!==rootIdentity||observed.state!=='result-unverified'||observed.executionAuthorized!==false||!isHash(observed.artifactDigest))fail('OBSERVATION_MISMATCH');
      return locked(async parents=>{
        const state=await read(parents),intent=originalIntent(state,request.grantId),existing=state.grants.get(request.grantId);
        if(!intent||wire(original)!==wire(intentReceipt(intent))||observed.runId!==intent.executionIntent.runId||observed.intentDigest!==intent.recordHash)fail('OBSERVATION_MISMATCH');
        const executionObservation={runId:observed.runId,intentRevision:intent.revision,intentDigest:intent.recordHash,artifactDigest:observed.artifactDigest};
        const retry=state.requests.get(request.requestId);
        if(retry){
          if(retry.event!=='result-recorded'||wire(retry.request)!==wire(request)||wire(retry.executionObservation)!==wire(executionObservation))fail('REQUEST_CONFLICT');
          await persist(state,null,parents);return freeze({observationLink:observationLink(retry),idempotent:true,launchAllowed:false,executionAuthorized:false});
        }
        if(request.expectedRevision!==state.records.length)fail('STALE_HEAD');
        if(existing.state!=='intent-recorded')fail('TERMINAL');
        const time=clock();if(time<Date.parse(state.records.at(-1).recordedAt))fail('CLOCK_REVERSED');
        // Expired execution permission must not prevent retaining its outcome.
        const record=makeRecord('result-recorded',request,existing.grant,state.records.length+1,state.records.at(-1).recordHash,new Date(time).toISOString(),undefined,executionObservation);
        await persist(state,record,parents);return freeze({observationLink:observationLink(record),idempotent:false,launchAllowed:false,executionAuthorized:false});
      });
    },
    revoke: request => transition('revoked', null, request),
    inspect: () => locked(async parents => { const state = await read(parents); return freeze({ schemaVersion: 1, projectId, rootIdentity,
      revision: state.records.length, headDigest: state.records.at(-1)?.recordHash ?? 'GENESIS',
      grants: [...state.grants.values()].map(entry => ({...entry, consumptionReceipt: consumptionReceipt(consumedRecord(state,entry.grant.grantId)),
        intentReceipt:intentReceipt(originalIntent(state,entry.grant.grantId)),observationLink:observationLink(observedRecord(state,entry.grant.grantId))})),
      history: state.records, executionAuthorized: false }); }),
  });
}
