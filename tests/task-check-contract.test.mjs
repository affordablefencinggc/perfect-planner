import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTaskCheckContract, verifyTaskCheckContract } from '../src/node/taskCheckContract.mjs';

const input = () => ({ schemaVersion: 1, kind: 'TASK_CHECK_CONTRACT', projectId: 'pp_checks_fixture', rootIdentity: 'a'.repeat(64),
  policyVersion: 1, policyDigest: 'b'.repeat(64), tasks: [{ taskId: 'T0001', checks: [{ checkId: 'unit',
    executablePath: process.execPath, executableDigest: 'c'.repeat(64), args: ['test/run.mjs', '--name', 'fixed value'], cwd: '.', timeoutMs: 30000,
    outputLimits: { stdoutBytes: 1024, stderrBytes: 1024, combinedBytes: 2048 } }] }] });
const check = value => value.tasks[0].checks[0];
const refused = value => assert.throws(() => createTaskCheckContract(value), /TASK_CHECK_CONTRACT_INVALID/);

test('captures immutable host review data without conferring execution or filesystem authority', () => {
  const source = input(), contract = createTaskCheckContract(source);
  source.tasks[0].checks[0].args[0] = 'changed'; source.tasks[0].checks[0].outputLimits.stdoutBytes = 1;
  assert.deepEqual(contract.tasks[0].checks[0].args, ['test/run.mjs', '--name', 'fixed value']);
  assert.equal(contract.executionAuthorized, false); assert.equal(contract.authorityVerified, false);
  assert.equal(Object.isFrozen(contract.tasks[0].checks[0].outputLimits), true);
  assert.match(contract.contractDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(verifyTaskCheckContract(JSON.parse(JSON.stringify(contract))), contract);
});

test('canonical member order is stable while policy, arguments and check order bind the digest', () => {
  const source = input();
  source.tasks[0].checks.push({ ...structuredClone(check(source)), checkId: 'integration' });
  const original = createTaskCheckContract(source);
  const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reorder(value[key])])) : value;
  assert.equal(createTaskCheckContract(reorder(source)).contractDigest, original.contractDigest);
  for (const change of [
    value => { value.policyVersion++; }, value => { value.policyDigest = 'd'.repeat(64); },
    value => { check(value).args.reverse(); }, value => { value.tasks[0].checks.reverse(); },
    value => { check(value).executableDigest = 'd'.repeat(64); }, value => { check(value).cwd = 'tests'; },
    value => { check(value).timeoutMs++; }, value => { check(value).outputLimits.combinedBytes--; },
  ]) { const value = structuredClone(source); change(value); assert.notEqual(createTaskCheckContract(value).contractDigest, original.contractDigest); }
});

test('refuses unknown fields, forged authorization and malformed identities', () => {
  for (const change of [
    value => { value.schemaVersion = 2; }, value => { value.kind = 'APPROVED'; }, value => { value.projectId = 'other'; },
    value => { value.rootIdentity = 'A'.repeat(64); }, value => { value.policyDigest = 'bad'; }, value => { value.policyVersion = '1'; },
    value => { value.approved = true; }, value => { value.tasks[0].owner = 'worker'; }, value => { check(value).env = { PATH: 'other' }; },
    value => { value.tasks[0].taskId = 'T0000'; }, value => { value.tasks[0].taskId = 'T00001'; }, value => { check(value).checkId = 'bad id'; },
  ]) { const value = input(); change(value); refused(value); }
  const contract = createTaskCheckContract(input());
  for (const patch of [{ executionAuthorized: true }, { authorityVerified: true }, { contractDigest: '0'.repeat(64) }, { extra: false }]) {
    assert.throws(() => verifyTaskCheckContract({ ...contract, ...patch }), /TASK_CHECK_CONTRACT_INVALID/);
  }
  const changed = structuredClone(contract); check(changed).args.push('unreviewed');
  assert.throws(() => verifyTaskCheckContract(changed), /TASK_CHECK_CONTRACT_INVALID/);
});

