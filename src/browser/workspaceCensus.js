import { validateWorkspaceCensus, validateWorkspaceRegistration } from "../native/workspaceCensus.js";
import { createImportedProjectId } from "../project/projectIds.js";
import { findRememberedFolder, folderAccessState, lastRememberedFolder, loadRememberedFolder, rememberFolder, requestRememberedFolder } from "./folderAccess.js";
import { createLaunchFolderHandle, describeLaunchFolder } from "./launchFolder.js";

const handles = new Map();
const encoder = new TextEncoder();
// Generated, dependency, cache and archive folders are skipped by default so a real repository scans quickly
// and the map is not polluted. Each skip is listed in the census as a skipped folder.
const ignoredDirectories = new Set([".git", ".next", ".turbo", ".cache", ".claude", ".ledger", ".local-preview-cache", ".perfect-planner", "_archive", "build", "coverage", "dist", "node_modules", "target", "target-codex"]);
let browserSelectionSequence = 0;

export const browserWorkspaceCensusDefaults = Object.freeze({
  batchSize: 32,
  maxFiles: 10_000,
  maxFileBytes: 2_000_000,
  maxTotalBytes: 256_000_000,
  maxDirectories: 10_000,
  maxEntries: 50_000,
  maxDepth: 64,
  maxPathLength: 4_096,
  maxDurationMs: 120_000,
  fileReadTimeoutMs: 15_000,
  progressThrottleMs: 150,
});

class CensusInterruption extends Error {
  constructor(reason, path = null, size = null) {
    super(reason);
    this.name = "CensusInterruption";
    this.reason = reason;
    this.path = path;
    this.size = size;
  }
}

function unavailable(reason) {
  return Object.freeze({ available: false, authoritative: false, reason, schemaVersion: 1 });
}

class FileReadTimeout extends Error {}

// A small .gitignore reader: plain names, folder names ("dist/"), anchored paths ("/public/generated/")
// and simple "*.ext" patterns. Negations and complex globs are ignored (those files are scanned).
async function readGitignore(handle, prefix, context) {
  let text = "";
  try {
    const file = await withTimeout(handle.getFile(), context.limits.fileReadTimeoutMs);
    if (file.size > 256_000) return [];
    text = new TextDecoder().decode(await withTimeout(file.arrayBuffer(), context.limits.fileReadTimeoutMs));
  } catch { return []; }
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const directoryOnly = line.endsWith("/");
    line = line.replace(/\/+$/, "");
    const anchored = line.startsWith("/") || line.includes("/");
    line = line.replace(/^\/+/, "");
    if (!line) continue;
    if (/^\*\.[^*?[\]/]+$/.test(line)) { rules.push({ base: prefix, extension: line.slice(1).toLowerCase(), directoryOnly: false }); continue; }
    if (/[*?[\]]/.test(line)) continue;
    rules.push({ base: prefix, pattern: line, anchored, directoryOnly });
  }
  return rules;
}

function isGitignored(rules, path, name, isDirectory) {
  for (const rule of rules) {
    if (rule.base && path !== rule.base && !path.startsWith(`${rule.base}/`)) continue;
    if (rule.directoryOnly && !isDirectory) continue;
    const relative = rule.base ? path.slice(rule.base.length + 1) : path;
    if (rule.extension) { if (!isDirectory && name.toLowerCase().endsWith(rule.extension)) return true; continue; }
    if (rule.anchored ? relative === rule.pattern : name === rule.pattern) return true;
  }
  return false;
}

// One stalled file (locked, on a sleeping network drive, or virtualised) must never hang the whole scan.
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new FileReadTimeout("read-timeout")), ms); })]).finally(() => clearTimeout(timer));
}

