const WORKSPACE_SCHEMA_VERSION = 1;
const REGISTRATION_KEYS = Object.freeze([
  "access",
  "canonicalRoot",
  "capabilities",
  "idempotent",
  "registryRevision",
  "rootIdentity",
  "schemaVersion",
  "workspaceId",
]);
const CENSUS_KEYS = Object.freeze([
  "capabilities",
  "contentReturned",
  "digest",
  "fileCount",
  "files",
  "generatedEpochMs",
  "registryRevision",
  "rootIdentity",
  "schemaVersion",
  "skipped",
  "summary",
  "totalBytesHashed",
  "workspaceId",
]);
const FILE_KEYS = Object.freeze(["category", "extension", "modifiedEpochMs", "path", "sha256", "size"]);
const SKIP_KEYS = Object.freeze(["path", "reason", "size"]);
const PICKER_KEYS = Object.freeze(["capabilities", "commandRevision", "schemaVersion", "selectedPath", "selectionState"]);
const HEX_64 = /^[a-f0-9]{64}$/;

function unavailable(reason) {
  return Object.freeze({ available: false, authoritative: false, reason, schemaVersion: WORKSPACE_SCHEMA_VERSION });
}

function nativeFailure(error, fallback) {
  if (error && typeof error === "object") {
    const code = typeof error.code === "string" && error.code.trim() ? error.code.trim() : "";
    const message = typeof error.message === "string" && error.message.trim() ? error.message.trim() : "";
    if (code && message) return unavailable(`${code}: ${message}`);
    if (code) return unavailable(code);
    if (message) return unavailable(message);
  }
  if (error instanceof Error && error.message) return unavailable(error.message);
  if (typeof error === "string" && error.trim()) return unavailable(error.trim());
  return unavailable(fallback);
}

function assertExactObject(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const keys = Object.keys(value).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`${label} has an unknown or missing field.`);
  }
}

function assertIdentity(value, label) {
  if (typeof value !== "string" || !HEX_64.test(value)) throw new Error(`${label} must be a SHA-256 identity.`);
}

function assertCapabilities(value) {
  if (!Array.isArray(value) || value.length !== 1 || value[0] !== "workspace-census:read") {
    throw new Error("Workspace census capability set is invalid.");
  }
}

export function isNativeWorkspaceRuntime(runtime = globalThis) {
  return Boolean(runtime && typeof runtime === "object" && "__TAURI_INTERNALS__" in runtime);
}

export function validateWorkspacePickerReceipt(value) {
  assertExactObject(value, PICKER_KEYS, "Workspace picker receipt");
  if (value.schemaVersion !== 1 || value.commandRevision !== 1) throw new Error("Workspace picker version is invalid.");
  if (!Array.isArray(value.capabilities) || value.capabilities.length !== 1 || value.capabilities[0] !== "workspace-folder-picker:select") throw new Error("Workspace picker capability set is invalid.");
  if (!["selected", "cancelled"].includes(value.selectionState)) throw new Error("Workspace picker state is invalid.");
  if (value.selectionState === "selected" && (typeof value.selectedPath !== "string" || !/^(?:[a-zA-Z]:[\\/]|\/)/.test(value.selectedPath))) throw new Error("Workspace picker selected path is invalid.");
  if (value.selectionState === "cancelled" && value.selectedPath !== null) throw new Error("Cancelled workspace picker returned a path.");
  return Object.freeze({ ...value, capabilities: Object.freeze([...value.capabilities]), available: true, authoritative: true });
}

export async function selectWorkspaceFolder({ runtime = globalThis, invoke } = {}) {
  if (!isNativeWorkspaceRuntime(runtime)) return unavailable("native-runtime-unavailable");
  try {
    const nativeInvoke = invoke ?? (await import("@tauri-apps/api/core")).invoke;
    return validateWorkspacePickerReceipt(await nativeInvoke("select_workspace_folder", { request: { schemaVersion: 1 } }));
  } catch (error) {
    return nativeFailure(error, "workspace-picker-failed");
  }
}

export function validateWorkspaceRegistration(value) {
  assertExactObject(value, REGISTRATION_KEYS, "Workspace registration receipt");
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.registryRevision) || value.registryRevision < 1) throw new Error("Workspace registration version is invalid.");
  if (typeof value.workspaceId !== "string" || !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(value.workspaceId)) throw new Error("Workspace registration identity is invalid.");
  if (typeof value.canonicalRoot !== "string" || value.canonicalRoot.length < 3) throw new Error("Workspace registration root is invalid.");
  assertIdentity(value.rootIdentity, "Workspace root identity");
  if (value.access !== "metadata-read-only" || typeof value.idempotent !== "boolean") throw new Error("Workspace registration access boundary is invalid.");
  assertCapabilities(value.capabilities);
  return Object.freeze({ ...value, capabilities: Object.freeze([...value.capabilities]), available: true, authoritative: true });
}