test('refuses duplicate tasks and task-local checks, sparse arrays and population limits', () => {
  const duplicateTask = input(); duplicateTask.tasks.push(structuredClone(duplicateTask.tasks[0])); refused(duplicateTask);
  const duplicateCheck = input(); duplicateCheck.tasks[0].checks.push(structuredClone(check(duplicateCheck))); refused(duplicateCheck);
  for (const field of ['tasks', 'checks', 'args']) {
    const value = input(), target = field === 'tasks' ? value.tasks : field === 'checks' ? value.tasks[0].checks : check(value).args;
    delete target[0]; refused(value);
  }
  const empty = input(); empty.tasks = []; refused(empty);
  const tooMany = input(); tooMany.tasks[0].checks = Array.from({ length: 257 }, (_, i) => ({ ...structuredClone(check(input())), checkId: `check-${i}` })); refused(tooMany);
  const total = input(); total.tasks = Array.from({ length: 2 }, (_, i) => ({ taskId: `T000${i + 1}`, checks: Array.from({ length: 129 }, (_, j) => ({ ...structuredClone(check(input())), checkId: `check-${j}` })) })); refused(total);
  const valid = input(); valid.tasks.push({ taskId: 'T0002', checks: [structuredClone(check(valid))] });
  assert.equal(createTaskCheckContract(valid).tasks.length, 2);
});

test('rejects nonabsolute executable paths, ambiguous cwd spelling and invalid digests', () => {
  for (const executablePath of ['node', `.${path.sep}node`, path.parse(process.execPath).root, `${path.dirname(process.execPath)}${path.sep}..${path.sep}node`]) {
    const value = input(); check(value).executablePath = executablePath; refused(value);
  }
  if (process.platform === 'win32') for (const executablePath of ['C:node.exe', '\\\\server\\share\\node.exe', 'C:\\tools\\node.exe:stream', 'C:\\tools\\node.exe ', 'C:\\tools\\CON.exe']) {
    const value = input(); check(value).executablePath = executablePath; refused(value);
  }
  for (const cwd of ['', '..', '../tests', '/tests', './tests', 'tests/../src', 'tests//unit', 'tests/', 'tests\\unit', 'C:/tests', 'tests:stream', 'tests/CON', 'tests/name.']) {
    const value = input(); check(value).cwd = cwd; refused(value);
  }
  const valid = input(); check(valid).cwd = 'tests/unit'; assert.equal(createTaskCheckContract(valid).tasks[0].checks[0].cwd, 'tests/unit');
  const badDigest = input(); check(badDigest).executableDigest = 'c'.repeat(63); refused(badDigest);
});

test('argument, timeout, output and aggregate byte budgets are mandatory and finite', () => {
  for (const args of [null, 'test.mjs', Array(65).fill('x'), ['x'.repeat(4097)], Array(9).fill('x'.repeat(4096)), ['bad\u0000arg'], ['bad\narg'], ['\ud800']]) {
    const value = input(); check(value).args = args; refused(value);
  }
  for (const timeoutMs of [0, -1, 300001, Infinity, NaN, '100', 1.1]) { const value = input(); check(value).timeoutMs = timeoutMs; refused(value); }
  for (const limit of [0, -1, 2097153, Infinity, '1024', 1.5]) { const value = input(); check(value).outputLimits.stdoutBytes = limit; refused(value); }
  const impossible = input(); check(impossible).outputLimits.combinedBytes = 2049; refused(impossible);
  const unknown = input(); check(unknown).outputLimits.extra = 1; refused(unknown);
  const large = input(); large.tasks[0].checks = Array.from({ length: 256 }, (_, i) => ({ ...structuredClone(check(input())), checkId: `check-${i}`, args: ['x'.repeat(4096)] })); refused(large);
  const valid = input(); check(valid).args = ['', '😀']; assert.deepEqual(createTaskCheckContract(valid).tasks[0].checks[0].args, ['', '😀']);
});
