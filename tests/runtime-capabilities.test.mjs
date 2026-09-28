import test from "node:test";
import assert from "node:assert/strict";

import {
  RUNTIME_CAPABILITY_MATRIX_SCHEMA_VERSION,
  RUNTIME_CAPABILITY_RECEIPT_SCHEMA_VERSION,
  createRuntimeCapabilityMatrix,
  createRuntimeCapabilityReceipt,
  runtimeActionCatalog,
  runtimeCapabilityCatalog,
  runtimeCapabilityHealthStates,
  runtimeCapabilityIds,
  runtimeCapabilityScopes,
  selectRuntimeActionEligibility,
  selectRuntimeCapabilities,
  selectRuntimeCapability,
  validateRuntimeCapabilityMatrix,
} from "../src/runtime/runtimeCapabilities.js";

const projectA = "pp_alpha_project";
const projectB = "pp_beta_project";
const now = "2026-09-04T04:00:00.000Z";
const observedAt = "2026-09-04T03:59:00.000Z";
const expiresAt = "2026-09-04T04:05:00.000Z";

function descriptor(capabilityId) {
  return runtimeCapabilityCatalog.find((item) => item.capabilityId === capabilityId);
}

function receipt(capabilityId, overrides = {}) {
  const health = overrides.health ?? "available";
  const definition = descriptor(capabilityId);
  return {
    capabilityId,
    denialReasons: health === "available" ? [] : ["runtime-probe-failed"],
    expiresAt,
    health,
    observedAt,
    projectId: projectA,
    receiptId: `rcpt_${capabilityId.replaceAll("-", "_")}_001`,
    schemaVersion: RUNTIME_CAPABILITY_RECEIPT_SCHEMA_VERSION,
    scopes: [definition.supportedScopes[0]],
    source: definition.receiptSources[0],
    ...overrides,
  };
}

test("the catalog models every required runtime with exact immutable descriptors", () => {
  assert.deepEqual(runtimeCapabilityIds, ["browser", "native-tauri", "hosted-static", "mcp", "git", "provider", "ci", "computer-use"]);
  assert.deepEqual(runtimeCapabilityHealthStates, ["available", "degraded", "unavailable", "stale", "incompatible"]);
  assert.deepEqual(runtimeCapabilityScopes, ["read", "content", "mutate", "execute"]);
  assert.equal(runtimeCapabilityCatalog.every((item) => item.schemaVersion === 1), true);
  assert.equal(new Set(runtimeActionCatalog.map((item) => item.actionId)).size, runtimeActionCatalog.length);
  assert.throws(() => runtimeCapabilityCatalog.push({}), TypeError);
  assert.throws(() => runtimeCapabilityCatalog[0].supportedScopes.push("execute"), TypeError);
});

test("a clean matrix is complete, immutable, and unavailable without receipts", () => {
  const matrix = createRuntimeCapabilityMatrix({ projectId: projectA, receipts: [], now });
  assert.equal(matrix.schemaVersion, RUNTIME_CAPABILITY_MATRIX_SCHEMA_VERSION);
  assert.equal(matrix.capabilities.length, 8);
  assert.deepEqual(matrix.counts, { available: 0, degraded: 0, unavailable: 8, stale: 0, incompatible: 0 });
  assert.equal(matrix.capabilities.every((item) => item.available === false && item.denialReasons.includes("receipt-missing")), true);
  assert.equal(selectRuntimeActionEligibility(matrix, "mcp.inspect", { projectId: projectA }).eligible, false);
  assert.throws(() => matrix.capabilities.push({}), TypeError);
});

test("current project-bound receipts produce a deterministic aggregate matrix", () => {
  const receipts = runtimeCapabilityIds.map((capabilityId, index) => receipt(capabilityId, {
    receiptId: `rcpt_${capabilityId.replaceAll("-", "_")}_${String(index + 1).padStart(3, "0")}`,
    scopes: [...descriptor(capabilityId).supportedScopes],
  })).reverse();
  const matrix = createRuntimeCapabilityMatrix({ projectId: projectA, receipts, now });
  assert.deepEqual(matrix.capabilities.map((item) => item.capabilityId), runtimeCapabilityIds);
  assert.deepEqual(matrix.counts, { available: 8, degraded: 0, unavailable: 0, stale: 0, incompatible: 0 });
  assert.equal(matrix.rejectedReceipts.length, 0);
  assert.equal(selectRuntimeCapabilities(matrix, { available: true }).length, 8);
  assert.equal(selectRuntimeCapabilities(matrix, { scope: "execute" }).map((item) => item.capabilityId).includes("computer-use"), true);
});