export function validateWorkspaceCensus(value) {
  assertExactObject(value, CENSUS_KEYS, "Workspace census receipt");
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.registryRevision) || value.registryRevision < 1) throw new Error("Workspace census version is invalid.");
  if (typeof value.workspaceId !== "string" || !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(value.workspaceId)) throw new Error("Workspace census identity is invalid.");
  assertIdentity(value.rootIdentity, "Workspace root identity");
  assertIdentity(value.digest, "Workspace census digest");
  if (value.contentReturned !== false) throw new Error("Workspace census must never return file contents.");
  assertCapabilities(value.capabilities);
  if (!Number.isSafeInteger(value.fileCount) || value.fileCount < 0 || !Number.isSafeInteger(value.totalBytesHashed) || value.totalBytesHashed < 0) throw new Error("Workspace census bounds are invalid.");
  if ((typeof value.generatedEpochMs !== "number" && typeof value.generatedEpochMs !== "string") || !Array.isArray(value.files) || !Array.isArray(value.skipped)) throw new Error("Workspace census collections are invalid.");
  if (value.fileCount !== value.files.length) throw new Error("Workspace census file count does not reconcile.");
  assertExactObject(value.summary, Object.keys(value.summary).sort(), "Workspace census summary");
  if (Object.values(value.summary).some((count) => !Number.isSafeInteger(count) || count < 0)) throw new Error("Workspace census summary counts are invalid.");
  for (const file of value.files) {
    assertExactObject(file, FILE_KEYS, "Workspace census file record");
    if (typeof file.path !== "string" || file.path.startsWith("/") || file.path.includes("..") || typeof file.extension !== "string" || typeof file.category !== "string") throw new Error("Workspace census file path is invalid.");
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error("Workspace census file size is invalid.");
    assertIdentity(file.sha256, "Workspace file identity");
    if (file.modifiedEpochMs !== null && typeof file.modifiedEpochMs !== "number" && typeof file.modifiedEpochMs !== "string") throw new Error("Workspace census modified time is invalid.");
  }
  for (const skipped of value.skipped) {
    assertExactObject(skipped, SKIP_KEYS, "Workspace census skip record");
    if (typeof skipped.path !== "string" || typeof skipped.reason !== "string" || (skipped.size !== null && (!Number.isSafeInteger(skipped.size) || skipped.size < 0))) throw new Error("Workspace census skip record is invalid.");
  }
  return Object.freeze({
    ...value,
    capabilities: Object.freeze([...value.capabilities]),
    files: Object.freeze(value.files.map((file) => Object.freeze({ ...file }))),
    skipped: Object.freeze(value.skipped.map((item) => Object.freeze({ ...item }))),
    summary: Object.freeze({ ...value.summary }),
    available: true,
    authoritative: true,
  });
}

export async function registerWorkspaceReadOnly({ workspaceId, rootPath, explicitUserApproval, runtime = globalThis, invoke } = {}) {
  if (!isNativeWorkspaceRuntime(runtime)) return unavailable("native-runtime-unavailable");
  try {
    const nativeInvoke = invoke ?? (await import("@tauri-apps/api/core")).invoke;
    return validateWorkspaceRegistration(await nativeInvoke("register_workspace_read_only", {
      request: { schemaVersion: 1, workspaceId, rootPath, explicitUserApproval: explicitUserApproval === true },
    }));
  } catch (error) {
    return nativeFailure(error, "workspace-registration-failed");
  }
}

export async function previewRegisteredWorkspace({ workspaceId, registryRevision, runtime = globalThis, invoke } = {}) {
  if (!isNativeWorkspaceRuntime(runtime)) return unavailable("native-runtime-unavailable");
  try {
    const nativeInvoke = invoke ?? (await import("@tauri-apps/api/core")).invoke;
    const value = await nativeInvoke("preview_registered_workspace", {request:{schemaVersion:1,workspaceId,registryRevision,maxFiles:50_000,maxFileBytes:2_000_000}});
    if (value?.kind !== "folder-preview" || value.schemaVersion !== 1 || value.authoritative !== false || value.contentVerified !== false || value.workspaceId !== workspaceId || value.registryRevision !== registryRevision || !Array.isArray(value.files) || value.files.length !== value.fileCount || value.fileCount > 50_000 || !Array.isArray(value.skipped)) throw new Error("Invalid folder preview");
    return {...value,available:true};
  } catch(error) { return nativeFailure(error,"workspace-preview-failed"); }
}

export async function censusRegisteredWorkspace({ workspaceId, registryRevision, maxFiles = 50_000, maxFileBytes = 2_000_000, runtime = globalThis, invoke } = {}) {
  if (!isNativeWorkspaceRuntime(runtime)) return unavailable("native-runtime-unavailable");
  try {
    const nativeInvoke = invoke ?? (await import("@tauri-apps/api/core")).invoke;
    return validateWorkspaceCensus(await nativeInvoke("census_registered_workspace", {
      request: { schemaVersion: 1, workspaceId, registryRevision, maxFiles, maxFileBytes },
    }));
  } catch (error) {
    return nativeFailure(error, "workspace-census-failed");
  }
}

export const workspaceCensusSchemaVersion = WORKSPACE_SCHEMA_VERSION;
