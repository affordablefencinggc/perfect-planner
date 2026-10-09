// The folder `npm start` was launched for, exposed read-only by the local host. It is wrapped in the
// same handle shape as the browser folder picker returns, so the existing bounded census reads it.
const BASE = "/api/launch-folder";
const HEADERS = Object.freeze({ "x-pp-launch-folder": "1" });

async function getJson(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: HEADERS, credentials: "same-origin" });
  if (!response.ok) {
    const error = new Error(`launch-folder ${response.status}`);
    error.name = response.status === 403 ? "NotAllowedError" : "NotFoundError";
    throw error;
  }
  return response.json();
}

const query = (relative) => `?path=${encodeURIComponent(relative)}`;

function fileHandle(relative, name, fetchImpl) {
  return Object.freeze({
    kind: "file",
    name,
    // Fresh metadata on every call so the census's stability check sees real changes.
    async getFile() {
      const info = await getJson(`${BASE}/stat${query(relative)}`, fetchImpl);
      return Object.freeze({
        name,
        size: info.size,
        lastModified: info.lastModified,
        async arrayBuffer() {
          const response = await fetchImpl(`${BASE}/file${query(relative)}`, { headers: HEADERS, credentials: "same-origin" });
          if (!response.ok) {
            const error = new Error(`launch-folder ${response.status}`);
            error.name = "NotReadableError";
            throw error;
          }
          return response.arrayBuffer();
        },
      });
    },
  });
}

export function createLaunchFolderHandle({ name, relative = "", fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
  const handle = {
    kind: "directory",
    name,
    launchFolder: true,
    async *entries() {
      const { entries } = await getJson(`${BASE}/list${query(relative)}`, fetchImpl);
      for (const entry of entries) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        yield [entry.name, entry.kind === "directory"
          ? createLaunchFolderHandle({ name: entry.name, relative: child, fetchImpl })
          : fileHandle(child, entry.name, fetchImpl)];
      }
    },
    async queryPermission() { return "granted"; },
    async requestPermission() { return "granted"; },
    async isSameEntry(other) { return Boolean(other?.launchFolder) && other.name === name && other.relative === relative; },
    relative,
  };
  return Object.freeze(handle);
}

// What the local host offers, or null when there is none (static hosting, the desktop app, tests).
export async function describeLaunchFolder({ fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
  if (typeof fetchImpl !== "function") return null;
  try {
    const value = await getJson(BASE, fetchImpl);
    if (value?.available !== true || typeof value.name !== "string" || !value.name) return null;
    return Object.freeze({ name: value.name, path: typeof value.path === "string" ? value.path : null });
  } catch {
    return null;
  }
}
