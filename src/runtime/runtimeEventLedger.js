import { assertProjectId } from "../project/projectIds.js";

export const RUNTIME_EVENT_LEDGER_SCHEMA_VERSION = 1;
export const RUNTIME_EVENT_SCHEMA_VERSION = 1;
export const RUNTIME_EVENT_EXPORT_SCHEMA_VERSION = 1;
export const DEFAULT_RUNTIME_EVENT_STORAGE_KEY = "perfect-planner.runtime-events.v1";
export const runtimeEventSeverities = Object.freeze(["debug", "info", "warning", "error", "critical"]);

export const defaultRuntimeEventLimits = Object.freeze({
  maxDepth: 6,
  maxEntries: 256,
  maxEvents: 500,
  maxPayloadBytes: 16_384,
  maxStorageBytes: 2_000_000,
  maxStringLength: 2_048,
});

const LIMIT_CEILINGS = Object.freeze({
  maxDepth: 20,
  maxEntries: 5_000,
  maxEvents: 5_000,
  maxPayloadBytes: 1_000_000,
  maxStorageBytes: 20_000_000,
  maxStringLength: 32_768,
});
const LIMIT_FLOORS = Object.freeze({
  maxDepth: 1,
  maxEntries: 1,
  maxEvents: 1,
  maxPayloadBytes: 64,
  maxStorageBytes: 512,
  maxStringLength: 16,
});
const EVENT_KEYS = Object.freeze([
  "adapter",
  "eventId",
  "generation",
  "message",
  "payload",
  "projectId",
  "runId",
  "schemaVersion",
  "severity",
  "source",
  "taskId",
  "timestamp",
]);
const EVENT_INPUT_KEYS = Object.freeze(EVENT_KEYS.filter((key) => key !== "schemaVersion"));
const ENVELOPE_KEYS = Object.freeze(["events", "revision", "schemaVersion", "updatedAt"]);
const FILTER_KEYS = Object.freeze(["adapter", "generation", "limit", "runId", "severity", "source", "taskId"]);
const SAFE_TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const EVENT_ID = /^evt_[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/;
const REDACTED = "[REDACTED]";
const TRUNCATED_DEPTH = "[TRUNCATED:DEPTH]";
const TRUNCATED_ENTRIES = "[TRUNCATED:ENTRIES]";
const CIRCULAR = "[REDACTED:CIRCULAR]";
const SENSITIVE_KEY = /(?:secret|token|password|authorization|cookie|apikey|credential)/;
const BEARER_VALUE = /\bbearer\s+[^\s,;]+/gi;
const EMBEDDED_SECRET = /(\b(?:secret|token|password|authorization|cookie|api[-_ ]?key|credential)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const JWT_VALUE = /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g;
const PROVIDER_KEY = /(?:sk|rk|pk|ghp|glpat|github_pat)[-_][a-zA-Z0-9_-]{12,}/gi;

export class RuntimeEventLedgerError extends Error {
  constructor(message, code = "runtime-event-ledger-invalid") {
    super(message);
    this.name = "RuntimeEventLedgerError";
    this.code = code;
  }
}

export class UnsupportedRuntimeEventLedgerVersionError extends RuntimeEventLedgerError {
  constructor(version) {
    super(`Unsupported runtime event ledger schema version: ${String(version)}.`, "runtime-event-ledger-version-unsupported");
    this.name = "UnsupportedRuntimeEventLedgerVersionError";
  }
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || Object.isFrozen(value) || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) deepFreeze(item, seen);
  return Object.freeze(value);
}

function byteLength(value) {
  const text = String(value ?? "");
  if (typeof TextEncoder === "function") return new TextEncoder().encode(text).byteLength;
  return text.length * 2;
}

function exactObject(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeEventLedgerError(`${label} must be an object.`, "runtime-event-schema-invalid");
  }
  let actual;
  try {
    actual = Object.keys(value).sort();
  } catch {
    throw new RuntimeEventLedgerError(`${label} keys are unreadable.`, "runtime-event-schema-invalid");
  }
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new RuntimeEventLedgerError(`${label} has an unknown or missing field.`, "runtime-event-schema-invalid");
  }
}