test("configuration and toggle-shaped inputs can never create availability", () => {
  assert.throws(() => createRuntimeCapabilityMatrix({ projectId: projectA, receipts: [], now, enabled: { mcp: true } }), /unknown field/i);
  assert.throws(() => createRuntimeCapabilityReceipt({ ...receipt("mcp"), configured: true }), /unknown or missing field/i);
  const configured = { ...receipt("mcp"), source: "settings-toggle" };
  const matrix = createRuntimeCapabilityMatrix({ projectId: projectA, receipts: [configured], now });
  const mcp = selectRuntimeCapability(matrix, "mcp");
  assert.equal(mcp.available, false);
  assert.equal(mcp.health, "incompatible");
  assert.deepEqual(mcp.denialReasons, ["receipt-source-invalid"]);
});

test("receipt health and denial reasons must agree exactly", () => {
  assert.throws(() => createRuntimeCapabilityReceipt({ ...receipt("browser"), denialReasons: ["configured-only"] }), /available capability cannot carry denial/i);
  assert.throws(() => createRuntimeCapabilityReceipt({ ...receipt("browser", { health: "degraded" }), denialReasons: [] }), /requires a denial reason/i);
  const receipts = [
    receipt("browser"),
    receipt("native-tauri", { health: "degraded" }),
    receipt("hosted-static", { health: "unavailable" }),
    receipt("mcp", { health: "stale" }),
    receipt("git", { health: "incompatible" }),
  ];
  const matrix = createRuntimeCapabilityMatrix({ projectId: projectA, receipts, now });
  assert.deepEqual(matrix.counts, { available: 1, degraded: 1, unavailable: 4, stale: 1, incompatible: 1 });
});

test("expired receipts become stale and cannot make an action eligible", () => {
  const matrix = createRuntimeCapabilityMatrix({
    projectId: projectA,
    receipts: [receipt("ci", { expiresAt: "2026-09-04T04:00:00.000Z", scopes: ["execute"] })],
    now,
  });
  const ci = selectRuntimeCapability(matrix, "ci");
  assert.equal(ci.health, "stale");
  assert.equal(ci.available, false);
  assert.equal(ci.denialReasons.includes("receipt-expired"), true);
  const action = selectRuntimeActionEligibility(matrix, "ci.run", { projectId: projectA });
  assert.equal(action.eligible, false);
  assert.equal(action.denialReasons.includes("capability-stale"), true);
});

test("future observations and future receipt schemas fail closed", () => {
  const futureObservation = createRuntimeCapabilityMatrix({
    projectId: projectA,
    receipts: [receipt("browser", { observedAt: "2026-09-04T04:00:01.000Z" })],
    now,
  });
  assert.equal(selectRuntimeCapability(futureObservation, "browser").health, "incompatible");
  assert.deepEqual(selectRuntimeCapability(futureObservation, "browser").denialReasons, ["receipt-observed-in-future"]);

  const futureSchema = createRuntimeCapabilityMatrix({
    projectId: projectA,
    receipts: [{ ...receipt("mcp"), schemaVersion: 2 }],
    now,
  });
  assert.equal(selectRuntimeCapability(futureSchema, "mcp").available, false);
  assert.deepEqual(selectRuntimeCapability(futureSchema, "mcp").denialReasons, ["schema-version-unsupported"]);
});

test("foreign-project receipts fail closed without leaking their scopes", () => {
  const matrix = createRuntimeCapabilityMatrix({ projectId: projectA, receipts: [receipt("git", { projectId: projectB, scopes: ["read", "content", "mutate"] })], now });
  const git = selectRuntimeCapability(matrix, "git");
  assert.equal(git.health, "incompatible");
  assert.equal(git.available, false);
  assert.deepEqual(git.scopes, []);
  assert.deepEqual(git.denialReasons, ["project-binding-mismatch"]);
  assert.deepEqual(matrix.rejectedReceipts[0], { capabilityId: "git", denialReason: "project-binding-mismatch", receiptId: "rcpt_git_001" });
});

test("duplicates and unknown capability receipts are rejected deterministically", () => {
  const matrix = createRuntimeCapabilityMatrix({
    projectId: projectA,
    receipts: [receipt("browser"), receipt("browser", { receiptId: "rcpt_browser_002" }), { ...receipt("browser"), capabilityId: "teleport", receiptId: "rcpt_teleport_001" }],
    now,
  });
  assert.equal(selectRuntimeCapability(matrix, "browser").health, "incompatible");
  assert.deepEqual(selectRuntimeCapability(matrix, "browser").denialReasons, ["duplicate-receipts"]);
  assert.equal(matrix.rejectedReceipts.filter((item) => item.denialReason === "duplicate-receipts").length, 2);
  assert.equal(matrix.rejectedReceipts.some((item) => item.capabilityId === null && item.denialReason === "capability-unknown"), true);
});

