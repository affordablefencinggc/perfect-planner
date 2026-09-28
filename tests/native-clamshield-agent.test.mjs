import assert from "node:assert/strict";
import test from "node:test";
import {
  readClamShieldAgentStatus,
  validateClamShieldPingResponse,
  validateClamShieldStatusResponse,
} from "../src/native/clamShieldAgent.js";

const volume = (overrides = {}) => ({
  key: "c", root: "C:/", identity: "volume-c", filesystem: "NTFS", state: "READY", backend: "MFT",
  indexedRecords: 12, storageBytes: 1200, directoriesSeen: 3, errors: 0, startedAtMs: 1,
  completedAtMs: 2, lastError: null, complete: true, continuous: true, journalState: "CURRENT",
  journalId: "journal-c", journalNextUsn: 10, journalLowestValidUsn: 1, journalEventsApplied: 2,
  lastReconciledAtMs: 2, message: "ready", contentScanned: false, substringReady: true, online: true, ...overrides,
});
const ping = (overrides = {}) => ({ result: "pong", payload: { protocolVersion: 1, service: "ClamShieldIndexBroker", ...overrides } });
const status = (overrides = {}) => ({
  result: "status",
  payload: { running: false, cancelRequested: false, volumes: [volume()], indexedRecords: 12, completeVolumes: 1, incompleteVolumes: 0, message: "ready", contentScanned: false, ...overrides },
});

test("static Planner releases never contact the optional ClamShield agent", async () => {
  let calls = 0;
  const result = await readClamShieldAgentStatus({ runtime: {}, transport: async () => { calls += 1; } });
  assert.equal(calls, 0);
  assert.equal(result.connectionState, "unavailable");
  assert.equal(result.authoritative, false);
});

test("status connector emits only ping and status and remains unverified", async () => {
  const requests = [];
  const result = await readClamShieldAgentStatus({
    runtime: { __TAURI_INTERNALS__: {} },
    transport: async (request) => { requests.push(request); return request.command === "ping" ? ping() : status(); },
  });
  assert.deepEqual(requests, [{ command: "ping", protocolVersion: 1 }, { command: "status", protocolVersion: 1 }]);
  assert.equal(result.connectionState, "detected-unverified");
  assert.equal(result.contentMode, "metadata-only");
  assert.equal(result.authoritative, false);
  assert.equal(result.canApprove, false);
  assert.equal(result.canExecute, false);
  assert.equal(result.canMarkComplete, false);
  assert.equal(Object.isFrozen(result.index.volumes[0]), true);
});

test("even reported content scanning cannot become clean or CI authority", async () => {
  const result = await readClamShieldAgentStatus({
    runtime: { __TAURI_INTERNALS__: {} },
    transport: async (request) => request.command === "ping" ? ping() : status({ contentScanned: true, volumes: [volume({ contentScanned: true })] }),
  });
  assert.equal(result.contentMode, "reported-content-scanned-unverified");
  assert.equal("security" in result, false);
  assert.equal("ci" in result, false);
  assert.equal(result.authoritative, false);
});

test("wrong protocol, service, fields, result, and counts are incompatible", async () => {
  assert.throws(() => validateClamShieldPingResponse(ping({ protocolVersion: 2 })), /version/);
  assert.throws(() => validateClamShieldPingResponse(ping({ service: "Impostor" })), /identity/);
  assert.throws(() => validateClamShieldStatusResponse({ ...status(), extra: true }), /unknown or missing/);
  assert.throws(() => validateClamShieldStatusResponse({ ...status(), result: "action" }), /incompatible result/);
  assert.throws(() => validateClamShieldStatusResponse(status({ indexedRecords: 13 })), /do not reconcile/);
  assert.throws(() => validateClamShieldStatusResponse(status({ completeVolumes: 0 })), /volume counts/);

  const result = await readClamShieldAgentStatus({ runtime: { __TAURI_INTERNALS__: {} }, transport: async () => ping({ service: "Impostor" }) });
  assert.equal(result.connectionState, "incompatible");
  assert.equal(result.authoritative, false);
});

test("transport absence and connection failures remain ordinary unavailability", async () => {
  const runtime = { __TAURI_INTERNALS__: {} };
  assert.equal((await readClamShieldAgentStatus({ runtime })).connectionState, "unavailable");
  const result = await readClamShieldAgentStatus({ runtime, transport: async () => { throw new Error("pipe connection unavailable"); } });
  assert.equal(result.connectionState, "unavailable");
  assert.equal(result.available, false);
});

test("volume and text bounds fail closed", () => {
  assert.throws(() => validateClamShieldStatusResponse(status({ volumes: Array.from({ length: 65 }, (_, index) => volume({ key: `v${index}`, identity: `volume-${index}` })), completeVolumes: 65, indexedRecords: 780 })), /volume bound/);
  assert.throws(() => validateClamShieldStatusResponse(status({ message: "x".repeat(4097) })), /bounded text/);
  assert.throws(() => validateClamShieldStatusResponse(status({ volumes: [volume(), volume()], completeVolumes: 2, indexedRecords: 24 })), /duplicated/);
});
