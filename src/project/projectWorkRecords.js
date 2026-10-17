// Project-scoped work records for imported projects (v1).
// Each feature owns one section and writes whole-section revisions; nothing here
// borrows Demo data. Records are evidence of user/app actions, never inferred.

export const WORK_RECORDS_SCHEMA_VERSION = 1;
export const WORK_RECORD_SECTIONS = Object.freeze([
  "discoveryReview", // per-category confirm/dismiss/answer (Structure)
  "discoveryFindings", // finding labels + evidence paths for the saved scan (metadata only)
  "planAuthority",   // approved plan revision bound to this project (Plan/Ledger)
  "collisions",      // evaluated task write-claim collisions (Collision)
  "allocation",      // owner + order per task (Allocation)
  "proof",           // proof items attached per task (Evidence)
  "review",          // integrity sign-off per plan revision (Integrity)
  "build",           // per-task build status (Build)
  "planReady",       // "project is ready" confirmed against a core plan approval (P-n)
]);

const PREFIX = "perfect-planner.work-records.v1:";
const EVENT = "perfect-planner:work-records";
export const WORK_RECORDS_CHANGED_EVENT = EVENT;
export const workRecordsKey = (projectId) => `${PREFIX}${projectId}`;

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function empty(projectId) {
  return { schemaVersion: WORK_RECORDS_SCHEMA_VERSION, projectId, sections: {} };
}

export function readWorkRecords(projectId, storage = defaultStorage()) {
  if (!projectId || !storage) return empty(projectId);
  let raw = null;
  try { raw = storage.getItem(workRecordsKey(projectId)); } catch { return empty(projectId); }
  if (!raw) return empty(projectId);
  try {
    const value = JSON.parse(raw);
    if (value?.schemaVersion !== WORK_RECORDS_SCHEMA_VERSION || value.projectId !== projectId || typeof value.sections !== "object" || !value.sections) throw new Error("shape");
    return { ...value, sections: Object.fromEntries(Object.entries(value.sections).filter(([key]) => WORK_RECORD_SECTIONS.includes(key))) };
  } catch {
    // Keep the unreadable bytes for recovery instead of overwriting them on the next write.
    try { storage.setItem(`${workRecordsKey(projectId)}.unreadable`, raw); } catch { /* best effort */ }
    return { ...empty(projectId), unreadable: true };
  }
}

/** Returns the section record, or null when nothing has been recorded. */
export function readSection(projectId, section, storage = defaultStorage()) {
  if (!WORK_RECORD_SECTIONS.includes(section)) throw new Error(`Unknown work-record section: ${section}`);
  return readWorkRecords(projectId, storage).sections[section] ?? null;
}

/**
 * Replaces one section with `data`, bumping its revision. `now` is injectable
 * for tests. Returns the stored section record.
 */
export function writeSection(projectId, section, data, { storage = defaultStorage(), now = () => new Date().toISOString() } = {}) {
  if (!projectId) throw new Error("WORK_RECORDS_PROJECT_REQUIRED");
  if (!WORK_RECORD_SECTIONS.includes(section)) throw new Error(`Unknown work-record section: ${section}`);
  if (!storage) throw new Error("WORK_RECORDS_STORAGE_UNAVAILABLE");
  const current = readWorkRecords(projectId, storage);
  if (current.unreadable) throw new Error("WORK_RECORDS_UNREADABLE");
  const previous = current.sections[section] ?? null;
  const record = { revision: (previous?.revision ?? 0) + 1, recordedAt: now(), data };
  const next = { schemaVersion: WORK_RECORDS_SCHEMA_VERSION, projectId, sections: { ...current.sections, [section]: record } };
  storage.setItem(workRecordsKey(projectId), JSON.stringify(next));
  try { globalThis.dispatchEvent?.(new CustomEvent(EVENT, { detail: { projectId, section } })); } catch { /* non-browser */ }
  return record;
}

/** Subscribe to section changes in this tab and other tabs. Returns an unsubscribe function. */
export function subscribeWorkRecords(projectId, listener) {
  const target = globalThis.addEventListener ? globalThis : null;
  if (!target) return () => {};
  const local = (event) => { if (event.detail?.projectId === projectId) listener(event.detail.section); };
  const remote = (event) => { if (event.key === workRecordsKey(projectId)) listener(null); };
  target.addEventListener(EVENT, local);
  target.addEventListener("storage", remote);
  return () => { target.removeEventListener(EVENT, local); target.removeEventListener("storage", remote); };
}