function allowedObject(value, allowedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeEventLedgerError(`${label} must be an object.`, "runtime-event-schema-invalid");
  }
  let actual;
  try {
    actual = Object.keys(value);
  } catch {
    throw new RuntimeEventLedgerError(`${label} keys are unreadable.`, "runtime-event-schema-invalid");
  }
  if (actual.some((key) => !allowedKeys.includes(key))) {
    throw new RuntimeEventLedgerError(`${label} has an unknown field.`, "runtime-event-schema-invalid");
  }
}

function normalizeLimits(overrides = {}) {
  allowedObject(overrides, Object.keys(defaultRuntimeEventLimits), "Runtime event limits");
  const limits = { ...defaultRuntimeEventLimits, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < LIMIT_FLOORS[key] || value > LIMIT_CEILINGS[key]) {
      throw new RuntimeEventLedgerError(`${key} is outside its safe bounds.`, "runtime-event-limits-invalid");
    }
  }
  return Object.freeze(limits);
}

function isoTimestamp(value, label = "Runtime event timestamp") {
  const date = typeof value === "number" ? new Date(value) : value instanceof Date ? value : new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) {
    throw new RuntimeEventLedgerError(`${label} is invalid.`, "runtime-event-schema-invalid");
  }
  return date.toISOString();
}

function redactAndBoundString(value, maxLength) {
  let text = String(value ?? "");
  text = text
    .replace(BEARER_VALUE, "Bearer [REDACTED]")
    .replace(EMBEDDED_SECRET, "$1[REDACTED]")
    .replace(JWT_VALUE, REDACTED)
    .replace(PROVIDER_KEY, REDACTED);
  if (text.length <= maxLength) return text;
  const marker = "…[TRUNCATED]";
  return `${text.slice(0, Math.max(0, maxLength - marker.length))}${marker}`;
}

function isSensitiveKey(key) {
  return SENSITIVE_KEY.test(String(key).toLowerCase().replace(/[^a-z0-9]/g, ""));
}

function defineEnumerable(target, key, value) {
  Object.defineProperty(target, key, { configurable: false, enumerable: true, value, writable: false });
}

function sanitizePayload(input, limits) {
  const state = { entries: 0, seen: new WeakSet() };

  function visit(value, key, depth) {
    if (key != null && isSensitiveKey(key)) return REDACTED;
    if (typeof value === "string") return redactAndBoundString(value, limits.maxStringLength);
    if (value == null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "bigint") return redactAndBoundString(value.toString(), limits.maxStringLength);
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "undefined") return "[UNSUPPORTED]";
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? "[INVALID:DATE]" : value.toISOString();
    if (value instanceof Error) {
      return visit({ code: value.code ?? null, message: value.message, name: value.name }, null, depth);
    }
    if (depth >= limits.maxDepth) return TRUNCATED_DEPTH;
    if (state.seen.has(value)) return CIRCULAR;
    state.seen.add(value);

    if (Array.isArray(value)) {
      const result = [];
      for (let index = 0; index < value.length; index += 1) {
        if (state.entries >= limits.maxEntries) {
          result.push(TRUNCATED_ENTRIES);
          break;
        }
        state.entries += 1;
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        result.push(descriptor && "value" in descriptor ? visit(descriptor.value, String(index), depth + 1) : "[UNAVAILABLE:ACCESSOR]");
      }
      return result;
    }

    const result = {};
    let keys;
    try {
      keys = Object.keys(value).sort();
    } catch {
      return "[UNAVAILABLE:OBJECT]";
    }
    for (const itemKey of keys) {
      if (state.entries >= limits.maxEntries) {
        if (!Object.hasOwn(result, "__truncated__")) defineEnumerable(result, "__truncated__", TRUNCATED_ENTRIES);
        break;
      }
      state.entries += 1;
      let descriptor;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, itemKey);
      } catch {
        descriptor = null;
      }
      const itemValue = descriptor && "value" in descriptor ? visit(descriptor.value, itemKey, depth + 1) : "[UNAVAILABLE:ACCESSOR]";
      const safeKey = redactAndBoundString(itemKey, limits.maxStringLength);
      if (!Object.hasOwn(result, safeKey)) defineEnumerable(result, safeKey, itemValue);
    }
    return result;
  }

  const sanitized = visit(input ?? null, null, 0);
  const serialized = JSON.stringify(sanitized);
  if (byteLength(serialized) <= limits.maxPayloadBytes) return deepFreeze(sanitized);
  return deepFreeze({ reason: "payload-byte-limit", truncated: true });
}

