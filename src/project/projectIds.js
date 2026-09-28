const PROJECT_ID = /^pp_[a-z0-9][a-z0-9_-]{2,63}$/;
const ENTITY_ID = /^(pp_[a-z0-9][a-z0-9_-]{2,63})::([a-z][a-z0-9-]{1,31})::([a-z0-9]{13})$/;
const SHA256 = /^[a-f0-9]{64}$/;

export const projectEntityTypes = Object.freeze([
  "project",
  "map",
  "component",
  "folder",
  "plan",
  "task",
  "evidence",
  "source",
  "run",
  "decision",
  "provenance",
]);

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string.`);
  return value.trim();
}

function hash64(value) {
  const text = requireText(value, "Stable ID source");
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(36).padStart(13, "0").slice(-13);
}

export function isProjectId(value) {
  return typeof value === "string" && PROJECT_ID.test(value);
}

export function assertProjectId(value) {
  if (!isProjectId(value)) throw new TypeError("Project ID is invalid.");
  return value;
}

export function createImportedProjectId(rootIdentity) {
  const identity = requireText(rootIdentity, "Root identity").toLowerCase();
  if (!SHA256.test(identity)) throw new TypeError("Root identity must be a lowercase SHA-256 digest.");
  return `pp_${identity.slice(0, 16)}_${hash64(identity).slice(0, 8)}`;
}

export function createStableProjectId(label, stableSource) {
  const normalizedLabel = requireText(label, "Project label")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28) || "project";
  const id = `pp_${normalizedLabel}_${hash64(stableSource).slice(0, 10)}`;
  return assertProjectId(id.slice(0, 64));
}

export function createProjectEntityId(projectId, entityType, stableSource) {
  const owner = assertProjectId(projectId);
  const type = requireText(entityType, "Entity type").toLowerCase();
  if (!projectEntityTypes.includes(type)) throw new TypeError(`Unsupported project entity type: ${type}.`);
  return `${owner}::${type}::${hash64(`${owner}\u0000${type}\u0000${requireText(stableSource, "Entity source")}`)}`;
}

export function parseProjectEntityId(value) {
  if (typeof value !== "string") return null;
  const match = ENTITY_ID.exec(value);
  if (!match || !projectEntityTypes.includes(match[2])) return null;
  return Object.freeze({ projectId: match[1], entityType: match[2], token: match[3] });
}

export function assertProjectEntityId(value, { projectId, entityType } = {}) {
  const parsed = parseProjectEntityId(value);
  if (!parsed) throw new TypeError("Project entity ID is invalid.");
  if (projectId && parsed.projectId !== assertProjectId(projectId)) throw new TypeError("Project entity ID belongs to another project.");
  if (entityType && parsed.entityType !== entityType) throw new TypeError("Project entity ID has the wrong type.");
  return value;
}

export function projectOwnsEntity(projectId, entityId) {
  const parsed = parseProjectEntityId(entityId);
  return Boolean(parsed && parsed.projectId === projectId);
}

