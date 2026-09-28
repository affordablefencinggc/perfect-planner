import { assertProjectId } from "../project/projectIds.js";

export const RUNTIME_CAPABILITY_DESCRIPTOR_SCHEMA_VERSION = 1;
export const RUNTIME_CAPABILITY_RECEIPT_SCHEMA_VERSION = 1;
export const RUNTIME_CAPABILITY_MATRIX_SCHEMA_VERSION = 1;
export const RUNTIME_ACTION_ELIGIBILITY_SCHEMA_VERSION = 1;

export const runtimeCapabilityHealthStates = Object.freeze([
  "available",
  "degraded",
  "unavailable",
  "stale",
  "incompatible",
]);

export const runtimeCapabilityScopes = Object.freeze(["read", "content", "mutate", "execute"]);

const capabilityDefinitions = [
  { capabilityId: "browser", label: "Browser", receiptSources: ["browser-runtime-probe"], supportedScopes: ["read", "content"] },
  { capabilityId: "native-tauri", label: "Native / Tauri", receiptSources: ["tauri-runtime-snapshot"], supportedScopes: ["read", "content", "mutate", "execute"] },
  { capabilityId: "hosted-static", label: "Hosted / static", receiptSources: ["hosted-deployment-receipt"], supportedScopes: ["read", "content"] },
  { capabilityId: "mcp", label: "MCP", receiptSources: ["mcp-handshake-receipt"], supportedScopes: ["read", "content", "mutate", "execute"] },
  { capabilityId: "git", label: "Git", receiptSources: ["git-runtime-probe"], supportedScopes: ["read", "content", "mutate"] },
  { capabilityId: "provider", label: "Provider", receiptSources: ["provider-handshake-receipt"], supportedScopes: ["read", "content", "execute"] },
  { capabilityId: "ci", label: "CI", receiptSources: ["ci-run-receipt"], supportedScopes: ["read", "content", "execute"] },
  { capabilityId: "computer-use", label: "Computer use", receiptSources: ["computer-use-session-receipt"], supportedScopes: ["read", "content", "mutate", "execute"] },
];

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

export const runtimeCapabilityCatalog = deepFreeze(capabilityDefinitions.map((definition) => ({
  schemaVersion: RUNTIME_CAPABILITY_DESCRIPTOR_SCHEMA_VERSION,
  ...definition,
})));
export const runtimeCapabilityIds = Object.freeze(runtimeCapabilityCatalog.map((descriptor) => descriptor.capabilityId));

const descriptorById = new Map(runtimeCapabilityCatalog.map((descriptor) => [descriptor.capabilityId, descriptor]));
const RECEIPT_KEYS = Object.freeze(["capabilityId", "denialReasons", "expiresAt", "health", "observedAt", "projectId", "receiptId", "schemaVersion", "scopes", "source"]);
const MATRIX_KEYS = Object.freeze(["capabilities", "counts", "evaluatedAt", "projectId", "rejectedReceipts", "schemaVersion"]);
const MATRIX_ROW_KEYS = Object.freeze(["available", "capabilityId", "denialReasons", "expiresAt", "health", "label", "observedAt", "projectId", "receiptId", "schemaVersion", "scopes", "source"]);
const COUNT_KEYS = Object.freeze(runtimeCapabilityHealthStates);
const REJECTION_KEYS = Object.freeze(["capabilityId", "denialReason", "receiptId"]);
const SAFE_TOKEN = /^[a-z0-9][a-z0-9._:-]{0,95}$/;
const RECEIPT_ID = /^rcpt_[a-z0-9][a-z0-9_-]{2,95}$/;

export class RuntimeCapabilityContractError extends Error {
  constructor(message, code = "runtime-capability-invalid") {
    super(message);
    this.name = "RuntimeCapabilityContractError";
    this.code = code;
  }
}

export class UnsupportedRuntimeCapabilityVersionError extends RuntimeCapabilityContractError {
  constructor(version) {
    super(`Unsupported runtime capability schema version: ${String(version)}.`, "schema-version-unsupported");
    this.name = "UnsupportedRuntimeCapabilityVersionError";
  }
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeCapabilityContractError(`${label} must be an object.`, "receipt-schema-invalid");
  }
  let actual;
  try {
    actual = Object.keys(value).sort();
  } catch {
    throw new RuntimeCapabilityContractError(`${label} keys are unreadable.`, "receipt-schema-invalid");
  }
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new RuntimeCapabilityContractError(`${label} has an unknown or missing field.`, "receipt-schema-invalid");
  }
}

function allowedObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeCapabilityContractError(`${label} must be an object.`, "runtime-capability-input-invalid");
  }
  let actual;
  try {
    actual = Object.keys(value);
  } catch {
    throw new RuntimeCapabilityContractError(`${label} keys are unreadable.`, "runtime-capability-input-invalid");
  }
  if (actual.some((key) => !keys.includes(key))) {
    throw new RuntimeCapabilityContractError(`${label} has an unknown field.`, "runtime-capability-input-invalid");
  }
}

function timestamp(value, label, code = "receipt-time-invalid") {
  const date = typeof value === "number" ? new Date(value) : value instanceof Date ? value : new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) throw new RuntimeCapabilityContractError(`${label} is invalid.`, code);
  return date.toISOString();
}

function descriptorFor(capabilityId) {
  const descriptor = descriptorById.get(capabilityId);
  if (!descriptor) throw new RuntimeCapabilityContractError(`Unknown runtime capability: ${String(capabilityId)}.`, "capability-unknown");
  return descriptor;
}

function normalizedTokens(value, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(value)) throw new RuntimeCapabilityContractError(`${label} must be an array.`, "receipt-schema-invalid");
  if (Array.from({ length: value.length }, (_, index) => index).some((index) => !Object.hasOwn(value, index))) {
    throw new RuntimeCapabilityContractError(`${label} cannot contain sparse entries.`, "receipt-schema-invalid");
  }
  const result = value.map((item) => {
    if (typeof item !== "string" || !SAFE_TOKEN.test(item)) throw new RuntimeCapabilityContractError(`${label} contains an invalid value.`, "receipt-schema-invalid");
    return item;
  });
  if (!allowEmpty && result.length === 0) throw new RuntimeCapabilityContractError(`${label} cannot be empty.`, "receipt-schema-invalid");
  if (new Set(result).size !== result.length) throw new RuntimeCapabilityContractError(`${label} must be unique.`, "receipt-schema-invalid");
  return Object.freeze([...result].sort());
}

function safeReceiptId(value) {
  if (typeof value !== "string" || !RECEIPT_ID.test(value)) {
    throw new RuntimeCapabilityContractError("Runtime capability receipt ID is invalid.", "receipt-id-invalid");
  }
  return value;
}

export function validateRuntimeCapabilityReceipt(input) {
  exactObject(input, RECEIPT_KEYS, "Runtime capability receipt");
  if (input.schemaVersion !== RUNTIME_CAPABILITY_RECEIPT_SCHEMA_VERSION) throw new UnsupportedRuntimeCapabilityVersionError(input.schemaVersion);
  const descriptor = descriptorFor(input.capabilityId);
  const projectId = assertProjectId(input.projectId);
  if (!runtimeCapabilityHealthStates.includes(input.health)) {
    throw new RuntimeCapabilityContractError("Runtime capability health is invalid.", "receipt-health-invalid");
  }
  if (!descriptor.receiptSources.includes(input.source)) {
    throw new RuntimeCapabilityContractError("Runtime capability receipt source is not an accepted runtime evidence source.", "receipt-source-invalid");
  }
  const observedAt = timestamp(input.observedAt, "Runtime capability observation");
  const expiresAt = timestamp(input.expiresAt, "Runtime capability expiry");
  if (Date.parse(expiresAt) <= Date.parse(observedAt)) {
    throw new RuntimeCapabilityContractError("Runtime capability expiry must follow its observation.", "receipt-expiry-invalid");
  }
  const scopes = normalizedTokens(input.scopes, "Runtime capability scopes", { allowEmpty: input.health !== "available" });
  if (scopes.some((scope) => !runtimeCapabilityScopes.includes(scope) || !descriptor.supportedScopes.includes(scope))) {
    throw new RuntimeCapabilityContractError("Runtime capability receipt expands beyond supported scopes.", "receipt-scope-invalid");
  }
  const denialReasons = normalizedTokens(input.denialReasons, "Runtime capability denial reasons");
  if (input.health === "available" && denialReasons.length) {
    throw new RuntimeCapabilityContractError("An available capability cannot carry denial reasons.", "receipt-health-invalid");
  }
  if (input.health !== "available" && denialReasons.length === 0) {
    throw new RuntimeCapabilityContractError("A non-available capability requires a denial reason.", "receipt-health-invalid");
  }
  return deepFreeze({
    capabilityId: descriptor.capabilityId,
    denialReasons,
    expiresAt,
    health: input.health,
    observedAt,
    projectId,
    receiptId: safeReceiptId(input.receiptId),
    schemaVersion: RUNTIME_CAPABILITY_RECEIPT_SCHEMA_VERSION,
    scopes,
    source: input.source,
  });
}

