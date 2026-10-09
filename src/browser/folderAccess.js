// Remembers browser folder handles per project so a reload can reconnect the
// same folder instead of orphaning (or duplicating) the project. Handles are
// structured-cloneable, so IndexedDB keeps them; permission is never stored and
// must be asked again from a click after every reload.
const DB_NAME = "perfect-planner.folder-access";
const STORE = "folders";
const PROJECT_ID = /^pp_[a-z0-9][a-z0-9_-]{2,63}$/;

function validRecord(value) {
  return Boolean(value && typeof value === "object" && PROJECT_ID.test(value.projectId ?? "") &&
    typeof value.selectedPath === "string" && value.selectedPath.startsWith("browser://") &&
    value.handle?.kind === "directory" && typeof value.handle.name === "string");
}

export function createMemoryFolderHandleStore(initial = []) {
  const records = new Map(initial.map((record) => [record.projectId, record]));
  return Object.freeze({
    async get(projectId) { return records.get(projectId) ?? null; },
    async list() { return [...records.values()]; },
    async put(record) { records.set(record.projectId, record); return record; },
    async remove(projectId) { return records.delete(projectId); },
  });
}

export function createIndexedDbFolderHandleStore({ indexedDB = globalThis.indexedDB, name = DB_NAME } = {}) {
  if (typeof indexedDB?.open !== "function") return null;
  let opening = null;
  const open = () => opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "projectId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Folder memory could not be opened."));
    request.onblocked = () => reject(new Error("Folder memory is blocked by another tab."));
  }).catch((error) => { opening = null; throw error; });
  const run = (mode, action) => open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error ?? new Error("Folder memory failed."));
    tx.onabort = () => reject(tx.error ?? new Error("Folder memory was aborted."));
  }));
  return Object.freeze({
    async get(projectId) { return (await run("readonly", (store) => store.get(projectId))) ?? null; },
    async list() { return (await run("readonly", (store) => store.getAll())) ?? []; },
    async put(record) { await run("readwrite", (store) => store.put(record)); return record; },
    async remove(projectId) { await run("readwrite", (store) => store.delete(projectId)); return true; },
  });
}

let configuredStore;
const loaded = new Map();
const openThisSession = new Set();

export function setFolderHandleStore(store) {
  configuredStore = store ?? null;
  loaded.clear();
  openThisSession.clear();
}

export function getFolderHandleStore() {
  if (configuredStore === undefined) {
    try { configuredStore = createIndexedDbFolderHandleStore(); } catch { configuredStore = null; }
  }
  return configuredStore;
}

async function sameEntry(left, right) {
  if (left === right) return true;
  if (typeof left?.isSameEntry !== "function") return false;
  try { return (await left.isSameEntry(right)) === true; } catch { return false; }
}

// Returns the remembered record whose folder is the same entry as `handle`.
export async function findRememberedFolder(handle) {
  const store = getFolderHandleStore();
  if (!store || !handle) return null;
  let records;
  try { records = await store.list(); } catch { return null; }
  for (const record of records) {
    if (validRecord(record) && await sameEntry(record.handle, handle)) {
      loaded.set(record.projectId, record);
      return record;
    }
  }
  return null;
}

export async function rememberFolder({ projectId, selectedPath, handle, now = Date.now() }) {
  const record = { schemaVersion: 1, projectId, selectedPath, name: handle?.name, handle, savedAt: new Date(now).toISOString() };
  if (!validRecord(record)) return false;
  loaded.set(projectId, record);
  openThisSession.add(projectId);
  const store = getFolderHandleStore();
  if (!store) return false;
  try { await store.put(record); return true; } catch { return false; }
}

export async function forgetFolder(projectId) {
  loaded.delete(projectId);
  openThisSession.delete(projectId);
  try { return (await getFolderHandleStore()?.remove(projectId)) === true; } catch { return false; }
}

// Loads (and caches) the record so a later click can ask permission immediately.
export async function loadRememberedFolder(projectId) {
  if (loaded.has(projectId)) return loaded.get(projectId);
  const store = getFolderHandleStore();
  if (!store || !PROJECT_ID.test(projectId ?? "")) return null;
  try {
    const record = await store.get(projectId);
    if (!validRecord(record)) return null;
    loaded.set(projectId, record);
    return record;
  } catch { return null; }
}

// The most recently saved folder in this browser, for a one-click "Use last folder".
export async function lastRememberedFolder() {
  const store = getFolderHandleStore();
  if (!store) return null;
  let records;
  try { records = await store.list(); } catch { return null; }
  const latest = records.filter(validRecord).sort((left, right) => String(right.savedAt ?? "").localeCompare(String(left.savedAt ?? "")))[0];
  if (!latest) return null;
  loaded.set(latest.projectId, latest);
  return Object.freeze({ projectId: latest.projectId, name: latest.name ?? latest.handle.name, savedAt: latest.savedAt ?? null });
}

export function folderAccessState(projectId) {
  const record = loaded.get(projectId) ?? null;
  return Object.freeze({ remembered: Boolean(record), open: openThisSession.has(projectId), name: record?.name ?? null, savedAt: record?.savedAt ?? null });
}

// Must run from a click: the browser shows its permission prompt here.
export async function requestRememberedFolder(projectId) {
  const record = loaded.get(projectId) ?? await loadRememberedFolder(projectId);
  if (!record) return Object.freeze({ state: "missing" });
  let permission;
  try {
    permission = typeof record.handle.requestPermission === "function" ? await record.handle.requestPermission({ mode: "read" }) : "granted";
  } catch (error) {
    return Object.freeze({ state: error?.name === "NotFoundError" ? "missing-folder" : "failed" });
  }
  if (permission !== "granted") return Object.freeze({ state: "denied" });
  return Object.freeze({ state: "granted", record });
}
