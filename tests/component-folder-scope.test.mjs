import test from 'node:test';
import assert from 'node:assert/strict';
import { assessComponentFolderScope } from '../src/engine/componentFolderScope.js';
const nodes = [{ id: 'F001', kind: 'folder', path: 'src' }, { id: 'F002', kind: 'folder', path: 'tests' }, { id: 'F003', kind: 'file', path: 'package.json' }];
const input = paths => ({ inventory: [{ id: 'C001', folderNodeId: 'F001' }], components: [{ id: 'C001', folderNodeId: 'F001', fileClaims: paths.map(path => ({ path, access: 'write' })) }] });
test('one primary folder permits exact approved multi-root claims', () => {
  assert.deepEqual(assessComponentFolderScope(input(['src/feature.js', 'tests/feature.test.js', 'package.json']), nodes), { ready: true, blockers: [] });
});
test('unknown folder and unapproved roots or root files block preflight', () => {
  const unknown = input(['src/feature.js']); unknown.components[0].folderNodeId = 'F999';
  assert.equal(assessComponentFolderScope(unknown, nodes).ready, false);
  for (const path of ['unknown/file.js', 'package-lock.json', 'src-other/file.js', 'src/NUL.js', 'src/x. ', 'src/file:stream', 'src/../file.js']) assert.equal(assessComponentFolderScope(input([path]), nodes).ready, false, path);
});
test('case-insensitive cross-component write collision blocks but shared reads do not', () => {
  const value = input(['src/Feature.js']);
  value.inventory.push({ id: 'C002', folderNodeId: 'F001' });
  value.components.push({ id: 'C002', folderNodeId: 'F001', fileClaims: [{ path: 'src/feature.js', access: 'read' }] });
  assert.match(assessComponentFolderScope(value, nodes).blockers.join(' '), /case-insensitive write collision/);
  value.components[0].fileClaims[0].access = 'read';
  assert.equal(assessComponentFolderScope(value, nodes).ready, true);
});
