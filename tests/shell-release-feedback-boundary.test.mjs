import "./helpers/hermetic-env.mjs";
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { requiresBuild } from './helpers/build-output.mjs';

// Like the static-package tests, this checks a freshly built candidate. It must
// fail when the build is missing, not turn an absent release artifact into a pass.
test('shell release assets do not ship the development annotation toolbar', { skip: requiresBuild }, async () => {
  const assets = new URL('../dist/client/assets/', import.meta.url);
  const scripts = (await readdir(assets)).filter(name => name.endsWith('.js'));
  assert.ok(scripts.some(name => name.startsWith('index-')), 'Build the release client before testing');
  for (const name of scripts) {
    const code = await readFile(new URL(name, assets), 'utf8');
    assert.doesNotMatch(code, /agentation\.(?:com|dev)|Start feedback mode|styles-module__toolbarContainer/, `${name} contains the development feedback UI`);
  }
});
