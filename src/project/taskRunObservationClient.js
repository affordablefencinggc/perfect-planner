import { validateTaskDraftLedger } from './taskDraftLedger.js';

const PREFIX = '/api/task-run-observations';
const MAX_BYTES = 2 * 1024 * 1024;
const fail = () => { throw new Error('TASK_RUN_OBSERVATIONS_UNAVAILABLE'); };
const exact = (value, fields) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('|') !== [...fields].sort().join('|')) fail();
};
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const token = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

async function readJson(response, limit, signal) {
  if (!response?.ok || !/^application\/json(?:\s*;.*)?$/i.test(response.headers.get('content-type') ?? '')) fail();
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) fail();
  const reader = response.body?.getReader();
  if (!reader) fail();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let length = 0;
  const chunks = [];
  try {
    for (;;) {
      if (signal.aborted) fail();
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) fail();
      length += value.byteLength;
      if (length > limit) fail();
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    signal.removeEventListener('abort', cancel);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function validateObservations(value, ledger) {
  exact(value, ['schemaVersion', 'binding', 'ledgerRevision', 'authorityVerified', 'runs', 'ledgerSource', 'currentHostLedgerVerified']);
  exact(value.binding, ['projectId', 'rootIdentity', 'censusDigest']);
  if (value.schemaVersion !== 1 || value.ledgerRevision !== ledger.revision
      || Object.keys(ledger.binding).some(key => value.binding[key] !== ledger.binding[key])
      || value.authorityVerified !== false || value.currentHostLedgerVerified !== false
      || value.ledgerSource !== 'renderer-supplied-draft' || !Array.isArray(value.runs) || value.runs.length > 1000) fail();
  const seen = new Set();
  for (const run of value.runs) {
    exact(run, ['runId', 'taskId', 'attemptId', 'attemptNumber', 'checkId', 'ledgerMatch', 'admittedAt', 'terminalAt', 'state', 'exitCode', 'timedOut', 'outputTruncated', 'failureStage', 'cleanup', 'artifactDigest', 'artifactVerified', 'authorityVerified', 'cause', 'nextAction']);
    if (typeof run.runId !== 'string' || !/^[a-f0-9-]{36}$/.test(run.runId) || seen.has(run.runId)
        || typeof run.taskId !== 'string' || !/^T\d{4,6}$/.test(run.taskId) || Number(run.taskId.slice(1)) < 1
        || run.taskId !== `T${String(Number(run.taskId.slice(1))).padStart(4, '0')}`
        || !token(run.attemptId) || !token(run.checkId) || !Number.isSafeInteger(run.attemptNumber) || run.attemptNumber < 1
        || !['current-draft', 'historical-or-changed'].includes(run.ledgerMatch)
        || !timestamp(run.admittedAt) || (run.terminalAt !== null && (!timestamp(run.terminalAt) || Date.parse(run.terminalAt) < Date.parse(run.admittedAt)))
        || run.artifactVerified !== false || run.authorityVerified !== false || run.cause !== 'unknown'
        || typeof run.nextAction !== 'string' || !run.nextAction.trim() || run.nextAction.length > 1000 || /[\u0000-\u001f]/.test(run.nextAction)
        || !['complete', 'incomplete', 'unknown'].includes(run.cleanup)) fail();
    seen.add(run.runId);
    if (run.ledgerMatch === 'current-draft' && !ledger.tasks.some(task => task.id === run.taskId && !task.archived)) fail();
    if (run.state === 'unresolved') {
      if (run.exitCode !== null || run.timedOut !== null || run.outputTruncated !== null || run.artifactDigest !== null || run.cleanup !== 'unknown'
          || (run.terminalAt === null ? run.failureStage !== null : !['execution', 'isolation-validation', 'artifact-persistence', 'terminal-receipt-persistence'].includes(run.failureStage))) fail();
    } else {
      if (!['failure-observed', 'result-unverified'].includes(run.state) || run.terminalAt === null || run.failureStage !== null
          || !digest(run.artifactDigest) || typeof run.timedOut !== 'boolean' || typeof run.outputTruncated !== 'boolean'
          || (run.exitCode !== null && (!Number.isSafeInteger(run.exitCode) || Math.abs(run.exitCode) > 4294967295))) fail();
      const failed = (run.exitCode !== null && run.exitCode !== 0) || run.timedOut || run.outputTruncated;
      if ((run.state === 'failure-observed') !== failed) fail();
    }
  }
  return freeze(value);
}

export async function readTaskRunObservationsForDraft(ledger, { signal, fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  let timer;
  const abort = () => controller.abort();
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = () => reject(new Error('TASK_RUN_OBSERVATIONS_UNAVAILABLE')); });
  controller.signal.addEventListener('abort', rejectAbort, { once: true });
  try {
    const snapshot = validateTaskDraftLedger(structuredClone(ledger));
    if (typeof fetchImpl !== 'function' || signal?.aborted) fail();
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(abort, 6000);
    const work = (async () => {
      const post = (suffix, headers, body) => fetchImpl(`${PREFIX}/${suffix}`, {
        method: 'POST', mode: 'same-origin', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
        signal: controller.signal, headers: { 'Content-Type': 'application/json', ...headers }, body,
      });
      const session = await readJson(await post('session', {}, '{}'), 4096, controller.signal);
      exact(session, ['schemaVersion', 'token', 'executionAuthorized']);
      if (session.schemaVersion !== 1 || !digest(session.token) || session.executionAuthorized !== false || controller.signal.aborted) fail();
      const response = await readJson(await post('read', { 'x-pp-observation-token': session.token }, JSON.stringify({ ledger: snapshot })), MAX_BYTES, controller.signal);
      if (controller.signal.aborted) fail();
      return validateObservations(response, snapshot);
    })();
    return await Promise.race([work, aborted]);
  } catch { fail(); }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', rejectAbort);
    controller.abort();
  }
}
