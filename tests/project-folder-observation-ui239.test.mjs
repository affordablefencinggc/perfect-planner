import "./helpers/hermetic-env.mjs";
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryStorage, createProjectRegistry } from '../src/project/projectRegistry.js';
import { createImportedProjectSession } from '../src/project/projectSession.js';
import { createProjectEntityId } from '../src/project/projectIds.js';

const now = Date.parse('2026-09-13T01:00:00Z');
const hash = letter => letter.repeat(64);
function setup() {
  const storage = createMemoryStorage();
  const registry = createProjectRegistry({ storage, now: () => now + 100 });
  const project = createImportedProjectSession({ name: 'App', adapter: 'browser', registration: { access: 'metadata-read-only', canonicalRoot: 'browser://app', registryRevision: 1, rootIdentity: hash('a'), workspaceId: 'workspace-app' }, now });
  registry.upsert(project);
  const architectureReceipt = { valid: true, planId: project.projectId, head: { revision: 1, contractDigest: hash('b'), registeredAt: new Date(now).toISOString() } };
  registry.recordArchitectureObservation(project.projectId, { state: 'observed', expectedRootIdentity: hash('a'), receipt: architectureReceipt });
  const observation = { state: 'observed', expectedRootIdentity: hash('a'), architectureReceipt, receipt: { valid: true, planId: project.projectId, head: { revision: 1, contractDigest: hash('c'), registeredAt: new Date(now).toISOString(), architectureContractDigest: hash('b'), architectureRevision: 1 } } };
  return { registry, project, storage, observation };
}

test('folder requires exact freshly checked parent and merges latest project view', () => {
  const { registry, project, storage, observation } = setup();
  const other = createProjectRegistry({ storage, now: () => now + 200 });
  other.updateView(project.projectId, { workspace: 'ledger' });
  const result = registry.recordFolderObservation(project.projectId, observation);
  assert.equal(result.persisted, true);
  assert.equal(result.project.authorities.folder.state, 'authoritative');
  assert.equal(result.project.provenance['authority.folder'].state, 'authoritative');
  assert.equal(result.project.provenance['authority.folder'].digest, hash('c'));
  assert.equal(result.project.view.workspace, 'ledger');
  assert.deepEqual(result.project.registration, project.registration);
  assert.deepEqual(result.project.census, project.census);
  assert.deepEqual(createProjectRegistry({ storage }).get(project.projectId), result.project);
});

test('old, missing or locally unverified parent keeps folder stale', () => {
  for (const mode of ['folder-parent', 'fresh-parent', 'missing-parent', 'local-parent']) {
    const { registry, project, observation } = setup();
    if (mode === 'folder-parent') observation.receipt.head.architectureContractDigest = hash('d');
    if (mode === 'fresh-parent') observation.architectureReceipt.head = { revision: 2, contractDigest: hash('d') };
    if (mode === 'missing-parent') observation.architectureReceipt.head = null;
    if (mode === 'local-parent') registry.recordArchitectureObservation(project.projectId, { state: 'unavailable', expectedRootIdentity: hash('a') });
    const result = registry.recordFolderObservation(project.projectId, observation);
    assert.equal(result.project.authorities.folder.state, 'stale', mode);
    assert.equal(result.project.provenance['authority.folder'].reason, 'folder-parent-stale', mode);
  }
});

test('service failure retains last known folder; malformed or cross-project observations refuse', () => {
  const { registry, project, observation } = setup();
  registry.recordFolderObservation(project.projectId, observation);
  for (const state of ['stale', 'unavailable']) {
    const result = registry.recordFolderObservation(project.projectId, { state, expectedRootIdentity: hash('a') });
    assert.equal(result.project.authorities.folder.state, state);
    assert.equal(result.project.authorities.folder.digest, hash('c'));
    assert.equal(result.project.provenance['authority.folder'].state, state);
  }
  const before = registry.exportRedacted();
  for (const [input, code] of [
    [{ ...observation, expectedRootIdentity: hash('d') }, 'folder-root-mismatch'],
    [{ ...observation, receipt: { ...observation.receipt, planId: 'pp_wrong-project' } }, 'folder-observation-invalid'],
    [{ ...observation, architectureReceipt: { ...observation.architectureReceipt, planId: 'pp_wrong-project' } }, 'folder-observation-invalid'],
    [{ ...observation, architectureReceipt: undefined }, 'folder-observation-invalid'],
    [{ ...observation, receipt: { ...observation.receipt, head: { ...observation.receipt.head, architectureRevision: 0 } } }, 'folder-observation-invalid'],
  ]) {
    assert.throws(() => registry.recordFolderObservation(project.projectId, input), error => error.code === code);
    assert.equal(registry.exportRedacted(), before);
  }
});

test('changed folder invalidates downstream summaries but does not promote architecture or project', () => {
  const { registry, project, observation } = setup();
  registry.recordFolderObservation(project.projectId, observation);
  const current = registry.get(project.projectId);
  const dependencies = Object.fromEntries(['component', 'plan'].map(kind => [kind, { digest: hash('d'), entityId: createProjectEntityId(project.projectId, 'source', kind), recordedAt: new Date(now).toISOString(), revision: 1, state: 'authoritative' }]));
  registry.upsert({ ...current, authorities: { ...current.authorities, ...dependencies } });
  const unchanged = registry.recordFolderObservation(project.projectId, observation).project;
  assert.equal(unchanged.authorities.component.state, 'authoritative');
  observation.receipt.head.revision = 2; observation.receipt.head.contractDigest = hash('e');
  const changed = registry.recordFolderObservation(project.projectId, observation).project;
  for (const kind of ['component', 'plan']) {
    assert.equal(changed.authorities[kind].state, 'stale');
    assert.equal(changed.provenance[`authority.${kind}`].reason, 'folder-head-changed');
  }
  assert.deepEqual(changed.authorities.architecture, current.authorities.architecture);
  assert.equal(changed.state, project.state);
});

test('folder revision regression or same revision different digest refuses without mutation', () => {
  const { registry, project, observation } = setup();
  observation.receipt.head.revision = 2;
  registry.recordFolderObservation(project.projectId, observation);
  const before = registry.exportRedacted();
  for (const head of [{ ...observation.receipt.head, revision: 1 }, { ...observation.receipt.head, contractDigest: hash('e') }]) {
    assert.throws(() => registry.recordFolderObservation(project.projectId, { ...observation, receipt: { ...observation.receipt, head } }), error => error.code === 'folder-observation-stale');
    assert.equal(registry.exportRedacted(), before);
  }
});

test('missing head retains last-known summary; persistence refusal remains a separate observable failure', () => {
  const { registry, project, observation, storage } = setup();
  registry.recordFolderObservation(project.projectId, observation);
  const absent = registry.recordFolderObservation(project.projectId, { ...observation, receipt: { ...observation.receipt, head: null } });
  assert.equal(absent.project.authorities.folder.state, 'unavailable');
  assert.equal(absent.project.authorities.folder.digest, observation.receipt.head.contractDigest);
  assert.equal(absent.project.authorities.folder.revision, observation.receipt.head.revision);
  assert.equal(absent.project.provenance['authority.folder'].reason, 'folder-head-missing');
  storage.setItem = () => { throw Error('storage unavailable'); };
  const failed = registry.recordFolderObservation(project.projectId, observation);
  assert.equal(failed.persisted, false);
  assert.equal(failed.persistenceReason, 'storage-write-failed');
  assert.equal(failed.project.authorities.folder.digest, hash('c'));
});
