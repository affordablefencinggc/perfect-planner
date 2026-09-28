import { assertProjectId, createProjectEntityId } from "./projectIds.js";
import { createProvenanceRecord } from "./projectProvenance.js";
import {
  PROJECT_SESSION_SCHEMA_VERSION,
  UnsupportedProjectSchemaVersionError,
  createEmptyProjectState,
  migrateProjectSession,
  validateProjectSession,
  withProjectView,
} from "./projectSession.js";

export const PROJECT_REGISTRY_SCHEMA_VERSION = 1;
export const DEFAULT_PROJECT_REGISTRY_KEY = "perfect-planner.project-registry.v1";

class ProjectRegistryError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ProjectRegistryError";
    this.code = code;
  }
}

export class UnsupportedProjectRegistryVersionError extends ProjectRegistryError {
  constructor(version) {
    super(`Unsupported project registry schema version: ${String(version)}.`, "registry-schema-version-unsupported");
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function isoTimestamp(value) {
  const date = typeof value === "number" ? new Date(value) : new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) throw new ProjectRegistryError("Registry timestamp is invalid.", "registry-schema-invalid");
  return date.toISOString();
}

function emptyEnvelope(now) {
  return {
    activeProjectId: null,
    projectOrder: [],
    projects: [],
    revision: 0,
    schemaVersion: PROJECT_REGISTRY_SCHEMA_VERSION,
    updatedAt: isoTimestamp(now),
  };
}

function assertEnvelopeShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProjectRegistryError("Project registry must be an object.", "registry-schema-invalid");
  const expected = ["activeProjectId", "projectOrder", "projects", "revision", "schemaVersion", "updatedAt"];
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new ProjectRegistryError("Project registry has an unknown or missing field.", "registry-schema-invalid");
}

export function validateProjectRegistryEnvelope(value) {
  assertEnvelopeShape(value);
  if (value.schemaVersion !== PROJECT_REGISTRY_SCHEMA_VERSION) throw new UnsupportedProjectRegistryVersionError(value.schemaVersion);
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new ProjectRegistryError("Project registry revision is invalid.", "registry-schema-invalid");
  if (!Array.isArray(value.projects) || !Array.isArray(value.projectOrder)) throw new ProjectRegistryError("Project registry collections are invalid.", "registry-schema-invalid");
  const projects = value.projects.map((project) => validateProjectSession(project));
  const ids = projects.map((project) => project.projectId);
  if (new Set(ids).size !== ids.length) throw new ProjectRegistryError("Project registry contains duplicate projects.", "registry-schema-invalid");
  if (value.projectOrder.length !== ids.length || new Set(value.projectOrder).size !== value.projectOrder.length || value.projectOrder.some((id) => !ids.includes(id))) {
    throw new ProjectRegistryError("Project order must contain every project exactly once.", "registry-schema-invalid");
  }
  if (value.activeProjectId != null && !ids.includes(value.activeProjectId)) throw new ProjectRegistryError("Active project is not in the registry.", "registry-schema-invalid");
  return deepFreeze({
    activeProjectId: value.activeProjectId,
    projectOrder: [...value.projectOrder],
    projects,
    revision: value.revision,
    schemaVersion: PROJECT_REGISTRY_SCHEMA_VERSION,
    updatedAt: isoTimestamp(value.updatedAt),
  });
}

export function migrateProjectRegistryEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProjectRegistryError("Project registry migration input is invalid.", "registry-schema-invalid");
  if (value.schemaVersion === PROJECT_REGISTRY_SCHEMA_VERSION) return validateProjectRegistryEnvelope(value);
  if (value.schemaVersion !== 0) throw new UnsupportedProjectRegistryVersionError(value.schemaVersion);
  const sourceProjects = Array.isArray(value.projects) ? value.projects : [];
  const projects = sourceProjects.map((project) => migrateProjectSession(project));
  const ids = projects.map((project) => project.projectId);
  const requestedOrder = Array.isArray(value.projectOrder) ? value.projectOrder : ids;
  const projectOrder = [...requestedOrder.filter((id) => ids.includes(id)), ...ids.filter((id) => !requestedOrder.includes(id))];
  const activeProjectId = ids.includes(value.activeProjectId) ? value.activeProjectId : projectOrder[0] ?? null;
  return validateProjectRegistryEnvelope({
    activeProjectId,
    projectOrder,
    projects,
    revision: Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0,
    schemaVersion: PROJECT_REGISTRY_SCHEMA_VERSION,
    updatedAt: value.updatedAt ?? new Date(0).toISOString(),
  });
}

