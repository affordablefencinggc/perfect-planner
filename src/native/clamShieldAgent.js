const CLIENT_SCHEMA_VERSION = 1;
const CLAMSHIELD_PROTOCOL_VERSION = 1;
const EXPECTED_SERVICE = "ClamShieldIndexBroker";
const MAX_VOLUMES = 64;
const MAX_TEXT_LENGTH = 4096;

const RESPONSE_KEYS = Object.freeze(["payload", "result"]);
const PING_KEYS = Object.freeze(["protocolVersion", "service"]);
const STATUS_KEYS = Object.freeze([
  "cancelRequested",
  "completeVolumes",
  "contentScanned",
  "incompleteVolumes",
  "indexedRecords",
  "message",
  "running",
  "volumes",
]);
const VOLUME_KEYS = Object.freeze([
  "backend",
  "complete",
  "completedAtMs",
  "contentScanned",
  "continuous",
  "directoriesSeen",
  "errors",
  "filesystem",
  "identity",
  "indexedRecords",
  "journalEventsApplied",
  "journalId",
  "journalLowestValidUsn",
  "journalNextUsn",
  "journalState",
  "key",
  "lastError",
  "lastReconciledAtMs",
  "message",
  "online",
  "root",
  "startedAtMs",
  "state",
  "storageBytes",
  "substringReady",
]);

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) throw new Error(`${label} has an unknown or missing field.`);
}

function boundedText(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.length > MAX_TEXT_LENGTH) throw new Error(`${label} must be bounded text.`);
  return value;
}

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer.`);
  return value;
}

function optionalInteger(value, label) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer or null.`);
  return value;
}

function unavailable(reason) {
  return Object.freeze({
    schemaVersion: CLIENT_SCHEMA_VERSION,
    connectionState: "unavailable",
    available: false,
    authoritative: false,
    reason,
    canApprove: false,
    canExecute: false,
    canMarkComplete: false,
  });
}

function incompatible(reason) {
  return Object.freeze({
    schemaVersion: CLIENT_SCHEMA_VERSION,
    connectionState: "incompatible",
    available: true,
    authoritative: false,
    reason,
    canApprove: false,
    canExecute: false,
    canMarkComplete: false,
  });
}

export function isClamShieldDesktopRuntime(runtime = globalThis) {
  return Boolean(runtime && typeof runtime === "object" && "__TAURI_INTERNALS__" in runtime);
}

export function validateClamShieldPingResponse(value) {
  exactObject(value, RESPONSE_KEYS, "ClamShield ping response");
  if (value.result !== "pong") throw new Error("ClamShield ping returned an incompatible result.");
  exactObject(value.payload, PING_KEYS, "ClamShield ping payload");
  if (value.payload.protocolVersion !== CLAMSHIELD_PROTOCOL_VERSION) throw new Error("ClamShield protocol version is incompatible.");
  if (value.payload.service !== EXPECTED_SERVICE) throw new Error("ClamShield service identity is incompatible.");
  return Object.freeze({ protocolVersion: value.payload.protocolVersion, service: value.payload.service });
}

export function validateClamShieldStatusResponse(value) {
  exactObject(value, RESPONSE_KEYS, "ClamShield status response");
  if (value.result !== "status") throw new Error("ClamShield status returned an incompatible result.");
  exactObject(value.payload, STATUS_KEYS, "ClamShield status payload");
  const status = value.payload;
  if (typeof status.running !== "boolean" || typeof status.cancelRequested !== "boolean" || typeof status.contentScanned !== "boolean") throw new Error("ClamShield status flags are invalid.");
  for (const key of ["indexedRecords", "completeVolumes", "incompleteVolumes"]) count(status[key], `ClamShield ${key}`);
  boundedText(status.message, "ClamShield status message");
  if (!Array.isArray(status.volumes) || status.volumes.length > MAX_VOLUMES) throw new Error("ClamShield status exceeds the volume bound.");
  if (status.completeVolumes + status.incompleteVolumes !== status.volumes.length) throw new Error("ClamShield volume counts do not reconcile.");

  const identities = new Set();
  const volumes = status.volumes.map((volume, index) => {
    exactObject(volume, VOLUME_KEYS, `ClamShield volume ${index}`);
    for (const key of ["key", "root", "identity", "filesystem", "state", "backend", "journalState", "message"]) boundedText(volume[key], `ClamShield volume ${key}`);
    for (const key of ["journalId", "lastError"]) boundedText(volume[key], `ClamShield volume ${key}`, { nullable: true });
    for (const key of ["indexedRecords", "storageBytes", "directoriesSeen", "errors", "journalEventsApplied"]) count(volume[key], `ClamShield volume ${key}`);
    for (const key of ["startedAtMs", "completedAtMs", "journalNextUsn", "journalLowestValidUsn", "lastReconciledAtMs"]) optionalInteger(volume[key], `ClamShield volume ${key}`);
    for (const key of ["complete", "continuous", "contentScanned", "substringReady", "online"]) if (typeof volume[key] !== "boolean") throw new Error(`ClamShield volume ${key} must be boolean.`);
    if (!volume.key || !volume.identity || identities.has(volume.identity)) throw new Error("ClamShield volume identity is blank or duplicated.");
    identities.add(volume.identity);
    return Object.freeze({ ...volume });
  });

  const indexedRecords = volumes.reduce((total, volume) => total + volume.indexedRecords, 0);
  if (!Number.isSafeInteger(indexedRecords) || indexedRecords !== status.indexedRecords) throw new Error("ClamShield indexed-record counts do not reconcile.");
  return Object.freeze({ ...status, volumes: Object.freeze(volumes) });
}

export async function readClamShieldAgentStatus({ runtime = globalThis, transport } = {}) {
  if (!isClamShieldDesktopRuntime(runtime)) return unavailable("native-runtime-unavailable");
  if (typeof transport !== "function") return unavailable("clamshield-status-transport-unavailable");
  try {
    const ping = validateClamShieldPingResponse(await transport(Object.freeze({ command: "ping", protocolVersion: CLAMSHIELD_PROTOCOL_VERSION })));
    const status = validateClamShieldStatusResponse(await transport(Object.freeze({ command: "status", protocolVersion: CLAMSHIELD_PROTOCOL_VERSION })));
    return Object.freeze({
      schemaVersion: CLIENT_SCHEMA_VERSION,
      connectionState: "detected-unverified",
      available: true,
      authoritative: false,
      reason: "ClamShield protocol v1 has no authenticated, workspace-bound evidence receipt.",
      protocolVersion: ping.protocolVersion,
      service: ping.service,
      contentMode: status.contentScanned ? "reported-content-scanned-unverified" : "metadata-only",
      index: status,
      canApprove: false,
      canExecute: false,
      canMarkComplete: false,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "ClamShield status request failed.";
    if (/unavailable|not found|closed|timeout|timed out|connect/i.test(reason)) return unavailable(reason);
    return incompatible(reason);
  }
}

export const clamShieldStatusProtocolVersion = CLAMSHIELD_PROTOCOL_VERSION;
