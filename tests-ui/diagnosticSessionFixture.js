import { createRuntimeEventCodec, DEFAULT_RUNTIME_EVENT_STORAGE_KEY } from '../src/runtime/runtimeEventLedger.js';
import { createRuntimeEventSession } from '../src/runtime/runtimeEventSession.js';

// Presentation/controller fixture only. Actual IndexedDB atomicity is proved
// separately in real-browser scenarios, never by this in-memory adapter.
export function diagnosticSessionFixture(storage = window.localStorage) {
  const codec = createRuntimeEventCodec();
  const initial = storage.getItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY);
  let head, failure;
  try { head = initial === null ? codec.empty() : codec.parse(initial); } catch (error) { failure = error; }
  const read = () => {
    if (failure) throw failure;
    return { envelope: head, legacyStatus: storage.getItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY) === initial ? 'snapshot-matches' : 'changed-recovery-needed' };
  };
  return createRuntimeEventSession({store:{
    read: async () => read(), subscribe: () => () => {},
    appendCaptured: async event => { read(); head = codec.append(head,event); return read(); },
  }});
}