export function createMemoryStorage(initial = {}) {
  const entries = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
  return {
    get length() { return entries.size; },
    clear() { entries.clear(); },
    getItem(key) { return entries.has(String(key)) ? entries.get(String(key)) : null; },
    key(index) { return [...entries.keys()][index] ?? null; },
    removeItem(key) { entries.delete(String(key)); },
    setItem(key, value) { entries.set(String(key), String(value)); },
  };
}

function health(state, persistence, reason, error = null) {
  return deepFreeze({
    state,
    persistence,
    reason,
    errorCode: error?.code ?? (error ? "storage-error" : null),
  });
}

function runtimeSnapshot(envelope, registryHealth) {
  const ordered = envelope.projectOrder.map((id) => envelope.projects.find((project) => project.projectId === id));
  const activeProject = ordered.find((project) => project.projectId === envelope.activeProjectId) ?? null;
  return deepFreeze({
    activeProject,
    activeProjectId: activeProject?.projectId ?? null,
    health: registryHealth,
    projectOrder: [...envelope.projectOrder],
    projects: ordered,
    revision: envelope.revision,
    schemaVersion: envelope.schemaVersion,
    state: activeProject?.state ?? "empty",
    updatedAt: envelope.updatedAt,
  });
}

function envelopeJson(value) {
  return JSON.stringify(value);
}

function newestProject(left, right) {
  if (!left) return right;
  if (!right) return left;
  const leftTime = Date.parse(left.updatedAt);
  const rightTime = Date.parse(right.updatedAt);
  if (leftTime !== rightTime) return leftTime > rightTime ? left : right;
  return envelopeJson(left) <= envelopeJson(right) ? left : right;
}

function mergeConflictingEnvelopes(left, right, now) {
  const projectsById = new Map();
  for (const project of [...left.projects, ...right.projects]) {
    projectsById.set(
      project.projectId,
      newestProject(projectsById.get(project.projectId), project),
    );
  }
  const projectOrder = [...projectsById.keys()].sort();
  const activeCandidates = [left.activeProjectId, right.activeProjectId]
    .filter((id) => id && projectsById.has(id))
    .sort();
  const leftUpdated = Date.parse(left.updatedAt);
  const rightUpdated = Date.parse(right.updatedAt);
  const activeProjectId =
    leftUpdated > rightUpdated
      ? left.activeProjectId
      : rightUpdated > leftUpdated
        ? right.activeProjectId
        : activeCandidates[0] ?? projectOrder[0] ?? null;
  return validateProjectRegistryEnvelope({
    activeProjectId:
      activeProjectId && projectsById.has(activeProjectId)
        ? activeProjectId
        : projectOrder[0] ?? null,
    projectOrder,
    projects: projectOrder.map((id) => projectsById.get(id)),
    revision: Math.max(left.revision, right.revision) + 1,
    schemaVersion: PROJECT_REGISTRY_SCHEMA_VERSION,
    updatedAt: isoTimestamp(now),
  });
}

