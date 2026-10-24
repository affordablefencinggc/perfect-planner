// The folder each scanned project came from, kept in this window's storage by project name. The desktop
// scan knows the real path; planning needs it to read the repo, so Structure writes it here and Deep planning
// hands it to the host (POST /planning/repo). Remembering is optional: without it the person pastes the folder.
const KEY = "perfect-planner:project-folders:v1";
const LIMIT = 30;

function read() {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function rememberProjectFolder(name, folder) {
  const key = String(name ?? "").trim().toLowerCase();
  const path = String(folder ?? "").trim();
  if (!key || !path) return;
  try {
    const all = read();
    delete all[key];
    const kept = Object.entries({ ...all, [key]: path }).slice(-LIMIT);
    globalThis.localStorage?.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch { /* remembering is optional */ }
}

export function projectFolderFor(name) {
  const path = read()[String(name ?? "").trim().toLowerCase()];
  return typeof path === "string" && path ? path : null;
}