test("unsupported scope expansion and malformed expiry are incompatible", () => {
  const matrix = createRuntimeCapabilityMatrix({
    projectId: projectA,
    receipts: [receipt("hosted-static", { scopes: ["mutate"] }), receipt("provider", { expiresAt: observedAt })],
    now,
  });
  assert.deepEqual(selectRuntimeCapability(matrix, "hosted-static").denialReasons, ["receipt-scope-invalid"]);
  assert.deepEqual(selectRuntimeCapability(matrix, "provider").denialReasons, ["receipt-expiry-invalid"]);
});

test("invalid identities, unsafe reasons, sparse arrays, and hostile accessors fail closed", () => {
  assert.throws(() => createRuntimeCapabilityMatrix({ projectId: "alpha", receipts: [], now }), /Project ID is invalid/i);
  assert.throws(() => createRuntimeCapabilityReceipt({ ...receipt("browser"), projectId: "alpha" }), /Project ID is invalid/i);
  assert.throws(() => createRuntimeCapabilityReceipt({ ...receipt("browser", { health: "degraded" }), denialReasons: ["raw error includes a path"] }), /invalid value/i);

  const sparseScopes = [];
  sparseScopes.length = 1;
  const sparse = createRuntimeCapabilityMatrix({ projectId: projectA, receipts: [receipt("mcp", { scopes: sparseScopes })], now });
  assert.deepEqual(selectRuntimeCapability(sparse, "mcp").denialReasons, ["receipt-schema-invalid"]);

  const hostile = {};
  Object.defineProperty(hostile, "capabilityId", { enumerable: true, get() { throw new Error("secret filesystem path"); } });
  const hostileMatrix = createRuntimeCapabilityMatrix({ projectId: projectA, receipts: [hostile], now });
  assert.equal(hostileMatrix.rejectedReceipts.length, 1);
  assert.deepEqual(hostileMatrix.rejectedReceipts[0], { capabilityId: null, denialReason: "capability-unknown", receiptId: null });
  assert.equal(JSON.stringify(hostileMatrix).includes("secret filesystem path"), false);
});

test("action eligibility requires the exact project, healthy receipt, and every required scope", () => {
  const matrix = createRuntimeCapabilityMatrix({ projectId: projectA, receipts: [receipt("git", { scopes: ["read"] })], now });
  assert.equal(selectRuntimeActionEligibility(matrix, "git.inspect", { projectId: projectA }).eligible, true);

  const mutation = selectRuntimeActionEligibility(matrix, "git.mutate", { projectId: projectA });
  assert.equal(mutation.eligible, false);
  assert.deepEqual(mutation.denialReasons, ["scope-missing:mutate"]);

  assert.deepEqual(selectRuntimeActionEligibility(matrix, "git.inspect").denialReasons, ["project-binding-required"]);
  assert.deepEqual(selectRuntimeActionEligibility(matrix, "git.inspect", { projectId: projectB }).denialReasons, ["project-binding-mismatch"]);
  assert.deepEqual(selectRuntimeActionEligibility(matrix, "unknown.action", { projectId: projectA }).denialReasons, ["action-unknown"]);
});

test("degraded capabilities retain health evidence but remain action-ineligible", () => {
  const matrix = createRuntimeCapabilityMatrix({ projectId: projectA, receipts: [receipt("computer-use", { health: "degraded", scopes: ["read", "mutate"] })], now });
  const capability = selectRuntimeCapability(matrix, "computer-use");
  assert.equal(capability.health, "degraded");
  assert.equal(capability.available, false);
  const action = selectRuntimeActionEligibility(matrix, "computer-use.mutate", { projectId: projectA });
  assert.equal(action.eligible, false);
  assert.equal(action.denialReasons.includes("capability-degraded"), true);
  assert.equal(action.denialReasons.includes("runtime-probe-failed"), true);
});

test("matrix validation rejects tampered counts, ordering, and future schemas", () => {
  const matrix = createRuntimeCapabilityMatrix({ projectId: projectA, receipts: [receipt("browser")], now });
  const tamperedCounts = JSON.parse(JSON.stringify(matrix));
  tamperedCounts.counts.available = 8;
  assert.throws(() => validateRuntimeCapabilityMatrix(tamperedCounts), /counts are inconsistent/i);

  const reordered = JSON.parse(JSON.stringify(matrix));
  [reordered.capabilities[0], reordered.capabilities[1]] = [reordered.capabilities[1], reordered.capabilities[0]];
  assert.throws(() => validateRuntimeCapabilityMatrix(reordered), /identity is invalid/i);

  const future = JSON.parse(JSON.stringify(matrix));
  future.schemaVersion = 99;
  assert.throws(() => validateRuntimeCapabilityMatrix(future), /Unsupported runtime capability schema version/i);

  const forgedFreshness = JSON.parse(JSON.stringify(matrix));
  forgedFreshness.capabilities[0].expiresAt = "2026-09-04T04:00:00.000Z";
  assert.throws(() => validateRuntimeCapabilityMatrix(forgedFreshness), /not current/i);
});
