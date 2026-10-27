import { projectLabelFromRoot } from "./projectLabel.js";
import {
  assertProjectEntityId,
  assertProjectId,
  createImportedProjectId,
  createProjectEntityId,
  createStableProjectId,
  isProjectId,
} from "./projectIds.js";
import {
  assertProjectTruthState,
  createProvenanceRecord,
  projectMetricKeys,
  projectTruthStates,
  validateProvenanceRecord,
} from "./projectProvenance.js";

export const PROJECT_SESSION_SCHEMA_VERSION = 1;
export const projectSessionKinds = Object.freeze(["empty", "demo", "imported", "generated"]);
export const projectAuthorityKinds = Object.freeze(["architecture", "folder", "component", "plan"]);
export const projectWorkspaceNames = Object.freeze(["home", "blueprint", "structure", "components", "plan", "collision", "allocation", "build", "integrity", "evidence", "ledger", "index", "planning", "mvp", "decisions", "people", "share", "tasks", "lookup"]);

const SHA256 = /^[a-f0-9]{64}$/;
const WORKSPACE_ID = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const SAFE_LABEL = /^[^\\/\u0000-\u001f]{1,120}$/;
const SAFE_TOKEN = /^[a-zA-Z0-9._:-]{1,96}$/;
const ADAPTERS = Object.freeze(["browser", "native", "hosted", "unknown"]);
const ACCESS_STATES = Object.freeze(["metadata-read-only", "unavailable"]);
const PERSISTENCE_STATES = Object.freeze(["durable", "session-only", "reselect-required", "unavailable"]);
const GRAPH_MODES = Object.freeze([null, "files", "architecture", "dependencies", "tasks", "changes"]);

export class ProjectSchemaError extends Error {
  constructor(message, code = "project-schema-invalid") {
    super(message);
    this.name = "ProjectSchemaError";
    this.code = code;
  }
}

export class UnsupportedProjectSchemaVersionError extends ProjectSchemaError {
  constructor(version) {
    super(`Unsupported ProjectSession schema version: ${String(version)}.`, "project-schema-version-unsupported");
  }
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProjectSchemaError(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ProjectSchemaError(`${label} has an unknown or missing field.`);
  }
}

function isoTimestamp(value, label) {
  const text = typeof value === "number" ? new Date(value).toISOString() : String(value ?? "");
  if (!text || Number.isNaN(Date.parse(text))) throw new ProjectSchemaError(`${label} must be an ISO timestamp.`);
  return new Date(text).toISOString();
}

function monotonicTimestamp(value, previousValue) {
  const requested = Date.parse(isoTimestamp(value, "Project update"));
  const previous = Date.parse(isoTimestamp(previousValue, "Previous project update"));
  return new Date(Math.max(requested, previous + 1)).toISOString();
}

function safeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new ProjectSchemaError(`${label} must be an integer of at least ${minimum}.`);
  return value;
}

function safeLabel(value, label) {
  const text = String(value ?? "").trim();
  if (!SAFE_LABEL.test(text)) throw new ProjectSchemaError(`${label} is invalid.`);
  return text;
}

function rootLabelFromPath(value) {
  return safeLabel(projectLabelFromRoot(value), "Root label");
}

function validateRegistration(value) {
  if (value == null) return null;
  exactObject(value, ["access", "adapter", "persistence", "registryRevision", "rootIdentity", "rootLabel", "workspaceId"], "Project registration");
  if (!ADAPTERS.includes(value.adapter)) throw new ProjectSchemaError("Project registration adapter is invalid.");
  if (!ACCESS_STATES.includes(value.access)) throw new ProjectSchemaError("Project registration access state is invalid.");
  if (!PERSISTENCE_STATES.includes(value.persistence)) throw new ProjectSchemaError("Project registration persistence state is invalid.");
  if (typeof value.workspaceId !== "string" || !WORKSPACE_ID.test(value.workspaceId)) throw new ProjectSchemaError("Project workspace ID is invalid.");
  if (typeof value.rootIdentity !== "string" || !SHA256.test(value.rootIdentity)) throw new ProjectSchemaError("Project root identity is invalid.");
  return Object.freeze({
    access: value.access,
    adapter: value.adapter,
    persistence: value.persistence,
    registryRevision: safeInteger(value.registryRevision, "Project registration revision", 1),
    rootIdentity: value.rootIdentity,
    rootLabel: safeLabel(value.rootLabel, "Project root label"),
    workspaceId: value.workspaceId,
  });
}

