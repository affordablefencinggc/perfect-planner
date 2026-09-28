import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');
test('native setup and preparation have exact local main-window permissions and registered commands',async()=>{
  const cap=JSON.parse(await read('src-tauri/capabilities/main-check-setup.json'));
  assert.deepEqual(cap.permissions,['allow-choose-native-check-setup','allow-prepare-native-checks','allow-inspect-native-checks','allow-review-native-checks','allow-recover-native-check-review','allow-execute-native-check','allow-recover-native-check-execution']);
  assert.deepEqual(cap.windows,['main']);assert.deepEqual(cap.platforms,['windows']);assert.equal(cap.remote,undefined);
  const config=JSON.parse(await read('src-tauri/tauri.conf.json'));
  assert.equal(config.app.security.capabilities.filter(v=>v==='main-check-setup').length,1);
  assert.match(await read('src-tauri/build.rs'),/"choose_native_check_setup"/);
  assert.match(await read('src-tauri/src/lib.rs'),/native_draft_commands::choose_native_check_setup,/);
  assert.match(await read('src-tauri/build.rs'),/"prepare_native_checks"/);
  assert.match(await read('src-tauri/src/lib.rs'),/native_draft_commands::prepare_native_checks,/);
  assert.match(await read('src-tauri/build.rs'),/"inspect_native_checks"/);
  assert.match(await read('src-tauri/src/lib.rs'),/native_draft_commands::inspect_native_checks,/);
});

 test('execution endpoints are explicitly registered without caller-owned configuration',async()=>{
  for(const name of ['execute_native_check','recover_native_check_execution']){
   assert.ok((await read('src-tauri/build.rs')).includes(`"${name}"`));
   assert.ok((await read('src-tauri/src/lib.rs')).includes(`native_draft_commands::${name},`));
  }
 });
