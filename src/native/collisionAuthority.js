import { isNativeWorkspaceRuntime } from "./workspaceCensus.js";

const SCHEMA_VERSION = 1;
const CAPABILITIES = Object.freeze([
  "collision-authority:inspect",
  "collision-authority:approve",
  "collision-authority:commit",
]);
const RECEIPT_KEYS = Object.freeze([
  "approvedIds",
  "authority",
  "authorityTransport",
  "authoritative",
  "capabilities",
  "censusDigest",
  "commandRevision",
  "headHash",
  "ledger",
  "planId",
  "revision",
  "schemaVersion",
].sort());
const HEX_64 = /^[a-f0-9]{64}$/;

function assertExactObject(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`${label} has an unknown or missing field.`);
  }
}

function assertIdentity(value, label) {
  if (typeof value !== "string" || !HEX_64.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 identity.`);
  }
}

export function validateNativeCollisionAuthorityReceipt(value) {
  assertExactObject(value, RECEIPT_KEYS, "Native collision authority receipt");
  if (value.schemaVersion !== SCHEMA_VERSION || value.commandRevision !== 1) {
    throw new Error("Native collision authority version is unsupported.");
  }
  if (value.authority !== "native-journal" || value.authorityTransport !== "tauri-ipc-v1" || value.authoritative !== true) {
    throw new Error("Native collision authority boundary is invalid.");
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.length !== CAPABILITIES.length || value.capabilities.some((item, index) => item !== CAPABILITIES[index])) {
    throw new Error("Native collision authority capability set is invalid.");
  }
  if (typeof value.planId !== "string" || !value.planId || value.planId.length > 128) {
    throw new Error("Native collision plan identity is invalid.");
  }
  assertIdentity(value.censusDigest, "Native collision census digest");
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.ledger) || value.revision !== value.ledger.length) {
    throw new Error("Native collision authority revision does not reconcile.");
  }
  if (value.headHash !== "GENESIS") assertIdentity(value.headHash, "Native collision authority head");
  if (!Array.isArray(value.approvedIds) || value.approvedIds.some((id) => !/^COL-\d{3,12}$/.test(id))) {
    throw new Error("Native collision approval summary is invalid.");
  }
  return Object.freeze({
    ...value,
    capabilities: CAPABILITIES,
    approvedIds: Object.freeze([...value.approvedIds]),
    ledger: Object.freeze(value.ledger.map((entry) => Object.freeze({ ...entry }))),
  });
}

function exactParty(value) {
  return {
    planId: value?.planId,
    taskId: value?.taskId,
    access: value?.access,
  };
}

function exactCollision(value) {
  return {
    id: value?.id,
    surface: value?.surface,
    severity: value?.severity,
    first: exactParty(value?.first),
    then: exactParty(value?.then),
    contingency: value?.contingency,
  };
}

function exactAssessment(value) {
  return {
    manifestIds: value?.manifestIds,
    claims: value?.claims,
    collisionIds: value?.collisionIds,
    surfaces: value?.surfaces,
  };
}

export function createNativeCollisionAuthorityAdapter({ runtime = globalThis, invoke } = {}) {
  if (!isNativeWorkspaceRuntime(runtime)) return null;
  let nativeInvoke = invoke;
  const loadInvoke = async () => {
    nativeInvoke ??= (await import("@tauri-apps/api/core")).invoke;
    return nativeInvoke;
  };
  return Object.freeze({
    transport: "tauri-ipc-v1",
    inspect: async ({ planId, censusDigest }) => {
      await loadInvoke();
      return validateNativeCollisionAuthorityReceipt(await nativeInvoke("collision_authority_inspect", { request: {
        schemaVersion: SCHEMA_VERSION,
        planId,
        censusDigest,
      } }));
    },
    approve: async ({ planId, censusDigest, expectedRevision, expectedHeadHash, collision }) => {
      await loadInvoke();
      return validateNativeCollisionAuthorityReceipt(await nativeInvoke("collision_authority_approve", { request: {
        schemaVersion: SCHEMA_VERSION,
        planId,
        censusDigest,
        expectedRevision,
        expectedHeadHash,
        explicitUserApproval: true,
        collision: exactCollision(collision),
      } }));
    },
    commit: async ({ planId, censusDigest, expectedRevision, expectedHeadHash, assessment }) => {
      await loadInvoke();
      return validateNativeCollisionAuthorityReceipt(await nativeInvoke("collision_authority_commit", { request: {
        schemaVersion: SCHEMA_VERSION,
        planId,
        censusDigest,
        expectedRevision,
        expectedHeadHash,
        explicitUserApproval: true,
        assessment: exactAssessment(assessment),
      } }));
    },
  });
}

export const nativeCollisionAuthoritySchemaVersion = SCHEMA_VERSION;