function validateCensus(value, registration) {
  if (value == null) return null;
  exactObject(value, ["digest", "fileCount", "generatedAt", "registryRevision", "rootIdentity", "skippedCount", "totalBytesHashed", "workspaceId"], "Project census");
  if (typeof value.digest !== "string" || !SHA256.test(value.digest)) throw new ProjectSchemaError("Project census digest is invalid.");
  if (typeof value.rootIdentity !== "string" || !SHA256.test(value.rootIdentity)) throw new ProjectSchemaError("Project census root identity is invalid.");
  if (typeof value.workspaceId !== "string" || !WORKSPACE_ID.test(value.workspaceId)) throw new ProjectSchemaError("Project census workspace ID is invalid.");
  if (registration && (registration.rootIdentity !== value.rootIdentity || registration.workspaceId !== value.workspaceId || registration.registryRevision !== value.registryRevision)) {
    throw new ProjectSchemaError("Project census does not match the registered workspace.");
  }
  if (value.totalBytesHashed != null) safeInteger(value.totalBytesHashed, "Project census total bytes");
  return Object.freeze({
    digest: value.digest,
    fileCount: safeInteger(value.fileCount, "Project census file count"),
    generatedAt: isoTimestamp(value.generatedAt, "Project census generation"),
    registryRevision: safeInteger(value.registryRevision, "Project census registry revision", 1),
    rootIdentity: value.rootIdentity,
    skippedCount: safeInteger(value.skippedCount, "Project census skipped count"),
    totalBytesHashed: value.totalBytesHashed,
    workspaceId: value.workspaceId,
  });
}

function validateDiscovery(value, census) {
  if (value == null) return null;
  exactObject(value, ["categories", "censusDigest", "counts", "generatedAt", "schemaVersion", "state"], "Project discovery");
  if (value.schemaVersion !== 1) throw new ProjectSchemaError("Project discovery version is invalid.");
  if (!["generated", "unavailable", "stale"].includes(value.state)) throw new ProjectSchemaError("Project discovery state is invalid.");
  if (typeof value.censusDigest !== "string" || !SHA256.test(value.censusDigest)) throw new ProjectSchemaError("Project discovery census digest is invalid.");
  if (census && value.censusDigest !== census.digest) throw new ProjectSchemaError("Project discovery is bound to another census.");
  exactObject(value.counts, ["observed", "signals", "unanswered"], "Project discovery counts");
  const counts = Object.freeze({
    observed: safeInteger(value.counts.observed, "Observed finding count"),
    signals: safeInteger(value.counts.signals, "Signal finding count"),
    unanswered: safeInteger(value.counts.unanswered, "Unanswered category count"),
  });
  if (!Array.isArray(value.categories)) throw new ProjectSchemaError("Project discovery categories must be an array.");
  const categories = value.categories.map((category) => {
    exactObject(category, ["findingCount", "findingIds", "id", "state"], "Project discovery category");
    if (typeof category.id !== "string" || !/^[A-Z][A-Z0-9-]{1,31}$/.test(category.id)) throw new ProjectSchemaError("Project discovery category ID is invalid.");
    if (!["observed", "signal", "unanswered"].includes(category.state)) throw new ProjectSchemaError("Project discovery category state is invalid.");
    if (!Array.isArray(category.findingIds) || category.findingIds.some((id) => typeof id !== "string" || !SAFE_TOKEN.test(id))) throw new ProjectSchemaError("Project discovery finding IDs are invalid.");
    if (new Set(category.findingIds).size !== category.findingIds.length) throw new ProjectSchemaError("Project discovery finding IDs must be unique.");
    if (safeInteger(category.findingCount, "Project discovery finding count") !== category.findingIds.length) throw new ProjectSchemaError("Project discovery finding count does not match its IDs.");
    return Object.freeze({ findingCount: category.findingCount, findingIds: Object.freeze([...category.findingIds]), id: category.id, state: category.state });
  });
  return Object.freeze({ categories: Object.freeze(categories), censusDigest: value.censusDigest, counts, generatedAt: isoTimestamp(value.generatedAt, "Project discovery generation"), schemaVersion: 1, state: value.state });
}