export const createRuntimeCapabilityReceipt = validateRuntimeCapabilityReceipt;

function uniqueReasons(reasons) {
  return Object.freeze([...new Set(reasons)].sort());
}

function matrixRow(descriptor, projectId, {
  health,
  denialReasons,
  receipt = null,
}) {
  const available = health === "available";
  return deepFreeze({
    available,
    capabilityId: descriptor.capabilityId,
    denialReasons: uniqueReasons(available ? [] : denialReasons),
    expiresAt: receipt?.expiresAt ?? null,
    health,
    label: descriptor.label,
    observedAt: receipt?.observedAt ?? null,
    projectId,
    receiptId: receipt?.receiptId ?? null,
    schemaVersion: RUNTIME_CAPABILITY_MATRIX_SCHEMA_VERSION,
    scopes: Object.freeze(available ? [...receipt.scopes] : []),
    source: receipt?.source ?? null,
  });
}

function rawToken(value, expression) {
  try {
    return typeof value === "string" && expression.test(value) ? value : null;
  } catch {
    return null;
  }
}

function rejectedReceipt(value, denialReason) {
  let capabilityId = null;
  let receiptId = null;
  try {
    capabilityId = runtimeCapabilityIds.includes(value?.capabilityId) ? value.capabilityId : null;
    receiptId = rawToken(value?.receiptId, RECEIPT_ID);
  } catch {
    // Accessor failures are deliberately reduced to a redacted rejection.
  }
  return Object.freeze({ capabilityId, denialReason, receiptId });
}

function capabilityFromRaw(value) {
  try {
    return runtimeCapabilityIds.includes(value?.capabilityId) ? value.capabilityId : null;
  } catch {
    return null;
  }
}

export function createRuntimeCapabilityMatrix(input) {
  allowedObject(input, ["now", "projectId", "receipts"], "Runtime capability matrix input");
  const projectId = assertProjectId(input.projectId);
  const evaluatedAt = timestamp(input.now ?? Date.now(), "Runtime capability evaluation", "matrix-time-invalid");
  const evaluatedEpoch = Date.parse(evaluatedAt);
  const rawReceipts = input.receipts ?? [];
  if (!Array.isArray(rawReceipts) || rawReceipts.length > 64) {
    throw new RuntimeCapabilityContractError("Runtime capability receipts must be a bounded array.", "matrix-receipts-invalid");
  }

  const grouped = new Map(runtimeCapabilityIds.map((capabilityId) => [capabilityId, []]));
  const rejectedReceipts = [];
  for (const candidate of rawReceipts) {
    const capabilityId = capabilityFromRaw(candidate);
    if (!capabilityId) rejectedReceipts.push(rejectedReceipt(candidate, "capability-unknown"));
    else grouped.get(capabilityId).push(candidate);
  }

  const capabilities = runtimeCapabilityCatalog.map((descriptor) => {
    const candidates = grouped.get(descriptor.capabilityId);
    if (candidates.length === 0) {
      return matrixRow(descriptor, projectId, { health: "unavailable", denialReasons: ["receipt-missing"] });
    }
    if (candidates.length > 1) {
      candidates.forEach((candidate) => rejectedReceipts.push(rejectedReceipt(candidate, "duplicate-receipts")));
      return matrixRow(descriptor, projectId, { health: "incompatible", denialReasons: ["duplicate-receipts"] });
    }

    let receipt;
    try {
      receipt = validateRuntimeCapabilityReceipt(candidates[0]);
    } catch (error) {
      const reason = error instanceof RuntimeCapabilityContractError ? error.code : "receipt-schema-invalid";
      rejectedReceipts.push(rejectedReceipt(candidates[0], reason));
      return matrixRow(descriptor, projectId, { health: "incompatible", denialReasons: [reason] });
    }
    if (receipt.projectId !== projectId) {
      rejectedReceipts.push(rejectedReceipt(receipt, "project-binding-mismatch"));
      return matrixRow(descriptor, projectId, { health: "incompatible", denialReasons: ["project-binding-mismatch"], receipt });
    }
    if (Date.parse(receipt.observedAt) > evaluatedEpoch) {
      rejectedReceipts.push(rejectedReceipt(receipt, "receipt-observed-in-future"));
      return matrixRow(descriptor, projectId, { health: "incompatible", denialReasons: ["receipt-observed-in-future"], receipt });
    }
    if (Date.parse(receipt.expiresAt) <= evaluatedEpoch) {
      return matrixRow(descriptor, projectId, { health: "stale", denialReasons: [...receipt.denialReasons, "receipt-expired"], receipt });
    }
    if (receipt.health !== "available") {
      return matrixRow(descriptor, projectId, { health: receipt.health, denialReasons: receipt.denialReasons, receipt });
    }
    return matrixRow(descriptor, projectId, { health: "available", denialReasons: [], receipt });
  });

  const counts = Object.fromEntries(runtimeCapabilityHealthStates.map((health) => [health, capabilities.filter((capability) => capability.health === health).length]));
  return deepFreeze({
    capabilities,
    counts,
    evaluatedAt,
    projectId,
    rejectedReceipts,
    schemaVersion: RUNTIME_CAPABILITY_MATRIX_SCHEMA_VERSION,
  });
}