function safeToken(value, label, limits, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (typeof value !== "string" || !SAFE_TOKEN.test(value) || value.length > Math.min(128, limits.maxStringLength)) {
    throw new RuntimeEventLedgerError(`${label} is invalid.`, "runtime-event-schema-invalid");
  }
  if (redactAndBoundString(value, limits.maxStringLength) !== value) {
    throw new RuntimeEventLedgerError(`${label} resembles sensitive material.`, "runtime-event-sensitive-identifier");
  }
  return value;
}

function safeGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RuntimeEventLedgerError("Runtime event generation is invalid.", "runtime-event-schema-invalid");
  }
  return value;
}

function safeEventId(value) {
  if (typeof value !== "string" || !EVENT_ID.test(value)) {
    throw new RuntimeEventLedgerError("Runtime event ID is invalid.", "runtime-event-schema-invalid");
  }
  if (redactAndBoundString(value, 256) !== value) {
    throw new RuntimeEventLedgerError("Runtime event ID resembles sensitive material.", "runtime-event-sensitive-identifier");
  }
  return value;
}

function safeMessage(value, limits) {
  if (typeof value !== "string" || !value.trim()) {
    throw new RuntimeEventLedgerError("Runtime event message is required.", "runtime-event-schema-invalid");
  }
  return redactAndBoundString(value.trim(), limits.maxStringLength);
}

function normalizeEvent(value, { limits, now, createId, stored = false }) {
  if (stored) exactObject(value, EVENT_KEYS, "Runtime event");
  else allowedObject(value, EVENT_INPUT_KEYS, "Runtime event input");
  if (stored && value.schemaVersion !== RUNTIME_EVENT_SCHEMA_VERSION) {
    throw new RuntimeEventLedgerError("Unsupported runtime event schema version.", "runtime-event-version-unsupported");
  }
  if (!runtimeEventSeverities.includes(value.severity)) {
    throw new RuntimeEventLedgerError("Runtime event severity is invalid.", "runtime-event-schema-invalid");
  }
  const message = safeMessage(value.message, limits);
  const eventId = safeEventId(value.eventId ?? createId());
  return deepFreeze({
    adapter: safeToken(value.adapter, "Runtime event adapter", limits),
    eventId,
    generation: safeGeneration(value.generation),
    message,
    payload: sanitizePayload(value.payload ?? null, limits),
    projectId: assertProjectId(value.projectId),
    runId: safeToken(value.runId, "Runtime event run ID", limits, { nullable: true }),
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    severity: value.severity,
    source: safeToken(value.source, "Runtime event source", limits),
    taskId: safeToken(value.taskId, "Runtime event task ID", limits, { nullable: true }),
    timestamp: isoTimestamp(value.timestamp ?? now()),
  });
}

export function validateRuntimeEvent(value, { limits = defaultRuntimeEventLimits } = {}) {
  const normalizedLimits = normalizeLimits(limits);
  return normalizeEvent(value, {
    limits: normalizedLimits,
    now: () => Date.now(),
    createId: () => "evt_validation_only",
    stored: true,
  });
}

function emptyEnvelope(now) {
  return deepFreeze({
    events: [],
    revision: 0,
    schemaVersion: RUNTIME_EVENT_LEDGER_SCHEMA_VERSION,
    updatedAt: isoTimestamp(now(), "Runtime event ledger update time"),
  });
}