function validateAuthorityReference(value, projectId, kind) {
  if (value == null) return null;
  exactObject(value, ["digest", "entityId", "recordedAt", "revision", "state"], `${kind} authority reference`);
  assertProjectEntityId(value.entityId, { projectId });
  if (typeof value.digest !== "string" || !SHA256.test(value.digest)) throw new ProjectSchemaError(`${kind} authority digest is invalid.`);
  if (!["generated", "authoritative", "stale", "unavailable"].includes(value.state)) throw new ProjectSchemaError(`${kind} authority state is invalid.`);
  return Object.freeze({
    digest: value.digest,
    entityId: value.entityId,
    recordedAt: isoTimestamp(value.recordedAt, `${kind} authority timestamp`),
    revision: safeInteger(value.revision, `${kind} authority revision`, 1),
    state: value.state,
  });
}

function validateAuthorities(value, projectId) {
  exactObject(value, projectAuthorityKinds, "Project authorities");
  return Object.freeze(Object.fromEntries(projectAuthorityKinds.map((kind) => [kind, validateAuthorityReference(value[kind], projectId, kind)])));
}

function validateView(value, projectId) {
  exactObject(value, ["filterKey", "focusId", "graphMode", "phase", "workspace"], "Project view state");
  if (!projectWorkspaceNames.includes(value.workspace)) throw new ProjectSchemaError("Project workspace route is invalid.");
  if (value.phase != null && (typeof value.phase !== "string" || !SAFE_TOKEN.test(value.phase))) throw new ProjectSchemaError("Project phase is invalid.");
  if (value.focusId != null) assertProjectEntityId(value.focusId, { projectId });
  if (!GRAPH_MODES.includes(value.graphMode)) throw new ProjectSchemaError("Project graph mode is invalid.");
  if (value.filterKey != null && (typeof value.filterKey !== "string" || !SAFE_TOKEN.test(value.filterKey))) throw new ProjectSchemaError("Project filter key is invalid.");
  return Object.freeze({ filterKey: value.filterKey, focusId: value.focusId, graphMode: value.graphMode, phase: value.phase, workspace: value.workspace });
}

function validateProvenance(value, projectId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProjectSchemaError("Project provenance must be an object.");
  const result = {};
  for (const [field, record] of Object.entries(value)) {
    result[field] = validateProvenanceRecord(record, projectId);
    if (result[field].field !== field) throw new ProjectSchemaError("Project provenance key does not match its field.");
  }
  return Object.freeze(result);
}

function defaultView() {
  return Object.freeze({ filterKey: null, focusId: null, graphMode: null, phase: null, workspace: "home" });
}

function emptyAuthorities() {
  return Object.freeze(Object.fromEntries(projectAuthorityKinds.map((kind) => [kind, null])));
}

