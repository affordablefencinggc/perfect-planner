import { createRuntimeEventCodec } from './runtimeEventLedger.js';
import { assertProjectId } from '../project/projectIds.js';

const documentSessions = new WeakMap();
export function getRuntimeEventSession(owner = globalThis.document ?? globalThis) {
  if (!documentSessions.has(owner)) documentSessions.set(owner, createRuntimeEventSession());
  return documentSessions.get(owner);
}

function deferredStore() {
  let loading;
  const open = () => loading ??= import('./runtimeEventStore.js').then(module => module.createRuntimeEventStore());
  return {
    read: () => open().then(store => store.read()),
    appendCaptured: event => open().then(store => store.appendCaptured(event)),
    subscribe(listener) {
      let cancelled = false, unsubscribe;
      open().then(store => { if (!cancelled) unsubscribe = store.subscribe(listener); }).catch(() => {});
      return () => { cancelled = true; unsubscribe?.(); };
    },
  };
}

// View-independent session: pending events stay here until the write commits.
// Unsubscribing a panel never closes storage or cancels a pending append.
export function createRuntimeEventSession({ store = deferredStore(), codec = createRuntimeEventCodec() } = {}) {
  let committed = codec.empty(), loaded = false, readFailure = null, legacyStatus = null;
  let readSequence = 0, appliedRead = 0, stopHints = null;
  const pending = new Map(), listeners = new Set(), writes = new Set();
  const notify = () => { for (const listener of listeners) { try { listener(); } catch {} } };
  function accept(result, sequence = null) {
    const next = codec.validate(result.envelope);
    if (!loaded || next.revision >= committed.revision) {
      committed = next; loaded = true;
      if (sequence === null) {
        // A write may have observed legacy bytes before a later read did.
        // Only a fresh ordered read can clear an existing recovery warning.
        if (legacyStatus === null || legacyStatus === 'snapshot-matches' || result.legacyStatus !== 'snapshot-matches') legacyStatus = result.legacyStatus;
      } else if (sequence >= appliedRead) legacyStatus = result.legacyStatus;
    }
  }
  function health() {
    const failed = [...pending.values()].some(entry => entry.state === 'unsaved');
    const reason = readFailure ? 'storage-read-failed'
      : failed ? 'events-unsaved'
        : !loaded ? 'history-loading'
          : pending.size ? 'events-saving'
            : legacyStatus !== 'snapshot-matches' ? 'legacy-recovery-needed' : 'storage-ready';
    return Object.freeze({
      state: readFailure || failed ? 'unavailable' : !loaded || pending.size ? 'pending' : legacyStatus !== 'snapshot-matches' ? 'stale' : 'ready',
      persistence: !readFailure && loaded && !pending.size ? 'durable' : 'memory',
      reason, errorCode: readFailure, pendingCount: pending.size, legacyStatus,
    });
  }
  async function refresh() {
    const sequence = ++readSequence;
    try {
      const result = await store.read();
      accept(result, sequence);
      if (sequence >= appliedRead) { appliedRead = sequence; readFailure = null; }
      notify();
      return true;
    } catch {
      if (sequence >= appliedRead) { appliedRead = sequence; readFailure = 'diagnostic-history-read-failed'; notify(); }
      return false;
    }
  }
  function snapshot(projectId) {
    const id = assertProjectId(projectId);
    const unsaved = [...pending.values()].filter(entry => entry.event.projectId === id);
    const saved = committed.events.filter(event => event.projectId === id);
    const identical = entry => saved.some(event => event.eventId === entry.event.eventId && JSON.stringify(event) === JSON.stringify(entry.event));
    return Object.freeze({
      projectId: id, revision: committed.revision, health: health(),
      events: Object.freeze([...saved, ...unsaved.filter(entry => !identical(entry)).map(entry => entry.event)]),
      savedEvents: Object.freeze(saved),
      pending: Object.freeze(unsaved.map(entry => Object.freeze({ eventId: entry.event.eventId, event: entry.event, state: entry.state,
        conflictsWithSaved: saved.some(event => event.eventId === entry.event.eventId) && !identical(entry) }))),
    });
  }
  function append(input) {
    const event = codec.capture(input);
    if (pending.size >= codec.limits.maxEvents) throw new Error('Unsaved diagnostic capacity reached. Export existing events before continuing.');
    if (pending.has(event.eventId) || committed.events.some(item => item.eventId === event.eventId)) throw new Error('Duplicate diagnostic event.');
    pending.set(event.eventId, { event, state: 'saving' });
    notify();
    const write = Promise.resolve().then(() => store.appendCaptured(event)).then(result => {
      accept(result);
      pending.delete(event.eventId);
      notify();
    }).catch(() => {
      pending.set(event.eventId, { event, state: 'unsaved' });
      notify();
    });
    writes.add(write);
    write.finally(() => writes.delete(write));
    return event;
  }
  return Object.freeze({
    append, refresh,
    getHealth: health,
    getSnapshot: snapshot,
    list: projectId => snapshot(projectId).events,
    async exportReport(projectId, globalProjectId) {
      // Bind requested scope before await. Build both sections synchronously
      // after the same refresh, with explicit pending IDs/state in each section.
      const id = assertProjectId(projectId), globalId = assertProjectId(globalProjectId);
      await refresh();
      return Object.freeze({ schemaVersion: 2, health: health(), global: snapshot(globalId), project: id === globalId ? null : snapshot(id) });
    },
    subscribe(projectId, listener) {
      assertProjectId(projectId);
      if (typeof listener !== 'function') throw new TypeError('A diagnostic listener is required.');
      if (!stopHints) stopHints = store.subscribe(() => { void refresh(); });
      listeners.add(listener);
      void refresh();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) { stopHints?.(); stopHints = null; }
      };
    },
    settled: () => Promise.all([...writes]),
  });
}
