import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { assertProjectId } from '../project/projectIds.js';
import { withPlanLock } from './planLock.mjs';

// Host-owned assignment custody, not authentication, consent or execution
// authority. Empty assignments revoke the preceding enrollment. File appends
// are flushed; first-file directory durability is not portable or guaranteed.
// Cooperative locks and hashes cannot defeat arbitrary same-user replacement,
// rollback or changes between filesystem checks. Never auto-clear stale locks.
// Retain sequential enrollment for the supported plan population and retries.
// Byte quotas and reserved revocation capacity still bound every admission.
const MAX_BYTES = 8 * 1024 * 1024, MAX_RECORDS = 2048, MAX_RECORD_BYTES = 512 * 1024;
const fail = code => { throw new Error(`TASK_ENROLLMENT_${code}`); };
const exact = (value, keys) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) fail('INVALID'); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const wire = value => JSON.stringify(canonical(value));
const hash = value => createHash('sha256').update(wire(value)).digest('hex');
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const same = (a, b) => b.isFile() && !b.isSymbolicLink() && b.nlink === 1 && a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
async function useHandle(handle, operation) {
  let failed = false;
  try { return await operation(handle); } catch (error) { failed = true; throw error; }
  finally { try { await handle.close(); } catch (error) { if (!failed) throw error; } }
}
async function directories(parent) {
  const result = [];
  for (let cursor = parent;;) {
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('UNSAFE_PATH');
    result.push({ name: cursor, ino: info.ino, dev: info.dev });
    const next = path.dirname(cursor); if (next === cursor) break; cursor = next;
  }
  if (path.relative(parent, await realpath(parent))) fail('UNSAFE_PATH');
  return result;
}
async function assertDirectories(snapshot) {
  for (const expected of snapshot) {
    const info = await lstat(expected.name);
    if (!info.isDirectory() || info.isSymbolicLink() || info.ino !== expected.ino || info.dev !== expected.dev) fail('PATH_CHANGED');
  }
}
async function fileInfo(file) {
  try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('UNSAFE_FILE'); return info; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function assertLock(file) {
  try {
    const info = await lstat(`${file}.pp-lock`);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('UNSAFE_LOCK');
    const holder = await fileInfo(path.join(`${file}.pp-lock`, 'holder.json'));
    if (holder && holder.size > 4096) fail('UNSAFE_LOCK');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function normalize(snapshot) {
  exact(snapshot, ['hostRevision', 'proposalDigest', 'checkContractDigest', 'policyVersion', 'policyDigest', 'assignments']);
  if (!positive(snapshot.hostRevision) || !positive(snapshot.policyVersion) || ![snapshot.proposalDigest, snapshot.checkContractDigest, snapshot.policyDigest].every(isHash)
      || !Array.isArray(snapshot.assignments) || snapshot.assignments.length > 500 || Object.keys(snapshot.assignments).length !== snapshot.assignments.length) fail('SNAPSHOT_INVALID');
  const tasks = new Set(), workers = new Map(), sessions = new Map();
  for (let index = 0; index < snapshot.assignments.length; index++) {
    if (!Object.hasOwn(snapshot.assignments, index)) fail('SNAPSHOT_INVALID');
    const assignment = snapshot.assignments[index];
    exact(assignment, ['taskId', 'workerId', 'sessionId', 'actor']);
    if (typeof assignment.taskId !== 'string' || !/^T\d{4,6}$/.test(assignment.taskId) || Number(assignment.taskId.slice(1)) < 1
        || assignment.taskId !== `T${String(Number(assignment.taskId.slice(1))).padStart(4, '0')}` || tasks.has(assignment.taskId)
        || !id(assignment.workerId) || !id(assignment.sessionId) || typeof assignment.actor !== 'string' || !assignment.actor.trim()
        || assignment.actor !== assignment.actor.trim() || assignment.actor.length > 128 || /[\u0000-\u001f\u007f]/.test(assignment.actor)) fail('SNAPSHOT_INVALID');
    const workerBinding = wire({ sessionId: assignment.sessionId, actor: assignment.actor });
    const sessionBinding = wire({ workerId: assignment.workerId, actor: assignment.actor });
    if ((workers.has(assignment.workerId) && workers.get(assignment.workerId) !== workerBinding)
        || (sessions.has(assignment.sessionId) && sessions.get(assignment.sessionId) !== sessionBinding)) fail('SNAPSHOT_INVALID');
    tasks.add(assignment.taskId); workers.set(assignment.workerId, workerBinding); sessions.set(assignment.sessionId, sessionBinding);
  }
  snapshot.assignments.sort((a, b) => a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0);
  return freeze(snapshot);
}

export function createTaskEnrollmentStore({ journalPath, projectId, rootIdentity, maxBytes = MAX_BYTES, maxRecords = MAX_RECORDS } = {}) {
  assertProjectId(projectId);
  if (typeof journalPath !== 'string' || !path.isAbsolute(journalPath) || path.normalize(journalPath) !== journalPath
      || /[:\u0000]/.test(path.basename(journalPath)) || /[. ]$/.test(path.basename(journalPath)) || !isHash(rootIdentity)
      || !positive(maxBytes) || maxBytes > MAX_BYTES || !positive(maxRecords) || maxRecords > MAX_RECORDS) fail('CONFIG_INVALID');
  const parent = path.dirname(journalPath);
  function recordsFrom(bytes) {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!value || !value.endsWith('\n')) fail('CORRUPT');
    const lines = value.slice(0, -1).split('\n');
    if (lines.length > maxRecords) fail('QUOTA');
    let previousHash = 'GENESIS'; const requests = new Set();
    return lines.map((line, index) => {
      if (!line || Buffer.byteLength(line) > MAX_RECORD_BYTES) fail('CORRUPT');
      const record = JSON.parse(line);
      exact(record, ['schemaVersion', 'kind', 'projectId', 'rootIdentity', 'revision', 'epoch', 'previousHash', 'requestId', 'requestDigest', 'expectedRevision', 'snapshot', 'snapshotDigest', 'publishedAt', 'executionAuthorized', 'recordHash']);
      const snapshot = normalize(structuredClone(record.snapshot));
      if (record.schemaVersion !== 1 || record.kind !== 'TASK_ENROLLMENT' || record.projectId !== projectId || record.rootIdentity !== rootIdentity
          || record.revision !== index + 1 || record.epoch !== index + 1 || record.expectedRevision !== index || record.previousHash !== previousHash
          || record.executionAuthorized !== false || !id(record.requestId) || requests.has(record.requestId)
          || typeof record.publishedAt !== 'string' || !Number.isFinite(Date.parse(record.publishedAt)) || new Date(record.publishedAt).toISOString() !== record.publishedAt
          || wire(snapshot) !== wire(record.snapshot) || record.snapshotDigest !== hash(snapshot)
          || record.requestDigest !== hash({ snapshot, expectedRevision: index })) fail('CORRUPT');
      const { recordHash, ...body } = record;
      if (recordHash !== hash(body)) fail('CORRUPT');
      requests.add(record.requestId); previousHash = recordHash;
      return record;
    });
  }
  async function read(parents) {
    await assertDirectories(parents);
    const info = await fileInfo(journalPath);
    if (!info) return { records: [], info: null, size: 0 };
    if (!info.size) fail('CORRUPT'); if (info.size > maxBytes) fail('QUOTA');
    return useHandle(await open(journalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)), async handle => {
      if (!same(info, await handle.stat())) fail('FILE_CHANGED');
      const bytes = Buffer.alloc(info.size + 1); let length = 0;
      while (length < bytes.length) { const result = await handle.read(bytes, length, Math.min(65536, bytes.length - length), length); if (!result.bytesRead) break; length += result.bytesRead; }
      const current = await fileInfo(journalPath);
      if (length !== info.size || !same(info, await handle.stat()) || !current || !same(info, current)) fail('FILE_CHANGED');
      await assertDirectories(parents);
      return { records: recordsFrom(bytes.subarray(0, length)), info, size: length };
    });
  }
  async function locked(operation) {
    const parents = await directories(parent); await assertLock(journalPath);
    let firstFailure;
    try {
      return await withPlanLock(journalPath, { actor: 'task-enrollment-store', timeoutMs: 5000, retryMs: 10 }, async () => {
        try { await assertDirectories(parents); return await operation(parents); }
        catch (error) { firstFailure = error; throw error; }
      });
    } catch (error) { throw firstFailure ?? error; }
  }
  return Object.freeze({
    inspect: () => locked(async parents => {
      const { records } = await read(parents), head = records.at(-1) ?? null;
      return freeze({ schemaVersion: 1, projectId, rootIdentity, revision: records.length, epoch: head?.epoch ?? 0,
        headDigest: head?.recordHash ?? 'GENESIS', head, history: records, executionAuthorized: false });
    }),
    // Hold enrollment stable throughout host preflight/admission composition.
    // Callback must not reacquire this store; other authority locks need one
    // consistent host-defined ordering. A callback is not authenticated here.
    async withCurrentEnrollment(expected, callback) {
      expected = structuredClone(expected); exact(expected, ['revision', 'epoch', 'headDigest']);
      if (!positive(expected.revision) || !positive(expected.epoch) || !isHash(expected.headDigest) || typeof callback !== 'function') fail('REQUEST_INVALID');
      return locked(async parents => {
        const { records, size } = await read(parents), head = records.at(-1);
        if (!head || head.revision !== expected.revision || head.epoch !== expected.epoch || head.recordHash !== expected.headDigest) fail('STALE_HEAD');
        // Never admit against a mapping if the configured history quotas would
        // prevent its next empty-assignment revocation. Reserve the longest
        // allowed request ID; this is quota headroom, not a disk-space lease or
        // a promise that a future revocation flush will succeed.
        const revoked = { ...head.snapshot, assignments: [] };
        const body = { schemaVersion: 1, kind: 'TASK_ENROLLMENT', projectId, rootIdentity, revision: records.length + 1, epoch: records.length + 1,
          previousHash: head.recordHash, requestId: 'r'.repeat(128), expectedRevision: records.length,
          requestDigest: hash({ snapshot: revoked, expectedRevision: records.length }), snapshot: revoked, snapshotDigest: hash(revoked),
          publishedAt: new Date().toISOString(), executionAuthorized: false };
        const revocationBytes = Buffer.byteLength(`${wire({ ...body, recordHash: hash(body) })}\n`);
        if (records.length >= maxRecords || revocationBytes > MAX_RECORD_BYTES || size + revocationBytes > maxBytes) fail('REVOCATION_CAPACITY');
        return callback(freeze(head));
      });
    },
    async publish(snapshot, request) {
      snapshot = normalize(structuredClone(snapshot)); request = structuredClone(request);
      exact(request, ['expectedRevision', 'requestId']);
      if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 || !id(request.requestId)) fail('REQUEST_INVALID');
      const requestDigest = hash({ snapshot, expectedRevision: request.expectedRevision });
      return locked(async parents => {
        const state = await read(parents), prior = state.records.find(record => record.requestId === request.requestId);
        if (prior && prior.requestDigest !== requestDigest) fail('REQUEST_CONFLICT');
        if (!prior && request.expectedRevision !== state.records.length) fail('STALE_HEAD');
        const body = { schemaVersion: 1, kind: 'TASK_ENROLLMENT', projectId, rootIdentity, revision: state.records.length + 1, epoch: state.records.length + 1,
          previousHash: state.records.at(-1)?.recordHash ?? 'GENESIS', ...request, requestDigest, snapshot, snapshotDigest: hash(snapshot), publishedAt: new Date().toISOString(), executionAuthorized: false };
        const record = prior ?? { ...body, recordHash: hash(body) }, bytes = prior ? null : Buffer.from(`${wire(record)}\n`);
        if (!prior && (state.records.length >= maxRecords || bytes.length > MAX_RECORD_BYTES || state.size + bytes.length > maxBytes)) fail('QUOTA');
        await assertDirectories(parents);
        const flags = constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) | (state.info ? 0 : constants.O_CREAT | constants.O_EXCL);
        await useHandle(await open(journalPath, flags, 0o600), async handle => {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.nlink !== 1 || (state.info ? !same(state.info, opened) : opened.size !== 0)) fail('FILE_CHANGED');
          await assertDirectories(parents);
          if (bytes) await handle.writeFile(bytes);
          // Retry sync even on an idempotent retry after a failed flush.
          await handle.sync();
        });
        const after = await read(parents);
        const expectedHead = prior ? state.records.at(-1) : record;
        if (after.records.length !== (prior ? state.records.length : record.revision) || after.records.at(-1)?.recordHash !== expectedHead.recordHash) fail('PUBLICATION_UNCERTAIN');
        return freeze({ enrollment: prior ?? after.records.at(-1), idempotent: Boolean(prior), executionAuthorized: false });
      });
    },
  });
}
