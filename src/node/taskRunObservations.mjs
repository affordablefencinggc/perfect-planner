import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyJournalEntries } from './journalStore.mjs';
import { parseTaskAttempt, parseTaskCheckResult, inspectTaskAttemptResults } from './taskOutcomeContract.mjs';
import { parseTaskDraftImport } from '../project/taskDraftLedger.js';

const fail = () => { throw new Error('TASK_RUN_OBSERVATIONS_UNAVAILABLE'); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const frozen = value => { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; };
const same = (a,b) => a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && b.isFile() && !b.isSymbolicLink() && b.nlink === 1;

// Host-configured path only. Renderer/tool requests must not select a file.
// A bounded consistent read is not proof of producer or filesystem authority.
async function readEntries(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) fail();
  const parents = [];
  for (let cursor = path.dirname(file);;) {
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) fail();
    parents.push({name:cursor,ino:info.ino,dev:info.dev});
    const next = path.dirname(cursor); if (next === cursor) break; cursor = next;
  }
  if (path.relative(path.dirname(file), await realpath(path.dirname(file)))) fail();
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8 * 1024 * 1024) fail();
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!same(info,await handle.stat())) fail();
    const bytes = Buffer.alloc(info.size + 1); let length = 0;
    while (length < bytes.length) { const next = await handle.read(bytes,length,Math.min(65536,bytes.length-length),length); if (!next.bytesRead) break; length += next.bytesRead; }
    if (length !== info.size || !same(info,await handle.stat()) || !same(info,await lstat(file))) fail();
    for (const parent of parents) { const current = await lstat(parent.name); if (!current.isDirectory() || current.isSymbolicLink() || current.ino !== parent.ino || current.dev !== parent.dev) fail(); }
    const wire = new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length));
    if (wire && !wire.endsWith('\n')) fail();
    const lines = wire.split(/\r?\n/).filter(Boolean);
    if (lines.length > 10000) fail();
    const entries = lines.map(line => JSON.parse(line));
    if (!verifyJournalEntries(entries).valid) fail();
    return entries;
  } finally { await handle.close(); }
}

export async function readTaskRunObservations({ journalPath, ledgerWire }) {
  try {
    const ledger = parseTaskDraftImport(ledgerWire), ledgerDigest = digest(ledger);
    const entries = await readEntries(journalPath), runs = new Map(), terminalRuns = new Set();
    for (const entry of entries) {
      if (!['proof-admitted','prove','proof-unresolved'].includes(entry.action) || !entry.payload?.taskContext) continue;
      const payload = entry.payload, context = payload.taskContext;
      const attempt = parseTaskAttempt(JSON.stringify(context.attempt));
      if (attempt.binding.projectId !== ledger.binding.projectId || attempt.binding.rootIdentity !== ledger.binding.rootIdentity) continue;
      if (typeof entry.timestamp !== 'string' || !Number.isFinite(Date.parse(entry.timestamp)) || new Date(entry.timestamp).toISOString() !== entry.timestamp) fail();
      if (typeof payload.runId !== 'string' || !/^[a-f0-9-]{36}$/.test(payload.runId) || !attempt.requiredCheckIds.includes(context.checkId) || payload.itemId !== attempt.binding.taskId) fail();
      const task = ledger.tasks.find(task => task.id === attempt.binding.taskId);
      if (entry.action === 'proof-admitted') {
        if (runs.has(payload.runId) || runs.size >= 1000) fail();
        const current = ledger.revision === attempt.binding.ledgerRevision && ledgerDigest === attempt.binding.ledgerDigest && task && digest(task) === attempt.binding.taskDigest && !task.archived;
        runs.set(payload.runId, { runId:payload.runId, taskId:attempt.binding.taskId, attemptId:attempt.attemptId, attemptNumber:attempt.attemptNumber, checkId:context.checkId,
          ledgerMatch:current ? 'current-draft' : 'historical-or-changed', admittedAt:entry.timestamp, terminalAt:null,
          state:'unresolved', exitCode:null, timedOut:null, outputTruncated:null, failureStage:null, cleanup:'unknown', artifactDigest:null, artifactVerified:false, authorityVerified:false,
          cause:'unknown', nextAction:'Inspect the retained run; completion and process cleanup are not established.', contextDigest:digest(context) });
      } else {
        const run = runs.get(payload.runId);
        if (!run || terminalRuns.has(payload.runId) || run.contextDigest !== digest(context) || Date.parse(entry.timestamp) < Date.parse(run.admittedAt)) fail();
        terminalRuns.add(payload.runId);
        run.terminalAt = entry.timestamp;
        if (entry.action === 'prove') {
          const result = parseTaskCheckResult(JSON.stringify(payload.taskCheckResult));
          inspectTaskAttemptResults(JSON.stringify(attempt),[JSON.stringify(result)]);
          if (result.checkId !== context.checkId || result.artifactDigest !== payload.sha256) fail();
          if (result.exitCode !== (payload.exit ?? null) || result.timedOut !== payload.timedOut || result.outputTruncated !== payload.outputOverflow) fail();
          run.exitCode = result.exitCode; run.cleanup = result.cleanup; run.artifactDigest = result.artifactDigest;
          run.timedOut = result.timedOut; run.outputTruncated = result.outputTruncated;
          run.state = result.exitCode !== null && result.exitCode !== 0 || result.timedOut || result.outputTruncated ? 'failure-observed' : 'result-unverified';
          run.nextAction = run.state === 'failure-observed' ? 'Review this check and its retained artifact before retrying.' : 'Verify task authority, complete acceptance and artifact evidence before marking the task complete.';
        } else {
          if (!['execution','isolation-validation','artifact-persistence','terminal-receipt-persistence'].includes(payload.failureStage)) fail();
          run.failureStage = payload.failureStage;
          run.nextAction = 'Inspect retained run evidence before retrying; process cleanup is unverified.';
        }
      }
    }
    return frozen({ schemaVersion:1, binding:ledger.binding, ledgerRevision:ledger.revision, authorityVerified:false,
      runs:[...runs.values()].map(({contextDigest,...run})=>run) });
  } catch { fail(); }
}