function validateMatrixRow(value, descriptor, projectId, evaluatedEpoch) {
  exactObject(value, MATRIX_ROW_KEYS, "Runtime capability matrix row");
  if (value.schemaVersion !== RUNTIME_CAPABILITY_MATRIX_SCHEMA_VERSION) throw new UnsupportedRuntimeCapabilityVersionError(value.schemaVersion);
  if (value.capabilityId !== descriptor.capabilityId || value.label !== descriptor.label || value.projectId !== projectId) {
    throw new RuntimeCapabilityContractError("Runtime capability matrix row identity is invalid.", "matrix-row-invalid");
  }
  if (!runtimeCapabilityHealthStates.includes(value.health) || value.available !== (value.health === "available")) {
    throw new RuntimeCapabilityContractError("Runtime capability matrix row health is invalid.", "matrix-row-invalid");
  }
  const scopes = normalizedTokens(value.scopes, "Runtime capability matrix scopes");
  if (scopes.some((scope) => !descriptor.supportedScopes.includes(scope))) throw new RuntimeCapabilityContractError("Runtime capability matrix scope is invalid.", "matrix-row-invalid");
  const denialReasons = normalizedTokens(value.denialReasons, "Runtime capability matrix denial reasons", { allowEmpty: value.available });
  if (value.available && (denialReasons.length || !value.receiptId || !value.source || !value.observedAt || !value.expiresAt || scopes.length === 0)) {
    throw new RuntimeCapabilityContractError("Available runtime capability matrix row lacks a valid receipt.", "matrix-row-invalid");
  }
  if (!value.available && denialReasons.length === 0) throw new RuntimeCapabilityContractError("Denied runtime capability matrix row lacks a reason.", "matrix-row-invalid");
  if (value.source != null && !descriptor.receiptSources.includes(value.source)) throw new RuntimeCapabilityContractError("Runtime capability matrix source is invalid.", "matrix-row-invalid");
  if (value.receiptId != null) safeReceiptId(value.receiptId);
  const observedAt = value.observedAt == null ? null : timestamp(value.observedAt, "Runtime capability matrix observation", "matrix-row-invalid");
  const expiresAt = value.expiresAt == null ? null : timestamp(value.expiresAt, "Runtime capability matrix expiry", "matrix-row-invalid");
  const hasReceipt = value.receiptId != null;
  const receiptFieldsComplete = value.source != null && observedAt != null && expiresAt != null;
  if (hasReceipt !== receiptFieldsComplete) throw new RuntimeCapabilityContractError("Runtime capability matrix receipt metadata is incomplete.", "matrix-row-invalid");
  if (hasReceipt && Date.parse(expiresAt) <= Date.parse(observedAt)) throw new RuntimeCapabilityContractError("Runtime capability matrix receipt expiry is invalid.", "matrix-row-invalid");
  if (value.available && (Date.parse(observedAt) > evaluatedEpoch || Date.parse(expiresAt) <= evaluatedEpoch)) {
    throw new RuntimeCapabilityContractError("Available runtime capability matrix receipt is not current.", "matrix-row-invalid");
  }
  return matrixRow(descriptor, projectId, { health: value.health, denialReasons, receipt: value.receiptId ? { ...value, observedAt, expiresAt, scopes } : null });
}

