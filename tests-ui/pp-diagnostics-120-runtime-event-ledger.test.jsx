import { describe, expect, test, vi } from "vitest";
import { createStableProjectId } from "../src/project/projectIds.js";
import {
  DEFAULT_RUNTIME_EVENT_STORAGE_KEY,
  RUNTIME_EVENT_EXPORT_SCHEMA_VERSION,
  RUNTIME_EVENT_LEDGER_SCHEMA_VERSION,
  RUNTIME_EVENT_SCHEMA_VERSION,
  RuntimeEventLedgerError,
  createRuntimeEventLedger,
  createRuntimeEventMemoryStorage,
  validateRuntimeEvent,
} from "../src/runtime/runtimeEventLedger.js";

const PROJECT_A = createStableProjectId("Alpha", "diagnostics-alpha");
const PROJECT_B = createStableProjectId("Beta", "diagnostics-beta");

function harness({ storage = createRuntimeEventMemoryStorage(), limits, start = Date.UTC(2026, 8, 4, 1, 2, 3) } = {}) {
  let time = start;
  let sequence = 0;
  const now = () => time++;
  const createId = () => `evt_test_${++sequence}`;
  return { ledger: createRuntimeEventLedger({ storage, limits, now, createId }), now, storage };
}

function event(overrides = {}) {
  return {
    adapter: "browser",
    generation: 3,
    message: "Workspace census completed",
    payload: { files: 12, status: "complete" },
    projectId: PROJECT_A,
    runId: "run-17",
    severity: "info",
    source: "workspace-census",
    taskId: "task-4",
    ...overrides,
  };
}