function validateEnvelope(value, limits) {
  exactObject(value, ENVELOPE_KEYS, "Runtime event ledger");
  if (value.schemaVersion !== RUNTIME_EVENT_LEDGER_SCHEMA_VERSION) {
    throw new UnsupportedRuntimeEventLedgerVersionError(value.schemaVersion);
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.events) || value.events.length > limits.maxEvents) {
    throw new RuntimeEventLedgerError("Runtime event ledger envelope is invalid.", "runtime-event-ledger-schema-invalid");
  }
  const events = value.events.map((event) => normalizeEvent(event, {
    limits,
    now: () => Date.now(),
    createId: () => "evt_validation_only",
    stored: true,
  }));
  if (new Set(events.map((event) => event.eventId)).size !== events.length) {
    throw new RuntimeEventLedgerError("Runtime event ledger contains duplicate event IDs.", "runtime-event-ledger-schema-invalid");
  }
  return deepFreeze({
    events,
    revision: value.revision,
    schemaVersion: RUNTIME_EVENT_LEDGER_SCHEMA_VERSION,
    updatedAt: isoTimestamp(value.updatedAt, "Runtime event ledger update time"),
  });
}

function classifyStorageError(error, operation) {
  const name = String(error?.name ?? "").toLowerCase();
  if (name.includes("quota")) return "storage-quota-denied";
  if (name.includes("security") || name.includes("notallowed")) return "storage-access-denied";
  if (typeof error?.code === "string" && /^[a-zA-Z0-9._-]{1,64}$/.test(error.code)) return error.code;
  return `storage-${operation}-error`;
}

function createHealth(state, persistence, reason, errorCode = null) {
  return deepFreeze({ errorCode, persistence, reason, state });
}

function defaultEventIdFactory(now) {
  let counter = 0;
  return () => {
    counter += 1;
    let random = "";
    try {
      random = globalThis.crypto?.randomUUID?.().replaceAll("-", "").slice(0, 12) ?? "";
    } catch {
      random = "";
    }
    const suffix = random || counter.toString(36).padStart(6, "0");
    return `evt_${Number(now()).toString(36)}.${suffix}`;
  };
}

function envelopeWithEvents(events, revision, updatedAt, limits) {
  let bounded = events.length > limits.maxEvents ? events.slice(-limits.maxEvents) : [...events];
  let candidate = { events: bounded, revision, schemaVersion: RUNTIME_EVENT_LEDGER_SCHEMA_VERSION, updatedAt };
  while (bounded.length > 1 && byteLength(JSON.stringify(candidate)) > limits.maxStorageBytes) {
    bounded = bounded.slice(1);
    candidate = { ...candidate, events: bounded };
  }
  if (byteLength(JSON.stringify(candidate)) > limits.maxStorageBytes) {
    throw new RuntimeEventLedgerError("Runtime event cannot fit inside the configured ledger bound.", "runtime-event-storage-bound-exceeded");
  }
  return deepFreeze(candidate);
}

function validateFilters(filters, limits) {
  allowedObject(filters, FILTER_KEYS, "Runtime event filters");
  const result = {};
  if (filters.adapter != null) result.adapter = safeToken(filters.adapter, "Runtime event adapter filter", limits);
  if (filters.source != null) result.source = safeToken(filters.source, "Runtime event source filter", limits);
  if (filters.runId != null) result.runId = safeToken(filters.runId, "Runtime event run filter", limits, { nullable: true });
  if (filters.taskId != null) result.taskId = safeToken(filters.taskId, "Runtime event task filter", limits, { nullable: true });
  if (filters.generation != null) result.generation = safeGeneration(filters.generation);
  if (filters.severity != null) {
    const values = Array.isArray(filters.severity) ? filters.severity : [filters.severity];
    if (!values.length || values.some((severity) => !runtimeEventSeverities.includes(severity))) {
      throw new RuntimeEventLedgerError("Runtime event severity filter is invalid.", "runtime-event-filter-invalid");
    }
    result.severity = new Set(values);
  }
  if (filters.limit != null) {
    if (!Number.isSafeInteger(filters.limit) || filters.limit < 1 || filters.limit > limits.maxEvents) {
      throw new RuntimeEventLedgerError("Runtime event result limit is invalid.", "runtime-event-filter-invalid");
    }
    result.limit = filters.limit;
  }
  return result;
}