export function validateProjectSession(input) {
  exactObject(input, ["authorities", "census", "createdAt", "discovery", "generation", "kind", "name", "projectId", "provenance", "registration", "schemaVersion", "state", "updatedAt", "view"], "ProjectSession");
  if (input.schemaVersion !== PROJECT_SESSION_SCHEMA_VERSION) throw new UnsupportedProjectSchemaVersionError(input.schemaVersion);
  const projectId = assertProjectId(input.projectId);
  if (!projectSessionKinds.includes(input.kind)) throw new ProjectSchemaError("ProjectSession kind is invalid.");
  const state = assertProjectTruthState(input.state);
  if (input.kind === "demo" && state !== "demo") throw new ProjectSchemaError("Demo project must have demo truth state.");
  if (input.kind === "empty" && state !== "empty") throw new ProjectSchemaError("Empty project must have empty truth state.");
  const registration = validateRegistration(input.registration);
  const census = validateCensus(input.census, registration);
  const discovery = validateDiscovery(input.discovery, census);
  if (input.kind === "imported" && !registration) throw new ProjectSchemaError("Imported project requires a redacted registration receipt.");
  const authorities = validateAuthorities(input.authorities, projectId);
  const result = {
    authorities,
    census,
    createdAt: isoTimestamp(input.createdAt, "Project creation"),
    discovery,
    generation: safeInteger(input.generation, "Project generation"),
    kind: input.kind,
    name: safeLabel(input.name, "Project name"),
    projectId,
    provenance: validateProvenance(input.provenance, projectId),
    registration,
    schemaVersion: PROJECT_SESSION_SCHEMA_VERSION,
    state,
    updatedAt: isoTimestamp(input.updatedAt, "Project update"),
    view: validateView(input.view, projectId),
  };
  if (Date.parse(result.updatedAt) < Date.parse(result.createdAt)) throw new ProjectSchemaError("Project update cannot predate project creation.");
  return deepFreeze(result);
}

function sanitizeRegistration(receipt, { adapter = "unknown", persistence } = {}) {
  if (!receipt || typeof receipt !== "object") throw new ProjectSchemaError("Workspace registration receipt is required.");
  const resolvedAdapter = ADAPTERS.includes(adapter) ? adapter : "unknown";
  const resolvedPersistence = persistence ?? (resolvedAdapter === "browser" ? "reselect-required" : resolvedAdapter === "native" ? "durable" : "unavailable");
  return validateRegistration({
    access: receipt.access === "metadata-read-only" ? receipt.access : "unavailable",
    adapter: resolvedAdapter,
    persistence: resolvedPersistence,
    registryRevision: receipt.registryRevision,
    rootIdentity: String(receipt.rootIdentity ?? "").toLowerCase(),
    rootLabel: rootLabelFromPath(receipt.canonicalRoot ?? receipt.rootLabel ?? receipt.workspaceId),
    workspaceId: receipt.workspaceId,
  });
}

function sanitizeCensus(receipt, registration, now) {
  if (!receipt || typeof receipt !== "object") return null;
  return validateCensus({
    digest: String(receipt.digest ?? "").toLowerCase(),
    fileCount: receipt.fileCount,
    generatedAt: receipt.generatedAt ?? receipt.generatedEpochMs ?? now,
    registryRevision: receipt.registryRevision,
    rootIdentity: String(receipt.rootIdentity ?? "").toLowerCase(),
    skippedCount: Array.isArray(receipt.skipped) ? receipt.skipped.length : receipt.skippedCount ?? 0,
    totalBytesHashed: receipt.totalBytesHashed ?? null,
    workspaceId: receipt.workspaceId,
  }, registration);
}

function sanitizeDiscovery(value, census, now) {
  if (!value || !census) return null;
  const categories = Array.isArray(value.categories) ? value.categories.map((category) => ({
    findingCount: Array.isArray(category.findings) ? category.findings.length : category.findingCount ?? 0,
    findingIds: Array.isArray(category.findings) ? category.findings.map((finding) => String(finding.id)) : Array.isArray(category.findingIds) ? category.findingIds.map(String) : [],
    id: String(category.id),
    state: ["observed", "signal", "unanswered"].includes(category.state) ? category.state : "unanswered",
  })) : [];
  return validateDiscovery({
    categories,
    censusDigest: census.digest,
    counts: {
      observed: value.counts?.observed ?? 0,
      signals: value.counts?.signals ?? 0,
      unanswered: value.counts?.unanswered ?? 0,
    },
    generatedAt: value.generatedAt ?? now,
    schemaVersion: 1,
    state: value.state === "stale" ? "stale" : value.state === "unavailable" ? "unavailable" : "generated",
  }, census);
}

