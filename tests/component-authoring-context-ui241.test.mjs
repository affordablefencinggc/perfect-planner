import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { currentComponentPlanInput } from '../src/engine/componentPlanSeed.js';
import { bindComponentParents, componentArchitectureInput } from './fixtures/componentParents.mjs';
import { inspectComponentAuthoringContext, publishComponentPlans } from '../src/node/componentPlanStore.mjs';
import { createComponentPlanMiddleware } from '../src/node/componentPlanHttp.mjs';
import { withCurrentFolderContract, publishFolderContract } from '../src/node/folderContractStore.mjs';
import { publishArchitectureContract } from '../src/node/architectureContractStore.mjs';
import { freezeArchitectureContract } from '../src/engine/rulebookEngine.js';
async function fixture(publish = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-authoring-context-'));
  const seed = structuredClone(currentComponentPlanInput);
  for (const component of seed.components) component.handover.openQuestions = [];
  const input = await bindComponentParents(root, seed);
  if (publish) await publishComponentPlans(root, input, { planId: input.planId, expectedRevision: 0, expectedHeadDigest: 'GENESIS' }, { actor: 'fixture-owner' });
  return { root, input };
}

test('ready context returns verified complete catalog and exact parents without granting actions', async () => {
  const f = await fixture(), result = await inspectComponentAuthoringContext(f.root, f.input.planId);
  assert.equal(result.ready, true); assert.equal(result.state, 'ready'); assert.equal(result.catalogState, 'current');
  assert.equal(result.catalogHead.contractDigest, result.catalog.digest);
  assert.equal(result.catalog.architectureDigest, result.architectureHead.contractDigest);
  assert.equal(result.catalog.folderDigest, result.folderHead.contractDigest);
  assert.deepEqual(result.catalog.components, f.input.components);
  assert.ok(result.folderNodes.length > 1);
  assert.equal(result.publicationAuthorized, false); assert.equal(result.executionAuthorized, false);
  result.catalog.components[0].purpose = 'caller mutation';
  assert.deepEqual((await inspectComponentAuthoringContext(f.root, f.input.planId)).catalog.components, f.input.components);
});

test('missing parents and missing catalog remain distinct; foreign plan receives no other project data', async () => {
  const f = await fixture(false);
  const ready = await inspectComponentAuthoringContext(f.root, f.input.planId);
  assert.equal(ready.ready, true); assert.equal(ready.catalogState, 'missing'); assert.equal(ready.catalog, null);
  const absent = await inspectComponentAuthoringContext(f.root, 'OTHER-PLAN');
  assert.equal(absent.ready, false); assert.equal(absent.state, 'architecture-missing'); assert.equal(absent.catalog, null); assert.deepEqual(absent.folderNodes, []);
  await rename(path.join(f.root, 'folder-contracts'), path.join(f.root, 'preserved-folder-contracts'));
  const folderMissing = await inspectComponentAuthoringContext(f.root, f.input.planId);
  assert.equal(folderMissing.state, 'folder-missing'); assert.equal(folderMissing.folderHead, null); assert.equal(folderMissing.ready, false);
});

test('saved catalog retains stale content after folder changes rather than silently rebinding', async () => {
  const f = await fixture(); let folder;
  await withCurrentFolderContract(f.root, f.input.planId, { revision: 1, contractDigest: f.input.folderDigest }, value => { folder = value; });
  folder.nodes[0].purpose += ' successor';
  await publishFolderContract(f.root, folder, { planId: f.input.planId, architectureContractDigest: f.input.architectureDigest, architectureRevision: 1, expectedRevision: 1, expectedHeadDigest: f.input.folderDigest }, { actor: 'fixture-owner' });
  const result = await inspectComponentAuthoringContext(f.root, f.input.planId);
  assert.equal(result.ready, true); assert.equal(result.catalogState, 'stale');
  assert.equal(result.catalog.folderDigest, f.input.folderDigest);
  assert.notEqual(result.folderHead.contractDigest, result.catalog.folderDigest);
});

test('advanced architecture marks folder and catalog stale; removed parent retains historical catalog', async () => {
  const f = await fixture(), nextInput = componentArchitectureInput(); nextInput.answers.costCeiling = '$19/run';
  const next = await freezeArchitectureContract(nextInput, { planId: f.input.planId, actor: 'fixture-owner', approvedAt: '2026-09-03T00:00:00.000Z' });
  await publishArchitectureContract(f.root, next, { actor: 'fixture-owner', supersedes: f.input.architectureDigest });
  const stale = await inspectComponentAuthoringContext(f.root, f.input.planId);
  assert.equal(stale.state, 'folder-stale'); assert.equal(stale.ready, false); assert.equal(stale.catalogState, 'stale');
  await rename(path.join(f.root, 'contracts'), path.join(f.root, 'preserved-architecture-contracts'));
  const missing = await inspectComponentAuthoringContext(f.root, f.input.planId);
  assert.equal(missing.state, 'architecture-missing'); assert.equal(missing.catalogState, 'stale'); assert.equal(missing.catalog.digest, stale.catalog.digest);
});

test('busy parent lock refuses context without falling back to an unlocked read', async () => {
  const f = await fixture();
  await withCurrentFolderContract(f.root, f.input.planId, { revision: 1, contractDigest: f.input.folderDigest }, async () => {
    await assert.rejects(inspectComponentAuthoringContext(f.root, f.input.planId, { timeoutMs: 20 }), /lock timeout/i);
  });
  assert.equal((await inspectComponentAuthoringContext(f.root, f.input.planId)).catalogState, 'current');
});

test('broken catalog read fails rather than presenting a fake empty catalog', async () => {
  const f = await fixture();
  const directory = path.join(f.root, 'component-catalogs', (await readdir(path.join(f.root, 'component-catalogs')))[0]);
  const file = path.join(directory, '00000001.json'), original = await readFile(file);
  await writeFile(file, '{');
  await assert.rejects(inspectComponentAuthoringContext(f.root, f.input.planId));
  assert.equal(await readFile(file, 'utf8'), '{'); assert.ok(original.length > 1);
});

test('authoring endpoint requires exact origin, capability, and bounded planId-only JSON', async t => {
  const f = await fixture(false), middleware = createComponentPlanMiddleware({ root: f.root, actor: 'fixture-owner', token: 'context-fixture-token' });
  const server = createServer((req, res) => middleware(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (body, token = 'context-fixture-token', requestOrigin = origin) => fetch(`${origin}/api/component-plans/authoring-context`, { method: 'POST', headers: { origin: requestOrigin, 'content-type': 'application/json', 'x-pp-component-token': token }, body: JSON.stringify(body) });
  assert.equal((await request({ planId: f.input.planId })).status, 200);
  assert.equal((await request({ planId: f.input.planId }, '')).status, 403);
  assert.equal((await request({ planId: f.input.planId }, 'context-fixture-token', 'https://other.invalid')).status, 403);
  for (const body of [{ planId: f.input.planId, actor: 'forged' }, {}, null, [], { planId: 'x'.repeat(1100) }]) assert.equal((await request(body)).status, 400);
});
