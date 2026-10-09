import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, readdir, readFile, writeFile, appendFile, link } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { currentComponentPlanInput } from '../src/engine/componentPlanSeed.js';
import { publishComponentPlans, inspectComponentPlans } from '../src/node/componentPlanStore.mjs';
import { withCurrentFolderContract, publishFolderContract, inspectFolderContracts } from '../src/node/folderContractStore.mjs';
import { withCurrentArchitectureContract, publishArchitectureContract } from '../src/node/architectureContractStore.mjs';
import { freezeArchitectureContract } from '../src/engine/rulebookEngine.js';
import { bindComponentParents, componentArchitectureInput } from './fixtures/componentParents.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-components-parents-'));
  const seed = structuredClone(currentComponentPlanInput);
  for (const item of seed.components) item.handover.openQuestions = [];
  const input = await bindComponentParents(root, seed);
  return { root, input, request: { planId: input.planId, expectedRevision: 0, expectedHeadDigest: 'GENESIS' }, options: { actor: 'fixture-owner' } };
}
const binding = input => ({ revision: input.folderRevision, contractDigest: input.folderDigest });

test('fabricated, foreign and stale parents cannot publish component authority', async () => {
  const f = await fixture();
  await assert.rejects(publishComponentPlans(f.root, f.input, f.request, { actor: {} }), /exact plan and actor/);
  for (const change of [{ architectureDigest: 'f'.repeat(64) }, { folderDigest: 'f'.repeat(64) }, { architectureRevision: 2 }, { folderRevision: 2 }]) {
    await assert.rejects(publishComponentPlans(f.root, { ...f.input, ...change }, f.request, f.options), /head is stale/);
  }
  await assert.rejects(publishComponentPlans(f.root, { ...f.input, planId: 'OTHER-PLAN' }, { ...f.request, planId: 'OTHER-PLAN' }, f.options), /head is unavailable/);
  assert.equal((await inspectComponentPlans(f.root, f.input.planId)).revision, 0);
});

test('folder custody refuses multiply linked and foreign embedded project history', async () => {
  for (const variant of ['hardlink', 'foreign']) {
    const f = await fixture();
    const directory = path.join(f.root, 'folder-contracts', (await readdir(path.join(f.root, 'folder-contracts')))[0]);
    const file = path.join(directory, '00000001.json');
    if (variant === 'hardlink') await link(file, `${file}.preserved-link`);
    else {
      const record = JSON.parse(await readFile(file, 'utf8')); record.contract.planId = 'OTHER-PLAN';
      const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
      const { recordHash, ...body } = record;
      record.recordHash = createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex'); await writeFile(file, JSON.stringify(record));
    }
    await assert.rejects(inspectFolderContracts(f.root, f.input.planId), /bounded regular|identity or approval/);
    await assert.rejects(withCurrentFolderContract(f.root, f.input.planId, binding(f.input), () => assert.fail('Do not admit invalid history')), /bounded regular|identity or approval/);
  }
});

test('folder history growth during open cannot trigger an unbounded read or callback', async t => {
  const f = await fixture();
  const directory = path.join(f.root, 'folder-contracts', (await readdir(path.join(f.root, 'folder-contracts')))[0]);
  const file = path.join(directory, '00000001.json'), originalSize = (await fs.stat(file)).size;
  const originalOpen = fs.open; let changed = false, bytesRead = 0;
  const mock = t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === file) {
      const originalRead = handle.read.bind(handle);
      handle.read = async (...readArgs) => { if (!changed) { changed = true; await appendFile(file, ' '.repeat(2_000_000)); } const result = await originalRead(...readArgs); bytesRead += result.bytesRead; return result; };
    }
    return handle;
  });
  syncBuiltinESMExports();
  try { await assert.rejects(withCurrentFolderContract(f.root, f.input.planId, binding(f.input), () => assert.fail('Do not admit changed history')), /changed during read/); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(changed, true); assert.ok(bytesRead <= originalSize + 1);
});

test('unknown folder, file boundary escape and prefix lookalikes refuse', async () => {
  const f = await fixture();
  const unknown = structuredClone(f.input); unknown.inventory[0].folderNodeId = unknown.components[0].folderNodeId = 'F999';
  await assert.rejects(publishComponentPlans(f.root, unknown, f.request, f.options), /unknown approved folder/);
  for (const claimed of ['src-other/escape.js', 'src/../escape.js', 'src/./escape.js', 'src/file:stream', 'elsewhere/file.js', 'unapproved-root.config.mjs', 'src/file. ', 'src/NUL.js', 'src/con', 'src/x?.js']) {
    const input = structuredClone(f.input); input.components[0].fileClaims[0].path = claimed;
    await assert.rejects(publishComponentPlans(f.root, input, f.request, f.options), /outside its exact approved folder/);
  }
  const collision = structuredClone(f.input);
  collision.components[1].fileClaims[0] = { ...collision.components[0].fileClaims[0], path: collision.components[0].fileClaims[0].path.toUpperCase().replace('SRC/', 'src/') };
  await assert.rejects(publishComponentPlans(f.root, collision, f.request, f.options), /case-insensitive write collision/);
});

