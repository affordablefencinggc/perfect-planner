import { createHash } from 'node:crypto';
import path from 'node:path';
import { assertProjectId } from '../project/projectIds.js';

// Host-authored review data only. This does not resolve, read or execute paths.
// Approval/grant policy, executable bytes, candidate content and canonical cwd
// containment (including links/junctions) must be verified by the actual host
// admission boundary later. A valid contract is never an execution capability.
const MAX_BYTES = 1024 * 1024;
const TOP_KEYS = ['schemaVersion', 'kind', 'projectId', 'rootIdentity', 'policyVersion', 'policyDigest', 'tasks'];
const fail = () => { throw new Error('TASK_CHECK_CONTRACT_INVALID'); };
const exact = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) fail();
};
const integer = (value, min, max) => { if (!Number.isSafeInteger(value) || value < min || value > max) fail(); };
const digest = value => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(); };
const text = (value, max, empty = false) => {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.length) || /[\u0000-\u001f\u007f]/.test(value)
      || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) fail();
};
const token = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) fail(); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const serialize = value => JSON.stringify(canonical(value));
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const windowsAlias = part => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part);

function dense(array, min, max, visit) {
  if (!Array.isArray(array) || array.length < min || array.length > max
      || Object.keys(array).length !== array.length) fail();
  for (let index = 0; index < array.length; index++) {
    if (!Object.hasOwn(array, index)) fail();
    visit(array[index]);
  }
}

export function createTaskCheckContract(input) {
  try {
    // Capture all review data synchronously; no caller-owned arrays escape.
    const value = structuredClone(input);
    exact(value, TOP_KEYS);
    if (value.schemaVersion !== 1 || value.kind !== 'TASK_CHECK_CONTRACT') fail();
    assertProjectId(value.projectId); digest(value.rootIdentity); digest(value.policyDigest);
    integer(value.policyVersion, 1, Number.MAX_SAFE_INTEGER);
    const taskIds = new Set(); let totalChecks = 0;
    dense(value.tasks, 1, 256, task => {
      exact(task, ['taskId', 'checks']);
      if (typeof task.taskId !== 'string' || !/^T\d{4,6}$/.test(task.taskId) || Number(task.taskId.slice(1)) < 1
          || task.taskId !== `T${String(Number(task.taskId.slice(1))).padStart(4, '0')}` || taskIds.has(task.taskId)) fail();
      taskIds.add(task.taskId);
      const checkIds = new Set();
      dense(task.checks, 1, 256, check => {
        exact(check, ['checkId', 'executablePath', 'executableDigest', 'args', 'cwd', 'timeoutMs', 'outputLimits']);
        token(check.checkId);
        if (checkIds.has(check.checkId) || ++totalChecks > 256) fail();
        checkIds.add(check.checkId); digest(check.executableDigest);
        text(check.executablePath, 4096);
        if (!path.isAbsolute(check.executablePath) || path.normalize(check.executablePath) !== check.executablePath
            || check.executablePath === path.parse(check.executablePath).root || check.executablePath.endsWith(path.sep)
            || (process.platform === 'win32' && (check.executablePath.startsWith('\\\\')
              || check.executablePath.slice(path.parse(check.executablePath).root.length).split(path.sep).some(part => /[:*?"<>|]/.test(part) || windowsAlias(part))))) fail();
        let argumentBytes = 0;
        dense(check.args, 0, 64, arg => { text(arg, 4096, true); argumentBytes += Buffer.byteLength(arg); });
        if (argumentBytes > 32768) fail();
        text(check.cwd, 1024);
        if (check.cwd !== '.' && (check.cwd.includes('\\') || check.cwd.split('/').some(part => !part || part === '.' || part === '..' || /[:*?"<>|]/.test(part) || windowsAlias(part)))) fail();
        integer(check.timeoutMs, 1, 300000);
        exact(check.outputLimits, ['stdoutBytes', 'stderrBytes', 'combinedBytes']);
        for (const key of Object.keys(check.outputLimits)) integer(check.outputLimits[key], 1, 2 * 1024 * 1024);
        if (check.outputLimits.combinedBytes > check.outputLimits.stdoutBytes + check.outputLimits.stderrBytes) fail();
      });
    });
    // Task/check ordering is deliberate: preserve the host-authored order. Only
    // object member order is irrelevant to the version-one digest.
    const bytes = serialize(value);
    if (Buffer.byteLength(bytes) > MAX_BYTES) fail();
    return freeze({ ...value, contractDigest: createHash('sha256').update(bytes).digest('hex'), executionAuthorized: false, authorityVerified: false });
  } catch { fail(); }
}

export function verifyTaskCheckContract(input) {
  try {
    const value = structuredClone(input);
    exact(value, [...TOP_KEYS, 'contractDigest', 'executionAuthorized', 'authorityVerified']);
    if (value.executionAuthorized !== false || value.authorityVerified !== false) fail();
    digest(value.contractDigest);
    const { contractDigest, executionAuthorized, authorityVerified, ...body } = value;
    const verified = createTaskCheckContract(body);
    if (verified.contractDigest !== contractDigest) fail();
    return verified;
  } catch { fail(); }
}
