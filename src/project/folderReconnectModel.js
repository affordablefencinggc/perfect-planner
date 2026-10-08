// Plain-language status for a browser project's folder after a reload.
// A saved scan is only ever "last scan": it is never shown as current until
// the folder has been opened and scanned again in this visit.
function scanDate(value) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC` : null;
}

export function describeFolderConnection({ project, access = null, scannedThisVisit = false } = {}) {
  if (!project || project.kind !== "imported" || project.registration?.adapter !== "browser" || scannedThisVisit) return null;
  const census = project.census ?? null;
  const date = scanDate(census?.generatedAt);
  const files = Number.isSafeInteger(census?.fileCount) ? census.fileCount : null;
  const lastScan = census
    ? Object.freeze({ label: "Last scan", files, date, text: `Last scan${date ? ` · ${date}` : ""}${files === null ? "" : ` · ${files} ${files === 1 ? "file" : "files"}`}` })
    : null;
  const remembered = access?.remembered === true;
  const open = remembered && access?.open === true;
  const state = open ? "scan-again" : remembered ? "reconnect" : "choose-again";
  const name = typeof access?.name === "string" && access.name ? access.name : project.registration?.rootLabel ?? "this folder";
  const copy = {
    "scan-again": {
      title: `${name} is open in this tab`,
      detail: "Scan it again to replace the last scan. The project, its plan and its tasks stay the same.",
      action: "Scan folder again",
    },
    reconnect: {
      title: `Reconnect ${name}`,
      detail: "The page was reloaded, so the browser closed the folder. Reconnect it to scan again. The browser will ask you to allow read access. The project, its plan and its tasks stay the same.",
      action: "Reconnect folder",
    },
    "choose-again": {
      title: "This browser does not remember the folder",
      detail: "Choose the app folder again to scan it. Folders opened before this browser could remember them may appear as a new project.",
      action: null,
    },
  }[state];
  return Object.freeze({ state, lastScan, current: false, ...copy });
}