function eventMatches(event, filters) {
  return (filters.adapter == null || event.adapter === filters.adapter)
    && (filters.source == null || event.source === filters.source)
    && (filters.runId === undefined || event.runId === filters.runId)
    && (filters.taskId === undefined || event.taskId === filters.taskId)
    && (filters.generation == null || event.generation === filters.generation)
    && (!filters.severity || filters.severity.has(event.severity));
}

export function createRuntimeEventMemoryStorage(initial = {}) {
  const entries = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)]));
  return {
    get length() { return entries.size; },
    clear() { entries.clear(); },
    getItem(key) { return entries.has(String(key)) ? entries.get(String(key)) : null; },
    key(index) { return [...entries.keys()][index] ?? null; },
    removeItem(key) { entries.delete(String(key)); },
    setItem(key, value) { entries.set(String(key), String(value)); },
  };
}

export function resolveRuntimeEventStorage(runtime = globalThis) {
  try {
    return runtime?.localStorage ?? null;
  } catch {
    return null;
  }
}

// Shared validated transformations for the asynchronous diagnostic store.
// This does not open or rewrite legacy storage.
export function createRuntimeEventCodec({ limits: overrides = {}, now = () => Date.now(), createId } = {}) {
  const limits = normalizeLimits(overrides);
  const nextId = createId ?? defaultEventIdFactory(now);
  const parse = (raw) => {
    if (typeof raw !== "string" || byteLength(raw) > limits.maxStorageBytes) {
      throw new RuntimeEventLedgerError("Diagnostic history exceeds its safe bound.", "runtime-event-ledger-storage-oversize");
    }
    return validateEnvelope(JSON.parse(raw), limits);
  };
  const validate = (value) => parse(JSON.stringify(value));
  function advance(current, events) {
    if (current.revision >= Number.MAX_SAFE_INTEGER) throw new RuntimeEventLedgerError("Diagnostic revision exhausted.");
    return envelopeWithEvents(events, current.revision + 1, isoTimestamp(now()), limits);
  }
  return Object.freeze({
    limits,
    empty: () => emptyEnvelope(now),
    parse,
    validate,
    validateEvent: (event) => validateRuntimeEvent(event, { limits }),
    capture: (input) => normalizeEvent(input, { limits, now, createId: nextId }),
    append(current, event) {
      current = validate(current);
      event = validateRuntimeEvent(event, { limits });
      if (current.events.some((item) => item.eventId === event.eventId)) {
        throw new RuntimeEventLedgerError("Runtime event ID already exists.", "runtime-event-id-duplicate");
      }
      return advance(current, [...current.events, event]);
    },
    clear(current, projectId, expectedRevision) {
      current = validate(current);
      assertProjectId(projectId);
      if (current.revision !== expectedRevision) {
        throw new RuntimeEventLedgerError("History changed. Review it before clearing.", "runtime-event-storage-conflict");
      }
      const events = current.events.filter((event) => event.projectId !== projectId);
      return events.length === current.events.length ? current : advance(current, events);
    },
  });
}

