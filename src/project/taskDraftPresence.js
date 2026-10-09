// A small synchronous summary of the task drafts saved in IndexedDB, so that
// synchronous workflow receipts can say whether the Ledger holds any tasks.
// It is only ever written after a successful read of the real draft store.
import { WORK_RECORDS_CHANGED_EVENT } from "./projectWorkRecords.js";

const PREFIX = "perfect-planner.task-draft-presence.v1:";
export const taskDraftPresenceKey = (projectId) => `${PREFIX}${projectId}`;

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function summarizeTaskDrafts(ledger) {
  const tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
  return {
    censusDigest: ledger?.binding?.censusDigest ?? null,
    revision: Number.isSafeInteger(ledger?.revision) ? ledger.revision : 0,
    active: tasks.filter((task) => !task.archived).length,
    total: tasks.length,
  };
}

export function readTaskDraftPresence(projectId, storage = defaultStorage()) {
  if (!projectId || !storage) return null;
  try {
    const value = JSON.parse(storage.getItem(taskDraftPresenceKey(projectId)) ?? "null");
    if (!value || typeof value !== "object" || !Number.isSafeInteger(value.total) || !Number.isSafeInteger(value.active)) return null;
    return value;
  } catch { return null; }
}

/** Records the summary of a ledger that was just read from the store. Returns true when it changed. */
export function recordTaskDraftPresence(projectId, ledger, { storage = defaultStorage(), now = () => new Date().toISOString() } = {}) {
  if (!projectId || !storage) return false;
  const summary = summarizeTaskDrafts(ledger);
  const previous = readTaskDraftPresence(projectId, storage);
  if (previous && ["censusDigest", "revision", "active", "total"].every((key) => previous[key] === summary[key])) return false;
  try { storage.setItem(taskDraftPresenceKey(projectId), JSON.stringify({ ...summary, checkedAt: now() })); } catch { return false; }
  try { globalThis.dispatchEvent?.(new CustomEvent(WORK_RECORDS_CHANGED_EVENT, { detail: { projectId, section: null } })); } catch { /* non-browser */ }
  return true;
}