test('primary folder does not exclude explicitly approved tests/configuration claims', async () => {
  const f = await fixture();
  const crossRoot = f.input.components.find(component => new Set(component.fileClaims.map(claim => claim.path.split('/')[0])).size > 1);
  assert.ok(crossRoot, 'Keep a real multi-root dossier in the fixture');
  assert.ok(f.input.components.some(component => component.fileClaims.some(claim => !claim.path.includes('/'))), 'Keep explicit root-file obligations');
  let folder;
  await withCurrentFolderContract(f.root, f.input.planId, binding(f.input), value => { folder = value; });
  assert.ok(folder.nodes.some(node => node.kind === 'file' && !node.path.includes('/')));
  assert.ok(folder.nodes.filter(node => node.kind === 'folder').length > 1);
  const saved = await publishComponentPlans(f.root, f.input, f.request, f.options);
  assert.equal(saved.head.claimCount, f.input.components.reduce((sum, component) => sum + component.fileClaims.length, 0));
  assert.equal(saved.head.componentCount, f.input.components.length);
});

test('publication snapshots caller input before awaits and exposes exact parents', async () => {
  const f = await fixture(), original = structuredClone(f.input);
  const pending = publishComponentPlans(f.root, f.input, f.request, f.options);
  f.input.components[0].folderNodeId = 'F999'; f.request.planId = 'changed';
  const result = await pending;
  const state = await inspectComponentPlans(f.root, original.planId);
  for (const field of ['architectureDigest', 'architectureRevision', 'folderDigest', 'folderRevision']) {
    assert.equal(result.head[field], original[field]); assert.equal(state.head[field], original[field]);
  }
});

test('ordered parent locks exclude parent publishers through callback then release', async () => {
  const f = await fixture();
  const nextInput = componentArchitectureInput(); nextInput.answers.costCeiling = '$9/run';
  const next = await freezeArchitectureContract(nextInput, { planId: f.input.planId, actor: 'fixture-owner', approvedAt: '2026-09-03T00:00:00.000Z' });
  await withCurrentArchitectureContract(f.root, f.input.planId, { revision: 1, contractDigest: f.input.architectureDigest }, () => withCurrentFolderContract(f.root, f.input.planId, binding(f.input), async folder => {
    assert.equal(folder.digest, f.input.folderDigest);
    await assert.rejects(publishArchitectureContract(f.root, next, { actor: 'fixture-owner', supersedes: f.input.architectureDigest, timeoutMs: 20, retryMs: 5 }), /lock|timeout|timed/i);
    await assert.rejects(publishComponentPlans(f.root, f.input, f.request, { ...f.options, timeoutMs: 20 }), /lock|timeout|timed/i);
  }), { actor: 'fixture-owner' });
  await publishComponentPlans(f.root, f.input, f.request, f.options);
  await publishArchitectureContract(f.root, next, { actor: 'fixture-owner', supersedes: f.input.architectureDigest });
  await assert.rejects(publishComponentPlans(f.root, f.input, f.request, f.options), /architecture head is stale/);
});

test('superseding real folder blocks previous component binding', async () => {
  const f = await fixture(); let folder;
  await withCurrentFolderContract(f.root, f.input.planId, binding(f.input), value => { folder = value; });
  folder.nodes[0].purpose += ' updated boundary';
  await publishFolderContract(f.root, folder, { planId: f.input.planId, architectureContractDigest: f.input.architectureDigest, architectureRevision: 1, expectedRevision: 1, expectedHeadDigest: f.input.folderDigest }, f.options);
  await assert.rejects(publishComponentPlans(f.root, f.input, f.request, f.options), /folder head is stale/);
});

test('folder writer refuses approvals that its reader would reject without appending history', async () => {
  const f = await fixture(); let folder;
  await withCurrentFolderContract(f.root, f.input.planId, binding(f.input), value => { folder = value; });
  folder.nodes[0].purpose += ' reviewed successor';
  const request = { planId: f.input.planId, architectureContractDigest: f.input.architectureDigest, architectureRevision: 1, expectedRevision: 1, expectedHeadDigest: f.input.folderDigest };
  for (const options of [{ actor: {} }, { actor: 'fixture-owner', timestamp: '2026-09-02' }, { actor: 'fixture-owner', timestamp: nowNumber() }]) {
    await assert.rejects(publishFolderContract(f.root, folder, request, options), /exact plan and actor|canonical approval timestamp/);
    const state = await inspectFolderContracts(f.root, f.input.planId);
    assert.equal(state.revision, 1); assert.equal(state.head.contractDigest, f.input.folderDigest);
  }
});
function nowNumber() { return 0; }

test('rehashing a foreign embedded project or mismatched approver does not legitimize history', async () => {
  for (const field of ['planId', 'registeredBy']) {
    const f = await fixture(); await publishComponentPlans(f.root, f.input, f.request, f.options);
    const directory = path.join(f.root, 'component-catalogs', (await readdir(path.join(f.root, 'component-catalogs')))[0]);
    const file = path.join(directory, '00000001.json'); const record = JSON.parse(await readFile(file, 'utf8'));
    if (field === 'planId') record.contract.planId = 'OTHER-PLAN'; else record.registeredBy = 'other-owner';
    const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
    const { recordHash, ...body } = record;
    record.recordHash = createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex');
    await writeFile(file, JSON.stringify(record));
    await assert.rejects(inspectComponentPlans(f.root, f.input.planId), /identity or approval/);
  }
});
