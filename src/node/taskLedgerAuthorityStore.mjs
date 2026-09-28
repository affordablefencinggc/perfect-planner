import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { assertProjectId } from '../project/projectIds.js';
import { validateTaskDraftLedger } from '../project/taskDraftLedger.js';
import { withPlanLock } from './planLock.mjs';

// Host-configured proposal custody only: no approval, execution grant or human
// identity is inferred. File sync is performed, but directory entries are not
// flushed portably; power-loss durability of first creation is not guaranteed.
// Locks coordinate cooperating writers. Hashes do not defeat arbitrary same-user
// replacement, deletion, rollback or changes between filesystem checks.
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS = 64;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const fail = code => { throw new Error(`TASK_LEDGER_${code}`); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const wire = value => JSON.stringify(canonical(value));
const hash = value => createHash('sha256').update(wire(value)).digest('hex');
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) fail('INVALID'); };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const same = (a, b) => b.isFile() && !b.isSymbolicLink() && b.nlink === 1 && a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

async function directories(parent) {
  const snapshot = [];
  for (let cursor = parent;;) {
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('UNSAFE_PATH');
    snapshot.push({ name: cursor, ino: info.ino, dev: info.dev });
    const next = path.dirname(cursor); if (next === cursor) break; cursor = next;
  }
  if (path.relative(parent, await realpath(parent))) fail('UNSAFE_PATH');
  return snapshot;
}
async function checkDirectories(snapshot) {
  for (const item of snapshot) {
    const info = await lstat(item.name);
    if (!info.isDirectory() || info.isSymbolicLink() || info.ino !== item.ino || info.dev !== item.dev) fail('PATH_CHANGED');
  }
}
async function fileInfo(file) {
  try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('UNSAFE_FILE'); return info; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function checkLock(file) {
  const directory = `${file}.pp-lock`;
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('UNSAFE_LOCK');
    const holder = await fileInfo(path.join(directory, 'holder.json'));
    if (holder && holder.size > 4096) fail('UNSAFE_LOCK');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export function createTaskLedgerAuthorityStore({ journalPath, projectId, rootIdentity, maxBytes = MAX_BYTES, maxRecords = MAX_RECORDS } = {}) {
  assertProjectId(projectId);
  if (typeof journalPath !== 'string' || !path.isAbsolute(journalPath) || path.normalize(journalPath) !== journalPath
      || /[:\u0000]/.test(path.basename(journalPath)) || /[. ]$/.test(path.basename(journalPath))
      || !isHash(rootIdentity) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES
      || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_RECORDS) fail('CONFIG_INVALID');
  // Parent must already exist and belong to the host. Requests never create or
  // select a storage root, and cannot register a different project/root.
  const parent = path.dirname(journalPath);
  function normalize(ledger) {
    const value = validateTaskDraftLedger(ledger);
    if (value.binding.projectId !== projectId || value.binding.rootIdentity !== rootIdentity) fail('BINDING_MISMATCH');
    return value;
  }
  function requestBody(ledger, request) { return { ledger, expectedRevision: request.expectedRevision, expectedHeadDigest: request.expectedHeadDigest }; }
  function validateRecords(bytes) {
    if (!bytes.length) return [];
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.endsWith('\n')) fail('CORRUPT');
    const lines = text.slice(0, -1).split('\n');
    if (lines.length > maxRecords) fail('QUOTA');
    const ids = new Set(); let previous = 'GENESIS';
    return lines.map((line, index) => {
      if (!line || Buffer.byteLength(line) > MAX_RECORD_BYTES) fail('CORRUPT');
      const record = JSON.parse(line);
      exact(record, ['schemaVersion', 'kind', 'hostRevision', 'previousHash', 'requestId', 'requestDigest', 'expectedRevision', 'expectedHeadDigest', 'ledgerDigest', 'ledger', 'receivedAt', 'executionAuthorized', 'recordHash']);
      const ledger = normalize(record.ledger);
      if (record.schemaVersion !== 1 || record.kind !== 'TASK_LEDGER_PROPOSAL' || record.executionAuthorized !== false
          || record.hostRevision !== index + 1 || record.previousHash !== previous || record.expectedRevision !== index || record.expectedHeadDigest !== previous
          || typeof record.requestId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(record.requestId) || ids.has(record.requestId)
          || typeof record.receivedAt !== 'string' || !Number.isFinite(Date.parse(record.receivedAt)) || new Date(record.receivedAt).toISOString() !== record.receivedAt
          || wire(ledger) !== wire(record.ledger) || record.ledgerDigest !== hash(ledger) || record.requestDigest !== hash(requestBody(ledger, record))) fail('CORRUPT');
      const { recordHash, ...body } = record;
      if (recordHash !== hash(body)) fail('CORRUPT');
      previous = recordHash; ids.add(record.requestId);
      return record;
    });
  }
  async function read(snapshot) {
    await checkDirectories(snapshot);
    const info = await fileInfo(journalPath);
    if (!info) return { records: [], size: 0, info: null };
    if (info.size === 0) fail('CORRUPT');
    if (info.size > maxBytes) fail('QUOTA');
    const handle = await open(journalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      if (!same(info, await handle.stat())) fail('FILE_CHANGED');
      const bytes = Buffer.alloc(info.size + 1); let length = 0;
      while (length < bytes.length) { const result = await handle.read(bytes, length, Math.min(65536, bytes.length - length), length); if (!result.bytesRead) break; length += result.bytesRead; }
      const current = await fileInfo(journalPath);
      if (length !== info.size || !same(info, await handle.stat()) || !current || !same(info, current)) fail('FILE_CHANGED');
      await checkDirectories(snapshot);
      return { records: validateRecords(bytes.subarray(0, length)), size: length, info };
    } finally { await handle.close(); }
  }
  async function locked(operation) {
    const snapshot = await directories(parent);
    await checkLock(journalPath);
    return withPlanLock(journalPath, { actor: 'task-ledger-proposal-store', timeoutMs: 5000, retryMs: 10 }, async () => {
      await checkDirectories(snapshot);
      return operation(snapshot);
    });
  }
  const visible = records => freeze({ schemaVersion: 1, projectId, rootIdentity, hostRevision: records.length,
    headDigest: records.at(-1)?.recordHash ?? 'GENESIS', proposals: records, executionAuthorized: false, approvalState: 'unapproved-proposal' });
  return Object.freeze({
    inspect: () => locked(async snapshot => visible((await read(snapshot)).records)),
    // Recovery-only host composition. Retained history is not current approval
    // or execution authority. Callers must never substitute this for admission.
    async withRetainedProposal(expected,operation){
      expected=structuredClone(expected);exact(expected,['hostRevision','headDigest']);
      if(!Number.isSafeInteger(expected.hostRevision)||expected.hostRevision<1||!isHash(expected.headDigest)||typeof operation!=='function')fail('REQUEST_INVALID');
      return locked(async snapshot=>{
        const state=await read(snapshot),record=state.records[expected.hostRevision-1];
        if(!record||record.recordHash!==expected.headDigest)fail('HISTORY_MISMATCH');
        return operation(freeze(record));
      });
    },
    // Host composition only. Lock order: proposal store before confirmation
    // store. The callback must never acquire this proposal lock recursively.
    async withCurrentProposal(expected, operation) {
      expected=structuredClone(expected);
      exact(expected,['hostRevision','headDigest']);
      if(!Number.isSafeInteger(expected.hostRevision)||expected.hostRevision<1||!isHash(expected.headDigest)||typeof operation!=='function')fail('REQUEST_INVALID');
      return locked(async snapshot=>{
        const state=await read(snapshot),head=state.records.at(-1);
        if(!head||head.hostRevision!==expected.hostRevision||head.recordHash!==expected.headDigest)fail('STALE_HEAD');
        return operation(freeze(head));
      });
    },
    async propose(ledger, request) {
      ledger = normalize(structuredClone(ledger)); request = structuredClone(request);
      exact(request, ['requestId', 'expectedRevision', 'expectedHeadDigest']);
      if (typeof request.requestId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(request.requestId)
          || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0
          || !(isHash(request.expectedHeadDigest) || request.expectedHeadDigest === 'GENESIS')) fail('REQUEST_INVALID');
      const requestDigest = hash(requestBody(ledger, request));
      return locked(async snapshot => {
        const state = await read(snapshot);
        const prior = state.records.find(record => record.requestId === request.requestId);
        if (prior) {
          if (prior.requestDigest !== requestDigest) fail('REQUEST_CONFLICT');
          // A previous append may have reached storage but failed during sync.
          // An idempotent success must retry the flush, not assume it happened.
          const handle = await open(journalPath, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
          try {
            if (!same(state.info, await handle.stat())) fail('FILE_CHANGED');
            await checkDirectories(snapshot);
            await handle.sync();
          } finally { await handle.close(); }
          const current = await read(snapshot);
          if (current.size !== state.size || current.records.at(-1)?.recordHash !== state.records.at(-1)?.recordHash) fail('PUBLICATION_UNCERTAIN');
          return freeze({ proposal: prior, idempotent: true, executionAuthorized: false });
        }
        const previousHash = state.records.at(-1)?.recordHash ?? 'GENESIS';
        if (request.expectedRevision !== state.records.length || request.expectedHeadDigest !== previousHash) fail('STALE_HEAD');
        const body = { schemaVersion: 1, kind: 'TASK_LEDGER_PROPOSAL', hostRevision: state.records.length + 1, previousHash,
          ...request, requestDigest, ledgerDigest: hash(ledger), ledger, receivedAt: new Date().toISOString(), executionAuthorized: false };
        const record = { ...body, recordHash: hash(body) };
        const bytes = Buffer.from(`${wire(record)}\n`);
        if (state.records.length >= maxRecords || bytes.length > MAX_RECORD_BYTES || state.size + bytes.length > maxBytes) fail('QUOTA');
        await checkDirectories(snapshot);
        const flags = constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
          | (state.info ? 0 : constants.O_CREAT | constants.O_EXCL);
        const handle = await open(journalPath, flags, 0o600);
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.nlink !== 1 || (state.info ? !same(state.info, opened) : opened.size !== 0)) fail('FILE_CHANGED');
          await checkDirectories(snapshot);
          await handle.writeFile(bytes); await handle.sync();
        } finally { await handle.close(); }
        const after = await read(snapshot);
        if (after.records.length !== record.hostRevision || after.records.at(-1)?.recordHash !== record.recordHash) fail('PUBLICATION_UNCERTAIN');
        return freeze({ proposal: after.records.at(-1), idempotent: false, executionAuthorized: false });
      });
    },
  });
}
