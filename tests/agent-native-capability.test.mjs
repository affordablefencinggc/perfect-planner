import "./helpers/hermetic-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('packaged main window enables only the intended observation and consent-gated pairing commands',async()=>{
  const config=JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json',import.meta.url),'utf8'));
  const capability=JSON.parse(await readFile(new URL('../src-tauri/capabilities/main-agent-observation.json',import.meta.url),'utf8'));
  assert.ok(config.app.security.capabilities.includes(capability.identifier));
  assert.deepEqual(capability.windows,['main']);
  assert.deepEqual(capability.platforms,['windows']);
  assert.deepEqual(capability.permissions,['allow-inspect-agent-sessions','allow-read-agent-exchange-notes','allow-stop-project-agent-broker','allow-prepare-agent-pairing','allow-prepare-agent-plan-pairing','allow-prepare-agent-proposal-pairing']);
});