export function validateRuntimeCapabilityMatrix(value) {
  exactObject(value, MATRIX_KEYS, "Runtime capability matrix");
  if (value.schemaVersion !== RUNTIME_CAPABILITY_MATRIX_SCHEMA_VERSION) throw new UnsupportedRuntimeCapabilityVersionError(value.schemaVersion);
  const projectId = assertProjectId(value.projectId);
  const evaluatedAt = timestamp(value.evaluatedAt, "Runtime capability matrix evaluation", "matrix-time-invalid");
  if (!Array.isArray(value.capabilities) || value.capabilities.length !== runtimeCapabilityCatalog.length) {
    throw new RuntimeCapabilityContractError("Runtime capability matrix is incomplete.", "matrix-incomplete");
  }
  const capabilities = runtimeCapabilityCatalog.map((descriptor, index) => validateMatrixRow(value.capabilities[index], descriptor, projectId, Date.parse(evaluatedAt)));
  exactObject(value.counts, COUNT_KEYS, "Runtime capability matrix counts");
  const counts = Object.fromEntries(runtimeCapabilityHealthStates.map((health) => {
    const count = capabilities.filter((capability) => capability.health === health).length;
    if (value.counts[health] !== count) throw new RuntimeCapabilityContractError("Runtime capability matrix counts are inconsistent.", "matrix-count-invalid");
    return [health, count];
  }));
  if (!Array.isArray(value.rejectedReceipts)) throw new RuntimeCapabilityContractError("Runtime capability rejections must be an array.", "matrix-rejections-invalid");
  const rejectedReceipts = value.rejectedReceipts.map((rejection) => {
    exactObject(rejection, REJECTION_KEYS, "Runtime capability rejection");
    if (rejection.capabilityId != null && !runtimeCapabilityIds.includes(rejection.capabilityId)) throw new RuntimeCapabilityContractError("Rejected capability identity is invalid.", "matrix-rejections-invalid");
    if (rejection.receiptId != null) safeReceiptId(rejection.receiptId);
    if (typeof rejection.denialReason !== "string" || !SAFE_TOKEN.test(rejection.denialReason)) throw new RuntimeCapabilityContractError("Rejected capability reason is invalid.", "matrix-rejections-invalid");
    return Object.freeze({ ...rejection });
  });
  return deepFreeze({ capabilities, counts, evaluatedAt, projectId, rejectedReceipts, schemaVersion: RUNTIME_CAPABILITY_MATRIX_SCHEMA_VERSION });
}

export function selectRuntimeCapability(matrix, capabilityId) {
  const checked = validateRuntimeCapabilityMatrix(matrix);
  descriptorFor(capabilityId);
  return checked.capabilities.find((capability) => capability.capabilityId === capabilityId);
}

export function selectRuntimeCapabilities(matrix, filters = {}) {
  allowedObject(filters, ["available", "health", "scope"], "Runtime capability filters");
  const checked = validateRuntimeCapabilityMatrix(matrix);
  if (filters.health != null && !runtimeCapabilityHealthStates.includes(filters.health)) throw new RuntimeCapabilityContractError("Runtime capability health filter is invalid.", "selector-filter-invalid");
  if (filters.scope != null && !runtimeCapabilityScopes.includes(filters.scope)) throw new RuntimeCapabilityContractError("Runtime capability scope filter is invalid.", "selector-filter-invalid");
  if (filters.available != null && typeof filters.available !== "boolean") throw new RuntimeCapabilityContractError("Runtime capability availability filter is invalid.", "selector-filter-invalid");
  return Object.freeze(checked.capabilities.filter((capability) =>
    (filters.health == null || capability.health === filters.health)
    && (filters.scope == null || capability.scopes.includes(filters.scope))
    && (filters.available == null || capability.available === filters.available)));
}