export function createRuntimeEventLedger({
  storage = resolveRuntimeEventStorage(),
  storageKey = DEFAULT_RUNTIME_EVENT_STORAGE_KEY,
  now = () => Date.now(),
  createId,
  limits: limitOverrides = {},
} = {}) {
  if (typeof storageKey !== "string" || !storageKey.trim()) {
    throw new RuntimeEventLedgerError("Runtime event storage key is required.", "runtime-event-ledger-config-invalid");
  }
  if (typeof now !== "function") throw new RuntimeEventLedgerError("Runtime event clock must be a function.", "runtime-event-ledger-config-invalid");
  const limits = normalizeLimits(limitOverrides);
  const nextEventId = createId ?? defaultEventIdFactory(now);
  if (typeof nextEventId !== "function") throw new RuntimeEventLedgerError("Runtime event ID factory must be a function.", "runtime-event-ledger-config-invalid");

  let envelope;
  let ledgerHealth = storage
    ? createHealth("ready", "durable", "storage-ready")
    : createHealth("unavailable", "memory", "storage-unavailable");
  let persistenceEnabled = Boolean(storage);
  let expectedStorage = null;
  const listeners = new Set();
  const snapshots = new Map();
  let loadPhase = "read";

  try {
    const raw = storage?.getItem(storageKey);
    expectedStorage = raw ?? null;
    loadPhase = "parse";
    if (raw == null) {
      envelope = emptyEnvelope(now);
    } else {
      if (byteLength(raw) > limits.maxStorageBytes) {
        throw new RuntimeEventLedgerError("Persisted runtime event ledger exceeds its byte bound.", "runtime-event-ledger-storage-oversize");
      }
      const parsed = JSON.parse(raw);
      loadPhase = "validate";
      envelope = validateEnvelope(parsed, limits);
      const sanitized = JSON.stringify(envelope);
      if (sanitized !== raw) {
        publishStorage(sanitized, "storage-sanitized");
      }
    }
  } catch (error) {
    envelope = emptyEnvelope(now);
    persistenceEnabled = false;
    const futureSchema = error instanceof UnsupportedRuntimeEventLedgerVersionError;
    ledgerHealth = createHealth(
      loadPhase === "read" ? "unavailable" : "stale",
      "memory",
      futureSchema
        ? "schema-version-unsupported"
        : loadPhase === "read"
          ? "storage-read-failed"
          : error instanceof SyntaxError
            ? "storage-corrupt"
            : "storage-invalid",
      error instanceof RuntimeEventLedgerError ? error.code : classifyStorageError(error, "read"),
    );
    // Keep failed history exactly where it was. A fresh instance must encounter
    // the same warning, not interpret our deletion as an empty healthy ledger.
    // Never expose unvalidated bytes through snapshots, search or export.
  }

  function invalidateSnapshots() {
    snapshots.clear();
  }

  function projectSnapshot(projectId) {
    const id = assertProjectId(projectId);
    if (!snapshots.has(id)) {
      snapshots.set(id, deepFreeze({
        events: envelope.events.filter((event) => event.projectId === id),
        health: ledgerHealth,
        projectId: id,
        revision: envelope.revision,
        schemaVersion: RUNTIME_EVENT_LEDGER_SCHEMA_VERSION,
        updatedAt: envelope.updatedAt,
      }));
    }
    return snapshots.get(id);
  }

  function notify(changedProjects, healthChanged) {
    for (const subscription of listeners) {
      if (!healthChanged && !changedProjects.has(subscription.projectId)) continue;
      try { subscription.listener(projectSnapshot(subscription.projectId)); } catch { /* One subscriber cannot break event capture. */ }
    }
  }

  // Refuse sequential stale-instance writes, including sanitization. This is
  // not a cross-tab transaction: localStorage has no atomic compare-and-set.
  function publishStorage(serialized, reason = "storage-ready") {
    if (!persistenceEnabled) return false;
    let current;
    try {
      current = storage.getItem(storageKey);
    } catch (error) {
      persistenceEnabled = false;
      ledgerHealth = createHealth("unavailable", "memory", "storage-read-failed", classifyStorageError(error, "read"));
      return false;
    }
    if (current !== expectedStorage) {
      persistenceEnabled = false;
      ledgerHealth = createHealth("stale", "memory", "storage-conflict", "runtime-event-storage-conflict");
      return false;
    }
    try {
      storage.setItem(storageKey, serialized);
      expectedStorage = serialized;
      ledgerHealth = createHealth("ready", "durable", reason);
      return true;
    } catch (error) {
      persistenceEnabled = false;
      ledgerHealth = createHealth("unavailable", "memory", "storage-write-failed", classifyStorageError(error, "write"));
      return false;
    }
  }

  function persist(nextEnvelope, changedProjects, retainInMemory = true) {
    const previousHealth = ledgerHealth;
    const persisted = publishStorage(JSON.stringify(nextEnvelope));
    // Failed append remains exportable; failed clear must not erase it.
    if (persisted || retainInMemory) envelope = nextEnvelope;
    invalidateSnapshots();
    const healthChanged = previousHealth.state !== ledgerHealth.state
      || previousHealth.persistence !== ledgerHealth.persistence
      || previousHealth.reason !== ledgerHealth.reason
      || previousHealth.errorCode !== ledgerHealth.errorCode;
    notify(changedProjects, healthChanged);
    return persisted;
  }

  function list(projectId, filters = {}) {
    const checked = validateFilters(filters, limits);
    let events = projectSnapshot(projectId).events.filter((event) => eventMatches(event, checked));
    if (checked.limit != null && events.length > checked.limit) events = events.slice(-checked.limit);
    return deepFreeze([...events]);
  }

  const api = {
    append(input) {
      const event = normalizeEvent(input, { limits, now, createId: nextEventId, stored: false });
      if (envelope.events.some((existing) => existing.eventId === event.eventId)) {
        throw new RuntimeEventLedgerError("Runtime event ID already exists.", "runtime-event-id-duplicate");
      }
      const previousEvents = envelope.events;
      const next = envelopeWithEvents(
        [...previousEvents, event],
        envelope.revision + 1,
        isoTimestamp(now(), "Runtime event ledger update time"),
        limits,
      );
      const retainedIds = new Set(next.events.map((item) => item.eventId));
      const changedProjects = new Set([event.projectId]);
      for (const previous of previousEvents) if (!retainedIds.has(previous.eventId)) changedProjects.add(previous.projectId);
      persist(next, changedProjects);
      return event;
    },
    clear(projectId) {
      const id = assertProjectId(projectId);
      const events = envelope.events.filter((event) => event.projectId !== id);
      if (events.length === envelope.events.length) return false;
      const next = envelopeWithEvents(events, envelope.revision + 1, isoTimestamp(now(), "Runtime event ledger update time"), limits);
      return persist(next, new Set([id]), false);
    },
    exportRedacted(projectId, filters = {}) {
      const id = assertProjectId(projectId);
      const events = list(id, filters).map((event) => validateRuntimeEvent(event, { limits }));
      return JSON.stringify({
        events,
        exportedAt: isoTimestamp(now(), "Runtime event export time"),
        projectId: id,
        schemaVersion: RUNTIME_EVENT_EXPORT_SCHEMA_VERSION,
      });
    },
    getHealth: () => ledgerHealth,
    getSnapshot: projectSnapshot,
    list,
    search(projectId, query, filters = {}) {
      if (typeof query !== "string" || !query.trim() || query.length > limits.maxStringLength) {
        throw new RuntimeEventLedgerError("Runtime event search query is invalid.", "runtime-event-filter-invalid");
      }
      const needle = redactAndBoundString(query.trim(), limits.maxStringLength).toLowerCase();
      const results = list(projectId, filters).filter((event) => {
        const haystack = [event.eventId, event.message, event.source, event.adapter, event.runId, event.taskId, JSON.stringify(event.payload)]
          .filter((value) => value != null)
          .join("\n")
          .toLowerCase();
        return haystack.includes(needle);
      });
      return deepFreeze(results);
    },
    subscribe(projectId, listener) {
      const id = assertProjectId(projectId);
      if (typeof listener !== "function") throw new TypeError("Runtime event subscriber must be a function.");
      const subscription = Object.freeze({ listener, projectId: id });
      listeners.add(subscription);
      return () => listeners.delete(subscription);
    },
  };

  return Object.freeze(api);
}