export function createProjectRegistry({ storage = null, storageKey = DEFAULT_PROJECT_REGISTRY_KEY, now = () => Date.now() } = {}) {
  if (typeof storageKey !== "string" || !storageKey.trim()) throw new ProjectRegistryError("Storage key is required.", "registry-config-invalid");
  const listeners = new Set();
  let registryHealth = storage ? health("ready", "durable", "storage-ready") : health("unavailable", "memory", "storage-unavailable");
  let envelope;

  const notify = () => listeners.forEach((listener) => listener());
  const refreshSnapshot = () => { snapshot = runtimeSnapshot(envelope, registryHealth); };
  const safeNow = () => isoTimestamp(now());

  try {
    const stored = storage?.getItem(storageKey);
    if (stored == null) {
      envelope = validateProjectRegistryEnvelope(emptyEnvelope(now()));
    } else {
      const parsed = JSON.parse(stored);
      envelope = migrateProjectRegistryEnvelope(parsed);
      if (parsed.schemaVersion === 0) {
        try {
          storage.setItem(storageKey, JSON.stringify(envelope));
          registryHealth = health("ready", "durable", "schema-migrated");
        } catch (error) {
          registryHealth = health("unavailable", "memory", "storage-write-failed", error);
        }
      }
    }
  } catch (error) {
    envelope = validateProjectRegistryEnvelope(emptyEnvelope(now()));
    const unsupportedVersion = error instanceof UnsupportedProjectRegistryVersionError || error instanceof UnsupportedProjectSchemaVersionError;
    registryHealth = health("stale", "memory", unsupportedVersion ? "schema-version-unsupported" : "storage-corrupt", error);
    if (!unsupportedVersion) {
      try { storage?.removeItem(storageKey); } catch { /* Memory recovery remains available. */ }
    }
  }

  let snapshot = runtimeSnapshot(envelope, registryHealth);

  function parseStored(raw) {
    if (raw == null) return null;
    return migrateProjectRegistryEnvelope(JSON.parse(raw));
  }

  function persist(nextEnvelope) {
    const checked = validateProjectRegistryEnvelope(nextEnvelope);
    envelope = checked;
    if (storage && registryHealth.reason !== "schema-version-unsupported") {
      try {
        storage.setItem(storageKey, JSON.stringify(checked));
        registryHealth = health("ready", "durable", "storage-ready");
      } catch (error) {
        registryHealth = health("unavailable", "memory", "storage-write-failed", error);
      }
    }
    refreshSnapshot();
    notify();
    return snapshot;
  }

  function nextEnvelope(projects, projectOrder, activeProjectId) {
    return {
      activeProjectId,
      projectOrder,
      projects,
      revision: envelope.revision + 1,
      schemaVersion: PROJECT_REGISTRY_SCHEMA_VERSION,
      updatedAt: safeNow(),
    };
  }

  function synchronize(rawValue = undefined) {
    if (!storage || registryHealth.reason === "schema-version-unsupported") return false;
    let external;
    try {
      external = parseStored(
        rawValue === undefined ? storage.getItem(storageKey) : rawValue,
      );
    } catch (error) {
      registryHealth = health("stale", "durable", "external-storage-invalid", error);
      refreshSnapshot();
      notify();
      return false;
    }
    if (!external) return false;
    const localJson = envelopeJson(envelope);
    const externalJson = envelopeJson(external);
    if (localJson === externalJson) return false;
    if (external.revision > envelope.revision) {
      envelope = external;
      registryHealth = health("ready", "durable", "external-update-applied");
      refreshSnapshot();
      notify();
      return true;
    }
    if (external.revision < envelope.revision) return false;
    const merged = mergeConflictingEnvelopes(envelope, external, now());
    persist(merged);
    return true;
  }

  function rebaseBeforeMutation() {
    synchronize();
  }

  const api = {
    storageKey,
    getSnapshot: () => snapshot,
    getHealth: () => registryHealth,
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("Project registry listener must be a function.");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    list() { return snapshot.projects; },
    get(projectId) { return snapshot.projects.find((project) => project.projectId === projectId) ?? null; },
    getActive() { return snapshot.activeProject; },
    // A local summary of a verified server observation, never an approval grant.
    // The caller owns async request ordering; this synchronous merge reads the latest session.
    recordArchitectureObservation(projectId, observation) {
      const input = structuredClone(observation);
      const id = assertProjectId(projectId);
      if (!input || !["stale", "observed", "unavailable"].includes(input.state)) throw new ProjectRegistryError("Architecture observation is invalid.", "architecture-observation-invalid");
      rebaseBeforeMutation();
      const current = api.get(id);
      if (!current) throw new ProjectRegistryError("Cannot update an unknown project.", "project-not-found");
      if (current.kind !== "imported" || !/^[a-f0-9]{64}$/.test(input.expectedRootIdentity ?? "") || current.registration?.rootIdentity !== input.expectedRootIdentity) throw new ProjectRegistryError("Architecture observation belongs to another root.", "architecture-root-mismatch");
      const authorities = { ...current.authorities };
      const provenance = { ...current.provenance };
      const timestamp = isoTimestamp(Math.max(Date.parse(safeNow()), Date.parse(current.updatedAt) + 1));
      const previous = authorities.architecture;
      let reason = input.state === "stale" ? "architecture-refreshing" : "architecture-unavailable";
      let nextState = input.state;
      if (input.state === "observed") {
        const receipt = input.receipt;
        if (receipt?.valid !== true || receipt.planId !== id || !("head" in receipt)) throw new ProjectRegistryError("Architecture receipt does not match the project.", "architecture-observation-invalid");
        const head = receipt.head;
        if (head !== null) {
          if (!head || !Number.isSafeInteger(head.revision) || head.revision < 1 || !/^[a-f0-9]{64}$/.test(head.contractDigest ?? "") || typeof head.registeredAt !== "string" || !Number.isFinite(Date.parse(head.registeredAt))) throw new ProjectRegistryError("Architecture head is invalid.", "architecture-observation-invalid");
          if (previous && (head.revision < previous.revision || (head.revision === previous.revision && head.contractDigest !== previous.digest))) throw new ProjectRegistryError("Architecture observation conflicts with the retained revision.", "architecture-observation-stale");
          authorities.architecture = { digest: head.contractDigest, entityId: createProjectEntityId(id, "source", "architecture-contract"), recordedAt: isoTimestamp(head.registeredAt), revision: head.revision, state: "authoritative" };
          nextState = "authoritative";
          reason = "architecture-head-observed";
        } else {
          authorities.architecture = previous ? { ...previous, state: "unavailable" } : null;
          nextState = "unavailable";
          reason = "architecture-head-missing";
        }
      } else if (previous) authorities.architecture = { ...previous, state: input.state };
      const reference = authorities.architecture;
      provenance["authority.architecture"] = createProvenanceRecord({ projectId: id, field: "authority.architecture", state: nextState, sourceType: reference ? "authority" : "unavailable", sourceId: "architecture-contract", sourceRevision: reference?.revision ?? null, digest: reference?.digest ?? null, observedAt: timestamp, reason });
      if (input.state === "observed" && (previous?.digest !== reference?.digest || previous?.revision !== reference?.revision || reason === "architecture-head-missing")) {
        for (const kind of ["folder", "component", "plan"]) {
          const dependent = authorities[kind];
          if (!dependent) continue;
          authorities[kind] = { ...dependent, state: "stale" };
          provenance[`authority.${kind}`] = createProvenanceRecord({ projectId: id, field: `authority.${kind}`, state: "stale", sourceType: "authority", sourceId: `${kind}-contract`, sourceRevision: dependent.revision, digest: dependent.digest, observedAt: timestamp, reason: reason === "architecture-head-missing" ? reason : "architecture-head-changed" });
        }
      }
      const updated = validateProjectSession({ ...current, authorities, provenance, updatedAt: timestamp });
      // Avoid upsert's second rebase replacing unrelated changes with a captured whole session.
      persist(nextEnvelope(envelope.projects.map((item) => item.projectId === id ? updated : item), envelope.projectOrder, envelope.activeProjectId));
      return Object.freeze({ project: api.get(id), persisted: registryHealth.persistence === "durable" && registryHealth.state === "ready", persistenceReason: registryHealth.reason });
    },
    // Like architecture observations, this is a cache receipt, not execution authority.
    recordFolderObservation(projectId, observation) {
      const input = structuredClone(observation);
      const id = assertProjectId(projectId);
      if (!input || !["stale", "observed", "unavailable"].includes(input.state)) throw new ProjectRegistryError("Folder observation is invalid.", "folder-observation-invalid");
      rebaseBeforeMutation();
      const current = api.get(id);
      if (!current) throw new ProjectRegistryError("Cannot update an unknown project.", "project-not-found");
      if (current.kind !== "imported" || !/^[a-f0-9]{64}$/.test(input.expectedRootIdentity ?? "") || current.registration?.rootIdentity !== input.expectedRootIdentity) throw new ProjectRegistryError("Folder observation belongs to another root.", "folder-root-mismatch");
      const authorities = { ...current.authorities };
      const provenance = { ...current.provenance };
      const timestamp = isoTimestamp(Math.max(Date.parse(safeNow()), Date.parse(current.updatedAt) + 1));
      const previous = authorities.folder;
      let nextState = input.state;
      let reason = input.state === "stale" ? "folder-refreshing" : "folder-unavailable";
      if (input.state === "observed") {
        const receipt = input.receipt, parentReceipt = input.architectureReceipt;
        if (receipt?.valid !== true || receipt.planId !== id || !("head" in receipt) || parentReceipt?.valid !== true || parentReceipt.planId !== id || !("head" in parentReceipt)) throw new ProjectRegistryError("Folder receipt does not match the project.", "folder-observation-invalid");
        const head = receipt.head, parent = parentReceipt.head;
        const validIdentity = value => value && Number.isSafeInteger(value.revision) && value.revision > 0 && /^[a-f0-9]{64}$/.test(value.contractDigest ?? "");
        if (parent !== null && !validIdentity(parent)) throw new ProjectRegistryError("Architecture head is invalid.", "folder-observation-invalid");
        if (head !== null) {
          if (!validIdentity(head) || !Number.isSafeInteger(head.architectureRevision) || head.architectureRevision < 1 || !/^[a-f0-9]{64}$/.test(head.architectureContractDigest ?? "") || typeof head.registeredAt !== "string" || !Number.isFinite(Date.parse(head.registeredAt))) throw new ProjectRegistryError("Folder head is invalid.", "folder-observation-invalid");
          if (previous && (head.revision < previous.revision || (head.revision === previous.revision && head.contractDigest !== previous.digest))) throw new ProjectRegistryError("Folder observation conflicts with the retained revision.", "folder-observation-stale");
          const architecture = authorities.architecture;
          const matches = parent && architecture?.state === "authoritative" && architecture.digest === parent.contractDigest && architecture.revision === parent.revision && head.architectureContractDigest === parent.contractDigest && head.architectureRevision === parent.revision;
          nextState = matches ? "authoritative" : "stale";
          reason = matches ? "folder-head-observed" : "folder-parent-stale";
          authorities.folder = { digest: head.contractDigest, entityId: createProjectEntityId(id, "source", "folder-contract"), recordedAt: isoTimestamp(head.registeredAt), revision: head.revision, state: nextState };
        } else {
          authorities.folder = previous ? { ...previous, state: "unavailable" } : null;
          nextState = "unavailable";
          reason = "folder-head-missing";
        }
      } else if (previous) authorities.folder = { ...previous, state: input.state };
      const reference = authorities.folder;
      provenance["authority.folder"] = createProvenanceRecord({ projectId: id, field: "authority.folder", state: nextState, sourceType: reference ? "authority" : "unavailable", sourceId: "folder-contract", sourceRevision: reference?.revision ?? null, digest: reference?.digest ?? null, observedAt: timestamp, reason });
      if (input.state === "observed" && (previous?.digest !== reference?.digest || previous?.revision !== reference?.revision || reason === "folder-parent-stale" || reason === "folder-head-missing")) {
        for (const kind of ["component", "plan"]) {
          const dependent = authorities[kind];
          if (!dependent) continue;
          authorities[kind] = { ...dependent, state: "stale" };
          provenance[`authority.${kind}`] = createProvenanceRecord({ projectId: id, field: `authority.${kind}`, state: "stale", sourceType: "authority", sourceId: `${kind}-contract`, sourceRevision: dependent.revision, digest: dependent.digest, observedAt: timestamp, reason: reason === "folder-parent-stale" || reason === "folder-head-missing" ? reason : "folder-head-changed" });
        }
      }
      const updated = validateProjectSession({ ...current, authorities, provenance, updatedAt: timestamp });
      persist(nextEnvelope(envelope.projects.map(item => item.projectId === id ? updated : item), envelope.projectOrder, envelope.activeProjectId));
      return Object.freeze({ project: api.get(id), persisted: registryHealth.persistence === "durable" && registryHealth.state === "ready", persistenceReason: registryHealth.reason });
    },
    // Summary of checked componentClient context only, never a publication or execution grant.
    recordComponentObservation(projectId, observation) {
      const input = structuredClone(observation), id = assertProjectId(projectId);
      const invalid = () => { throw new ProjectRegistryError("Component observation is invalid.", "component-observation-invalid"); };
      if (!input || !["stale", "observed", "unavailable"].includes(input.state)) invalid();
      rebaseBeforeMutation();
      const current = api.get(id);
      if (!current) throw new ProjectRegistryError("Cannot update an unknown project.", "project-not-found");
      if (current.kind !== "imported" || !/^[a-f0-9]{64}$/.test(input.expectedRootIdentity ?? "") || current.registration?.rootIdentity !== input.expectedRootIdentity) throw new ProjectRegistryError("Component observation belongs to another root.", "component-root-mismatch");
      const authorities = { ...current.authorities }, provenance = { ...current.provenance };
      const timestamp = isoTimestamp(Math.max(Date.parse(safeNow()), Date.parse(current.updatedAt) + 1));
      const previous = authorities.component;
      let nextState = input.state, reason = input.state === "stale" ? "component-refreshing" : "component-unavailable";
      if (input.state === "observed") {
        const receipt = input.receipt;
        const identity = head => head && Number.isSafeInteger(head.revision) && head.revision > 0 && typeof head.contractDigest === "string" && /^[a-f0-9]{64}$/.test(head.contractDigest);
        if (receipt?.schemaVersion !== 1 || receipt.planId !== id || !["ready", "architecture-missing", "folder-missing", "folder-stale"].includes(receipt.state) || receipt.ready !== (receipt.state === "ready") || !["missing", "current", "stale"].includes(receipt.catalogState) || receipt.publicationAuthorized !== false || receipt.executionAuthorized !== false) invalid();
        const { architectureHead: architecture, folderHead: folder, catalogHead: head, catalog } = receipt;
        if ((architecture !== null && !identity(architecture)) || (folder !== null && !identity(folder)) || (head !== null && !identity(head)) || (head === null) !== (catalog === null) || (receipt.catalogState === "missing") !== (catalog === null)) invalid();
        const parentPair = architecture && folder && folder.architectureContractDigest === architecture.contractDigest && folder.architectureRevision === architecture.revision;
        if ((receipt.state === "ready" && !parentPair) || (receipt.state === "architecture-missing" && architecture !== null) || (receipt.state === "folder-missing" && (architecture === null || folder !== null)) || (receipt.state === "folder-stale" && (!architecture || !folder || parentPair))) invalid();
        if (head !== null) {
          if (typeof head.registeredAt !== "string" || !Number.isFinite(Date.parse(head.registeredAt)) || catalog?.planId !== id || catalog.digest !== head.contractDigest || ["architectureDigest", "architectureRevision", "folderDigest", "folderRevision"].some(key => catalog[key] !== head[key]) || !/^[a-f0-9]{64}$/.test(head.architectureDigest ?? "") || !/^[a-f0-9]{64}$/.test(head.folderDigest ?? "") || !Number.isSafeInteger(head.architectureRevision) || head.architectureRevision < 1 || !Number.isSafeInteger(head.folderRevision) || head.folderRevision < 1) invalid();
          if (previous && (head.revision < previous.revision || (head.revision === previous.revision && head.contractDigest !== previous.digest))) throw new ProjectRegistryError("Component observation conflicts with the retained revision.", "component-observation-stale");
          const bound = receipt.state === "ready" && head.architectureDigest === architecture.contractDigest && head.architectureRevision === architecture.revision && head.folderDigest === folder.contractDigest && head.folderRevision === folder.revision;
          if ((receipt.catalogState === "current") !== Boolean(bound)) invalid();
          const matches = bound && authorities.architecture?.state === "authoritative" && authorities.architecture.digest === architecture.contractDigest && authorities.architecture.revision === architecture.revision && authorities.folder?.state === "authoritative" && authorities.folder.digest === folder.contractDigest && authorities.folder.revision === folder.revision;
          nextState = matches ? "authoritative" : "stale";
          reason = matches ? "component-head-observed" : "component-parent-stale";
          authorities.component = { digest: head.contractDigest, entityId: createProjectEntityId(id, "source", "component-contract"), recordedAt: isoTimestamp(head.registeredAt), revision: head.revision, state: nextState };
        } else {
          authorities.component = previous ? { ...previous, state: "unavailable" } : null;
          nextState = "unavailable";
          reason = "component-head-missing";
        }
      } else if (previous) authorities.component = { ...previous, state: input.state };
      const reference = authorities.component;
      provenance["authority.component"] = createProvenanceRecord({ projectId: id, field: "authority.component", state: nextState, sourceType: reference ? "authority" : "unavailable", sourceId: "component-contract", sourceRevision: reference?.revision ?? null, digest: reference?.digest ?? null, observedAt: timestamp, reason });
      if (input.state === "observed" && (previous?.digest !== reference?.digest || previous?.revision !== reference?.revision || reason === "component-parent-stale" || reason === "component-head-missing") && authorities.plan) {
        const plan = authorities.plan;
        authorities.plan = { ...plan, state: "stale" };
        provenance["authority.plan"] = createProvenanceRecord({ projectId: id, field: "authority.plan", state: "stale", sourceType: "authority", sourceId: "plan-contract", sourceRevision: plan.revision, digest: plan.digest, observedAt: timestamp, reason: reason === "component-parent-stale" || reason === "component-head-missing" ? reason : "component-head-changed" });
      }
      const updated = validateProjectSession({ ...current, authorities, provenance, updatedAt: timestamp });
      persist(nextEnvelope(envelope.projects.map(item => item.projectId === id ? updated : item), envelope.projectOrder, envelope.activeProjectId));
      return Object.freeze({ project: api.get(id), persisted: registryHealth.persistence === "durable" && registryHealth.state === "ready", persistenceReason: registryHealth.reason });
    },
    upsert(session, { activate = true } = {}) {
      rebaseBeforeMutation();
      const project = validateProjectSession(session);
      const exists = envelope.projects.some((item) => item.projectId === project.projectId);
      const projects = exists ? envelope.projects.map((item) => item.projectId === project.projectId ? project : item) : [...envelope.projects, project];
      const projectOrder = exists ? [...envelope.projectOrder] : [...envelope.projectOrder, project.projectId];
      persist(nextEnvelope(projects, projectOrder, activate ? project.projectId : envelope.activeProjectId ?? project.projectId));
      return project;
    },
    setActive(projectId) {
      rebaseBeforeMutation();
      const id = assertProjectId(projectId);
      if (!envelope.projects.some((project) => project.projectId === id)) throw new ProjectRegistryError("Cannot activate an unknown project.", "project-not-found");
      if (envelope.activeProjectId !== id) persist(nextEnvelope(envelope.projects, envelope.projectOrder, id));
      return api.get(id);
    },
    updateView(projectId, patch) {
      rebaseBeforeMutation();
      const current = api.get(assertProjectId(projectId));
      if (!current) throw new ProjectRegistryError("Cannot update an unknown project.", "project-not-found");
      const requested = { ...current.view, ...patch };
      if (Object.keys(current.view).every((key) => current.view[key] === requested[key])) return current;
      const updated = withProjectView(current, patch, { now: now() });
      api.upsert(updated, { activate: envelope.activeProjectId === projectId });
      return updated;
    },
    remove(projectId) {
      rebaseBeforeMutation();
      const id = assertProjectId(projectId);
      if (!envelope.projects.some((project) => project.projectId === id)) return false;
      const projects = envelope.projects.filter((project) => project.projectId !== id);
      const projectOrder = envelope.projectOrder.filter((item) => item !== id);
      const activeProjectId = envelope.activeProjectId === id ? projectOrder[0] ?? null : envelope.activeProjectId;
      persist(nextEnvelope(projects, projectOrder, activeProjectId));
      return true;
    },
    clear() {
      rebaseBeforeMutation();
      persist({ ...emptyEnvelope(now()), revision: envelope.revision + 1 });
    },
    synchronize,
    exportRedacted() {
      return JSON.stringify(envelope);
    },
    emptyState: createEmptyProjectState,
  };
  return Object.freeze(api);
}

export function resolveProjectRegistryStorage(runtime = globalThis) {
  try {
    return runtime?.localStorage ?? null;
  } catch {
    return null;
  }
}

export { ProjectRegistryError, PROJECT_SESSION_SCHEMA_VERSION };
