import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRightIcon,
  CaretDownIcon,
  CheckCircleIcon,
  FolderIcon,
  PlusIcon,
  ShieldCheckIcon,
  TrashIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { currentFolderContractInput } from "../engine/folderContractSeed.js";
import {
  analyzeWorkspaceStructure,
  assessFolderContract,
  folderDraftStructureDigest,
  folderPlanHeadline,
  prepareFolderOrganizationReview,
} from "../engine/folderContractEngine.js";
import {
  assessWorkspaceIntake,
  redactWorkspaceIntakeSummary,
  workspaceIntakeStages,
  workspaceIntakeStageState,
} from "../engine/workspaceIntakeEngine.js";
import {
  buildWorkspaceDiscovery,
  buildWorkspaceStructureTree,
} from "../engine/workspaceDiscoveryEngine.js";
import { DEMO_ONLY_REASON, DemoOnlyReason } from "../demo/DemoSampleNotice.jsx";
import { createStableProjectId } from "../project/projectIds.js";
import { projectLabelFromRoot, projectRegistrationLabelFromRoot } from "../project/projectLabel.js";
import { boundedFetch } from "../runtime/boundedFetch.js";
import { defaultWorkspaceAdapter } from "../runtime/workspaceAdapter.js";
import { inspectArchitecture } from "../runtime/architectureClient.js";
import { useOptionalProject } from "../project/ProjectProvider.jsx";
import "./StructureWorkspace.css";
import { FolderReconnectNotice } from "./FolderReconnectNotice.jsx";
import { describeFolderConnection } from "../project/folderReconnectModel.js";
import { DiscoveryReviewPanel } from "./DiscoveryReviewPanel.jsx";
import { folderPlanGuidance } from '../engine/folderPlanGuidance.js';

// Home's button bumps this token; remembering the last one used stops a remount from reopening the picker.
let consumedAutoStartToken = 0;
const LAST_NATIVE_FOLDER_KEY = "perfect-planner:last-folder:v1";
// Off by default: a chosen folder waits for "Approve read-only scan". Set to "1" to start scans on pick.
export const SKIP_SCAN_APPROVAL_KEY = "perfect-planner:skip-scan-approval:v1";
function readSkipScanApproval() {
  try { return localStorage.getItem(SKIP_SCAN_APPROVAL_KEY) === "1"; } catch { return false; }
}
const readyMessage = (mode) =>
  mode === "browser"
    ? "Choose your app folder, then approve the read-only scan."
    : "Choose your app folder, or type its full path, then approve the read-only scan.";

// The desktop app remembers the last scanned path; the browser keeps folder handles in IndexedDB instead.
function readLastNativeFolder() {
  try {
    const value = JSON.parse(localStorage.getItem(LAST_NATIVE_FOLDER_KEY) ?? "null");
    return typeof value?.path === "string" && /^(?:[a-zA-Z]:[\\/]|\/)/.test(value.path) ? { path: value.path, name: String(value.name || value.path) } : null;
  } catch { return null; }
}

function scanFraction(progress) {
  if (!progress?.filesDiscovered) return null;
  return Math.min(0.99, progress.filesHashed / progress.filesDiscovered);
}

// Plain-language text for scan stops. Unreadable files and folders no longer stop a scan (they are skipped and listed),
// so what remains here are whole-folder problems the person can act on.
const censusFailureMessages = Object.freeze({
  "workspace-read-permission-lost": "The browser no longer has permission to read this folder. Choose the folder again to continue.",
  "workspace-read-permission-check-failed": "The browser could not confirm folder access. Choose the folder again to continue.",
  "workspace-directory-unreadable": "The top folder could not be listed. Check it still exists, then choose it again.",
  "workspace-changed-during-census": "Files changed while the scan was running, so the result was not saved. Run the scan again.",
  "maximum-file-count-reached": "This folder has more than 10,000 files. Choose the app folder itself rather than a parent folder.",
  "maximum-entry-count-reached": "This folder has too many entries to scan. Choose the app folder itself rather than a parent folder.",
  "maximum-directory-count-reached": "This folder has too many sub-folders to scan. Choose the app folder itself rather than a parent folder.",
  "maximum-directory-depth-reached": "Folders are nested too deeply to scan. Choose the app folder itself.",
  "maximum-path-length-reached": "A file path is too long to scan. Choose the app folder itself.",
  "maximum-total-bytes-reached": "There is too much file content to scan in one go. Choose the app folder itself rather than a parent folder.",
  "maximum-scan-duration-reached": "The scan took too long and was stopped. Choose the app folder itself rather than a parent folder.",
});
function censusFailureText(reason, path) {
  const text = censusFailureMessages[reason] ?? (reason ? `The folder scan stopped (${reason}). Try again.` : "The folder scan stopped without a result. Try again.");
  return path && path !== "." ? `${text} Last item: ${path}.` : text;
}

const cloneSeed = () => structuredClone(currentFolderContractInput);
// Only the Demo starts from the sample folders. A real project, and the page
// before any project is chosen, start from an empty plan.
const startingDraft = (demo, planId) => (demo ? cloneSeed() : { ...cloneSeed(), planId, nodes: [] });
const waves = ["approval", "architecture", "build", "proof", "release"];
const policies = ["owner-only", "collision-review", "immutable-after-approval"];
const MAX_RENDERED_FOLDER_NODES = 1_200;
function projectTreeForRendering(root, limit) {
  const result = [];
  const stack = [{ node: root, childIndex: 0, entered: false }];
  while (stack.length && result.length < limit) {
    const frame = stack.at(-1);
    if (!frame.entered) {
      frame.entered = true;
      result.push(frame.node);
      continue;
    }
    if (frame.childIndex >= frame.node.children.length) {
      stack.pop();
      continue;
    }
    const child = frame.node.children[frame.childIndex];
    frame.childIndex += 1;
    stack.push({ node: child, childIndex: 0, entered: false });
  }
  return result;
}

function DiscoveryTreeNode({ node, revealIndex, revealCount }) {
  const initialFileCount =
    node.kind === "root" ? Math.min(node.files.length, 12) : 0;
  const [visibleFileCount, setVisibleFileCount] = useState(initialFileCount);
  const visibleFiles = node.files.slice(0, visibleFileCount);
  const hiddenFileCount = node.files.length - visibleFiles.length;
  const nodeLabel = node.path || node.name;
  if (revealIndex.get(node.id) >= revealCount) return null;
  const hasContents = node.children.length > 0 || node.files.length > 0;
  return (
    <li className={`workspace-tree-node ${node.kind}`}>
      <details open={node.depth < 3 || node.kind === "root"}>
        <summary>
          <span className="tree-node-card">
            <FolderIcon weight={node.kind === "root" ? "fill" : "regular"} />
            <span>
              <code>{node.id}</code>
              <strong>{node.name}</strong>
              <small>
                {node.kind === "root"
                  ? `${node.children.length} root folders · ${node.files.length} root files`
                  : node.path}
              </small>
            </span>
            <em>
              {node.children.length} folders · {node.files.length} files
            </em>
          </span>
        </summary>
        {node.files.length > 0 && (
          <div className="workspace-tree-file-section">
            {visibleFiles.length > 0 && (
              <div
                className="workspace-tree-files"
                role="list"
                aria-label={`Files in ${nodeLabel}`}
              >
                {visibleFiles.map((file) => (
                  <span role="listitem" key={file.path} title={file.path}>
                    <b>{file.name}</b>
                    <small>{file.category}</small>
                  </span>
                ))}
              </div>
            )}
            <div className="workspace-tree-file-actions">
              {hiddenFileCount > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    setVisibleFileCount((count) =>
                      Math.min(
                        node.files.length,
                        Math.max(count, 0) + (count ? 48 : 24),
                      ),
                    )
                  }
                  aria-label={`Show ${Math.min(hiddenFileCount, visibleFileCount ? 48 : 24)} more files in ${nodeLabel}`}
                >
                  Show {Math.min(hiddenFileCount, visibleFileCount ? 48 : 24)}{" "}
                  more · {hiddenFileCount} hidden
                </button>
              )}
              {visibleFileCount > 0 && (
                <button
                  type="button"
                  onClick={() => setVisibleFileCount(0)}
                  aria-label={`Hide files in ${nodeLabel}`}
                >
                  Hide files
                </button>
              )}
            </div>
          </div>
        )}
        {node.children.length > 0 && (
          <ol className="workspace-tree-children">
            {node.children
              .filter((child) => revealIndex.get(child.id) < revealCount)
              .map((child) => (
              <DiscoveryTreeNode
                key={child.id}
                node={child}
                revealIndex={revealIndex}
                revealCount={revealCount}
              />
              ))}
          </ol>
        )}
        {!hasContents && (
          <small className="empty-folder">Empty folder observed</small>
        )}
      </details>
    </li>
  );
}

