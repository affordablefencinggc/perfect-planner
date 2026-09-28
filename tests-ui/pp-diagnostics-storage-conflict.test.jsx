import { describe, expect, test, vi } from "vitest";
import { createStableProjectId } from "../src/project/projectIds.js";
import { createRuntimeEventLedger, createRuntimeEventMemoryStorage, DEFAULT_RUNTIME_EVENT_STORAGE_KEY } from "../src/runtime/runtimeEventLedger.js";
const PROJECT_A = createStableProjectId("Alpha", "diagnostics-alpha");
const PROJECT_B = createStableProjectId("Beta", "diagnostics-beta");
function harness({ storage = createRuntimeEventMemoryStorage() } = {}) {
  let sequence=0;
  return { storage, ledger: createRuntimeEventLedger({ storage, now: () => Date.UTC(2026,8,5)+sequence, createId: () => `evt_conflict_${++sequence}` }) };
}
function event(overrides={}) {
  return { adapter:"fixture",generation:3,message:"Synthetic diagnostic",payload:{fixture:true},projectId:PROJECT_A,runId:null,severity:"info",source:"test",taskId:null,...overrides };
}
describe("Diagnostic stale-writer protection", () => {
  test("an older instance refuses to overwrite a newer event and keeps its late event exportable", () => {
    const storage = createRuntimeEventMemoryStorage();
    const old = harness({ storage }).ledger;
    const newer = harness({ storage }).ledger;
    const snapshot = old.getSnapshot(PROJECT_A), listener = vi.fn();
    old.subscribe(PROJECT_A, listener);
    newer.append(event({ eventId: "evt_newer" }));
    const saved = storage.getItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY);
    old.append(event({ eventId: "evt_old_late" }));
    expect(storage.getItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY)).toBe(saved);
    expect(old.getHealth()).toMatchObject({ state: "stale", persistence: "memory", reason: "storage-conflict" });
    expect(old.getSnapshot(PROJECT_A)).not.toBe(snapshot);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].health.reason).toBe("storage-conflict");
    expect(JSON.parse(old.exportRedacted(PROJECT_A)).events.map(e => e.eventId)).toEqual(["evt_old_late"]);
    old.append(event({ eventId: "evt_another_late" }));
    expect(old.clear(PROJECT_A)).toBe(false);
    expect(old.list(PROJECT_A)).toHaveLength(2);
    expect(storage.getItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY)).toBe(saved);
    expect(harness({ storage }).ledger.list(PROJECT_A).map(e => e.eventId)).toEqual(["evt_newer"]);
  });

  test("an older append cannot resurrect cleared events", () => {
    const { ledger: old, storage } = harness();
    old.append(event({ eventId: "evt_cleared" }));
    const current = harness({ storage }).ledger;
    expect(current.clear(PROJECT_A)).toBe(true);
    const saved = storage.getItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY);
    old.append(event({ eventId: "evt_late_after_clear" }));
    expect(storage.getItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY)).toBe(saved);
    expect(harness({ storage }).ledger.list(PROJECT_A)).toEqual([]);
  });

  test("stale clear preserves local events and newer durable events in both projects", () => {
    const { ledger: old, storage } = harness();
    old.append(event({ eventId: "evt_original" }));
    const current = harness({ storage }).ledger;
    current.append(event({ eventId: "evt_current_a" }));
    current.append(event({ eventId: "evt_current_b", projectId: PROJECT_B }));
    const saved = storage.getItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY);
    expect(old.clear(PROJECT_A)).toBe(false);
    expect(old.list(PROJECT_A).map(e => e.eventId)).toEqual(["evt_original"]);
    expect(old.getHealth().reason).toBe("storage-conflict");
    expect(storage.getItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY)).toBe(saved);
  });

  test.each(["same-revision", "deleted", "corrupt", "future"])("refuses %s replacement without repairing it", (kind) => {
    const { ledger, storage } = harness();
    ledger.append(event({ eventId: "evt_initial" }));
    const replacement = JSON.parse(storage.getItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY));
    if (kind === "same-revision") replacement.events[0].message = "Changed at the same revision";
    if (kind === "future") replacement.schemaVersion = 99;
    if (kind === "deleted") storage.removeItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY);
    else storage.setItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY, kind === "corrupt" ? "{bad" : JSON.stringify(replacement));
    const saved = storage.getItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY);
    ledger.append(event({ eventId: "evt_refused" }));
    expect(ledger.getHealth().reason).toBe("storage-conflict");
    expect(storage.getItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY)).toBe(saved);
  });

  test("sanitization refuses an intervening storage change without exposing raw secrets", () => {
    const { ledger, storage: original } = harness();
    ledger.append(event({ eventId: "evt_sensitive" }));
    const raw = JSON.parse(original.getItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY));
    raw.events[0].message = "Bearer do-not-expose";
    const initial = JSON.stringify(raw), replacement = "{preserved-changed-storage";
    let reads = 0;const write = vi.fn();
    const storage = { getItem: () => ++reads === 1 ? initial : replacement, setItem: write };
    const old = harness({ storage }).ledger;
    expect(write).not.toHaveBeenCalled();
    expect(old.getHealth().reason).toBe("storage-conflict");
    expect(JSON.stringify(old.getSnapshot(PROJECT_A))).not.toContain("do-not-expose");
    old.append(event({ eventId: "evt_late_sanitize" }));
    expect(write).not.toHaveBeenCalled();
  });

  test("a comparison read failure refuses clear, preserves events and disables further writes", () => {
    const base = createRuntimeEventMemoryStorage();let denied = false;
    const write = vi.fn((key,value) => base.setItem(key,value));
    const storage = { getItem(key) { if (denied) { const e = new Error("private detail");e.name = "SecurityError";throw e; }return base.getItem(key); }, setItem: write };
    const { ledger } = harness({ storage });ledger.append(event({ eventId: "evt_retained" }));
    denied = true;
    expect(ledger.clear(PROJECT_A)).toBe(false);
    expect(ledger.list(PROJECT_A)).toHaveLength(1);
    expect(ledger.getHealth()).toMatchObject({ reason: "storage-read-failed", persistence: "memory", errorCode: "storage-access-denied" });
    denied = false;ledger.append(event({ eventId: "evt_memory_only" }));
    expect(write).toHaveBeenCalledTimes(1);
  });

});
