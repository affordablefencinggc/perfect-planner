import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeEventCodec } from '../src/runtime/runtimeEventLedger.js';

const input = { adapter: 'browser-ui', generation: 0, projectId: 'pp_codec_test', source: 'runtime', severity: 'error', message: 'Synthetic failure', payload: { password: 'fixture-value' } };
test('diagnostic capture freezes and redacts before async storage begins', () => {
  const codec = createRuntimeEventCodec();
  const source = { ...input, payload: { ...input.payload } };
  const event = codec.capture(source);
  source.projectId = 'pp_other_test'; source.payload.password = 'changed';
  assert.equal(event.projectId, input.projectId);
  assert.equal(event.payload.password, '[REDACTED]');
  assert.ok(Object.isFrozen(event.payload));
});
test('diagnostic append rejects duplicate IDs and clear requires reviewed revision', () => {
  const codec = createRuntimeEventCodec(), event = codec.capture(input);
  const head = codec.append(codec.empty(), event);
  assert.throws(() => codec.append(head, event), { code: 'runtime-event-id-duplicate' });
  assert.throws(() => codec.clear(head, input.projectId, 0), { code: 'runtime-event-storage-conflict' });
  assert.equal(codec.clear(head, input.projectId, 1).events.length, 0);
  assert.equal(head.events.length, 1);
});
test('diagnostic clear preserves other project history', () => {
  const codec = createRuntimeEventCodec();
  let head = codec.append(codec.empty(), codec.capture(input));
  head = codec.append(head, codec.capture({ ...input, projectId: 'pp_other_test' }));
  assert.deepEqual(codec.clear(head, input.projectId, 2).events.map(e => e.projectId), ['pp_other_test']);
});
test('diagnostic codec refuses malformed future and oversized history', () => {
  const codec = createRuntimeEventCodec();
  assert.throws(() => codec.parse('{'));
  assert.throws(() => codec.validate({ ...codec.empty(), schemaVersion: 2 }));
  assert.throws(() => codec.parse(' '.repeat(codec.limits.maxStorageBytes + 1)));
});
test('diagnostic revision cannot advance past safe integer', () => {
  const codec = createRuntimeEventCodec();
  assert.throws(() => codec.append({ ...codec.empty(), revision: Number.MAX_SAFE_INTEGER }, codec.capture(input)));
});