export function StructureWorkspace({
  activeProject,
  onOpenBlueprint,
  onToast,
  onIntakeSummary,
  onProjectCaptured,
  onProjectUnavailable,
  onDiagnostic,
  autoStartIntakeToken = 0,
  skipScanApproval,
  workspaceAdapter = defaultWorkspaceAdapter,
}) {
  const projectContext = useOptionalProject();
  const imported = activeProject && activeProject.kind !== "demo";
  const demo = activeProject?.kind === "demo";
  const planId = imported ? activeProject.projectId : currentFolderContractInput.planId;
  const [draft, setDraft] = useState(() => startingDraft(demo, planId));
  const [confirmReset, setConfirmReset] = useState(false);
  const [architecture, setArchitecture] = useState({ head: null, error: null });
  const [draftStorageError, setDraftStorageError] = useState("");
  const [loadedDraftPlan, setLoadedDraftPlan] = useState(null);
  const [selectedId, setSelectedId] = useState(demo ? "F001" : undefined);
  const [openSections, setOpenSections] = useState({
    intake: true,
    dependencies: true,
    paths: false,
    editor: false,
    validation: false,
  });
  const [registry, setRegistry] = useState({
    available: false,
    revision: 0,
    head: null,
    actor: null,
    error: "Connecting durable registry…",
  });
  const [publishing, setPublishing] = useState(false);
  const currentPlanRef = useRef(planId);
  currentPlanRef.current = planId;
  const [rootPath, setRootPath] = useState("");
  const [folderPreview, setFolderPreview] = useState(null);
  // Cleared when a new selection or scan starts (not on rootPath changes, which race a fast preview).
  useEffect(() => { setFolderPreview(null); }, [activeProject?.projectId]);
  const [intake, setIntake] = useState({
    state: "idle",
    registration: null,
    census: null,
    gaps: null,
    message: readyMessage(workspaceAdapter.mode),
  });
  const scanStartsOnPick = skipScanApproval ?? readSkipScanApproval();
  const tokenRef = useRef(null);
  const discoveryPanelRef = useRef(null);
  const scanAbortRef = useRef(null);
  const scanRunRef = useRef(0);
  const selectionRunRef = useRef(0);
  const [scanProgress, setScanProgress] = useState(null);
  const [folderAccess, setFolderAccess] = useState({ projectId: null, access: null, busy: false, error: "" });
  const canRemember = imported && activeProject.registration?.adapter === "browser" && typeof workspaceAdapter.rememberedFolder === "function";
  useEffect(() => {
    if (!canRemember) return undefined;
    let current = true;
    const projectId = activeProject.projectId;
    setFolderAccess({ projectId, access: null, busy: false, error: "" });
    Promise.resolve(workspaceAdapter.rememberedFolder(projectId)).then((access) => {
      if (current) setFolderAccess((state) => state.projectId === projectId ? { ...state, access } : state);
    }).catch(() => {});
    return () => { current = false; };
  }, [canRemember, activeProject?.projectId, workspaceAdapter]);
  // One-click starts: the last folder used here, and the folder npm start was launched for.
  const [lastFolder, setLastFolder] = useState(null);
  const [launchFolder, setLaunchFolder] = useState(null);
  const refreshLastFolder = () => {
    if (workspaceAdapter.mode !== "browser") { setLastFolder(readLastNativeFolder()); return; }
    if (typeof workspaceAdapter.lastFolder !== "function") return;
    Promise.resolve(workspaceAdapter.lastFolder()).then((value) => setLastFolder(value ?? null)).catch(() => {});
  };
  useEffect(() => {
    let current = true;
    refreshLastFolder();
    if (typeof workspaceAdapter.launchFolder === "function")
      Promise.resolve(workspaceAdapter.launchFolder()).then((value) => { if (current) setLaunchFolder(value ?? null); }).catch(() => {});
    return () => { current = false; };
  }, [workspaceAdapter]);
  const assessment = useMemo(() => assessFolderContract(draft), [draft]);
  const headline = folderPlanHeadline(assessment, { imported });
  const [draftFingerprint, setDraftFingerprint] = useState(null);
  useEffect(() => {
    let current = true;
    folderDraftStructureDigest(draft).then((digest) => {
      if (current) setDraftFingerprint({ draft, digest });
    }).catch(() => { if (current) setDraftFingerprint(null); });
    return () => { current = false; };
  }, [draft]);
  const matchesSavedRevision = registry.available && !registry.error && draftFingerprint?.draft === draft &&
    !!draftFingerprint.digest && draftFingerprint.digest === registry.head?.structureDigest;
  const selected =
    draft.nodes.find((node) => node.id === selectedId) ?? draft.nodes[0];
  const children = selected
    ? draft.nodes.filter((node) => node.path.startsWith(`${selected.path}/`))
    : [];
  const projectLabel = projectLabelFromRoot(rootPath);
  const workspaceId = useMemo(
    () =>
      rootPath
        ? createStableProjectId(projectRegistrationLabelFromRoot(rootPath), rootPath)
        : "pending_workspace",
    [projectLabel, rootPath],
  );
  const discoveryMap = useMemo(
    () =>
      buildWorkspaceDiscovery(intake.census, {
        appName: projectLabel || "Dropped app",
      }),
    [intake.census, projectLabel],
  );
  const structureTree = useMemo(
    () =>
      buildWorkspaceStructureTree(intake.census ?? folderPreview, {
        appName: projectLabel || "Dropped app",
      }),
    [intake.census, folderPreview, projectLabel],
  );
  const renderedTreeNodes = useMemo(
    () => projectTreeForRendering(structureTree.root, MAX_RENDERED_FOLDER_NODES),
    [structureTree],
  );
  const revealIndex = useMemo(
    () => new Map(renderedTreeNodes.map((node, index) => [node.id, index])),
    [renderedTreeNodes],
  );
  const renderNodeLimit = renderedTreeNodes.length;
  const totalTreeNodeCount = structureTree.nodeCount ?? renderedTreeNodes.length;
  const [revealCount, setRevealCount] = useState(0);
  const [insightsVisible, setInsightsVisible] = useState(false);
  const [mapPaused, setMapPaused] = useState(false);
  const mapRunKey = (intake.census ?? folderPreview)
    ? `${intake.census?.digest ?? folderPreview?.generatedEpochMs ?? intake.census?.fileCount}:${rootPath}`
    : "";
  const mapLoading = ["registering", "scanning", "analyzing"].includes(
    intake.state,
  );
  const comparison = useMemo(
    () => {
      if (!intake.gaps) return { review: null, stale: false };
      try {
        if (draft.planId !== planId || intake.gaps.planId !== planId) throw new Error("Project changed");
        return { review: prepareFolderOrganizationReview(intake.gaps, draft), stale: false };
      } catch {
        return { review: null, stale: true };
      }
    },
    [intake.gaps, draft, planId],
  );
  const organizationReview = comparison.review;
  const toggleSection = (section) =>
    setOpenSections((current) => ({
      ...current,
      [section]: !current[section],
    }));

  useEffect(() => {
    let current = true;
    setArchitecture({ head: null, error: null });
    setLoadedDraftPlan(null);
    setDraftStorageError("");
    let nextDraft = startingDraft(demo, planId);
    setConfirmReset(false);
    setSelectedId(demo ? "F001" : undefined);
    if (imported) {
      try {
        const raw = localStorage.getItem(`perfect-planner:folder-draft:v1:${planId}`);
        if (raw) {
          if (raw.length > 200000) throw Error();
          const saved = JSON.parse(raw);
          if (saved.planId !== planId || saved.schemaVersion !== 1 || !["private", "hybrid", "git"].includes(saved.workspaceMode) || !Array.isArray(saved.nodes) || saved.nodes.some((node) =>
            !node || ["id", "kind", "path", "purpose", "owner", "taskId", "createAtStage", "allowedContents", "changePolicy", "renameFallback"].some((field) => typeof node[field] !== "string") || !Array.isArray(node.dependsOn) || node.dependsOn.some((id) => typeof id !== "string"))) throw Error();
          nextDraft = { schemaVersion: 1, planId, workspaceMode: saved.workspaceMode, nodes: saved.nodes };
        }
      } catch { setDraftStorageError("Saved folder draft could not be loaded. Original data is preserved; edits will remain in memory."); }
    }
    setDraft(nextDraft);
    setLoadedDraftPlan(planId);
    if (imported && intake.registration?.rootIdentity !== activeProject.registration?.rootIdentity) {
      selectionRunRef.current += 1;
      scanRunRef.current += 1;
      scanAbortRef.current?.abort();
      setRootPath("");
      setScanProgress(null);
      setIntake({ state: "idle", registration: null, census: null, gaps: null, message: "Reselect this project's folder to refresh its read-only map. Saved architecture remains separate." });
    }
    if (imported) {
      inspectArchitecture(planId).then((state) => {
        if (!current) return;
        setArchitecture(state);
        setDraft((value) => ({ ...value, architectureContractDigest: state.head?.contractDigest ?? null, architectureRevision: state.head?.revision ?? null }));
      }).catch((error) => { if (current) setArchitecture({ head: null, error: error.message }); });
    }
    return () => { current = false; };
  }, [planId, demo]);

  useEffect(() => {
    if (!imported || loadedDraftPlan !== planId || draft.planId !== planId || draftStorageError) return;
    try {
      const value = JSON.stringify({ schemaVersion: 1, planId, workspaceMode: draft.workspaceMode, nodes: draft.nodes });
      if (value.length > 200000) throw Error();
      localStorage.setItem(`perfect-planner:folder-draft:v1:${planId}`, value);
    } catch { setDraftStorageError("Folder draft could not be saved. Keep this page open; edits are only in memory."); }
  }, [draft, imported, loadedDraftPlan, planId, draftStorageError]);

  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    tokenRef.current = null;
    setPublishing(false);
    setRegistry({ available: false, revision: 0, head: null, actor: null, error: "Connecting this project's registry…" });
    (async () => {
      try {
        const session = await boundedFetch("/api/folder-contract/session", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: "{}",
        }, { signal: controller.signal });
        if (!session.ok) throw new Error(`registry session ${session.status}`);
        const identity = await session.json();
        if (!current) return;
        tokenRef.current = identity.token;
        const response = await boundedFetch("/api/folder-contract/inspect", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            "x-pp-folder-token": identity.token,
          },
          body: JSON.stringify({ planId }),
        }, { signal: controller.signal });
        if (!response.ok) throw new Error((await response.json()).error);
        const state = await response.json();
        if (current)
          setRegistry({
            available: true,
            actor: identity.actor,
            error: null,
            ...state,
          });
      } catch (error) {
        if (current)
          setRegistry({
            available: false,
            revision: 0,
            head: null,
            actor: null,
            error: error.message,
          });
      }
    })();
    return () => {
      current = false;
      controller.abort();
    };
  }, [planId]);

  useEffect(
    () => () => {
      selectionRunRef.current += 1;
      scanRunRef.current += 1;
      scanAbortRef.current?.abort();
    },
    [workspaceAdapter],
  );

  useEffect(() => {
    if (["empty", "invalid"].includes(structureTree.state)) {
      setRevealCount(0);
      setInsightsVisible(false);
      setMapPaused(false);
      return undefined;
    }
    const reduceMotion = globalThis.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    )?.matches;
    if (reduceMotion) {
      setRevealCount(renderNodeLimit);
      setInsightsVisible(true);
      setMapPaused(false);
      return undefined;
    }
    setRevealCount(1);
    setInsightsVisible(false);
    setMapPaused(false);
    return undefined;
  }, [mapRunKey, renderNodeLimit, structureTree.state]);

  useEffect(() => {
    if (
      ["empty", "invalid"].includes(structureTree.state) ||
      mapPaused ||
      revealCount >= renderNodeLimit
    )
      return undefined;
    const batchSize = Math.max(
      1,
      Math.ceil(Math.max(renderNodeLimit - 1, 1) / 72),
    );
    const cadence =
      totalTreeNodeCount > 500
        ? 42
        : Math.max(
            45,
            Math.min(110, Math.round(3200 / Math.max(totalTreeNodeCount, 1))),
          );
    const delay = revealCount <= 1 ? 220 : cadence;
    const timer = globalThis.setTimeout(() => {
      setRevealCount((count) => Math.min(renderNodeLimit, count + batchSize));
    }, delay);
    return () => globalThis.clearTimeout(timer);
  }, [mapPaused, renderNodeLimit, revealCount, structureTree.state, totalTreeNodeCount]);

  useEffect(() => {
    if (
      ["empty", "invalid"].includes(structureTree.state) ||
      revealCount < renderNodeLimit
    )
      return undefined;
    const timer = globalThis.setTimeout(() => setInsightsVisible(true), 260);
    return () => globalThis.clearTimeout(timer);
  }, [renderNodeLimit, revealCount, structureTree.state]);

  const cancelAnalysis = () => {
    scanRunRef.current += 1;
    scanAbortRef.current?.abort();
    scanAbortRef.current = null;
    setScanProgress(null);
    setIntake((current) => ({
      ...current,
      state: "idle",
      registration: null,
      census: null,
      gaps: null,
      message: "Analysis cancelled. No partial result was accepted.",
    }));
    onDiagnostic?.(
      "workspace",
      "info",
      "Read-only folder analysis cancelled; partial results discarded.",
    );
  };
  const resetRefusedAnalysis = () => {
    selectionRunRef.current += 1;
    scanRunRef.current += 1;
    scanAbortRef.current?.abort();
    scanAbortRef.current = null;
    setScanProgress(null);
    setRootPath("");
    setIntake({
      state: "idle",
      registration: null,
      census: null,
      gaps: null,
      message: readyMessage(workspaceAdapter.mode),
    });
    onDiagnostic?.(
      "workspace",
      "info",
      "Refused analysis cleared; no prior folder scan or findings were kept.",
    );
  };
  const connectFolder = async (pathOverride) => {
    const path = typeof pathOverride === "string" ? pathOverride : rootPath;
    const runWorkspaceId = path.trim() ? createStableProjectId(projectRegistrationLabelFromRoot(path), path) : "pending_workspace";
    const runLabel = projectLabelFromRoot(path);
    if (scanAbortRef.current && !scanAbortRef.current.signal.aborted) return;
    if (!path.trim()) {
      const message = "Choose one app folder first.";
      setIntake((current) => ({ ...current, state: "error", message }));
      onDiagnostic?.("workspace", "warning", message);
      return;
    }
    scanAbortRef.current?.abort();
    const controller = new AbortController();
    scanAbortRef.current = controller;
    const runId = ++scanRunRef.current;
    const isCurrentRun = () =>
      scanRunRef.current === runId && !controller.signal.aborted;
    setScanProgress(null);
    setFolderPreview(null);
    setIntake({
      state: "registering",
      registration: null,
      census: null,
      gaps: null,
      message: "Opening the folder read only…",
    });
    try {
      const registration = await workspaceAdapter.registerWorkspaceReadOnly({
        workspaceId: runWorkspaceId,
        rootPath: path.trim(),
        explicitUserApproval: true,
      });
      if (!isCurrentRun()) return;
      if (!registration?.authoritative) {
        const message =
          registration?.reason === "native-runtime-unavailable"
            ? "Open the native desktop app to connect a local folder. Static preview remains safely read-only."
            : registration?.reason ||
              "Folder registration failed without a saved check.";
        setIntake({
          state: "error",
          registration: null,
          census: null,
          gaps: null,
          message,
        });
        onProjectUnavailable?.({ reason: message, workspaceId: runWorkspaceId });
        onDiagnostic?.("workspace", "error", message);
        return;
      }
      setIntake({
        state: "scanning",
        registration,
        census: null,
        gaps: null,
        message: "Reading your app. Read only, nothing is run or moved…",
      });
      if (workspaceAdapter.previewRegisteredWorkspace) {
        setFolderPreview(null);
        const preview = await workspaceAdapter.previewRegisteredWorkspace({workspaceId:runWorkspaceId,registryRevision:registration.registryRevision});
        if (!isCurrentRun()) return;
        if (preview?.available && preview.authoritative === false && preview.contentVerified === false && buildWorkspaceStructureTree(preview).state !== "invalid") {
          setFolderPreview(preview);
          setIntake(current => ({...current,message:"Folder preview ready. Checking source contents separately…"}));
        } else {
          onDiagnostic?.("workspace","warning",preview?.reason || "Folder preview unavailable; attempting the content scan.");
        }
      }
      const census = await workspaceAdapter.censusRegisteredWorkspace({
        workspaceId: runWorkspaceId,
        registryRevision: registration.registryRevision,
        signal: controller.signal,
        onProgress: (progress) => {
          if (isCurrentRun()) setScanProgress(progress);
        },
      });
      if (!isCurrentRun()) return;
      if (!census?.authoritative) {
        const message =
          census?.reason === "workspace-census-aborted"
            ? "Analysis cancelled. No partial result was accepted."
            : censusFailureText(census?.reason, census?.path);
        setIntake({
          state: "error",
          registration,
          census: null,
          gaps: null,
          message,
        });
        setScanProgress(null);
        if (census?.reason !== "workspace-census-aborted")
          onProjectUnavailable?.({
            reason: message,
            registration,
            workspaceId: runWorkspaceId,
          });
        onDiagnostic?.(
          "workspace",
          census?.reason === "workspace-census-aborted" ? "info" : "error",
          message,
        );
        return;
      }
      const validatedStructure = buildWorkspaceStructureTree(census, {
        appName: runLabel,
      });
      const validatedDiscovery = buildWorkspaceDiscovery(census, {
        appName: runLabel,
      });
      if (
        validatedStructure.state === "invalid" ||
        validatedDiscovery.state === "invalid"
      ) {
        const reason =
          validatedStructure.integrity?.reason ||
          validatedDiscovery.integrity?.reason ||
          "workspace-discovery-input-invalid";
        const message = `Analysis refused: ${reason}. No files, folders, or inferred facts were accepted.`;
        setIntake({
          state: "analysis-refused",
          registration,
          census,
          gaps: null,
          message,
        });
        setScanProgress(null);
        onProjectUnavailable?.({ reason: message, registration, workspaceId: runWorkspaceId });
        onDiagnostic?.("workspace", "error", message);
        return;
      }
      const publishProject = (gaps = null) => {
        if (workspaceAdapter.mode !== "browser") {
          try { localStorage.setItem(LAST_NATIVE_FOLDER_KEY, JSON.stringify({ path: path.trim(), name: runLabel })); } catch { /* remembering is optional */ }
        }
        refreshLastFolder();
        globalThis.requestAnimationFrame?.(() => discoveryPanelRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }));
        onIntakeSummary?.(
          redactWorkspaceIntakeSummary({ registration, census, gaps }),
        );
        onProjectCaptured?.({
          adapter: workspaceAdapter.mode,
          census,
          discovery: validatedDiscovery,
          name: runLabel,
          persistence:
            workspaceAdapter.mode === "browser"
              ? "reselect-required"
              : "durable",
          registration,
        });
      };
      const sameRegisteredProject = imported && (
        activeProject.registration?.rootIdentity === registration.rootIdentity && draft.planId === activeProject.projectId
      );
      const indexed = assessWorkspaceIntake({
        selectedPath: path.trim(),
        registration,
        census,
        contractAssessment: sameRegisteredProject ? assessment : null,
      });
      if (!assessment.ready || !sameRegisteredProject) {
        setIntake({
          state: indexed.state,
          registration,
          census,
          gaps: null,
          message: indexed.reason,
        });
        setScanProgress(null);
        publishProject();
        onToast?.(
          `${census.fileCount} files indexed · view the discovery map now. Architecture approval is required only before approving a folder plan.`,
        );
        return;
      }
      const gaps = analyzeWorkspaceStructure(census, draft);
      const result = assessWorkspaceIntake({
        selectedPath: path.trim(),
        registration,
        census,
        gaps,
        contractAssessment: assessment,
      });
      setIntake({
        state: result.state,
        registration,
        census,
        gaps,
        message: result.reason,
      });
      setScanProgress(null);
      publishProject(gaps);
      onToast?.(
        `Folder scan complete · ${gaps.gaps.length} planned gaps · ${gaps.unexpected.length} outside contract.`,
      );
    } catch (error) {
      if (!isCurrentRun()) return;
      const message =
        error instanceof Error
          ? error.message
          : "Unexpected folder-analysis failure.";
      setScanProgress(null);
      setIntake((current) => ({
        state: "error",
        registration: current.registration,
        census: null,
        gaps: null,
        message,
      }));
      onProjectUnavailable?.({ reason: message, workspaceId: runWorkspaceId });
      onDiagnostic?.("workspace", "error", message);
    } finally {
      if (scanRunRef.current === runId) scanAbortRef.current = null;
    }
  };
  const reconnectFolder = async (projectId = activeProject?.projectId, { askFirst = false } = {}) => {
    if (!projectId || mapLoading || typeof workspaceAdapter.reconnectRememberedFolder !== "function") return;
    setFolderAccess((state) => ({ ...state, busy: true, error: "" }));
    let receipt;
    try {
      // First await is the browser's permission prompt, so it stays tied to the click.
      receipt = await workspaceAdapter.reconnectRememberedFolder(projectId);
    } catch {
      receipt = { authoritative: false, reason: "Folder access could not be requested. Choose the folder again." };
    }
    if (imported && currentPlanRef.current !== activeProject.projectId) return;
    if (!receipt?.authoritative || receipt.selectionState !== "selected" || !receipt.selectedPath) {
      const message = receipt?.reason || "The folder could not be reconnected. Choose it again.";
      setFolderAccess((state) => ({ ...state, busy: false, error: message }));
      onDiagnostic?.("workspace", "warning", message);
      return;
    }
    setFolderAccess((state) => ({ ...state, busy: false, error: "" }));
    setRootPath(receipt.selectedPath);
    if (askFirst) awaitScanApproval(receipt.selectedPath);
    else await connectFolder(receipt.selectedPath);
    if (typeof workspaceAdapter.rememberedFolder === "function")
      Promise.resolve(workspaceAdapter.rememberedFolder(projectId)).then((access) => {
        setFolderAccess((state) => state.projectId === projectId ? { ...state, access } : state);
      }).catch(() => {});
  };
  const openLastFolder = () => {
    if (!lastFolder || mapLoading) return;
    if (workspaceAdapter.mode !== "browser") {
      beginFolderSelection();
      setRootPath(lastFolder.path);
      awaitScanApproval(lastFolder.path);
      return;
    }
    reconnectFolder(lastFolder.projectId, { askFirst: true });
  };
  // A chosen folder waits for "Approve read-only scan" unless scans are set to start on pick.
  function awaitScanApproval(path) {
    if (scanStartsOnPick) return connectFolder(path);
    setIntake((current) => ({
      ...current,
      state: "selected",
      message: `Ready to scan ${projectLabelFromRoot(path) || "this folder"}. The scan only reads files; nothing is run or moved.`,
    }));
    return undefined;
  }
  const openLaunchFolder = () =>
    chooseFolder(() => workspaceAdapter.selectLaunchFolder());
  const beginFolderSelection = () => {
    const runId = ++selectionRunRef.current;
    scanRunRef.current += 1;
    scanAbortRef.current?.abort();
    scanAbortRef.current = null;
    setRootPath("");
    setScanProgress(null);
    setFolderPreview(null);
    setIntake({
      state: "choosing",
      registration: null,
      census: null,
      gaps: null,
      message: "Choose one app folder. The scan starts as soon as you pick it.",
    });
    return runId;
  };
  const acceptDrop = (event) => {
    event.preventDefault();
    if (mapLoading) {
      onDiagnostic?.(
        "workspace",
        "info",
        "Ignored a new folder drop while read-only analysis was running.",
      );
      return;
    }
    if (workspaceAdapter.mode === "browser") {
      const items = Array.from(event.dataTransfer?.items ?? []);
      // Capture the browser's handle during the drop event, before any await.
      // Paths and relative filenames are not browser read authority.
      chooseFolder(() => {
        if (items.length !== 1 || items[0].kind !== "file")
          return { authoritative: false, reason: "Drop exactly one app folder." };
        if (typeof items[0].getAsFileSystemHandle !== "function" ||
            typeof workspaceAdapter.selectDroppedWorkspaceFolder !== "function")
          return { authoritative: false, reason: "This browser cannot grant folder access by drag-and-drop. Use Choose app folder." };
        const handlePromise = items[0].getAsFileSystemHandle();
        return Promise.resolve(handlePromise).then((handle) =>
          workspaceAdapter.selectDroppedWorkspaceFolder(handle),
        );
      });
      return;
    }
    if (event.dataTransfer?.files?.length !== 1) {
      chooseFolder(() => ({ authoritative: false, reason: "Drop exactly one app folder." }));
      return;
    }
    const file = event.dataTransfer?.files?.[0];
    const path = file?.path || file?.webkitRelativePath?.split("/")[0] || "";
    if (!path || !/^(?:[a-zA-Z]:[\\/]|\/)/.test(path)) {
      const message =
        "This browser cannot grant folder access by drag-and-drop. Use Choose app folder.";
      chooseFolder(() => ({ authoritative: false, reason: message }));
      return;
    }
    beginFolderSelection();
    setRootPath(path);
    awaitScanApproval(path);
  };
  const chooseFolder = async (select = () => workspaceAdapter.selectWorkspaceFolder()) => {
    if (mapLoading) return;
    const runId = beginFolderSelection();
    try {
      const receipt = await select();
      if (selectionRunRef.current !== runId) return;
      if (!receipt?.authoritative) {
        if (receipt?.reason === "browser-folder-picker-needs-click") {
          setIntake((current) => ({ ...current, state: "idle", message: "Click Choose app folder to pick your app." }));
          return;
        }
        const message =
          receipt?.reason === "native-runtime-unavailable"
            ? "Open the native desktop app to choose a folder. This browser does not provide secure folder access."
            : receipt?.reason ||
              "Folder selection failed without a saved check.";
        setIntake((current) => ({ ...current, state: "error", message }));
        // Browser limits (no native picker, no drag-and-drop access) are expected, not failures.
        const expected = receipt?.reason === "native-runtime-unavailable" || /cannot grant folder access|Drop exactly one/.test(message);
        onDiagnostic?.("workspace", expected ? "warning" : "error", message);
        return;
      }
      if (receipt.selectionState === "cancelled") {
        setIntake((current) => ({
          ...current,
          state: "idle",
          message:
            "Folder selection cancelled. Nothing was registered or read.",
        }));
        return;
      }
      setRootPath(receipt.selectedPath);
      await awaitScanApproval(receipt.selectedPath);
    } catch (error) {
      if (selectionRunRef.current !== runId) return;
      const message =
        error instanceof Error
          ? error.message
          : "Unexpected folder-picker failure.";
      setIntake((current) => ({ ...current, state: "error", message }));
      onDiagnostic?.("workspace", "error", message);
    }
  };
  // Home's "Choose app folder" lands here and opens the picker straight away.
  useEffect(() => {
    if (autoStartIntakeToken <= consumedAutoStartToken) return;
    consumedAutoStartToken = autoStartIntakeToken;
    chooseFolder();
  }, [autoStartIntakeToken]);
  const updateNode = (key, value) =>
    setDraft((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === selected.id ? { ...node, [key]: value } : node,
      ),
    }));
  const addFolder = () => {
    const sequence =
      Math.max(0, ...draft.nodes.map((node) => Number(node.id.slice(1)) || 0)) +
      1;
    const id = `F${String(sequence).padStart(3, "0")}`;
    const parent =
      selected?.kind === "folder"
        ? selected.path
        : selected?.path.split("/").slice(0, -1).join("/");
    const path = `${parent ? `${parent}/` : ""}new-folder-${sequence}`;
    const node = {
      id,
      kind: "folder",
      path,
      purpose: "",
      owner: "",
      taskId: "",
      createAtStage: "architecture",
      dependsOn: selected ? [selected.id] : [],
      allowedContents: "",
      changePolicy: "collision-review",
      renameFallback:
        "Stop dependants, approve the rename, and rescan all claims.",
    };
    setDraft((current) => ({ ...current, nodes: [...current.nodes, node] }));
    setSelectedId(id);
    setOpenSections((current) => ({ ...current, paths: true, editor: true }));
    onToast?.(`${id} added as an unresolved planned folder.`);
  };
  const removeSelected = () => {
    if (!selected || children.length) return;
    setDraft((current) => ({
      ...current,
      nodes: current.nodes
        .filter((node) => node.id !== selected.id)
        .map((node) => ({
          ...node,
          dependsOn: (node.dependsOn ?? []).filter((id) => id !== selected.id),
        })),
    }));
    setSelectedId(draft.nodes.find((node) => node.id !== selected.id)?.id);
  };
  const publish = async () => {
    if (draft.planId !== planId || !registry.available || !tokenRef.current) return;
    const requestedPlan = planId;
    setPublishing(true);
    try {
      const response = await boundedFetch("/api/folder-contract/publish", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-pp-folder-token": tokenRef.current,
        },
        body: JSON.stringify({
          input: draft,
          architectureContractDigest: draft.architectureContractDigest,
          architectureRevision: draft.architectureRevision,
          expectedRevision: registry.revision,
          expectedHeadDigest: registry.head?.contractDigest ?? "GENESIS",
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (currentPlanRef.current !== requestedPlan) return;
      setRegistry((current) => ({
        ...current,
        available: true,
        revision: result.revision,
        head: result.head,
        error: null,
      }));
      // Publication is not itself a cached authority grant: re-read both saved heads.
      await projectContext?.refreshFolder?.(requestedPlan);
      if (currentPlanRef.current !== requestedPlan) return;
      onToast?.(
        `Structure frozen as revision ${result.revision} · ${result.head.contractDigest.slice(0, 12)}.`,
      );
    } catch (error) {
      if (currentPlanRef.current !== requestedPlan) return;
      setRegistry((current) => ({ ...current, error: error.message }));
      onToast?.(`Freeze refused: ${error.message}`, "error");
    } finally {
      if (currentPlanRef.current === requestedPlan) setPublishing(false);
    }
  };

  function resetProposal() {
    setConfirmReset(false);
    // A real project (or no project yet) starts from an empty plan, never the sample folders.
    setDraft(demo
      ? cloneSeed()
      : { ...startingDraft(false, planId), architectureContractDigest: architecture.head?.contractDigest ?? null, architectureRevision: architecture.head?.revision ?? null });
    setSelectedId(demo ? "F001" : undefined);
  }

  return (
    <section
      className="workspace structure-workspace"
      aria-label="Strict folder contract workspace"
    >
      <header className="structure-header">
        <div>
          <span className="eyebrow">STRICT PLAN · STRUCTURE BEFORE BUILD</span>
          <h1>Structure & Connections</h1>
          <p>
            Bring in the real app, compare it with the numbered folder contract,
            and see every credential, middleware service, and third-party
            dependency before work begins.
          </p>
        </div>
        <div
          className={`structure-state ${headline.tone}`}
        >
          {headline.tone !== "blocked" ? (
            <CheckCircleIcon weight="fill" />
          ) : (
            <WarningIcon weight="fill" />
          )}
          <span>
            <small>Contract state</small>
            <strong>{matchesSavedRevision ? `SAVED REVISION ${registry.revision}` : headline.verdict}</strong>
            <em>
              {matchesSavedRevision ? "This draft matches the saved contract · no files created" : assessment.ready
                ? registry.head ? "Unsaved draft · saved revision remains unchanged" : "Valid draft · approval to lock pending"
                : headline.detail}
            </em>
          </span>
        </div>
      </header>
      {imported && <section className="structure-panel" aria-label="Architecture approval binding">
        <h2>{architecture.head ? `Using approved architecture revision ${architecture.head.revision}` : "Approve the architecture before planning folders"}</h2>
        <p>{architecture.error || (architecture.head ? "Folder publication will recheck this exact saved approval. Add only the folder boundaries you intend to create; imported files are not moved." : "Open Blueprint to draft the architecture, review unanswered decisions, and explicitly publish approval. Importing a folder does not approve its design.")}</p>
        <button type="button" className="soft-button" onClick={onOpenBlueprint}>Open architecture draft</button>
        {draftStorageError && <p role="alert">{draftStorageError}</p>}
      </section>}
      <section className="structure-toolbar">
        <div className="mode-switch">
          <small>WORKSPACE MODE</small>
          {["private", "hybrid", "git"].map((mode) => (
            <button
              key={mode}
              className={draft.workspaceMode === mode ? "active" : ""}
              aria-pressed={draft.workspaceMode === mode}
              onClick={() =>
                setDraft((current) => ({ ...current, workspaceMode: mode }))
              }
            >
              {mode}
            </button>
          ))}
        </div>
        <div className="structure-metrics">
          <span>
            <b>{draft.nodes.length}</b>
            <small>named paths</small>
          </span>
          <span>
            <b>
              {structureTree.integrity?.accepted
                ? (intake.census?.fileCount ?? 0)
                : 0}
            </b>
            <small>
              {structureTree.state === "invalid"
                ? "accepted files"
                : "indexed files"}
            </small>
          </span>
          <span>
            <b>{discoveryMap.counts.observed}</b>
            <small>observed facts</small>
          </span>
          <span>
            <b>{discoveryMap.counts.signals}</b>
            <small>review signals</small>
          </span>
        </div>
        <div className="structure-toolbar-actions">
          <button
            className="soft-button"
            onClick={() =>
              setOpenSections({
                intake: false,
                dependencies: false,
                paths: false,
                editor: false,
                validation: false,
              })
            }
          >
            Collapse all
          </button>
          <button
            className="soft-button"
            aria-expanded={confirmReset}
            onClick={() => {
              // Resetting throws away every planned folder, so ask first.
              if (draft.nodes.length && !confirmReset) { setConfirmReset(true); return; }
              resetProposal();
            }}
          >
            <ShieldCheckIcon /> Reset proposal
          </button>
          {confirmReset && (
            <span role="group" aria-label="Confirm reset proposal" className="structure-reset-confirm">
              <span>{demo
                ? `Replace your ${draft.nodes.length} planned ${draft.nodes.length === 1 ? "folder" : "folders"} with the Demo sample?`
                : `Remove all ${draft.nodes.length} planned ${draft.nodes.length === 1 ? "folder" : "folders"}? This starts an empty plan.`}</span>
              <button type="button" className="soft-button" onClick={resetProposal}>Yes, reset</button>
              <button type="button" className="soft-button" onClick={() => setConfirmReset(false)}>Keep my folders</button>
            </span>
          )}
        </div>
      </section>
      <section
        className={`structure-intake-panel ${openSections.intake ? "expanded" : "collapsed"}`}
      >
        <header>
          <button
            className="structure-disclosure"
            type="button"
            aria-expanded={openSections.intake}
            aria-controls="folder-intake"
            onClick={() => toggleSection("intake")}
          >
            <CaretDownIcon />
            <FolderIcon />
            <span>
              <strong>Bring in an existing app</strong>
              <small>Reads only. Nothing is run or moved.</small>
            </span>
          </button>
          <span className={`intake-state ${intake.state}`}>
            {intake.state.replaceAll("-", " ")}
          </span>
        </header>
        {openSections.intake && (
          <div id="folder-intake" className="folder-intake-grid one-click-intake">
            {canRemember && (
              <FolderReconnectNotice
                status={describeFolderConnection({
                  project: activeProject,
                  access: folderAccess.projectId === activeProject.projectId ? folderAccess.access : null,
                  scannedThisVisit: Boolean(intake.census) && intake.registration?.rootIdentity === activeProject.registration?.rootIdentity,
                })}
                busy={folderAccess.busy || mapLoading}
                error={folderAccess.error}
                onReconnect={() => reconnectFolder()}
              />
            )}
            <div
              className="folder-drop-zone"
              onDragOver={(event) => event.preventDefault()}
              onDrop={acceptDrop}
            >
              <FolderIcon weight="duotone" />
              <strong>Drop your app folder here, or pick it</strong>
              <span className="folder-quick-actions">
                <button
                  type="button"
                  className="primary-button choose-folder-button"
                  onClick={() => chooseFolder()}
                  disabled={mapLoading}
                >
                  <FolderIcon /> Choose app folder
                </button>
                {rootPath && intake.state === "selected" && !mapLoading && (
                  <button
                    type="button"
                    className="primary-button approve-scan-button"
                    onClick={() => connectFolder()}
                  >
                    <ShieldCheckIcon /> Approve read-only scan
                  </button>
                )}
                {lastFolder && !(canRemember && lastFolder.projectId === activeProject.projectId) && (
                  <button
                    type="button"
                    className="soft-button"
                    onClick={openLastFolder}
                    disabled={mapLoading}
                    title={lastFolder.path ?? lastFolder.name}
                  >
                    Use last folder · {lastFolder.name}
                  </button>
                )}
                {launchFolder && workspaceAdapter.mode === "browser" && typeof workspaceAdapter.selectLaunchFolder === "function" && (
                  <button
                    type="button"
                    className="soft-button"
                    onClick={openLaunchFolder}
                    disabled={mapLoading}
                    title={launchFolder.path ?? launchFolder.name}
                  >
                    Use launch folder · {launchFolder.name}
                  </button>
                )}
              </span>
              <ol className="intake-process" aria-label="App intake progress">
                {workspaceIntakeStages.map((stage, index) => (
                  <li
                    key={stage.id}
                    className={workspaceIntakeStageState(
                      intake.state === "analysis-refused"
                        ? "scanning"
                        : intake.state,
                      index,
                    )}
                  >
                    <span>{stage.name}</span>
                  </li>
                ))}
              </ol>
            </div>
            {workspaceAdapter.mode !== "browser" && (
              <form
                className="folder-connect-form"
                onSubmit={(event) => { event.preventDefault(); connectFolder(); }}
              >
                <label>
                  <span>OR TYPE THE FOLDER PATH</span>
                  <input
                    value={rootPath}
                    onChange={(event) => {
                      beginFolderSelection();
                      setRootPath(event.target.value);
                      setIntake((current) => ({ ...current, state: "idle", message: "Press Scan folder to read it." }));
                    }}
                    disabled={mapLoading}
                    placeholder={"C:\\projects\\my-app"}
                  />
                </label>
                <button className="soft-button" type="submit" disabled={!rootPath.trim() || mapLoading}>
                  Scan folder
                </button>
              </form>
            )}
            <div className="folder-intake-status">
              <span className="folder-intake-message" role="status">{intake.message}</span>
              <span className="folder-scan-actions">
                {rootPath && !mapLoading && ["error", "analysis-refused"].includes(intake.state) && (
                  <button type="button" className="soft-button" onClick={() => connectFolder()}>
                    Scan again
                  </button>
                )}
                {mapLoading && (
                  <button
                    type="button"
                    className="soft-button cancel-analysis-button"
                    onClick={cancelAnalysis}
                  >
                    Cancel scan
                  </button>
                )}
              </span>
            </div>
            {mapLoading && (
              <div
                className="folder-scan-progress"
                role="status"
                aria-label="Read-only folder scan progress"
              >
                <progress
                  max={1}
                  value={scanFraction(scanProgress) ?? undefined}
                  aria-label="Scan progress"
                />
                <span>
                  <strong>
                    {scanProgress
                      ? `${scanProgress.filesHashed} of ${scanProgress.filesDiscovered} files read`
                      : intake.state === "registering" ? "Opening folder…" : "Reading folder…"}
                  </strong>
                  {scanProgress && (
                    <small>
                      {scanProgress.directoriesVisited} folders ·{" "}
                      {(scanProgress.bytesHashed / 1_000_000).toFixed(1)} MB
                    </small>
                  )}
                </span>
                {scanProgress?.currentPath && (
                  <code title={scanProgress.currentPath}>{scanProgress.currentPath}</code>
                )}
              </div>
            )}
            {intake.census &&
              !intake.gaps &&
              structureTree.state !== "invalid" && (
                <div className="folder-inventory-summary">
                  <strong>{intake.census.fileCount} files indexed</strong>
                  <span>
                    {intake.census.skipped.length
                      ? `${intake.census.skipped.length} skipped · partial coverage`
                      : "Bounded inventory captured"}
                  </span>
                  <small>
                    Discovery is read-only. Architecture approval is needed before approving a folder plan—not to view these files.
                  </small>
                </div>
              )}
            {comparison.stale && <p role="status">Folder comparison needs refreshing because the project or draft changed. No file moves are approved. Keep your draft and rerun read-only analysis after reviewing this project's architecture.</p>}
            {intake.gaps && !comparison.stale && (
              <div className="folder-gap-summary">
                <span>
                  <b>{intake.gaps.completionPercentage}%</b>
                  <small>plan aligned</small>
                </span>
                <span>
                  <b>{intake.gaps.gaps.length}</b>
                  <small>planned gaps</small>
                </span>
                <span>
                  <b>{intake.gaps.unexpected.length}</b>
                  <small>outside contract</small>
                </span>
                <span>
                  <b>{intake.gaps.proposals.length}</b>
                  <small>review proposals</small>
                </span>
                <p>
                  {intake.gaps.mutationAuthorized
                    ? "Changes authorised"
                    : "Analysis only · every move still requires explicit approval and rollback proof"}
                </p>
              </div>
            )}
            {organizationReview?.proposals.length > 0 && (
              <section
                className="organization-review"
                aria-label="Folder organisation collision preview"
              >
                <header>
                  <span>
                    <strong>Collision preview</strong>
                    <small>Exact read/write surfaces before approval</small>
                  </span>
                  <b>EXECUTION LOCKED</b>
                </header>
                <div>
                  {organizationReview.proposals.map((proposal) => (
                    <article
                      key={proposal.proposalId}
                      className={
                        proposal.internalCollision ? "blocked" : "pending"
                      }
                    >
                      <span>
                        <code>{proposal.proposalId}</code>
                        <strong>
                          {proposal.previewState.replaceAll("_", " ")}
                        </strong>
                      </span>
                      <p>
                        <small>READ</small>
                        <code>{proposal.readClaims.join(" · ")}</code>
                      </p>
                      <p>
                        <small>WRITE</small>
                        <code>{proposal.writeClaims.join(" → ")}</code>
                      </p>
                      <p>
                        <small>DEPENDANTS</small>
                        <code>
                          {proposal.dependantNodeIds.join(" · ") || "none"}
                        </code>
                      </p>
                      <em>
                        Named approval + live collision check + rollback
                        record required
                      </em>
                    </article>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </section>
      <section
        ref={discoveryPanelRef}
        className={`dependency-map-panel discovery-panel ${openSections.dependencies ? "expanded" : "collapsed"}`}
        aria-label="Progressive app discovery map"
      >
        <header>
          <button
            className="structure-disclosure"
            type="button"
            aria-expanded={openSections.dependencies}
            aria-controls="dependency-map"
            onClick={() => toggleSection("dependencies")}
          >
            <CaretDownIcon />
            <ShieldCheckIcon />
            <span>
              <strong>App discovery map</strong>
              <small>
                {folderPreview && !intake.census ? `Folder preview · ${folderPreview.fileCount} source-file paths · content not verified` : discoveryMap.state === "empty"
                  ? intake.census && structureTree.integrity?.accepted
                    ? `No files observed in this folder scan · ${intake.census.skipped?.length ?? 0} entries skipped · not proof the folder is empty`
                    : "Empty until a folder is indexed · headings are questions, not answers"
                  : discoveryMap.state === "invalid"
                    ? `Analysis refused · ${structureTree.integrity?.reason || discoveryMap.integrity?.reason || "invalid folder scan"} · no facts accepted`
                    : `${discoveryMap.observedFiles} files observed · ${discoveryMap.counts.observed} facts · ${discoveryMap.counts.signals} signals need review`}
              </small>
            </span>
          </button>
          <div className="connection-legend">
            <i className="observed" /> observed <i className="signal" /> review
            signal <i className="unanswered" /> unanswered
          </div>
        </header>
        {folderPreview && !intake.census && <details className="structure-panel" aria-label="Folder preview coverage">
          <summary>Preview only · {folderPreview.skipped.length} excluded entries · view coverage</summary>
          <p>This map lists eligible source-file paths. Contents have not been verified. Ignore rules and fixed output exclusions apply; excluded folders and empty folders are not expanded in this source map. No approval or execution permission is granted.</p>
          <ul>{folderPreview.skipped.slice(0,100).map((entry,index)=><li key={index}>{entry.path} — {entry.reason}</li>)}</ul>
          {folderPreview.skipped.length>100 && <p>Showing the first 100 exclusions.</p>}
        </details>}
        {openSections.dependencies &&
          (structureTree.state === "invalid" ? (
            <div
              id="dependency-map"
              className="discovery-map-refused"
              role="alert"
              aria-label="Folder analysis refused"
            >
              <WarningIcon weight="fill" />
              <span>
                <code>
                  {structureTree.integrity?.reason ||
                    discoveryMap.integrity?.reason ||
                    "workspace-discovery-input-invalid"}
                </code>
                <strong>Analysis refused</strong>
                <p>
                  The indexed metadata did not pass the safe structure contract.
                  No files, folders, or inferred architecture were promoted to
                  project status.
                </p>
                <small>
                  Retry reads a fresh bounded folder scan. Clearing removes this
                  rejected result before another folder is selected.
                </small>
              </span>
              <div>
                <button
                  type="button"
                  className="primary-button"
                  onClick={connectFolder}
                >
                  Retry read-only analysis
                </button>
                <button
                  type="button"
                  className="soft-button"
                  onClick={resetRefusedAnalysis}
                >
                  Clear and reselect
                </button>
              </div>
            </div>
          ) : structureTree.state === "empty" ? (
            mapLoading ? (
              <div
                id="dependency-map"
                className="discovery-map-scanning"
                aria-label="Repository scan starting"
              >
                <div className="discovery-scan-seed">
                  <FolderIcon weight="duotone" />
                  <span>
                    <strong>
                      {rootPath.split(/[\\/]/).filter(Boolean).at(-1) ||
                        "App folder"}
                    </strong>
                    <small>
                      {intake.state === "registering"
                        ? "Securing read-only access…"
                        : "Reading folder structure…"}
                    </small>
                  </span>
                </div>
                <i className="discovery-scan-spine" />
              </div>
            ) : (
              <div
                id="dependency-map"
                className="discovery-map-empty"
                role="region"
                aria-label="Empty app discovery canvas"
              />
            )
          ) : (
            <div
              id="dependency-map"
              className={`discovery-map-flow discovering ${revealCount >= renderNodeLimit ? "map-complete" : "map-building"}`}
            >
              <div
                className="discovery-build-status"
                role={revealCount >= renderNodeLimit ? "status" : undefined}
                aria-live={revealCount >= renderNodeLimit ? "polite" : "off"}
              >
                <span>
                  <i /> Rendering {Math.min(revealCount, renderNodeLimit)}{" "}
                  of {totalTreeNodeCount} folder nodes ·{" "}
                  {structureTree.fileCount} files indexed
                </span>
                <div className="discovery-build-actions">
                  <b>
                    {revealCount >= renderNodeLimit
                      ? totalTreeNodeCount > renderNodeLimit
                        ? `View capped at ${renderNodeLimit.toLocaleString()} nodes for responsiveness`
                        : "All folder nodes ready"
                      : mapPaused
                        ? "Map reveal paused"
                        : revealCount
                          ? "Building top down…"
                          : "Starting map…"}
                  </b>
                  {revealCount < renderNodeLimit && (
                    <span>
                      <button
                        type="button"
                        onClick={() => setMapPaused((paused) => !paused)}
                      >
                        {mapPaused ? "Resume" : "Pause"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setRevealCount(renderNodeLimit);
                          setMapPaused(false);
                        }}
                      >
                        Reveal current map
                      </button>
                    </span>
                  )}
                </div>
                <em>
                  <i
                    style={{
                      width: `${Math.round((revealCount / Math.max(renderNodeLimit, 1)) * 100)}%`,
                    }}
                  />
                </em>
              </div>
              <ol className="workspace-structure-tree">
                <DiscoveryTreeNode
                  node={structureTree.root}
                  revealIndex={revealIndex}
                  revealCount={revealCount}
                />
              </ol>
              {insightsVisible && (
                <section className="discovery-learning-lenses">
                  <header>
                    <span>
                      <strong>Architecture discovery — not verified</strong>
                      <small>
                        Filled from exact file presence and clearly labelled
                        naming signals
                      </small>
                    </span>
                    <b>{discoveryMap.categories.reduce((total, category) => total + category.questions.length, 0)} open review questions · {discoveryMap.counts.unanswered} areas without findings</b>
                  </header>
                  <div>
                    {discoveryMap.categories.map((category, index) => (
                      <article
                        className={category.state}
                        style={{ "--lens-order": index }}
                        key={category.id}
                      >
                        <span>
                          <code>{category.id}</code>
                          <strong>{category.title}</strong>
                        </span>
                        {category.findings.map((item) => (
                          <div className="discovery-finding" key={item.id}>
                            <b>
                              {item.certainty === "observed"
                                ? "OBSERVED"
                                : "REVIEW"}
                            </b>
                            <span>{item.label}</span>
                            <small>{item.detail}</small>
                            <details>
                              <summary>File evidence · {item.evidenceCount} matching paths</summary>
                              <ul>{item.evidence.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
                              {item.evidenceCount > item.evidence.length && <small>Showing {item.evidence.length} examples, not the complete matching list.</small>}
                              <small>Path evidence only. This does not confirm active use, correct configuration, or a passing check.</small>
                            </details>
                          </div>
                        ))}
                        {category.questions.map((question) => (
                          <p className="discovery-question" key={question}>
                            <b>QUESTION</b>
                            {question}
                          </p>
                        ))}
                      </article>
                    ))}
                  </div>
                </section>
              )}
            </div>
          ))}
      </section>
      {imported && <DiscoveryReviewPanel project={activeProject} liveDiscovery={discoveryMap} liveCensusDigest={intake.census?.digest ?? null} onToast={onToast} />}
      <div className="structure-layout">
        <section
          className={`structure-tree-panel ${openSections.paths ? "expanded" : "collapsed"}`}
        >
          <header>
            <button
              className="structure-disclosure"
              type="button"
              aria-expanded={openSections.paths}
              aria-controls="structure-planned-paths"
              onClick={() => toggleSection("paths")}
            >
              <CaretDownIcon />
              <FolderIcon />
              <span>
                <strong>Planned paths</strong>
                <small>
                  {draft.nodes.length} named · {assessment.reservations.length}{" "}
                  reserved
                </small>
              </span>
            </button>
            <button onClick={addFolder}>
              <PlusIcon /> Add folder
            </button>
          </header>
          {openSections.paths && (
            <div className="structure-tree" id="structure-planned-paths">
              {!activeProject && !draft.nodes.length && (
                <p className="structure-empty-plan">Choose an app folder first. The folders you plan for it appear here.</p>
              )}
              {draft.nodes.map((node) => {
                const depth = node.path.split("/").length - 1;
                return (
                  <button
                    className={selected?.id === node.id ? "selected" : ""}
                    style={{ "--depth": depth }}
                    key={node.id}
                    onClick={() => {
                      setSelectedId(node.id);
                      setOpenSections((current) => ({
                        ...current,
                        editor: true,
                      }));
                    }}
                  >
                    <code>{node.id}</code>
                    <FolderIcon
                      weight={selected?.id === node.id ? "fill" : "regular"}
                    />
                    <span>
                      <strong>{node.path.split("/").at(-1)}</strong>
                      <small>{node.path}</small>
                    </span>
                    <em>{node.createAtStage}</em>
                    <ArrowRightIcon />
                  </button>
                );
              })}
            </div>
          )}
        </section>
        {selected && (
          <section
            className={`structure-editor-panel ${openSections.editor ? "expanded" : "collapsed"}`}
          >
            <header>
              <button
                className="structure-disclosure"
                type="button"
                aria-expanded={openSections.editor}
                aria-controls="structure-node-editor"
                onClick={() => toggleSection("editor")}
              >
                <CaretDownIcon />
                <span>
                  <code>{selected.id}</code>
                  <strong>Edit contract node</strong>
                  <small>{selected.path}</small>
                </span>
              </button>
              <button
                className="danger-button"
                disabled={children.length > 0}
                title={
                  children.length
                    ? "Move or remove child paths first"
                    : "Remove path"
                }
                onClick={removeSelected}
              >
                <TrashIcon /> Remove
              </button>
            </header>
            {openSections.editor && (
              <div id="structure-node-editor">
                <div className="structure-form">
                  <label className="wide">
                    <span>PLANNED PATH</span>
                    <input
                      value={selected.path}
                      onChange={(event) =>
                        updateNode("path", event.target.value)
                      }
                    />
                  </label>
                  <label className="wide">
                    <span>PURPOSE</span>
                    <textarea
                      value={selected.purpose}
                      onChange={(event) =>
                        updateNode("purpose", event.target.value)
                      }
                    />
                  </label>
                  <label>
                    <span>OWNER</span>
                    <input
                      value={selected.owner}
                      onChange={(event) =>
                        updateNode("owner", event.target.value)
                      }
                    />
                  </label>
                  <label>
                    <span>TASK ID</span>
                    <input
                      value={selected.taskId}
                      onChange={(event) =>
                        updateNode("taskId", event.target.value)
                      }
                    />
                  </label>
                  <label>
                    <span>CREATION WAVE</span>
                    <select
                      value={selected.createAtStage}
                      onChange={(event) =>
                        updateNode("createAtStage", event.target.value)
                      }
                    >
                      {waves.map((wave) => (
                        <option key={wave}>{wave}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>CHANGE POLICY</span>
                    <select
                      value={selected.changePolicy}
                      onChange={(event) =>
                        updateNode("changePolicy", event.target.value)
                      }
                    >
                      {policies.map((policy) => (
                        <option key={policy}>{policy}</option>
                      ))}
                    </select>
                  </label>
                  <label className="wide">
                    <span>ALLOWED CONTENTS</span>
                    <input
                      value={selected.allowedContents}
                      onChange={(event) =>
                        updateNode("allowedContents", event.target.value)
                      }
                    />
                  </label>
                  <label className="wide">
                    <span>RENAME CONTINGENCY</span>
                    <textarea
                      value={selected.renameFallback}
                      onChange={(event) =>
                        updateNode("renameFallback", event.target.value)
                      }
                    />
                  </label>
                </div>
                <div className="selected-reservation">
                  <span>
                    <small>FORWARD RESERVATION</small>
                    <code>
                      {selected.kind === "folder"
                        ? `${selected.path}/**`
                        : selected.path}
                    </code>
                  </span>
                  <b>WRITE · {selected.changePolicy}</b>
                </div>
              </div>
            )}
          </section>
        )}
      </div>
      <section
        className={`structure-validation ${assessment.ready && registry.available ? "valid" : "invalid"} ${openSections.validation ? "expanded" : "collapsed"}`}
      >
        <header>
          <button
            className="structure-disclosure"
            type="button"
            aria-expanded={openSections.validation}
            aria-controls="structure-validation-detail"
            onClick={() => toggleSection("validation")}
          >
            <CaretDownIcon />
            {assessment.ready && registry.available ? (
              <CheckCircleIcon weight="fill" />
            ) : (
              <WarningIcon weight="fill" />
            )}
            <span>
              <strong>
                {assessment.ready
                  ? registry.available
                    ? `Durable registry ready · revision ${registry.revision}`
                    : "Draft valid · registry unavailable"
                  : headline.panelTitle}
              </strong>
              <small>
                {headline.panelDetail}
              </small>
            </span>
          </button>
          <button
            className="primary-button"
            disabled={demo || !assessment.ready || !registry.available || publishing}
            title={demo ? `${DEMO_ONLY_REASON}: sample folder plans are never saved.` : !assessment.ready ? "Resolve the folder plan blockers first." : !registry.available ? "The saved registry is unavailable." : undefined}
            onClick={publish}
          >
            <ShieldCheckIcon /> {publishing ? "Freezing…" : "Freeze revision"}
          </button>
          {demo && <DemoOnlyReason>sample folder plans are never saved.</DemoOnlyReason>}
        </header>
        {openSections.validation && (
          <div id="structure-validation-detail">
            {assessment.ready ? (
              <p>
                {registry.available
                  ? `Explicit click publishes as ${registry.actor}. ${registry.head ? `Current head ${registry.head.contractDigest.slice(0, 12)}.` : "No prior revision exists."} Folder creation remains a separate approved operation.`
                  : `Static mode stays locked: ${registry.error}`}
              </p>
            ) : (
              <div>
                <p>These checks apply to the proposed folder plan, not permission to scan or view your existing app.</p>
                {folderPlanGuidance(assessment.blockers, draft.nodes).map((blocker) => (
                  <p key={blocker}>{blocker}</p>
                ))}
                <details><summary>Technical approval checks</summary>{assessment.blockers.map(blocker => <p key={blocker}>{blocker}</p>)}</details>
              </div>
            )}
          </div>
        )}
      </section>
    </section>
  );
}
