import { createRuntimeEventCodec, DEFAULT_RUNTIME_EVENT_STORAGE_KEY } from './runtimeEventLedger.js';
import { assertProjectId } from '../project/projectIds.js';

export const RUNTIME_EVENT_DB_NAME = 'perfect-planner-diagnostics-v1';
const fail = (code) => Object.assign(new Error(code), { code });

// Device-local diagnostics, never an execution/approval authority or backup.
// Mutations read and validate the latest head inside the SAME write transaction.
export function createRuntimeEventStore({
  indexedDB = globalThis.indexedDB,
  legacyStorage,
  name = RUNTIME_EVENT_DB_NAME,
  codec = createRuntimeEventCodec(),
  openTimeoutMs = 10000,
  digest = async (text) => [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
} = {}) {
  if (!Number.isSafeInteger(openTimeoutMs) || openTimeoutMs < 1 || openTimeoutMs > 60000) throw fail('diagnostic-open-timeout-invalid');
  let connection = null;
  const eventName = `${name}:changed`;

  function captureLegacy() {
    return (async () => {
      try {
        // Observe before the first await. This is a point-in-time snapshot, not
        // a transaction across localStorage and IndexedDB. Never rewrite it.
        const source = legacyStorage === undefined ? globalThis.localStorage : legacyStorage;
        if (!source || typeof source.getItem !== 'function') throw fail('diagnostic-legacy-unavailable');
        const raw = source.getItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY);
        if (raw !== null && typeof raw !== 'string') throw fail('diagnostic-legacy-invalid');
        const envelope = raw === null ? codec.empty() : codec.parse(raw);
        const fingerprint = raw === null ? null : await digest(raw);
        return { envelope, marker: { schemaVersion: 1, fingerprint } };
      } catch {
        return { error: fail('diagnostic-legacy-unreadable') };
      }
    })();
  }

  function open() {
    if (!indexedDB) return Promise.reject(fail('diagnostic-storage-unavailable'));
    if (!connection) {
      const pending = new Promise((resolve, reject) => {
        let abandoned = false;
        const request = indexedDB.open(name, 1);
        // Open requests can queue without delivering onblocked. A late
        // connection cannot publish history; an already-committing schema
        // upgrade may still finish even when best-effort abort is too late.
        const timer = setTimeout(() => abandon('diagnostic-storage-open-timeout'), openTimeoutMs);
        function abandon(code) {
          abandoned = true;
          clearTimeout(timer);
          // An upgrade may have started before the deadline. Cancel its
          // in-flight schema work too; an already-finished transaction throws.
          try { request.transaction?.abort(); } catch {}
          reject(fail(code));
        }
        request.onupgradeneeded = () => {
          if (abandoned) { request.transaction.abort(); return; }
          request.result.createObjectStore('history');
        };
        request.onblocked = () => abandon('diagnostic-storage-blocked');
        request.onerror = () => abandon('diagnostic-storage-open-failed');
        request.onsuccess = () => {
          clearTimeout(timer);
          const db = request.result;
          if (abandoned) { db.close(); return; }
          db.onversionchange = () => { db.close(); connection = null; };
          resolve(db);
        };
      });
      connection = pending;
      pending.catch(() => { if (connection === pending) connection = null; });
    }
    return connection;
  }

  function validateMarker(marker) {
    if (!marker || Object.keys(marker).sort().join(',') !== 'fingerprint,schemaVersion'
      || marker.schemaVersion !== 1
      || !(marker.fingerprint === null || /^[a-f0-9]{64}$/.test(marker.fingerprint))) {
      throw fail('diagnostic-migration-invalid');
    }
    return marker;
  }

  async function transact(operation) {
    const legacy = await captureLegacy();
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('history', 'readwrite');
      const store = tx.objectStore('history');
      let result, failure;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? fail('diagnostic-transaction-aborted'));
      tx.onerror = () => {};
      const headRequest = store.get('head');
      const markerRequest = store.get('migration');
      markerRequest.onsuccess = () => {
        try {
          let head = headRequest.result, marker = markerRequest.result;
          const isNew = head === undefined && marker === undefined;
          if (isNew) {
            if (legacy.error) throw legacy.error;
            head = legacy.envelope;
            marker = legacy.marker;
          } else if (head === undefined || marker === undefined) {
            throw fail('diagnostic-history-incomplete');
          }
          head = codec.validate(head);
          marker = validateMarker(marker);
          const next = operation(head);
          result = { envelope: next, migration: marker, legacyStatus: legacy.error
            ? 'unreadable-recovery-needed'
            : legacy.marker.fingerprint !== marker.fingerprint
              ? 'changed-recovery-needed' : 'snapshot-matches' };
          if (isNew) store.add(marker, 'migration');
          if (isNew || next !== head) store.put(next, 'head');
        } catch (error) { failure = error; tx.abort(); }
      };
    });
  }

  function notify() {
    try { globalThis.window?.dispatchEvent(new Event(eventName)); } catch {}
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        const channel = new BroadcastChannel(eventName);
        channel.postMessage('refresh');
        channel.close();
      }
    } catch {}
  }

  function appendCaptured(captured) {
    const event = codec.validateEvent(captured);
    return transact((head) => codec.append(head, event)).then((result) => {
      notify();
      return { ...result, event };
    });
  }

  return Object.freeze({
    capture: codec.capture,
    read: () => transact((head) => head),
    append(input) {
      // Validation, redaction and project identity are captured synchronously.
      const event = codec.capture(input);
      return appendCaptured(event);
    },
    // Callers keep this exact sanitized identity in pending memory until commit.
    appendCaptured,
    clear(projectId, expectedRevision) {
      const id = assertProjectId(projectId);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw fail('diagnostic-revision-invalid');
      return transact((head) => codec.clear(head, id, expectedRevision)).then((result) => { notify(); return result; });
    },
    subscribe(listener) {
      // Hints contain no records. Consumers must re-read and validate the store.
      if (typeof listener !== 'function') throw new TypeError('A diagnostic listener is required.');
      const hint = () => { try { listener(); } catch {} };
      globalThis.window?.addEventListener(eventName, hint);
      let channel;
      try { if (typeof BroadcastChannel !== 'undefined') { channel = new BroadcastChannel(eventName); channel.onmessage = hint; } } catch {}
      return () => { globalThis.window?.removeEventListener(eventName, hint); channel?.close(); };
    },
    async close() {
      const pending = connection;
      connection = null;
      const db = await pending;
      db?.close();
    },
  });
}
