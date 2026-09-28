const RUNTIME_SCHEMA_VERSION = 1;

const EXPECTED_KEYS = Object.freeze([
  "appVersion",
  "authority",
  "capabilities",
  "commandRevision",
  "platform",
  "productName",
  "runtimeMode",
  "schemaVersion",
  "staticReleaseAuthoritative",
]);

function unavailable(reason) {
  return Object.freeze({
    available: false,
    authoritative: false,
    reason,
    schemaVersion: RUNTIME_SCHEMA_VERSION,
  });
}

export function isTauriRuntime(runtime = globalThis) {
  return Boolean(runtime && typeof runtime === "object" && "__TAURI_INTERNALS__" in runtime);
}

export function validateRuntimeSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Native runtime snapshot must be an object.");
  }

  const keys = Object.keys(value).sort();
  if (keys.length !== EXPECTED_KEYS.length || keys.some((key, index) => key !== EXPECTED_KEYS[index])) {
    throw new Error("Native runtime snapshot has an unknown or missing field.");
  }
  if (value.schemaVersion !== RUNTIME_SCHEMA_VERSION || value.commandRevision !== 1) {
    throw new Error("Native runtime snapshot schema or command revision is unsupported.");
  }
  if (value.productName !== "Perfect Planner" || value.runtimeMode !== "native-desktop") {
    throw new Error("Native runtime snapshot product identity is invalid.");
  }
  if (value.authority !== "tauri-read-only" || value.staticReleaseAuthoritative !== false) {
    throw new Error("Native runtime snapshot authority boundary is invalid.");
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.length !== 1 || value.capabilities[0] !== "runtime-snapshot:read") {
    throw new Error("Native runtime snapshot capability set is invalid.");
  }
  if (typeof value.appVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(value.appVersion)) {
    throw new Error("Native runtime snapshot app version is invalid.");
  }
  if (typeof value.platform !== "string" || value.platform.length === 0) {
    throw new Error("Native runtime snapshot platform is invalid.");
  }

  return Object.freeze({ ...value, capabilities: Object.freeze([...value.capabilities]), available: true, authoritative: true });
}

export async function readRuntimeSnapshot({ runtime = globalThis, invoke } = {}) {
  if (!isTauriRuntime(runtime)) return unavailable("native-runtime-unavailable");

  try {
    const nativeInvoke = invoke ?? (await import("@tauri-apps/api/core")).invoke;
    const value = await nativeInvoke("runtime_snapshot", {
      request: { schemaVersion: RUNTIME_SCHEMA_VERSION },
    });
    return validateRuntimeSnapshot(value);
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : "native-runtime-request-failed");
  }
}

export const runtimeSnapshotSchemaVersion = RUNTIME_SCHEMA_VERSION;