const actionDefinitions = [
  { actionId: "browser.inspect", capabilityId: "browser", requiredScopes: ["read"] },
  { actionId: "browser.read-content", capabilityId: "browser", requiredScopes: ["read", "content"] },
  { actionId: "native.inspect", capabilityId: "native-tauri", requiredScopes: ["read"] },
  { actionId: "native.read-content", capabilityId: "native-tauri", requiredScopes: ["read", "content"] },
  { actionId: "native.mutate", capabilityId: "native-tauri", requiredScopes: ["mutate"] },
  { actionId: "native.execute", capabilityId: "native-tauri", requiredScopes: ["execute"] },
  { actionId: "hosted.inspect", capabilityId: "hosted-static", requiredScopes: ["read"] },
  { actionId: "hosted.read-content", capabilityId: "hosted-static", requiredScopes: ["read", "content"] },
  { actionId: "mcp.inspect", capabilityId: "mcp", requiredScopes: ["read"] },
  { actionId: "mcp.invoke-read", capabilityId: "mcp", requiredScopes: ["read", "execute"] },
  { actionId: "mcp.invoke-mutation", capabilityId: "mcp", requiredScopes: ["mutate", "execute"] },
  { actionId: "git.inspect", capabilityId: "git", requiredScopes: ["read"] },
  { actionId: "git.read-content", capabilityId: "git", requiredScopes: ["read", "content"] },
  { actionId: "git.mutate", capabilityId: "git", requiredScopes: ["mutate"] },
  { actionId: "provider.inspect", capabilityId: "provider", requiredScopes: ["read"] },
  { actionId: "provider.request", capabilityId: "provider", requiredScopes: ["execute"] },
  { actionId: "ci.inspect", capabilityId: "ci", requiredScopes: ["read"] },
  { actionId: "ci.read-artifacts", capabilityId: "ci", requiredScopes: ["read", "content"] },
  { actionId: "ci.run", capabilityId: "ci", requiredScopes: ["execute"] },
  { actionId: "computer-use.inspect", capabilityId: "computer-use", requiredScopes: ["read"] },
  { actionId: "computer-use.read-content", capabilityId: "computer-use", requiredScopes: ["read", "content"] },
  { actionId: "computer-use.mutate", capabilityId: "computer-use", requiredScopes: ["mutate"] },
  { actionId: "computer-use.execute", capabilityId: "computer-use", requiredScopes: ["execute"] },
];

export const runtimeActionCatalog = deepFreeze(actionDefinitions.map((definition) => ({ schemaVersion: 1, ...definition })));
const actionById = new Map(runtimeActionCatalog.map((action) => [action.actionId, action]));

// This is a runtime-evidence preflight only. Mutation and execution still require
// their owning authorization policy, explicit gesture, and operation-bound proof.
export function selectRuntimeActionEligibility(matrix, actionId, options = {}) {
  allowedObject(options, ["projectId"], "Runtime action eligibility options");
  const checked = validateRuntimeCapabilityMatrix(matrix);
  const action = actionById.get(actionId) ?? null;
  const requestedProjectId = typeof options.projectId === "string" ? options.projectId : null;
  const denialReasons = [];
  if (!action) denialReasons.push("action-unknown");
  if (!requestedProjectId) denialReasons.push("project-binding-required");
  else {
    try {
      assertProjectId(requestedProjectId);
      if (requestedProjectId !== checked.projectId) denialReasons.push("project-binding-mismatch");
    } catch {
      denialReasons.push("project-binding-invalid");
    }
  }
  const capability = action ? checked.capabilities.find((item) => item.capabilityId === action.capabilityId) : null;
  if (capability && !capability.available) denialReasons.push(`capability-${capability.health}`, ...capability.denialReasons);
  const missingScopes = action && capability ? action.requiredScopes.filter((scope) => !capability.scopes.includes(scope)) : [];
  missingScopes.forEach((scope) => denialReasons.push(`scope-missing:${scope}`));
  const reasons = uniqueReasons(denialReasons);
  return deepFreeze({
    actionId: action?.actionId ?? String(actionId ?? ""),
    capabilityId: action?.capabilityId ?? null,
    denialReasons: reasons,
    eligible: reasons.length === 0,
    grantedScopes: Object.freeze(capability ? [...capability.scopes] : []),
    health: capability?.health ?? "unavailable",
    projectId: requestedProjectId,
    receiptId: capability?.receiptId ?? null,
    requiredScopes: Object.freeze(action ? [...action.requiredScopes] : []),
    schemaVersion: RUNTIME_ACTION_ELIGIBILITY_SCHEMA_VERSION,
  });
}