describe("PP-DIAGNOSTICS-120 runtime event ledger", () => {
  test("writes and reloads an exact, versioned, immutable event schema", () => {
    const { ledger, storage } = harness();
    const captured = ledger.append(event({ eventId: "evt_schema_001", timestamp: "2026-09-04T01:02:03.000Z" }));

    expect(Object.keys(captured).sort()).toEqual([
      "adapter", "eventId", "generation", "message", "payload", "projectId", "runId", "schemaVersion", "severity", "source", "taskId", "timestamp",
    ]);
    expect(captured.schemaVersion).toBe(RUNTIME_EVENT_SCHEMA_VERSION);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.payload)).toBe(true);

    const snapshot = ledger.getSnapshot(PROJECT_A);
    expect(snapshot.schemaVersion).toBe(RUNTIME_EVENT_LEDGER_SCHEMA_VERSION);
    expect(snapshot.events).toHaveLength(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.events)).toBe(true);
    expect(ledger.getSnapshot(PROJECT_A)).toBe(snapshot);

    const reloaded = createRuntimeEventLedger({ storage, now: () => Date.UTC(2026, 8, 4, 2), createId: () => "evt_reload_001" });
    expect(reloaded.list(PROJECT_A)).toEqual([captured]);
    expect(reloaded.getHealth()).toMatchObject({ persistence: "durable", state: "ready" });
  });

  test("recursively redacts sensitive fields and bearer-like values before memory, storage, and export", () => {
    const { ledger, storage } = harness();
    const jwt = "eyJabcdefghijk.abcdefghijk.abcdefghijk";
    const hostilePayload = {
      apiKey: "raw-" + "api-key",
      nested: {
        accessToken: "raw-" + "access-token",
        cookie: "sess" + "ion=raw-cookie",
        note: `Bearer nest${"ed-secret"} ${jwt}`,
        password: "raw-" + "password",
      },
      safe: "kept",
    };
    hostilePayload.self = hostilePayload;
    Object.defineProperty(hostilePayload, "danger", { enumerable: true, get() { throw new Error("getter secret"); } });
    const captured = ledger.append(event({
      message: "Authorization: Bearer top" + "-secret-value api_key=inline" + "-secret sk-" + "proj-1234567890abcdef",
      payload: hostilePayload,
    }));

    expect(captured.payload).toMatchObject({
      apiKey: "[RED" + "ACTED]",
      danger: "[UNAVAILABLE:ACCESSOR]",
      nested: { accessToken: "[RED" + "ACTED]", cookie: "[REDACTED]", password: "[RED" + "ACTED]" },
      safe: "kept",
      self: "[REDACTED:CIRCULAR]",
    });
    const allRepresentations = [
      JSON.stringify(captured),
      storage.getItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY),
      ledger.exportRedacted(PROJECT_A),
    ].join("\n");
    for (const secret of ["top-secret-value", "inline-secret", "1234567890abcdef", "raw-api-key", "raw-access-token", "raw-cookie", "nested-secret", "raw-password", jwt]) {
      expect(allRepresentations).not.toContain(secret);
    }
    expect(allRepresentations).toContain("[REDACTED]");
  });

  test("bounds strings, depth, entries, payload bytes, and retained event count", () => {
    const limits = { maxDepth: 2, maxEntries: 6, maxEvents: 2, maxPayloadBytes: 256, maxStorageBytes: 2_048, maxStringLength: 32 };
    const { ledger } = harness({ limits });
    ledger.append(event({ eventId: "evt_bound_001", message: "first" }));
    ledger.append(event({
      eventId: "evt_bound_002",
      message: "x".repeat(500),
      payload: { a: { b: { c: "too deep" } }, long: "y".repeat(500) },
    }));
    ledger.append(event({ eventId: "evt_bound_003", message: "third" }));

    const retained = ledger.list(PROJECT_A);
    expect(retained.map((item) => item.eventId)).toEqual(["evt_bound_002", "evt_bound_003"]);
    expect(retained[0].message.length).toBeLessThanOrEqual(32);
    expect(JSON.stringify(retained[0].payload)).toContain("TRUNCATED");

    const byteBounded = harness({ limits: { ...limits, maxEntries: 100, maxPayloadBytes: 64 } }).ledger;
    const oversized = byteBounded.append(event({ payload: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`field${index}`, "data-value"] )) }));
    expect(oversized.payload).toEqual({ reason: "payload-byte-limit", truncated: true });
  });

  test("corrupt storage is preserved across reloads while new events remain explicitly memory-only", () => {
    const storage = createRuntimeEventMemoryStorage({ [DEFAULT_RUNTIME_EVENT_STORAGE_KEY]: "{broken-json" });
    const { ledger } = harness({ storage });
    expect(ledger.getHealth()).toEqual({
      errorCode: "storage-read-error",
      persistence: "memory",
      reason: "storage-corrupt",
      state: "stale",
    });
    expect(ledger.list(PROJECT_A)).toEqual([]);

    ledger.append(event());
    expect(ledger.getSnapshot(PROJECT_A).events).toHaveLength(1);
    expect(ledger.getHealth().persistence).toBe("memory");
    expect(storage.getItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY)).toBe("{broken-json");
    const reopened = harness({ storage }).ledger;
    expect(reopened.getHealth()).toMatchObject({ state: "stale", persistence: "memory", reason: "storage-corrupt" });
    expect(reopened.list(PROJECT_A)).toEqual([]);
    expect(reopened.exportRedacted(PROJECT_A)).not.toContain("broken-json");
    ledger.clear(PROJECT_A);
    expect(storage.getItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY)).toBe("{broken-json");
  });

  test("invalid and oversized histories are neither erased nor leaked into exports", () => {
    for (const raw of [JSON.stringify({ schemaVersion: 1, events: "private invalid log", revision: 1 }), "private oversize log".repeat(200)]) {
      const storage = createRuntimeEventMemoryStorage({ [DEFAULT_RUNTIME_EVENT_STORAGE_KEY]: raw });
      const ledger = harness({ storage, limits: { maxStorageBytes: 512 } }).ledger;
      expect(ledger.getHealth()).toMatchObject({ state: "stale", persistence: "memory", reason: "storage-invalid" });
      ledger.append(event());
      expect(storage.getItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY)).toBe(raw);
      expect(ledger.exportRedacted(PROJECT_A)).not.toContain("private");
    }
  });

  test("future-schema storage is preserved but never treated as current authority", () => {
    const future = JSON.stringify({ events: [], revision: 9, schemaVersion: 99, updatedAt: "2026-09-04T00:00:00.000Z" });
    const storage = createRuntimeEventMemoryStorage({ [DEFAULT_RUNTIME_EVENT_STORAGE_KEY]: future });
    const { ledger } = harness({ storage });
    expect(ledger.getHealth()).toEqual({
      errorCode: "runtime-event-ledger-version-unsupported",
      persistence: "memory",
      reason: "schema-version-unsupported",
      state: "stale",
    });
    ledger.append(event());
    expect(storage.getItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY)).toBe(future);
    expect(ledger.getSnapshot(PROJECT_A).events).toHaveLength(1);
  });

  test("storage read denial has explicit unavailable health without throwing", () => {
    const denied = new Error("do not disclose this platform detail");
    denied.name = "SecurityError";
    const storage = {
      getItem() { throw denied; },
      removeItem() {},
      setItem() { throw denied; },
    };
    const { ledger } = harness({ storage });
    expect(ledger.getHealth()).toEqual({
      errorCode: "storage-access-denied",
      persistence: "memory",
      reason: "storage-read-failed",
      state: "unavailable",
    });
    expect(JSON.stringify(ledger.getHealth())).not.toContain(denied.message);
  });

  test("quota-denied writes retain events in memory and permanently stop durable claims", () => {
    let writes = 0;
    const quotaError = new Error("raw quota implementation detail");
    quotaError.name = "QuotaExceededError";
    const storage = {
      getItem: () => null,
      removeItem: () => {},
      setItem() { writes += 1; throw quotaError; },
    };
    const { ledger } = harness({ storage });
    ledger.append(event({ eventId: "evt_quota_001" }));
    expect(ledger.getHealth()).toEqual({
      errorCode: "storage-quota-denied",
      persistence: "memory",
      reason: "storage-write-failed",
      state: "unavailable",
    });
    ledger.append(event({ eventId: "evt_quota_002" }));
    expect(writes).toBe(1);
    expect(ledger.list(PROJECT_A)).toHaveLength(2);
    expect(JSON.stringify(ledger.getSnapshot(PROJECT_A))).not.toContain(quotaError.message);
  });

  test("strict project filters and searches cannot leak another project", () => {
    const { ledger } = harness();
    ledger.append(event({ eventId: "evt_alpha_info", message: "needle alpha info" }));
    ledger.append(event({ adapter: "native", eventId: "evt_alpha_error", message: "needle alpha error", severity: "error" }));
    ledger.append(event({ eventId: "evt_beta_error", message: "needle beta private", projectId: PROJECT_B, severity: "error" }));

    expect(ledger.list(PROJECT_A)).toHaveLength(2);
    expect(ledger.list(PROJECT_B)).toHaveLength(1);
    expect(ledger.list(PROJECT_A, { adapter: "native", severity: "error" }).map((item) => item.eventId)).toEqual(["evt_alpha_error"]);
    expect(ledger.search(PROJECT_A, "needle")).toHaveLength(2);
    expect(ledger.search(PROJECT_A, "beta private")).toEqual([]);

    const exported = JSON.parse(ledger.exportRedacted(PROJECT_A, { severity: ["info", "error"] }));
    expect(Object.keys(exported).sort()).toEqual(["events", "exportedAt", "projectId", "schemaVersion"]);
    expect(exported.schemaVersion).toBe(RUNTIME_EVENT_EXPORT_SCHEMA_VERSION);
    expect(exported.projectId).toBe(PROJECT_A);
    expect(JSON.stringify(exported)).not.toContain(PROJECT_B);
    expect(JSON.stringify(exported)).not.toContain("beta private");
  });

  test("subscriptions are project scoped and unsubscribe cleanly", () => {
    const { ledger } = harness();
    const alphaListener = vi.fn();
    const betaListener = vi.fn();
    const unsubscribe = ledger.subscribe(PROJECT_A, alphaListener);
    ledger.subscribe(PROJECT_B, betaListener);

    ledger.append(event({ eventId: "evt_sub_alpha" }));
    expect(alphaListener).toHaveBeenCalledTimes(1);
    expect(betaListener).not.toHaveBeenCalled();
    expect(alphaListener.mock.calls[0][0].projectId).toBe(PROJECT_A);

    ledger.append(event({ eventId: "evt_sub_beta", projectId: PROJECT_B }));
    expect(alphaListener).toHaveBeenCalledTimes(1);
    expect(betaListener).toHaveBeenCalledTimes(1);
    unsubscribe();
    ledger.append(event({ eventId: "evt_sub_alpha_2" }));
    expect(alphaListener).toHaveBeenCalledTimes(1);
  });

  test("a valid stored event containing raw secrets is sanitized before exposure and rewritten safely", () => {
    const rawEnvelope = {
      events: [{
        adapter: "browser",
        eventId: "evt_stored_001",
        generation: 1,
        message: "Bearer stor" + "ed-raw-secret",
        payload: { password: "stor" + "ed-password", safe: "visible" },
        projectId: PROJECT_A,
        runId: null,
        schemaVersion: 1,
        severity: "warning",
        source: "runtime",
        taskId: null,
        timestamp: "2026-09-04T00:00:00.000Z",
      }],
      revision: 1,
      schemaVersion: 1,
      updatedAt: "2026-09-04T00:00:00.000Z",
    };
    const storage = createRuntimeEventMemoryStorage({ [DEFAULT_RUNTIME_EVENT_STORAGE_KEY]: JSON.stringify(rawEnvelope) });
    const { ledger } = harness({ storage });
    const exposed = JSON.stringify(ledger.getSnapshot(PROJECT_A));
    const persisted = storage.getItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY);
    expect(exposed).not.toContain("stored-raw-secret");
    expect(exposed).not.toContain("stored-password");
    expect(persisted).not.toContain("stored-raw-secret");
    expect(persisted).not.toContain("stored-password");
    expect(ledger.getHealth()).toMatchObject({ persistence: "durable", reason: "storage-sanitized", state: "ready" });
  });

  test("invalid, foreign-shaped, and duplicate events fail without mutating the ledger", () => {
    const { ledger } = harness();
    expect(() => ledger.append(event({ projectId: "not-a-project" }))).toThrow();
    expect(() => ledger.append({ ...event(), plaintextSecret: "must" + "-not-enter" })).toThrow(RuntimeEventLedgerError);
    expect(() => ledger.append(event({ source: "sk-" + "proj-1234567890abcdef" }))).toThrowError(/sensitive material/i);
    expect(ledger.list(PROJECT_A)).toEqual([]);

    ledger.append(event({ eventId: "evt_duplicate_001" }));
    expect(() => ledger.append(event({ eventId: "evt_duplicate_001" }))).toThrowError(/already exists/i);
    expect(ledger.list(PROJECT_A)).toHaveLength(1);

    const stored = ledger.list(PROJECT_A)[0];
    expect(() => validateRuntimeEvent({ ...stored, extra: true })).toThrowError(/unknown or missing field/i);
  });

  test("a missing persistence adapter remains an honest memory-only ledger", () => {
    const { ledger } = harness({ storage: null });
    ledger.append(event());
    expect(ledger.getHealth()).toEqual({
      errorCode: null,
      persistence: "memory",
      reason: "storage-unavailable",
      state: "unavailable",
    });
    expect(ledger.list(PROJECT_A)).toHaveLength(1);
  });
});
