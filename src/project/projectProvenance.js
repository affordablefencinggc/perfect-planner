import { assertProjectEntityId, assertProjectId, createProjectEntityId } from "./projectIds.js";

export const projectTruthStates = Object.freeze([
  "empty",
  "demo",
  "imported",
  "generated",
  "authoritative",
  "unavailable",
  "stale",
]);

export const provenanceSourceTypes = Object.freeze([
  "none",
  "demo",
  "workspace-registration",
  "workspace-census",
  "workspace-discovery",
  "authority",
  "generated",
  "unavailable",
]);

export const projectMetricKeys = Object.freeze([
  "project.name",
  "project.state",
  "project.generation",
  "workspace.rootLabel",
  "workspace.adapter",
  "workspace.registryRevision",
  "census.fileCount",
  "census.skippedCount",
  "census.digest",
  "discovery.observed",
  "discovery.signals",
  "discovery.unanswered",
  "authority.architecture",
  "authority.folder",
  "authority.component",
  "authority.plan",
]);

const FIELD = /^[a-z][a-z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;
const REASON = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function isoTimestamp(value, label) {
  const text = typeof value === "number" ? new Date(value).toISOString() : String(value ?? "");
  if (!text || Number.isNaN(Date.parse(text))) throw new TypeError(`${label} must be an ISO timestamp.`);
  return new Date(text).toISOString();
}

function safeRevision(value) {
  if (value == null) return null;
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^[a-zA-Z0-9._:-]{1,96}$/.test(value)) return value;
  throw new TypeError("Provenance revision is invalid.");
}

export function assertProjectTruthState(value) {
  if (!projectTruthStates.includes(value)) throw new TypeError(`Unsupported project truth state: ${value}.`);
  return value;
}

export function createProvenanceRecord({
  projectId,
  field,
  state,
  sourceType,
  sourceId,
  sourceRevision = null,
  digest = null,
  observedAt,
  reason = "recorded",
}) {
  const owner = assertProjectId(projectId);
  if (typeof field !== "string" || !FIELD.test(field)) throw new TypeError("Provenance field is invalid.");
  const truthState = assertProjectTruthState(state);
  if (!provenanceSourceTypes.includes(sourceType)) throw new TypeError("Provenance source type is invalid.");
  const stableSource = String(sourceId ?? `${sourceType}:${field}`);
  const entitySourceId = sourceId && String(sourceId).includes("::")
    ? assertProjectEntityId(String(sourceId), { projectId: owner })
    : createProjectEntityId(owner, "source", stableSource);
  if (digest != null && (typeof digest !== "string" || !SHA256.test(digest))) throw new TypeError("Provenance digest must be a lowercase SHA-256 digest.");
  if (typeof reason !== "string" || !REASON.test(reason)) throw new TypeError("Provenance reason must be a redacted reason code.");
  return Object.freeze({
    schemaVersion: 1,
    provenanceId: createProjectEntityId(owner, "provenance", `${field}:${sourceType}:${stableSource}`),
    projectId: owner,
    field,
    state: truthState,
    sourceType,
    sourceId: entitySourceId,
    sourceRevision: safeRevision(sourceRevision),
    digest,
    observedAt: isoTimestamp(observedAt ?? Date.now(), "Provenance observation"),
    reason,
  });
}

export function validateProvenanceRecord(value, projectId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Provenance record must be an object.");
  const expected = ["digest", "field", "observedAt", "projectId", "provenanceId", "reason", "schemaVersion", "sourceId", "sourceRevision", "sourceType", "state"];
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new TypeError("Provenance record has an unknown or missing field.");
  if (value.schemaVersion !== 1) throw new TypeError("Unsupported provenance schema version.");
  const owner = assertProjectId(projectId ?? value.projectId);
  if (value.projectId !== owner) throw new TypeError("Provenance record belongs to another project.");
  assertProjectEntityId(value.provenanceId, { projectId: owner, entityType: "provenance" });
  assertProjectEntityId(value.sourceId, { projectId: owner, entityType: "source" });
  return createProvenanceRecord({ ...value, projectId: owner, sourceId: value.sourceId });
}

const metricReaders = Object.freeze({
  "project.name": (session) => session.name,
  "project.state": (session) => session.state,
  "project.generation": (session) => session.generation,
  "workspace.rootLabel": (session) => session.registration?.rootLabel ?? null,
  "workspace.adapter": (session) => session.registration?.adapter ?? null,
  "workspace.registryRevision": (session) => session.registration?.registryRevision ?? null,
  "census.fileCount": (session) => session.census?.fileCount ?? null,
  "census.skippedCount": (session) => session.census?.skippedCount ?? null,
  "census.digest": (session) => session.census?.digest ?? null,
  "discovery.observed": (session) => session.discovery?.counts.observed ?? null,
  "discovery.signals": (session) => session.discovery?.counts.signals ?? null,
  "discovery.unanswered": (session) => session.discovery?.counts.unanswered ?? null,
  "authority.architecture": (session) => session.authorities.architecture,
  "authority.folder": (session) => session.authorities.folder,
  "authority.component": (session) => session.authorities.component,
  "authority.plan": (session) => session.authorities.plan,
});

export function selectProjectMetric(session, key) {
  const reader = metricReaders[key];
  if (!reader) throw new TypeError(`Unknown project metric: ${key}.`);
  const provenance = session.provenance[key] ?? createProvenanceRecord({
    projectId: session.projectId,
    field: key,
    state: "unavailable",
    sourceType: "unavailable",
    sourceId: `missing:${key}`,
    sourceRevision: session.generation,
    observedAt: session.updatedAt,
    reason: "provenance-missing",
  });
  return Object.freeze({ key, value: reader(session), state: provenance.state, provenance });
}

export function selectProjectMetrics(session, keys = projectMetricKeys) {
  return Object.freeze(keys.map((key) => selectProjectMetric(session, key)));
}