function provenanceForSession({ projectId, state, registration, census, discovery, generation, observedAt }) {
  const records = {};
  const add = (field, recordState, sourceType, sourceId, sourceRevision, digest, reason) => {
    records[field] = createProvenanceRecord({ projectId, field, state: recordState, sourceType, sourceId, sourceRevision, digest, observedAt, reason });
  };
  const projectSource = registration?.workspaceId ?? projectId;
  add("project.name", state, state === "demo" ? "demo" : registration ? "workspace-registration" : state === "empty" ? "none" : "generated", projectSource, generation, null, "session-name");
  add("project.state", state, state === "demo" ? "demo" : "generated", projectSource, generation, census?.digest ?? null, "session-state");
  add("project.generation", state, "generated", projectSource, generation, census?.digest ?? null, "session-generation");
  for (const field of ["workspace.rootLabel", "workspace.adapter", "workspace.registryRevision"]) {
    add(field, registration ? "imported" : state === "demo" ? "demo" : "unavailable", registration ? "workspace-registration" : state === "demo" ? "demo" : "unavailable", projectSource, registration?.registryRevision ?? generation, null, registration ? "registration-receipt" : state === "demo" ? "demo-fixture" : "registration-missing");
  }
  for (const field of ["census.fileCount", "census.skippedCount", "census.digest"]) {
    add(field, census ? "imported" : state === "demo" ? "demo" : "unavailable", census ? "workspace-census" : state === "demo" ? "demo" : "unavailable", census?.workspaceId ?? projectSource, census?.registryRevision ?? generation, census?.digest ?? null, census ? "census-receipt" : state === "demo" ? "demo-fixture" : "census-missing");
  }
  for (const field of ["discovery.observed", "discovery.signals", "discovery.unanswered"]) {
    add(field, discovery?.state ?? (state === "demo" ? "demo" : "unavailable"), discovery ? "workspace-discovery" : state === "demo" ? "demo" : "unavailable", census?.workspaceId ?? projectSource, generation, discovery?.censusDigest ?? null, discovery ? "discovery-snapshot" : state === "demo" ? "demo-fixture" : "discovery-missing");
  }
  for (const kind of projectAuthorityKinds) {
    add(`authority.${kind}`, "unavailable", "unavailable", `${projectSource}:${kind}`, generation, null, "authority-not-connected");
  }
  return Object.freeze(records);
}

export function createProjectSession({
  projectId,
  name,
  kind,
  state,
  registration = null,
  census = null,
  discovery = null,
  authorities = emptyAuthorities(),
  view = defaultView(),
  provenance,
  generation = 1,
  createdAt,
  updatedAt,
  now = Date.now(),
}) {
  const timestamp = isoTimestamp(updatedAt ?? createdAt ?? now, "Project timestamp");
  const id = isProjectId(projectId) ? projectId : createStableProjectId(name, `${kind}:${name}`);
  const validatedRegistration = validateRegistration(registration);
  const validatedCensus = validateCensus(census, validatedRegistration);
  const validatedDiscovery = validateDiscovery(discovery, validatedCensus);
  const records = provenance ?? provenanceForSession({ projectId: id, state, registration: validatedRegistration, census: validatedCensus, discovery: validatedDiscovery, generation, observedAt: timestamp });
  return validateProjectSession({
    authorities,
    census: validatedCensus,
    createdAt: createdAt ?? timestamp,
    discovery: validatedDiscovery,
    generation,
    kind,
    name,
    projectId: id,
    provenance: records,
    registration: validatedRegistration,
    schemaVersion: PROJECT_SESSION_SCHEMA_VERSION,
    state,
    updatedAt: timestamp,
    view,
  });
}

export function createImportedProjectSession({ name, adapter = "unknown", persistence, registration: receipt, census: censusReceipt = null, discovery: discoveryInput = null, now = Date.now() }) {
  const registration = sanitizeRegistration(receipt, { adapter, persistence });
  const census = sanitizeCensus(censusReceipt, registration, now);
  const discovery = sanitizeDiscovery(discoveryInput, census, now);
  const state = discovery ? discovery.state : "imported";
  return createProjectSession({
    projectId: createImportedProjectId(registration.rootIdentity),
    name: name || registration.rootLabel,
    kind: "imported",
    state,
    registration,
    census,
    discovery,
    now,
  });
}

