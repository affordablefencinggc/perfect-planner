// Remembers the file paths seen by recent folder scans, keyed by the scan's
// census digest, so the Ledger can mark file scopes that name nothing scanned.
// The saved project session keeps only census counts and a digest, not paths.
//
// Advisory data only: a remembered list is never used to refuse a save or to
// claim that a file exists right now. Browser storage is best-effort; when it
// is unavailable the list lasts for this app session only.

const STORAGE_KEY = "perfect-planner.census-paths.v1";
const KEEP_SCANS = 3;
const MAX_STORED_BYTES = 2 * 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;

const memory = new Map();
const listeners = new Set();

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function readStored(storage) {
  try {
    const value = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "null");
    if (!Array.isArray(value)) return [];
    return value.filter((entry) => entry && DIGEST.test(entry.digest ?? "") && Array.isArray(entry.paths) && entry.paths.every((path) => typeof path === "string"));
  } catch { return []; }
}

/** Saves the paths of a completed census (an object with digest and files[].path). */
export function rememberCensusPaths(census, storage = defaultStorage()) {
  // The project session stores the digest in lower case; match it.
  const digest = typeof census?.digest === "string" ? census.digest.toLowerCase() : null;
  if (!digest || !DIGEST.test(digest) || !Array.isArray(census?.files)) return false;
  const paths = Object.freeze(census.files.map((file) => file?.path).filter((path) => typeof path === "string").map((path) => path.replaceAll("\\", "/")));
  memory.set(digest, paths);
  try {
    const entries = [{ digest, paths: [...paths] }, ...readStored(storage).filter((entry) => entry.digest !== digest)].slice(0, KEEP_SCANS);
    let text = JSON.stringify(entries);
    // Keep the newest scan when older ones do not fit; skip saving when it alone is too large.
    while (text.length > MAX_STORED_BYTES && entries.length > 1) { entries.pop(); text = JSON.stringify(entries); }
    if (text.length <= MAX_STORED_BYTES) storage?.setItem(STORAGE_KEY, text);
  } catch { /* Storage full or blocked: the in-memory list still works this session. */ }
  for (const listener of [...listeners]) { try { listener(); } catch { /* A listener error must not block others. */ } }
  return true;
}

/** The remembered paths for this census digest, or null when this scan's paths are not known. */
export function readCensusPaths(digest, storage = defaultStorage()) {
  if (typeof digest !== "string" || !DIGEST.test(digest)) return null;
  if (memory.has(digest)) return memory.get(digest);
  const stored = readStored(storage).find((entry) => entry.digest === digest);
  const paths = stored ? Object.freeze([...stored.paths]) : null;
  // Cache misses too, so repeated reads return the same value until a new scan is remembered.
  memory.set(digest, paths);
  return paths;
}

export function subscribeCensusPaths(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