async function sha256(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

async function sameDirectoryHandle(left, right) {
  if (left === right) return true;
  if (typeof left?.isSameEntry !== "function") return false;
  try {
    return (await left.isSameEntry(right)) === true;
  } catch {
    return false;
  }
}

async function selectedPathForHandle(handle) {
  for (const [selectedPath, candidate] of handles) {
    if (!selectedPath.startsWith("browser://") || candidate?.handle) continue;
    if (await sameDirectoryHandle(candidate, handle)) return selectedPath;
  }
  // Same folder chosen after a reload: reuse its path so it stays the same project.
  const remembered = await findRememberedFolder(handle);
  if (remembered) return remembered.selectedPath;
  browserSelectionSequence += 1;
  const token = (await sha256(
    `${handle.name}\0${Date.now()}\0${browserSelectionSequence}`,
  )).slice(0, 24);
  return `browser://${encodeURIComponent(handle.name)}/${token}`;
}

function extensionOf(path) {
  const name = path.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

function categoryOf(path) {
  const normalized = path.toLowerCase();
  if (/(^|\/)(test|tests|__tests__|spec)(\/|$)|\.(test|spec)\.[^.]+$/.test(normalized)) return "test";
  if (/(^|\/)\.github\/workflows\//.test(normalized)) return "ci";
  if (/(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|cargo\.toml|requirements\.txt)$/.test(normalized)) return "manifest";
  if (/\.(md|mdx|txt|rst)$/.test(normalized)) return "document";
  if (/\.(json|ya?ml|toml|ini|env|config\.[cm]?[jt]s)$/.test(normalized)) return "configuration";
  if (/\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf)$/.test(normalized)) return "asset";
  return "source";
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPermissionError(error) {
  return error?.name === "NotAllowedError" || error?.name === "SecurityError";
}

function validateCeiling(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new CensusInterruption(`invalid-${label}`);
  return value;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new CensusInterruption("workspace-census-aborted");
}

function throwIfInterrupted(context) {
  throwIfAborted(context.signal);
  if (context.now() - context.startedAt > context.limits.maxDurationMs)
    throw new CensusInterruption("maximum-scan-duration-reached");
}

function createProgressReceipt(context, phase, { currentPath = null, reason = null, authoritative = false } = {}) {
  return Object.freeze({
    authoritative,
    batchSize: context.limits.batchSize,
    bytesHashed: context.totalBytesHashed,
    currentPath,
    directoriesVisited: context.directoriesVisited,
    filesDiscovered: context.filesDiscovered,
    filesHashed: context.files.length,
    maxFileBytes: context.limits.maxFileBytes,
    maxFiles: context.limits.maxFiles,
    maxTotalBytes: context.limits.maxTotalBytes,
    phase,
    reason,
    registryRevision: context.registryRevision,
    schemaVersion: 1,
    skippedCount: context.skipped.length,
    workspaceId: context.workspaceId,
  });
}

async function emitProgress(context, phase, options = {}) {
  if (typeof context.onProgress !== "function") return;
  try {
    await context.onProgress(createProgressReceipt(context, phase, options));
  } catch {
    // Progress is observational. A broken listener must not change census truth.
  }
}

async function defaultYieldControl() {
  if (typeof globalThis.scheduler?.yield === "function") {
    await globalThis.scheduler.yield();
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function checkpoint(context, currentPath) {
  throwIfInterrupted(context);
  context.workSinceYield += 1;
  if (context.workSinceYield < context.limits.batchSize) return;
  context.workSinceYield = 0;
  const now = context.now();
  if (
    context.lastScanningProgressAt == null ||
    now - context.lastScanningProgressAt >= context.limits.progressThrottleMs
  ) {
    context.lastScanningProgressAt = now;
    await emitProgress(context, "scanning", { currentPath });
  }
  throwIfInterrupted(context);
  await context.yieldControl();
  throwIfInterrupted(context);
}

function classifyReadFailure(error, path, fallback) {
  if (error instanceof CensusInterruption) return error;
  if (isPermissionError(error)) return new CensusInterruption("workspace-read-permission-lost", path);
  return new CensusInterruption(fallback, path);
}

async function sortedEntries(directory, prefix, context) {
  const entries = [];
  try {
    for await (const [name, handle] of directory.entries()) {
      throwIfInterrupted(context);
      const entryName = String(name);
      context.entriesVisited += 1;
      if (context.entriesVisited > context.limits.maxEntries)
        throw new CensusInterruption("maximum-entry-count-reached", prefix || ".");
      if (handle?.kind === "file") {
        context.filesDiscovered += 1;
        if (context.filesDiscovered > context.limits.maxFiles) {
          const path = prefix ? `${prefix}/${entryName}` : entryName;
          throw new CensusInterruption("maximum-file-count-reached", path);
        }
      }
      entries.push([entryName, handle]);
      await checkpoint(context, prefix || ".");
    }
  } catch (error) {
    throw classifyReadFailure(error, prefix || ".", "workspace-directory-unreadable");
  }
  entries.sort(([leftName, leftHandle], [rightName, rightHandle]) => (
    compareText(leftName, rightName) || compareText(String(leftHandle?.kind ?? ""), String(rightHandle?.kind ?? ""))
  ));
  context.directorySnapshots.push({
    directory,
    path: prefix || ".",
    signature: entries.map(([name, handle]) => `${name}\0${String(handle?.kind ?? "")}`).join("\n"),
  });
  return entries;
}

async function walkDirectory(directory, prefix, context, depth = 0) {
  throwIfInterrupted(context);
  if (depth > context.limits.maxDepth)
    throw new CensusInterruption("maximum-directory-depth-reached", prefix || ".");
  context.directoriesVisited += 1;
  if (context.directoriesVisited > context.limits.maxDirectories)
    throw new CensusInterruption("maximum-directory-count-reached", prefix || ".");
  const entries = await sortedEntries(directory, prefix, context);
  const gitignore = entries.find(([name, handle]) => name === ".gitignore" && handle?.kind === "file");
  if (gitignore) context.ignoreRules.push(...await readGitignore(gitignore[1], prefix, context));
  for (const [name, handle] of entries) {
    throwIfInterrupted(context);
    const path = prefix ? `${prefix}/${name}` : name;
    if (path.length > context.limits.maxPathLength)
      throw new CensusInterruption("maximum-path-length-reached", path);
    if (isGitignored(context.ignoreRules, path, name, handle?.kind === "directory")) {
      context.skipped.push({ path, reason: "ignored-by-gitignore", size: null });
      await checkpoint(context, path);
      continue;
    }
    if (handle?.kind === "directory") {
      if (ignoredDirectories.has(name.toLowerCase())) {
        context.skipped.push({ path, reason: "generated-or-dependency-directory-excluded", size: null });
        await checkpoint(context, path);
        continue;
      }
      try {
        await walkDirectory(handle, path, context, depth + 1);
      } catch (error) {
        // A sub-folder that cannot be listed is skipped and listed, like an unreadable file.
        if (!(error instanceof CensusInterruption) || error.reason !== "workspace-directory-unreadable") throw error;
        const inside = (candidate) => candidate === path || candidate.startsWith(`${path}/`);
        context.skipped.push({ path, reason: "folder-unreadable", size: null });
        context.directorySnapshots = context.directorySnapshots.filter((snapshot) => !inside(snapshot.path));
        context.fileSnapshots = context.fileSnapshots.filter((snapshot) => !inside(snapshot.path));
        context.files = context.files.filter((entry) => !inside(entry.path));
        context.totalBytesHashed = context.files.reduce((sum, entry) => sum + entry.size, 0);
        await checkpoint(context, path);
      }
      continue;
    }
    if (handle?.kind !== "file") throw new CensusInterruption("workspace-entry-kind-unsupported", path);

    // An unreadable, locked or stalled file is skipped and listed; only a lost folder permission stops the scan.
    const skipUnreadable = async (error) => {
      if (isPermissionError(error) && !(error instanceof FileReadTimeout)) throw classifyReadFailure(error, path, "workspace-file-unreadable");
      context.skipped.push({ path, reason: error instanceof FileReadTimeout ? "file-read-timed-out" : "file-unreadable", size: null });
      await checkpoint(context, path);
    };
    let file;
    try {
      file = await withTimeout(handle.getFile(), context.limits.fileReadTimeoutMs);
    } catch (error) {
      if (error instanceof CensusInterruption) throw error;
      await skipUnreadable(error);
      continue;
    }
    throwIfInterrupted(context);
    if (!Number.isSafeInteger(file?.size) || file.size < 0) throw new CensusInterruption("workspace-file-metadata-invalid", path);
    if (file.size > context.limits.maxFileBytes) {
      context.skipped.push({ path, reason: "file-too-large", size: file.size });
      await checkpoint(context, path);
      continue;
    }
    // Past the content budget, remaining files are listed as skipped rather than failing the whole scan.
    if (context.totalBytesHashed + file.size > context.limits.maxTotalBytes) {
      context.skipped.push({ path, reason: "scan-size-budget-reached", size: file.size });
      await checkpoint(context, path);
      continue;
    }

    let bytes;
    try {
      bytes = await withTimeout(file.arrayBuffer(), context.limits.fileReadTimeoutMs);
    } catch (error) {
      if (error instanceof CensusInterruption) throw error;
      await skipUnreadable(error);
      continue;
    }
    throwIfInterrupted(context);
    let digest;
    try {
      digest = await sha256(bytes);
    } catch (error) {
      if (error instanceof CensusInterruption) throw error;
      await skipUnreadable(error);
      continue;
    }
    throwIfInterrupted(context);
    context.files.push({
      path,
      extension: extensionOf(path),
      category: categoryOf(path),
      size: file.size,
      modifiedEpochMs: file.lastModified || null,
      sha256: digest,
    });
    context.fileSnapshots.push({
      handle,
      path,
      size: file.size,
      lastModified: file.lastModified ?? null,
    });
    context.totalBytesHashed += file.size;
    await checkpoint(context, path);
  }
}

async function verifyWorkspaceStable(context) {
  await emitProgress(context, "verifying");
  for (const snapshot of context.directorySnapshots) {
    throwIfInterrupted(context);
    const entries = [];
    try {
      for await (const [name, handle] of snapshot.directory.entries()) {
        throwIfInterrupted(context);
        entries.push([String(name), String(handle?.kind ?? "")]);
        await checkpoint(context, snapshot.path);
      }
    } catch (error) {
      throw classifyReadFailure(error, snapshot.path, "workspace-directory-unreadable");
    }
    entries.sort(([leftName, leftKind], [rightName, rightKind]) => (
      compareText(leftName, rightName) || compareText(leftKind, rightKind)
    ));
    const signature = entries.map(([name, kind]) => `${name}\0${kind}`).join("\n");
    if (signature !== snapshot.signature) {
      throw new CensusInterruption("workspace-changed-during-census", snapshot.path);
    }
  }
  for (const snapshot of context.fileSnapshots) {
    throwIfInterrupted(context);
    let current;
    try {
      current = await snapshot.handle.getFile();
    } catch (error) {
      throw classifyReadFailure(error, snapshot.path, "workspace-file-unreadable");
    }
    if (
      current?.size !== snapshot.size ||
      (current?.lastModified ?? null) !== snapshot.lastModified
    ) {
      throw new CensusInterruption("workspace-changed-during-census", snapshot.path);
    }
    await checkpoint(context, snapshot.path);
  }
}

function summarize(files) {
  return files.reduce((summary, file) => {
    summary[file.category] = (summary[file.category] ?? 0) + 1;
    return summary;
  }, {});
}

async function confirmReadPermission(handle) {
  if (typeof handle.queryPermission !== "function") return;
  let permission;
  try {
    permission = await handle.queryPermission({ mode: "read" });
  } catch (error) {
    throw classifyReadFailure(error, ".", "workspace-read-permission-check-failed");
  }
  if (permission !== "granted") throw new CensusInterruption("workspace-read-permission-lost", ".");
}

export function isBrowserWorkspacePickerAvailable(runtime = globalThis) {
  return Boolean(runtime?.crypto?.subtle && typeof runtime?.showDirectoryPicker === "function");
}

async function selectDirectoryHandle(handle) {
  if (handle?.kind !== "directory" || typeof handle.name !== "string" || !handle.name || typeof handle.entries !== "function")
    return unavailable("browser-directory-handle-required");
  const selectedPath = await selectedPathForHandle(handle);
  handles.set(selectedPath, handle);
  return Object.freeze({ available: true, authoritative: true, schemaVersion: 1, commandRevision: 1, capabilities: Object.freeze(["workspace-folder-picker:select"]), selectionState: "selected", selectedPath });
}

export const browserWorkspaceAdapter = Object.freeze({
  mode: "browser",
  // The UI captures getAsFileSystemHandle synchronously during the drop event.
  // Selection only retains an opaque handle; no enumeration or read permission
  // request occurs here. Separate explicit analysis approval remains required.
  async selectDroppedWorkspaceFolder(handle) {
    try { return await selectDirectoryHandle(handle); }
    catch { return unavailable("browser-folder-drop-selection-failed"); }
  },
  async selectWorkspaceFolder({ runtime = globalThis } = {}) {
    if (!isBrowserWorkspacePickerAvailable(runtime)) return unavailable("browser-folder-picker-unavailable");
    try {
      const handle = await runtime.showDirectoryPicker({ mode: "read" });
      return await selectDirectoryHandle(handle);
    } catch (error) {
      if (error?.name === "SecurityError" || error?.name === "NotAllowedError") return unavailable("browser-folder-picker-needs-click");
      if (error?.name === "AbortError") return Object.freeze({ available: true, authoritative: true, schemaVersion: 1, commandRevision: 1, capabilities: Object.freeze(["workspace-folder-picker:select"]), selectionState: "cancelled", selectedPath: null });
      return unavailable(error instanceof Error ? error.message : "browser-folder-picker-failed");
    }
  },
  async registerWorkspaceReadOnly({ workspaceId, rootPath, explicitUserApproval }) {
    const handle = handles.get(rootPath);
    if (!handle) return unavailable("Choose the folder with the secure browser picker first.");
    if (explicitUserApproval !== true) return unavailable("Read-only analysis requires a separate approval.");
    let permission;
    try {
      permission = typeof handle.requestPermission === "function" ? await handle.requestPermission({ mode: "read" }) : "granted";
    } catch (error) {
      return unavailable(isPermissionError(error) ? "Folder read permission was not granted." : "Folder read permission could not be checked.");
    }
    if (permission !== "granted") return unavailable("Folder read permission was not granted.");
    const rootIdentity = await sha256(`${rootPath}:${handle.name}`);
    const registration = validateWorkspaceRegistration({ schemaVersion: 1, workspaceId, registryRevision: 1, canonicalRoot: rootPath, rootIdentity, access: "metadata-read-only", idempotent: false, capabilities: ["workspace-census:read"] });
    handles.set(`${workspaceId}:1`, { handle, registration });
    await rememberFolder({ projectId: createImportedProjectId(registration.rootIdentity), selectedPath: rootPath, handle });
    return registration;
  },
  // The folder npm start was launched for, when the local host offers one.
  async launchFolder() {
    return describeLaunchFolder();
  },
  async selectLaunchFolder() {
    const launch = await describeLaunchFolder();
    if (!launch) return unavailable("The local host is not offering a launch folder.");
    try { return await selectDirectoryHandle(createLaunchFolderHandle({ name: launch.name })); }
    catch { return unavailable("The launch folder could not be selected."); }
  },
  async lastFolder() {
    return lastRememberedFolder();
  },
  // Reload recovery: what is remembered for a project, without asking for access.
  async rememberedFolder(projectId) {
    await loadRememberedFolder(projectId);
    return folderAccessState(projectId);
  },
  // Must be called from a click. Asks the browser for read access to the
  // remembered folder, then makes it selectable again under its original path.
  async reconnectRememberedFolder(projectId) {
    const result = await requestRememberedFolder(projectId);
    if (result.state !== "granted") {
      const reasons = { missing: "This folder is not remembered in this browser. Choose it again.", "missing-folder": "The remembered folder could not be found. It may have been moved or deleted. Choose it again.", denied: "Folder access was not allowed. Nothing was read.", failed: "Folder access could not be requested. Choose the folder again." };
      return unavailable(reasons[result.state] ?? reasons.failed);
    }
    handles.set(result.record.selectedPath, result.record.handle);
    return Object.freeze({ available: true, authoritative: true, schemaVersion: 1, commandRevision: 1, capabilities: Object.freeze(["workspace-folder-picker:select"]), selectionState: "selected", selectedPath: result.record.selectedPath, reconnected: true });
  },
  async censusRegisteredWorkspace({
    workspaceId,
    registryRevision,
    maxFiles = browserWorkspaceCensusDefaults.maxFiles,
    maxFileBytes = browserWorkspaceCensusDefaults.maxFileBytes,
    maxTotalBytes = browserWorkspaceCensusDefaults.maxTotalBytes,
    maxDirectories = browserWorkspaceCensusDefaults.maxDirectories,
    maxEntries = browserWorkspaceCensusDefaults.maxEntries,
    maxDepth = browserWorkspaceCensusDefaults.maxDepth,
    maxPathLength = browserWorkspaceCensusDefaults.maxPathLength,
    maxDurationMs = browserWorkspaceCensusDefaults.maxDurationMs,
    fileReadTimeoutMs = browserWorkspaceCensusDefaults.fileReadTimeoutMs,
    batchSize = browserWorkspaceCensusDefaults.batchSize,
    progressThrottleMs = browserWorkspaceCensusDefaults.progressThrottleMs,
    signal,
    onProgress,
    now = () => Date.now(),
    yieldControl = defaultYieldControl,
  }) {
    const session = handles.get(`${workspaceId}:${registryRevision}`);
    if (!session) return unavailable("Browser folder approval has expired. Choose the folder again.");
    const context = {
      workspaceId,
      registryRevision,
      signal,
      onProgress,
      now: typeof now === "function" ? now : () => Date.now(),
      yieldControl: typeof yieldControl === "function" ? yieldControl : defaultYieldControl,
      limits: {
        batchSize,
        maxFiles,
        maxFileBytes,
        maxTotalBytes,
        maxDirectories,
        maxEntries,
        maxDepth,
        maxPathLength,
        maxDurationMs,
        fileReadTimeoutMs,
        progressThrottleMs,
      },
      files: [],
      fileSnapshots: [],
      skipped: [],
      ignoreRules: [],
      directorySnapshots: [],
      directoriesVisited: 0,
      entriesVisited: 0,
      filesDiscovered: 0,
      totalBytesHashed: 0,
      workSinceYield: 0,
      lastScanningProgressAt: null,
      startedAt: (typeof now === "function" ? now : () => Date.now())(),
    };
    try {
      validateCeiling(maxFiles, "max-files");
      validateCeiling(maxFileBytes, "max-file-bytes");
      validateCeiling(maxTotalBytes, "max-total-bytes");
      validateCeiling(maxDirectories, "max-directories", 1);
      validateCeiling(maxEntries, "max-entries", 1);
      validateCeiling(maxDepth, "max-depth");
      validateCeiling(maxPathLength, "max-path-length", 1);
      validateCeiling(maxDurationMs, "max-duration-ms", 1);
      validateCeiling(batchSize, "batch-size", 1);
      validateCeiling(progressThrottleMs, "progress-throttle-ms");
      throwIfInterrupted(context);
      await confirmReadPermission(session.handle);
      await emitProgress(context, "started");
      throwIfInterrupted(context);
      await walkDirectory(session.handle, "", context);
      throwIfInterrupted(context);
      await verifyWorkspaceStable(context);
      throwIfInterrupted(context);
      context.files.sort((left, right) => compareText(left.path, right.path));
      context.skipped.sort((left, right) => compareText(left.path, right.path) || compareText(left.reason, right.reason));
      const digest = await sha256(context.files.map((file) => `${file.path}\0${file.size}\0${file.sha256}`).join("\n"));
      throwIfInterrupted(context);
      const census = validateWorkspaceCensus({
        schemaVersion: 1,
        workspaceId,
        registryRevision,
        rootIdentity: session.registration.rootIdentity,
        digest,
        contentReturned: false,
        fileCount: context.files.length,
        totalBytesHashed: context.totalBytesHashed,
        generatedEpochMs: Date.now(),
        files: context.files,
        skipped: context.skipped,
        summary: summarize(context.files),
        capabilities: ["workspace-census:read"],
      });
      await emitProgress(context, "complete", { authoritative: true });
      return census;
    } catch (error) {
      const reason = error instanceof CensusInterruption ? error.reason : "workspace-census-failed";
      await emitProgress(context, reason === "workspace-census-aborted" ? "cancelled" : "failed", {
        currentPath: error instanceof CensusInterruption ? error.path : null,
        reason,
      });
      return unavailable(reason);
    }
  },
});