export function createEmptyProjectState() {
  return Object.freeze({ projectId: null, state: "empty", project: null, reason: "no-project-selected" });
}

export function withProjectView(session, patch, { now = Date.now() } = {}) {
  const current = validateProjectSession(session);
  const next = validateView({ ...current.view, ...cloneJson(patch) }, current.projectId);
  // Where the user is looking (page, selection) is not a new scan or state of
  // the project, so the generation stays put; only updatedAt moves.
  return validateProjectSession({ ...cloneJson(current), updatedAt: monotonicTimestamp(now, current.updatedAt), view: next });
}

export function withProjectState(session, state, { now = Date.now(), reason = "state-updated" } = {}) {
  const current = validateProjectSession(session);
  const nextState = assertProjectTruthState(state);
  if (current.kind === "demo" && nextState !== "demo") throw new ProjectSchemaError("Demo project state cannot be promoted outside Demo mode.");
  const generation = current.generation + 1;
  const updatedAt = monotonicTimestamp(now, current.updatedAt);
  const provenance = cloneJson(current.provenance);
  provenance["project.state"] = createProvenanceRecord({ projectId: current.projectId, field: "project.state", state: nextState, sourceType: nextState === "unavailable" ? "unavailable" : "generated", sourceId: current.projectId, sourceRevision: generation, digest: current.census?.digest ?? null, observedAt: updatedAt, reason });
  provenance["project.generation"] = createProvenanceRecord({ projectId: current.projectId, field: "project.generation", state: nextState, sourceType: "generated", sourceId: current.projectId, sourceRevision: generation, digest: current.census?.digest ?? null, observedAt: updatedAt, reason: "session-generation" });
  return validateProjectSession({ ...cloneJson(current), generation, provenance, state: nextState, updatedAt });
}

export function migrateProjectSession(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ProjectSchemaError("ProjectSession migration input must be an object.");
  if (input.schemaVersion === PROJECT_SESSION_SCHEMA_VERSION) return validateProjectSession(input);
  if (input.schemaVersion !== 0) throw new UnsupportedProjectSchemaVersionError(input.schemaVersion);
  const kind = input.kind ?? input.mode ?? (input.rootIdentity ? "imported" : "generated");
  if (kind === "demo") {
    return createProjectSession({ projectId: input.projectId ?? input.id, name: input.name ?? "Perfect Planner Demo", kind: "demo", state: "demo", generation: input.generation ?? 1, createdAt: input.createdAt ?? input.updatedAt, updatedAt: input.updatedAt ?? input.createdAt });
  }
  const registration = input.registration ?? {
    access: "metadata-read-only",
    adapter: input.adapter ?? "unknown",
    persistence: input.persistence ?? "reselect-required",
    registryRevision: input.registryRevision ?? 1,
    rootIdentity: input.rootIdentity,
    rootLabel: input.rootLabel ?? input.name,
    workspaceId: input.workspaceId,
  };
  const census = input.censusDigest ? {
    digest: input.censusDigest,
    fileCount: input.fileCount ?? 0,
    generatedAt: input.updatedAt ?? input.createdAt,
    registryRevision: registration.registryRevision,
    rootIdentity: registration.rootIdentity,
    skippedCount: input.skippedCount ?? 0,
    totalBytesHashed: input.totalBytesHashed ?? null,
    workspaceId: registration.workspaceId,
  } : null;
  return createProjectSession({
    projectId: input.projectId ?? input.id ?? createImportedProjectId(registration.rootIdentity),
    name: input.name ?? registration.rootLabel,
    kind: "imported",
    state: census ? "imported" : input.state ?? "imported",
    registration,
    census,
    generation: input.generation ?? 1,
    createdAt: input.createdAt ?? input.updatedAt,
    updatedAt: input.updatedAt ?? input.createdAt,
    view: input.view ?? defaultView(),
  });
}

export function serializeProjectSession(session) {
  return JSON.stringify(validateProjectSession(session));
}

export { projectMetricKeys, projectTruthStates };
