import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {useAgentSessionObservations} from './runtime/useAgentSessionObservations.js';
import {DeveloperNotes} from './components/DeveloperNotes.jsx';
import {BrowserInputMarkers,useBrowserInputMarkerControl} from './components/BrowserInputMarkers.jsx';
import {
  ActivityIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  CalendarDotsIcon,
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CaretUpIcon,
  CheckCircleIcon,
  ChatsCircleIcon,
  ClockIcon,
  CrosshairIcon,
  DotsThreeIcon,
  FolderIcon,
  GitBranchIcon,
  GitMergeIcon,
  HardDrivesIcon,
  ListChecksIcon,
  MagnifyingGlassIcon,
  MinusIcon,
  PlugsConnectedIcon,
  PlusIcon,
  RobotIcon,
  ShieldCheckIcon,
  TerminalWindowIcon,
  TreeStructureIcon,
  UserCircleIcon,
  UsersThreeIcon,
  WarningIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import {
  branchRows,
  documentLedger,
  evidenceNodes,
  journeySteps,
  ledgerTasks,
  phases,
  plans,
  repositories,
} from "./plannerWorkspaceData.js";
import { assessCollisions } from "./engine/collisionEngine.js";
import { collisionSeedManifests } from "./engine/collisionSeed.js";
import {
  classifySession,
  deriveExecutionMap,
} from "./engine/executionEngine.js";
import { buildAllocationWorkspaceModel } from "./engine/conveyorEngine.js";
import { assessCompletion } from "./engine/proofEngine.js";
import {
  guaranteeArtifacts,
  guaranteeItems,
  guaranteeJournal,
  guaranteeManifest,
  guaranteeSessions,
} from "./engine/guaranteeSeed.js";
import { BlueprintWorkspace } from "./components/BlueprintWorkspace.jsx";
import { CollisionWorkspace } from "./components/CollisionWorkspace.jsx";
import { StructureWorkspace } from "./components/StructureWorkspace.jsx";
import { ComponentPlansWorkspace } from "./components/ComponentPlansWorkspace.jsx";
import { ImportedProjectWorkflowWorkspace } from "./components/ImportedProjectWorkflowWorkspace.jsx";
import { ConnectAgentDrawer } from "./components/ConnectAgentDrawer.jsx";
import { ProjectTruthGate } from "./components/ProjectTruthGate.jsx";
import { DEMO_ONLY_REASON, DemoOnlyReason, DemoSampleBadge } from "./demo/DemoSampleNotice.jsx";
const loadRuntimeTools = (name) => import("./components/RuntimeConnectionsPanel.jsx")
  .then((module) => ({ default: module[name] })).catch(() => ({ default: RuntimeToolsUnavailable }));
const BundledPlannerConnection = lazy(() => loadRuntimeTools("BundledPlannerConnection"));
const RuntimeConnectionsPanel = lazy(() => loadRuntimeTools("RuntimeConnectionsPanel"));
import {
  getModelMeta,
  getModelWorkerAsset,
  workerStateForNode,
} from "./modelWorkerAssets.js";
import {
  ProjectProvider,
  useOptionalProject,
} from "./project/ProjectProvider.jsx";
import { deriveProjectHomeModel } from "./project/projectHomeModel.js";
import { useProjectWorkRecords } from "./project/useProjectWorkRecords.js";
import { usePlanTaskDriftWatch } from "./project/usePlanApproval.js";
import { confirmProjectReady } from "./project/planApproval.js";
import { createDemoProjectSession, isDemoProject } from "./demo/demoProject.js";
import {
  createProjectHistoryState,
  projectHistoryHref,
  readProjectSelection,
} from "./project/projectUrl.js";
import { getRuntimeEventSession } from "./runtime/runtimeEventSession.js";
import { createRuntimeCapabilityMatrix } from "./runtime/runtimeCapabilities.js";
import { captureOperationDefinitions, selectOperationDefinitions } from "./runtime/operationDefinitionObservations.js";
import { OperationTaskAccounting } from "./components/OperationTaskAccounting.jsx";
import { createPlannerMcpConnectionController } from "./runtime/plannerMcpConnection.js";
const GitInventoryPanel = lazy(() => import("./components/GitInventoryPanel.jsx").catch(() => ({
  default: BranchToolsUnavailable,
})));
import "./components/GitInventoryPanel.css";
import {
  readCurrentTruthGeneration,
  TruthGenerationReadError,
} from "./runtime/truthGenerationReader.js";

const workspaceOrder = [
  "home",
  "blueprint",
  "structure",
  "components",
  "plan",
  "collision",
  "allocation",
  "build",
  "integrity",
  "evidence",
  "ledger",
  "index",
];
const GLOBAL_DIAGNOSTIC_PROJECT_ID = "pp_global_runtime";
const EMPTY_RUNTIME_CAPABILITY_RECEIPTS = Object.freeze([]);
const workspaceLabels = {
  home: "Project Home",
  index: "Index",
  blueprint: "Blueprint",
  structure: "Structure",
  components: "Components",
  plan: "Plan",
  collision: "Collisions",
  allocation: "Allocation",
  build: "Build",
  integrity: "Integrity",
  evidence: "Evidence",
  ledger: "To-do / Ledger",
};
const stageNavigation = [
  {
    id: "define",
    label: "Define",
    number: "01",
    workspaces: ["blueprint", "structure", "components"],
  },
  {
    id: "coordinate",
    label: "Coordinate",
    number: "02",
    workspaces: ["plan", "collision", "allocation"],
  },
  { id: "build", label: "Build", number: "03", workspaces: ["build"] },
  {
    id: "prove",
    label: "Prove",
    number: "04",
    workspaces: ["integrity", "evidence"],
  },
  { id: "release", label: "Release", number: "05", workspaces: ["ledger"] },
];
const workspaceContext = {
  home: {
    stage: "home",
    purpose: "See the whole project without reading the whole project.",
    outcome: "One honest status and one exact next action.",
    unlock: "Resolve the active collision order.",
  },
  blueprint: {
    stage: "define",
    purpose: "Turn the business goal into a bounded product brief.",
    outcome:
      "Viability, audience, obligations, and success criteria are explicit.",
    unlock: "Freeze the chosen product path.",
  },
  structure: {
    stage: "define",
    purpose: "Pre-name the folders, boundaries, and ownership surfaces.",
    outcome: "Every planned file has one distinctive purpose.",
    unlock: "Approve the structure contract.",
  },
  components: {
    stage: "define",
    purpose: "Give every component its own numbered build contract.",
    outcome: "Inputs, outputs, dependencies, and proof are mapped.",
    unlock: "Complete the component dossier.",
  },
  plan: {
    stage: "coordinate",
    purpose: "Order the work and show where each package sits.",
    outcome: "A numbered plan with dependencies and contingencies.",
    unlock: "Clear B07 collision claims.",
  },
  collision: {
    stage: "coordinate",
    purpose:
      "Find overlapping files, interfaces, branches, and resources before work starts.",
    outcome: "A forced resolution and safe execution order.",
    unlock: "Reduce unresolved collisions to zero.",
  },
  allocation: {
    stage: "coordinate",
    purpose: "Assign safe work to people and agents over time.",
    outcome: "An honest day-by-day allocation derived from dependencies.",
    unlock: "Collision clearance is required.",
  },
  build: {
    stage: "build",
    purpose: "Move claimed work through one guarded conveyor.",
    outcome: "Every change is bounded, attributable, and ready for proof.",
    unlock: "Attach screenshot and scoped code difference.",
  },
  integrity: {
    stage: "prove",
    purpose: "Test whether the plan can truthfully continue.",
    outcome: "A fail-closed GO or NO-GO verdict.",
    unlock: "Clear every release stop.",
  },
  evidence: {
    stage: "prove",
    purpose: "Show the user journey and the proof behind every built surface.",
    outcome: "Visual completion and code proof agree.",
    unlock: "Complete missing journey screenshots.",
  },
  ledger: {
    stage: "release",
    purpose: "Close the source ledger and prepare the handover.",
    outcome: "A reproducible release bundle with honest limits.",
    unlock: "All required proof must be accepted.",
  },
};
function readInitialWorkspace() {
  const requested = new URLSearchParams(window.location.search).get(
    "workspace",
  );
  return workspaceOrder.includes(requested) ? requested : "home";
}
function readInitialPhaseFocus() {
  const requested = new URLSearchParams(window.location.search).get("phase");
  return phases.some((phase) => phase.id === requested) ? requested : null;
}
function writeProjectLocation(
  { projectId = null, workspace = "home", phase = null },
  mode = "replace",
) {
  const href = projectHistoryHref(window.location.href, {
    projectId,
    workspace,
    phase,
  });
  const state = createProjectHistoryState(window.history.state, {
    projectId,
    workspace,
    phase,
  });
  if (
    `${window.location.pathname}${window.location.search}${window.location.hash}` ===
      href &&
    mode === "push"
  )
    return;
  if (mode === "push") window.history.pushState(state, "", href);
  else window.history.replaceState(state, "", href);
}
const initialCollisionAssessment = assessCollisions(collisionSeedManifests);
const initialCollisionGate = {
  ready: false,
  unresolved: initialCollisionAssessment.unresolved,
  hardStops: initialCollisionAssessment.hardStops,
  authorityAvailable: false,
  authorityReason: "Collision authority has not supplied a receipt.",
};
const statusLabel = {
  verified: "verified",
  done: "verified",
  active: "in progress",
  ready: "ready",
  risk: "at risk",
  blocked: "hard stop",
  queued: "queued",
};

function runtimeEventSeveritiesForShell(level) {
  return ["debug", "info", "warning", "error", "critical"].includes(level)
    ? level
    : "info";
}

const ownerMeta = {
  Danie: {
    color: "#4f7d60",
    initials: "D",
    profileSrc: "/assets/profiles/danie-profile-mock.png",
  },
  Mira: { color: "#b2664d", initials: "M", mockProfile: 1 },
  Jon: { color: "#4f7394", initials: "J", mockProfile: 2 },
  "Build Agent A": { color: "#9a713d", initials: "A" },
  "Review Agent B": { color: "#765b91", initials: "B" },
};

function IconButton({ label, children, className = "", ...props }) {
  return (
    <button
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}

function StatusChip({ status, children }) {
  return (
    <span className={`status-chip status-${status}`}>
      {children ?? statusLabel[status] ?? status}
    </span>
  );
}

function useDialogFocus(open, onClose) {
  const dialogRef = useRef(null);
  const closeRef = useRef(onClose);
  const returnFocusRef = useRef(null);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open || typeof document === "undefined") return undefined;
    returnFocusRef.current = document.activeElement;
    const focusableSelector =
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusFirst = () =>
      dialogRef.current?.querySelector(focusableSelector)?.focus();
    const frame = globalThis.requestAnimationFrame?.(focusFirst);
    if (frame == null) queueMicrotask(focusFirst);
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [
        ...(dialogRef.current?.querySelectorAll(focusableSelector) ?? []),
      ];
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      if (frame != null) globalThis.cancelAnimationFrame?.(frame);
      document.removeEventListener("keydown", onKeyDown);
      const target = returnFocusRef.current;
      globalThis.requestAnimationFrame?.(() => target?.focus?.()) ??
        queueMicrotask(() => target?.focus?.());
    };
  }, [open]);
  return dialogRef;
}

function RuntimeToolsUnavailable({ onLoadError }) {
  const callback = useRef(onLoadError);
  callback.current = onLoadError;
  useEffect(() => { callback.current?.(); }, []);
  return <p role="alert">Connection tools could not be loaded. Reload the app to try again. No connection check was run.</p>;
}

function stageForWorkspace(workspace) {
  return (
    stageNavigation.find((stage) => stage.workspaces.includes(workspace)) ??
    null
  );
}

function TopBar({
  workspace,
  onWorkspace,
  onToast,
  onDiagnostic,
  onOpenDiagnostics,
  collisionGate,
  projectContext,
  onProjectSelect,
  onOpenDemo,
  runtimeCapabilityReceipts,
  runtimeCapabilityNow,
  plannerConnection,
  onCheckPlannerConnection,
  onDisconnectPlannerConnection,
}) {
  const activeStage = stageForWorkspace(workspace);
  const activeProject = projectContext.activeProject;
  const demoMode = isDemoProject(activeProject);
  const [openMenu, setOpenMenu] = useState(null);
  const agentObservations=useAgentSessionObservations(activeProject);
  const browserInput=useBrowserInputMarkerControl(activeProject);
  const [actionView, setActionView] = useState("menu");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("Developer");
  const [organizationName, setOrganizationName] = useState("");
  const [mcpAllowed, setMcpAllowed] = useState(true);
  const [agentDrawerOpen, setAgentDrawerOpen] = useState(false);
  const openAgentDrawer = () => { setOpenMenu(null); setAgentDrawerOpen(true); };
  const menuTriggerRef = useRef(null);
  const menuPopoverRef = useRef(null);
  let runtimeCapabilityMatrix = null;
  if (activeProject) {
    try {
      runtimeCapabilityMatrix = createRuntimeCapabilityMatrix({
        projectId: activeProject.projectId,
        receipts: Array.isArray(runtimeCapabilityReceipts)
          ? runtimeCapabilityReceipts
          : EMPTY_RUNTIME_CAPABILITY_RECEIPTS,
        now: runtimeCapabilityNow ?? Date.now(),
      });
    } catch {
      runtimeCapabilityMatrix = createRuntimeCapabilityMatrix({
        projectId: activeProject.projectId,
        receipts: EMPTY_RUNTIME_CAPABILITY_RECEIPTS,
        now: runtimeCapabilityNow ?? Date.now(),
      });
    }
  }
  const todayLabel = new Intl.DateTimeFormat("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date());
  const people = demoMode
    ? [
        { name: "Danie", role: "Plan owner", state: "online" },
        { name: "Mira", role: "Backend lead", state: "working" },
        { name: "Jon", role: "Frontend lead", state: "reviewing" },
      ]
    : [];
  const toggleMenu = (menu) => {
    menuTriggerRef.current = document.activeElement;
    setActionView("menu");
    setOpenMenu((current) => (current === menu ? null : menu));
  };
  useEffect(() => {
    if (!openMenu) return undefined;
    const frame = globalThis.requestAnimationFrame?.(() => {
      const target = menuPopoverRef.current?.querySelector(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      target?.focus();
    });
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpenMenu(null);
      globalThis.requestAnimationFrame?.(() => menuTriggerRef.current?.focus());
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      if (frame != null) globalThis.cancelAnimationFrame?.(frame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu]);
  const setMcpAccess = (allowed) => {
    setMcpAllowed(allowed);
    onDiagnostic(
      "mcp",
      "info",
      allowed
        ? "MCP context enabled for this session."
        : "MCP context paused for this session.",
    );
    onToast(
      allowed
        ? "MCP context allowed for this session."
        : "MCP context paused for this session.",
    );
  };
  const createInvitation = (event) => {
    event.preventDefault();
    const address = inviteEmail.trim();
    if (!/^\S+@\S+\.\S+$/.test(address)) {
      onToast("Enter a valid email address for the invitation.");
      return;
    }
    onToast(
      "Invitation drafted for " +
        address +
        " as " +
        inviteRole +
        ". Delivery connection is still required.",
    );
    setInviteEmail("");
    setActionView("menu");
    setOpenMenu(null);
  };
  const exportPlan = () => {
    if (!activeProject) {
      onToast("Select or import a project before exporting.");
      setOpenMenu(null);
      return;
    }
    const payload = {
      schemaVersion: 1,
      project: activeProject,
      workspace,
      exportedAt: new Date().toISOString(),
    };
    const href = URL.createObjectURL(
      new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `${activeProject.projectId}-perfect-planner.json`;
    anchor.click();
    URL.revokeObjectURL(href);
    onToast("Current project truth exported as a redacted local JSON file.");
    setOpenMenu(null);
  };
  return (
    <header className="topbar">
      <BrowserInputMarkers key={browserInput.scope} enabled={browserInput.enabled} scope={browserInput.scope} onDisable={()=>browserInput.setEnabled(false)}/>
      <div className="topbar-primary">
        <button
          className="brand-lockup brand-button"
          onClick={() => onWorkspace("home")}
          aria-label="Open Perfect Planner home"
        >
          <div className="brand-mark">PP</div>
          <div>
            <strong>Perfect Planner</strong>
            <span title={`v0.1 clean-room · ${todayLabel}`}>v0.1 clean-room · {todayLabel}</span>
          </div>
        </button>

        <ProjectTruthGate
          className="topbar-project-truth"
          projectSession={activeProject}
          provenance={
            activeProject
              ? {
                  field: "Active project",
                  value: activeProject.name,
                  projectId: activeProject.projectId,
                  generation: activeProject.generation,
                  entityId:
                    activeProject.provenance?.["project.name"]?.sourceId,
                  sourceType:
                    activeProject.provenance?.["project.name"]?.sourceType,
                  digest: activeProject.census?.digest,
                  schemaVersion: activeProject.schemaVersion,
                  revision: activeProject.registration?.registryRevision,
                  observedAt: activeProject.updatedAt,
                  adapter: activeProject.registration?.adapter,
                  authorityReason:
                    activeProject.provenance?.["project.state"]?.reason,
                }
              : null
          }
          showWorkspaceState={false}
        />

        <nav className="workspace-nav" aria-label="Build stages">
          <button
            className={
              workspace === "home"
                ? "workspace-tab home-tab active"
                : "workspace-tab home-tab"
            }
            onClick={() => onWorkspace("home")}
          >
            Home
          </button>
          {stageNavigation.map((stage) => (
            <button
              key={stage.id}
              aria-label={stage.label}
              className={
                activeStage?.id === stage.id
                  ? "workspace-tab active"
                  : "workspace-tab"
              }
              onClick={() => onWorkspace(stage.workspaces[0])}
            >
              <small>{stage.number}</small>
              {stage.label}
            </button>
          ))}
          <button
            className={
              workspace === "index"
                ? "workspace-tab index-tab active"
                : "workspace-tab index-tab"
            }
            onClick={() => onWorkspace("index")}
          >
            <MagnifyingGlassIcon /> Index
          </button>
        </nav>

        <div className="top-metrics">
          <div className="topbar-menu-anchor">
            <button
              className="top-metric-button"
              onClick={() => toggleMenu("developers")}
              aria-expanded={openMenu === "developers"}
            >
              <UsersThreeIcon />{" "}
              {demoMode
                ? `${people.length} developers`
                : "Roster not connected"}{" "}
              <CaretDownIcon />
            </button>
            {openMenu === "developers" && (
              <div
                ref={menuPopoverRef}
                className="topbar-popover developer-popover"
                role="dialog"
                aria-label="Developer roster"
              >
                <header>
                  <strong>People on this project</strong>
                  <span>
                    {people.length
                      ? `${people.length} sample people · ${DEMO_ONLY_REASON}`
                      : "No roster connected"}
                  </span>
                </header>
                {!people.length && (
                  <div className="popover-empty">
                    <strong>No people connected</strong>
                    <small>
                      Imported folder evidence does not imply organization
                      membership.
                    </small>
                    <button
                      onClick={() => {
                        onWorkspace("allocation");
                        setOpenMenu(null);
                      }}
                    >
                      Open allocation
                    </button>
                  </div>
                )}
                {people.map((person) => {
                  const meta = ownerMeta[person.name];
                  return (
                    <button
                      key={person.name}
                      className="demo-sample-row"
                      disabled
                      title={`${DEMO_ONLY_REASON}: sample people have no profile pages.`}
                    >
                      <span
                        className="popover-avatar"
                        style={{ borderColor: meta?.color }}
                      >
                        {meta?.profileSrc ? (
                          <img src={meta.profileSrc} alt="" />
                        ) : (
                          person.name.slice(0, 1)
                        )}
                      </span>
                      <span>
                        <strong>{person.name}</strong>
                        <small>
                          {person.role} · {person.state}
                        </small>
                      </span>
                      <i />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <button
            className="top-metric-button"
            aria-haspopup="dialog"
            aria-expanded={openMenu === "actions" && actionView === "runtime"}
            onClick={() => {
              setActionView("runtime");
              setOpenMenu("actions");
            }}
          >
            <RobotIcon /> {demoMode ? "2 demo agents" : agentObservations.label}
          </button>
          <div className="topbar-menu-anchor">
            <button
              className="top-metric-button"
              onClick={() => toggleMenu("calendar")}
              aria-expanded={openMenu === "calendar"}
            >
              <CalendarDotsIcon />{" "}
              {demoMode ? <>P80&nbsp; 18 days</> : "No forecast"}{" "}
              <CaretDownIcon />
            </button>
            {openMenu === "calendar" && (
              <div
                ref={menuPopoverRef}
                className="topbar-popover calendar-popover"
                role="dialog"
                aria-label="Plan calendar"
              >
                <header>
                  <strong>Delivery window</strong>
                  <span>
                    {demoMode
                      ? "Demonstration forecast"
                      : "No authoritative forecast"}
                  </span>
                </header>
                {demoMode ? (
                  <>
                    <div className="calendar-date">
                      <small>START</small>
                      <strong>02 Sep 2026</strong>
                    </div>
                    <div className="calendar-date">
                      <small>P50</small>
                      <strong>14 Sep 2026</strong>
                    </div>
                    <div className="calendar-date">
                      <small>P80</small>
                      <strong>20 Sep 2026</strong>
                    </div>
                  </>
                ) : (
                  <p className="popover-note">
                    A folder census does not create dates. Generate and approve
                    a plan before forecasting.
                  </p>
                )}
                <button
                  onClick={() => {
                    onWorkspace("allocation");
                    setOpenMenu(null);
                  }}
                >
                  Open allocation calendar <ArrowRightIcon />
                </button>
              </div>
            )}
          </div>
          <button
            className={`top-metric-button ${demoMode ? (collisionGate.ready ? "metric-clear" : "metric-stop") : ""}`}
            onClick={() => onWorkspace("collision")}
          >
            <ShieldCheckIcon />{" "}
            {demoMode
              ? `${collisionGate.unresolved} unresolved collisions`
              : "Collision scan unavailable"}
          </button>
          <button
            className="top-metric-button topbar-connect-agent"
            aria-haspopup="dialog"
            aria-expanded={agentDrawerOpen}
            onClick={openAgentDrawer}
          >
            <PlugsConnectedIcon /> Connect agent
          </button>
          <ConnectAgentDrawer open={agentDrawerOpen} onClose={() => setAgentDrawerOpen(false)} onWorkspace={onWorkspace} />
          <div className="topbar-menu-anchor more-actions-anchor">
            <IconButton
              label="More actions"
              className="more-actions-button"
              aria-expanded={openMenu === "actions"}
              aria-haspopup="dialog"
              onClick={() => toggleMenu("actions")}
            >
              <DotsThreeIcon weight="bold" />
            </IconButton>
            {openMenu === "actions" && (
              <div
                ref={menuPopoverRef}
                className={`topbar-popover more-actions-popover ${
                  actionView === "runtime"
                    ? "runtime-connections-popover"
                    : ""
                }`}
                role="dialog"
                aria-label="More actions"
              >
                {actionView === "menu" && (
                  <>
                    <header>
                      <strong>More actions</strong>
                      <span>Organization, access, and plan controls</span>
                    </header>
                    <div className="more-actions-list">
                      <button
                        className="responsive-topbar-action"
                        onClick={() => setActionView("roster")}
                      >
                        <UsersThreeIcon />
                        <span>
                          <strong>People &amp; roster</strong>
                          <small>
                            {people.length
                              ? `${people.length} demo identities`
                              : "No roster connected"}
                          </small>
                        </span>
                        <ArrowRightIcon />
                      </button>
                      <button
                        className="responsive-topbar-action"
                        onClick={() => setActionView("schedule")}
                      >
                        <CalendarDotsIcon />
                        <span>
                          <strong>Delivery calendar</strong>
                          <small>
                            {demoMode ? "P80 · 18 days" : "No authoritative forecast"}
                          </small>
                        </span>
                        <ArrowRightIcon />
                      </button>
                      <button
                        className="responsive-topbar-action"
                        onClick={() => {
                          setActionView("runtime");
                        }}
                      >
                        <RobotIcon />
                        <span>
                          <strong>Agent connection</strong>
                          <small>{demoMode ? "2 demo agents" : agentObservations.label}</small>
                        </span>
                        <ArrowRightIcon />
                      </button>
                      <button
                        className="responsive-topbar-action"
                        onClick={() => {
                          onWorkspace("collision");
                          setOpenMenu(null);
                        }}
                      >
                        <ShieldCheckIcon />
                        <span>
                          <strong>Collision review</strong>
                          <small>
                            {demoMode
                              ? `${collisionGate.unresolved} unresolved collisions`
                              : "Collision scan unavailable"}
                          </small>
                        </span>
                        <ArrowRightIcon />
                      </button>
                      <button onClick={() => setActionView("runtime")}>
                        <ActivityIcon />
                        <span>
                          <strong>Runtime &amp; connections</strong>
                          <small>
                            {activeProject
                              ? "Project-bound capability receipts"
                              : "Select a project to evaluate runtimes"}
                          </small>
                        </span>
                        <ArrowRightIcon />
                      </button>
                      <button onClick={() => setActionView("mcp")}>
                        <RobotIcon />
                        <span>
                          <strong>MCP access</strong>
                          <small>
                            {mcpAllowed
                              ? "Context allowed · runtime connection unverified"
                              : "Paused for this session"}
                          </small>
                        </span>
                        <ArrowRightIcon />
                      </button>
                      <button
                        onClick={() => {
                          onOpenDiagnostics("errors");
                          setOpenMenu(null);
                        }}
                      >
                        <TerminalWindowIcon />
                        <span>
                          <strong>Diagnostics console</strong>
                          <small>Application, route, and MCP events</small>
                        </span>
                        <ArrowRightIcon />
                      </button>
                      <button onClick={() => setActionView("invite")}>
                        <UsersThreeIcon />
                        <span>
                          <strong>Invite to organization</strong>
                          <small>Add a person and choose their role</small>
                        </span>
                        <ArrowRightIcon />
                      </button>
                      <button onClick={() => setActionView("organization")}>
                        <TreeStructureIcon />
                        <span>
                          <strong>Organization settings</strong>
                          <small>Name and local workspace policy</small>
                        </span>
                        <ArrowRightIcon />
                      </button>
                      <button onClick={exportPlan}>
                        <ArrowRightIcon />
                        <span>
                          <strong>Export project receipt</strong>
                          <small>
                            Download a redacted identity and evidence snapshot
                          </small>
                        </span>
                        <ArrowRightIcon />
                      </button>
                    </div>
                  </>
                )}
                {actionView === "runtime" && (
                  <Suspense fallback={<p role="status">Opening connection tools…</p>}>
                  <RuntimeConnectionsPanel
                    onLoadError={() => onDiagnostic("runtime", "error", "Connection tools could not be downloaded. No connection check was run.", { adapter: "runtime-tools", projectId: activeProject?.projectId ?? GLOBAL_DIAGNOSTIC_PROJECT_ID, projectGeneration: activeProject?.generation ?? 0 })}
                    activeProject={activeProject}
                    onAgentObservation={agentObservations.publish}
                    onOpenProjectSetup={() => {
                      setOpenMenu(null);
                      setActionView("menu");
                      onWorkspace("structure");
                    }}
                    browserInput={browserInput}
                    matrix={runtimeCapabilityMatrix}
                    mcpContextAllowed={mcpAllowed}
                    plannerConnection={plannerConnection}
                    onCheckPlannerConnection={onCheckPlannerConnection}
                    onDisconnectPlannerConnection={onDisconnectPlannerConnection}
                    onBack={() => setActionView("menu")}
                    onOpenDiagnostics={() => {
                      onOpenDiagnostics("logs");
                      setOpenMenu(null);
                    }}
                    onAction={(eligibility, capability) => {
                      onDiagnostic(
                        "runtime",
                        "info",
                        `${eligibility.actionId} checked against ${capability.receiptId}; no runtime action was executed.`,
                      );
                      onToast(
                        `${capability.label} evidence is current. This check did not execute a runtime action.`,
                      );
                    }}
                  />
                  </Suspense>
                )}
                {actionView === "roster" && (
                  <section className="topbar-action-view">
                    <header>
                      <button
                        className="popover-back"
                        aria-label="Back to more actions"
                        onClick={() => setActionView("menu")}
                      >
                        <ArrowLeftIcon />
                      </button>
                      <span>
                        <strong>People &amp; roster</strong>
                        <small>Project membership must come from a connected organization</small>
                      </span>
                    </header>
                    {!people.length ? (
                      <p className="popover-note">
                        No roster is connected. Imported folder evidence does not imply organization membership.
                      </p>
                    ) : (
                      <div className="more-actions-list">
                        <DemoOnlyReason>sample people have no profile pages.</DemoOnlyReason>
                        {people.map((person) => (
                          <button
                            key={person.name}
                            className="demo-sample-row"
                            disabled
                            title={`${DEMO_ONLY_REASON}: sample people have no profile pages.`}
                          >
                            <UsersThreeIcon />
                            <span>
                              <strong>{person.name}</strong>
                              <small>{person.role} · {person.state}</small>
                            </span>
                            <ArrowRightIcon />
                          </button>
                        ))}
                      </div>
                    )}
                  </section>
                )}
                {actionView === "schedule" && (
                  <section className="topbar-action-view">
                    <header>
                      <button
                        className="popover-back"
                        aria-label="Back to more actions"
                        onClick={() => setActionView("menu")}
                      >
                        <ArrowLeftIcon />
                      </button>
                      <span>
                        <strong>Delivery calendar</strong>
                        <small>{demoMode ? "Demonstration forecast" : "No authoritative forecast"}</small>
                      </span>
                    </header>
                    {demoMode ? (
                      <>
                        <div className="calendar-date"><small>START</small><strong>02 Sep 2026</strong></div>
                        <div className="calendar-date"><small>P50</small><strong>14 Sep 2026</strong></div>
                        <div className="calendar-date"><small>P80</small><strong>20 Sep 2026</strong></div>
                      </>
                    ) : (
                      <p className="popover-note">
                        A folder census does not create dates. Generate and approve a plan before forecasting.
                      </p>
                    )}
                    <button
                      className="popover-primary"
                      onClick={() => {
                        onWorkspace("allocation");
                        setOpenMenu(null);
                      }}
                    >
                      Open allocation calendar <ArrowRightIcon />
                    </button>
                  </section>
                )}
                {actionView === "mcp" && (
                  <section className="topbar-action-view">
                    <header>
                      <button
                        className="popover-back"
                        aria-label="Back to more actions"
                        onClick={() => setActionView("menu")}
                      >
                        <ArrowLeftIcon />
                      </button>
                      <span>
                        <strong>MCP access</strong>
                        <small>Perfect Planner local bridge</small>
                      </span>
                    </header>
                    <div className="mcp-access-card">
                      <span>
                        <i className={mcpAllowed ? "online" : "paused"} />
                        <strong>
                          {mcpAllowed
                            ? "Permission allowed · connection unverified"
                            : "Paused"}
                        </strong>
                      </span>
                      <small>
                        This switch records a session preference only. A
                        timestamped runtime capability receipt is still required
                        before Perfect Planner may claim any MCP connection.
                      </small>
                    </div>
                    <label className="organization-switch">
                      <span>
                        <strong>Allow MCP context in this session</strong>
                        <small>
                          The Codex host remains the real permission boundary
                        </small>
                      </span>
                      <input
                        type="checkbox"
                        checked={mcpAllowed}
                        onChange={(event) => setMcpAccess(event.target.checked)}
                      />
                    </label>
                    <button className="popover-primary" onClick={openAgentDrawer}>
                      Set up an agent connection <ArrowRightIcon />
                    </button>
                  </section>
                )}
                {actionView === "invite" && (
                  <form
                    className="topbar-action-view"
                    onSubmit={createInvitation}
                  >
                    <header>
                      <button
                        type="button"
                        className="popover-back"
                        aria-label="Back to more actions"
                        onClick={() => setActionView("menu")}
                      >
                        <ArrowLeftIcon />
                      </button>
                      <span>
                        <strong>Invite to organization</strong>
                        <small>Create a delivery-ready invitation draft</small>
                      </span>
                    </header>
                    <label className="popover-field">
                      <span>EMAIL ADDRESS</span>
                      <input
                        type="email"
                        value={inviteEmail}
                        onChange={(event) => setInviteEmail(event.target.value)}
                        placeholder="name@company.com"
                        required
                      />
                    </label>
                    <label className="popover-field">
                      <span>ROLE</span>
                      <select
                        value={inviteRole}
                        onChange={(event) => setInviteRole(event.target.value)}
                      >
                        <option>Developer</option>
                        <option>Reviewer</option>
                        <option>Viewer</option>
                        <option>Organization admin</option>
                      </select>
                    </label>
                    <p className="popover-note">
                      No mail provider is connected yet. This creates an honest
                      invitation draft without claiming it was sent.
                    </p>
                    <button className="popover-primary" type="submit">
                      Create invitation draft <ArrowRightIcon />
                    </button>
                  </form>
                )}
                {actionView === "organization" && (
                  <section className="topbar-action-view">
                    <header>
                      <button
                        className="popover-back"
                        aria-label="Back to more actions"
                        onClick={() => setActionView("menu")}
                      >
                        <ArrowLeftIcon />
                      </button>
                      <span>
                        <strong>Organization settings</strong>
                        <small>Current local workspace</small>
                      </span>
                    </header>
                    <label className="popover-field">
                      <span>ORGANIZATION NAME</span>
                      <input
                        value={organizationName}
                        onChange={(event) =>
                          setOrganizationName(event.target.value)
                        }
                        placeholder="No organization connected"
                      />
                    </label>
                    <div className="organization-summary">
                      <span>
                        <b>{demoMode ? people.length : "—"}</b>
                        <small>people</small>
                      </span>
                      <span>
                        <b>{demoMode ? 2 : "—"}</b>
                        <small>agents</small>
                      </span>
                      <span>
                        <b>{mcpAllowed ? "ON" : "OFF"}</b>
                        <small>context</small>
                      </span>
                    </div>
                    <p className="popover-note">
                      No durable organization service is connected. This name
                      remains a local session draft.
                    </p>
                    <button
                      className="popover-primary"
                      onClick={() => {
                        onToast(
                          "Organization name kept as a session-only draft.",
                        );
                        setOpenMenu(null);
                      }}
                    >
                      Keep session draft
                    </button>
                  </section>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <WorkspaceContextBar
        workspace={workspace === "index" ? "home" : workspace}
        onWorkspace={onWorkspace}
        onToast={onToast}
        projectContext={projectContext}
        onProjectSelect={onProjectSelect}
        onOpenDemo={onOpenDemo}
      />
    </header>
  );
}

function RepositoryDrawer({
  open,
  onClose,
  onWorkspace,
  projectContext,
  onProjectSelect,
}) {
  const demoMode = isDemoProject(projectContext.activeProject);
  const dialogRef = useDialogFocus(open, onClose);
  return (
    <aside
      ref={dialogRef}
      className={`side-drawer drawer-left ${open ? "open" : ""}`}
      aria-hidden={!open}
      aria-modal={open ? "true" : undefined}
      inert={!open}
      role="dialog"
      aria-label="Project registry drawer"
    >
      <div className="drawer-header">
        <div>
          <span className="eyebrow">
            {demoMode ? "Demonstration repository" : "Project registry"}
          </span>
          <h2>
            {demoMode ? "Demo plans and workers" : "Registered local projects"}
          </h2>
        </div>
        <IconButton label="Close repository drawer" onClick={onClose}>
          <CaretLeftIcon />
        </IconButton>
      </div>
      <div className="drawer-scroll">
        {!demoMode && (
          <section
            className="project-registry-drawer"
            aria-label="Registered projects"
          >
            {!projectContext.projects.length && (
              <div className="drawer-empty-state">
                <FolderIcon />
                <strong>No registered projects</strong>
                <p>
                  Choose a local folder to create the first redacted project
                  receipt.
                </p>
              </div>
            )}
            {projectContext.projects.map((project) => {
              const status =
                project.state === "authoritative"
                  ? "verified"
                  : project.state === "unavailable"
                    ? "blocked"
                    : ["stale", "generated"].includes(project.state)
                      ? "risk"
                      : project.state === "empty"
                        ? "queued"
                        : "active";
              const censusLabel = project.census
                ? `${project.state === "stale" || project.state === "unavailable" ? "last known · " : ""}${project.census.fileCount} files`
                : "not indexed";
              return (
                <button
                  className={
                    project.projectId === projectContext.activeProjectId
                      ? "project-registry-row active"
                      : "project-registry-row"
                  }
                  key={project.projectId}
                  onClick={() => onProjectSelect(project.projectId)}
                >
                  <FolderIcon
                    weight={
                      project.projectId === projectContext.activeProjectId
                        ? "fill"
                        : "regular"
                    }
                  />
                  <span>
                    <strong>{project.name}</strong>
                    <small>
                      {project.kind === "demo"
                        ? "Demo fixtures · not imported evidence"
                        : `${project.registration?.rootLabel ?? "Local folder"} · ${censusLabel}`}
                    </small>
                    <code>{project.projectId}</code>
                  </span>
                  <StatusChip status={status}>{project.state}</StatusChip>
                </button>
              );
            })}
          </section>
        )}
        {demoMode && <DemoOnlyReason className="demo-drawer-reason">these sample plans cannot be opened.</DemoOnlyReason>}
        {demoMode &&
          repositories.map((repo) => (
            <section className="repo-group" key={repo.key}>
              <div className="repo-heading">
                <span className={`repo-key tone-${repo.tone}`}>{repo.key}</span>
                <div>
                  <strong>{repo.name}</strong>
                  <small>{repo.path}</small>
                </div>
                <span className="count-badge">{repo.count}</span>
              </div>
              {plans.slice(0, repo.key === "P" ? 2 : 1).map((plan) => (
                <button
                  className="plan-row demo-sample-row"
                  key={`${repo.key}-${plan.id}`}
                  disabled
                  title={`${DEMO_ONLY_REASON}: this sample plan cannot be opened.`}
                >
                  <span className="plan-row-top">
                    <strong>{plan.id}</strong>
                    <StatusChip
                      status={
                        plan.state === "blocked"
                          ? "blocked"
                          : plan.state === "queued"
                            ? "queued"
                            : "active"
                      }
                    />
                  </span>
                  <span>{plan.name}</span>
                  <small>
                    {plan.owner} · {plan.progress}
                  </small>
                </button>
              ))}
            </section>
          ))}
        {demoMode && (
          <section className="document-ledger">
            <div className="section-title">
              <ListChecksIcon />
              <strong>Source document ledger</strong>
              <span>{documentLedger.length}</span>
            </div>
            {documentLedger.map((document) => (
              <div className="document-row" key={document.id}>
                <code>{document.id}</code>
                <span>
                  <strong>{document.name}</strong>
                  <small>{document.progress}</small>
                </span>
                <StatusChip
                  status={
                    document.state === "built"
                      ? "ready"
                      : document.state === "queued"
                        ? "queued"
                        : "verified"
                  }
                >
                  {document.state}
                </StatusChip>
              </div>
            ))}
          </section>
        )}
      </div>
      <div className="drawer-footer">
        <button
          className="soft-button"
          onClick={() => {
            onClose();
            onWorkspace(demoMode ? "blueprint" : "structure");
          }}
        >
          <PlusIcon /> {demoMode ? "New demo plan" : "Add project"}
        </button>
        <button
          className="soft-button"
          onClick={() => {
            onClose();
            onWorkspace(demoMode ? "index" : "home");
          }}
        >
          <MagnifyingGlassIcon /> {demoMode ? "Find demo item" : "Project home"}
        </button>
      </div>
    </aside>
  );
}

// Demo inspector shows only fields the selected sample item actually carries.
function demoInspectorProperties(selected) {
  const missing = "Not recorded in the sample";
  return [
    ["Owner", selected.owner ?? missing],
    ["Branch", selected.branch ?? missing],
    ["Repository", selected.repository ?? missing],
    ["Depends on", selected.dependency ?? missing],
    ["Files", Array.isArray(selected.files) && selected.files.length ? selected.files.join(" · ") : missing],
  ];
}

export function InspectorDrawer({ open, onClose, selected, side = "right", demoMode = false }) {
  const dialogRef = useDialogFocus(open, onClose);
  if (!selected) return null;
  if (!demoMode) return (
    <aside ref={dialogRef} className={`side-drawer drawer-${side} inspector-drawer ${open ? "open" : ""}`} aria-hidden={!open} aria-modal={open ? "true" : undefined} inert={!open} role="dialog" aria-label="Project evidence inspector">
      <div className="drawer-header"><div><span className="eyebrow">Project evidence</span><h2>{selected.id} · {selected.title}</h2></div><IconButton label="Close inspector" onClick={onClose}>{side === "left" ? <CaretLeftIcon /> : <CaretRightIcon />}</IconButton></div>
      <div className="drawer-scroll inspector-body">
        <p>Recorded context only. Discovery findings and review questions are not assigned work, execution proof, or architecture approval.</p>
        {selected.estimate && <p>{selected.estimate}</p>}
        <section className="inspector-section"><h3>Findings and review questions</h3>
          {selected.items?.length ? <ul>{selected.items.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul> : <p>No detailed evidence was supplied for this selection.</p>}
        </section>
        <p>No owner, branch, worktree, dependencies, or proof requirements are inferred here.</p>
      </div>
    </aside>
  );
  const proofReady =
    selected.status === "verified" &&
    Boolean(selected.proof?.screenshot && selected.proof?.diff);
  const proofImage =
    selected.proof?.screenshot ??
    selected.image ??
    "/assets/evidence/selected-spine-canvas.png";
  const checklist = selected.items?.length
    ? selected.items
    : ["Exact claim surface", "Collision scan", "Safe merge order", "Proof complete"];
  return (
    <aside
      ref={dialogRef}
      className={`side-drawer drawer-${side} inspector-drawer ${open ? "open" : ""}`}
      aria-hidden={!open}
      aria-modal={open ? "true" : undefined}
      inert={!open}
      role="dialog"
      aria-label="Work item inspector"
    >
      <div className="drawer-header">
        <div>
          <span className="eyebrow">Inspector</span>
          <h2>
            {selected.id} · {selected.title}
          </h2>
        </div>
        <IconButton label="Close inspector" onClick={onClose}>
          {side === "left" ? <CaretLeftIcon /> : <CaretRightIcon />}
        </IconButton>
      </div>
      <div className="drawer-scroll inspector-body">
        <div className="inspector-summary">
          <StatusChip status={selected.status} />
          <span>{selected.estimate ?? "No estimate in the sample"}</span>
        </div>
        <DemoOnlyReason>this item comes from the sample project; nothing here describes real work.</DemoOnlyReason>
        <dl className="property-list">
          {demoInspectorProperties(selected).map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <section className="inspector-section">
          <div className="section-title">
            <ListChecksIcon />
            <strong>Proof-gated must-haves</strong>
            <span>{proofReady ? `${checklist.length}/${checklist.length}` : `0/${checklist.length} proven`}</span>
          </div>
          {!proofReady && (
            <p className="demo-inspector-status-note">
              {selected.status === "ready" || selected.status === "active"
                ? `Status "${statusLabel[selected.status] ?? selected.status}" means this sample work can start or is under way. None of its checks are proven yet.`
                : "None of these sample checks are proven yet."}
            </p>
          )}
          {checklist.map((item, index) => (
            <div
              className={`proof-requirement ${proofReady ? "proof-ready" : "proof-blocked"}`}
              key={item}
            >
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={proofReady}
                  readOnly
                  disabled={!proofReady}
                />
                <span>
                  <code>
                    {selected.id}:{index + 1}
                  </code>
                  {item}
                </span>
                <strong className="gate-verdict">
                  {proofReady ? "Proven" : "Not proven"}
                </strong>
              </label>
              <div className="proof-pair">
                <figure className="proof-shot">
                  {proofReady ? (
                    <img
                      src={proofImage}
                      alt={`Sample screenshot for ${item}`}
                      loading="lazy"
                      decoding="async"
                      width="640"
                      height="360"
                    />
                  ) : (
                    <div className="proof-missing">
                      <CrosshairIcon /> Screenshot required
                    </div>
                  )}
                  <figcaption>
                    SCREENSHOT · {proofReady ? "sample" : "missing"}
                  </figcaption>
                </figure>
                <div className="proof-diff">
                  <span>SCOPED CODE DIFF</span>
                  <pre>
                    {proofReady
                      ? `${selected.proof.diff}\nartifact: ${selected.proof.hash}`
                      : "Diff not attached\nDependent work blocked"}
                  </pre>
                </div>
              </div>
            </div>
          ))}
        </section>
        {proofReady && (
          <section className="inspector-section">
            <div className="section-title">
              <ShieldCheckIcon />
              <strong>Reviewer</strong>
              <span>sample</span>
            </div>
            <p>{selected.proof.reviewer}</p>
          </section>
        )}
      </div>
      <div className="drawer-action">
        <button className="primary-button" disabled title={`${DEMO_ONLY_REASON}: approvals are not recorded in the Demo.`}>
          <ShieldCheckIcon weight="bold" /> Approve next gate
        </button>
        <DemoOnlyReason>approvals are not recorded in the Demo.</DemoOnlyReason>
      </div>
    </aside>
  );
}

function OwnerAvatar({ meta, isAgent, className = "" }) {
  return (
    <span
      className={`owner-avatar ${isAgent ? "agent-avatar" : "profile-avatar"} ${className}`}
    >
      {isAgent ? (
        <RobotIcon weight="fill" />
      ) : (
        <img
          className={`owner-profile-photo ${meta.profileSrc ? "individual-profile" : `profile-${meta.mockProfile ?? 0}`}`}
          src={
            meta.profileSrc ?? "/assets/profiles/mock-google-login-profiles.png"
          }
          alt=""
        />
      )}
    </span>
  );
}

function OwnerBadge({ owner = "Unallocated", labeled = false, interactive = false }) {
  const meta = ownerMeta[owner] ?? { color: "#7d8480", initials: "?" };
  const isAgent = owner.includes("Agent");
  const [profileOpen, setProfileOpen] = useState(false);
  const profileInteractive = interactive && !isAgent;
  const openProfile = () => profileInteractive && setProfileOpen(true);
  const closeProfile = () => setProfileOpen(false);
  return (
    <span
      className={`owner-badge ${labeled ? "labeled" : ""}`}
      style={{ "--owner-color": meta.color }}
      title={owner}
      role={profileInteractive ? "button" : undefined}
      tabIndex={profileInteractive ? 0 : undefined}
      aria-label={profileInteractive ? `View ${owner} profile` : undefined}
      aria-haspopup={profileInteractive ? "dialog" : undefined}
      aria-expanded={profileInteractive ? profileOpen : undefined}
      data-open={profileOpen ? "true" : "false"}
      onMouseEnter={openProfile}
      onMouseLeave={closeProfile}
      onFocus={openProfile}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) closeProfile();
      }}
      onClick={(event) => {
        if (!profileInteractive) return;
        event.preventDefault();
        event.stopPropagation();
        setProfileOpen((value) => !value);
      }}
      onKeyDown={(event) => {
        if (!profileInteractive) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          setProfileOpen((value) => !value);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeProfile();
        }
      }}
    >
      <OwnerAvatar meta={meta} isAgent={isAgent} />
      {!isAgent && (
        <span
          className="owner-profile-popover"
          role={profileInteractive ? "dialog" : undefined}
          aria-label={profileInteractive ? `${owner} profile` : undefined}
          aria-hidden={!profileInteractive || !profileOpen}
        >
          <OwnerAvatar
            meta={meta}
            isAgent={false}
            className="profile-preview-avatar"
          />
          <span className="owner-profile-copy">
            <strong>{owner}</strong>
            <small>{owner === "Danie" ? "Owner" : "Developer"}</small>
            <em>Active now</em>
          </span>
        </span>
      )}
      {labeled && (
        <span>
          <strong>{owner}</strong>
          <small>{isAgent ? "agent" : "developer"}</small>
        </span>
      )}
    </span>
  );
}

function EdgeHandle({ side, label, onClick }) {
  return (
    <button
      className={`edge-handle edge-${side}`}
      onClick={onClick}
      aria-label={`Open ${label}`}
    >
      {side === "left" ? <CaretRightIcon /> : <CaretLeftIcon />}
      <span>{label}</span>
    </button>
  );
}

function PlanNode({ node, selected, onSelect }) {
  const proven = node.status === "verified";
  const working = node.status === "active";
  const [lapComplete, setLapComplete] = useState(false);
  useEffect(() => {
    if (!working) setLapComplete(false);
  }, [working]);
  const model = getModelMeta(node.model);
  const workerState = workerStateForNode(node, lapComplete);
  const workerAsset = getModelWorkerAsset(
    node.model,
    workerState,
    node.side === "right" ? "left" : "right",
  );
  const workerActivity =
    workerState === "running"
      ? "working and drawing a success lap around the card perimeter"
      : workerState === "dead-still"
        ? "stopped by a hard gate"
        : lapComplete
          ? "finished one full perimeter lap and waiting"
          : "waiting";
  return (
    <button
      className={`plan-node ${selected ? "selected" : ""} ${lapComplete ? "lap-complete" : ""}`}
      onClick={() => onSelect(node)}
    >
      {working && (
        <span
          className={`perimeter-success-trail ${lapComplete ? "complete" : "drawing"}`}
          aria-hidden="true"
        >
          <i className="trail-side trail-top" />
          <i className="trail-side trail-right" />
          <i className="trail-side trail-bottom" />
          <i className="trail-side trail-left" />
        </span>
      )}
      <span
        className={`perimeter-worker ${working && !lapComplete ? "running" : "stopped"} ${lapComplete ? "lap-finished" : ""}`}
        aria-label={`${model.label} by ${model.provider}, assigned to ${node.owner}, ${workerActivity}`}
        title={`${model.label} · ${model.provider} · ${workerActivity.toUpperCase()}`}
        onAnimationEnd={() => working && setLapComplete(true)}
      >
        <img className="model-worker-image" src={workerAsset} alt="" />
      </span>
      <span className="node-header">
        <code>{node.id}</code>
        <span
          className="node-branch-ref"
          title={`Branch: ${node.branch}`}
          aria-label={`Branch ${node.branch}`}
        >
          <GitBranchIcon />
        </span>
        <strong>{node.title}</strong>
        <span
          className="model-id-chip"
          title={`${model.label} by ${model.provider}`}
        >
          {model.label}
        </span>
        <small>{node.estimate}</small>
        <span
          className={`proof-counter ${proven ? "proven" : ""}`}
          title="Code diff proof"
        >
          <GitBranchIcon />
          {proven ? node.items.length : 0}/{node.items.length}
        </span>
        <span
          className={`proof-counter ${proven ? "proven" : ""}`}
          title="Screenshot proof"
        >
          <CrosshairIcon />
          {proven ? node.items.length : 0}/{node.items.length}
        </span>
        <OwnerBadge owner={node.owner} />
      </span>
      <span className="proof-column-labels">
        <span>DIFF</span>
        <span>SHOT</span>
        <span>TASK</span>
      </span>
      <span className="node-items">
        {node.items.map((item, index) => (
          <span className="node-item" key={item}>
            <span
              className={`tiny-check ${proven ? "checked" : ""}`}
              title={
                proven ? "Code diff proof verified" : "Code diff proof required"
              }
            />
            <span
              className={`tiny-check ${proven ? "checked" : ""}`}
              title={
                proven
                  ? "Screenshot proof verified"
                  : "Screenshot proof required"
              }
            />
            <code>
              {node.id}-{index + 1}
            </code>
            <span>{item}</span>
          </span>
        ))}
      </span>
    </button>
  );
}

function HeadOrchestrator() {
  const [chatOpen, setChatOpen] = useState(false);
  const rootRef = useRef(null);
  const activeNodes = phases
    .flatMap((phase) => phase.nodes)
    .filter((node) => node.status === "active");
  const activeLabel = activeNodes.length
    ? activeNodes.map((node) => node.id).join(", ")
    : "no workers";
  const orchestrator = getModelMeta("gpt");
  const orchestratorAsset = getModelWorkerAsset(
    "gpt",
    activeNodes.length ? "waiting" : "dead-still",
  );
  useEffect(() => {
    if (!chatOpen) return undefined;
    const closeOnOutsideClick = (event) => {
      if (!rootRef.current?.contains(event.target)) setChatOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () =>
      document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [chatOpen]);
  return (
    <div className="head-orchestrator-perch" ref={rootRef}>
      <button
        className="head-orchestrator-character"
        onClick={() => setChatOpen((value) => !value)}
        aria-expanded={chatOpen}
        aria-label={`${orchestrator.label} by ${orchestrator.provider}, head orchestrator. Open sample worker updates.`}
        title={`${orchestrator.label} · ${orchestrator.provider} · sample worker updates`}
      >
        <img className="model-worker-image" src={orchestratorAsset} alt="" />
      </button>
      {chatOpen && (
        <div className="orchestrator-popover" aria-live="polite">
          <div className="feed-heading">
            <ChatsCircleIcon weight="fill" />
            <span>
              {orchestrator.label} / {orchestrator.provider} · SAMPLE WORKER
              UPDATES
            </span>
            <small>sample</small>
          </div>
          <DemoOnlyReason>no worker is connected; these messages are examples.</DemoOnlyReason>
          <div className="relay-line relay-in">
            <span>Sample · B07 → ORCH</span>
            <strong>Success lap in progress. Collision surfaces 3/4.</strong>
          </div>
          <div className="relay-line relay-in">
            <span>Sample · B07 → ORCH</span>
            <strong>Heartbeat good. No new file claim collision.</strong>
          </div>
          <div className="relay-line relay-out">
            <span>Sample · ORCH → USER</span>
            <strong>{activeLabel} working. All other workers stopped.</strong>
          </div>
        </div>
      )}
    </div>
  );
}

function PhaseMap({ focusId, onFocus, onClose, onNodeOpen }) {
  const focused = phases.find((phase) => phase.id === focusId) ?? phases[0];
  return (
    <section className="phase-map-view" aria-label="Whole-plan phase map">
      <header className="phase-map-header">
        <button className="soft-button" onClick={onClose}>
          <ArrowLeftIcon /> Return to spine
        </button>
        <div>
          <span className="eyebrow">
            Whole-plan map · click a silver bezel to move focus
          </span>
          <h1>
            {focused.id} · {focused.title}
          </h1>
          <p>{focused.description}</p>
        </div>
        <div className="owner-legend">
          {Object.keys(ownerMeta).map((owner) => (
            <OwnerBadge key={owner} owner={owner} interactive />
          ))}
        </div>
      </header>
      <div className="phase-map-scroll">
        <div className="phase-map-board">
          <div className="phase-map-axis" aria-hidden="true" />
          {phases.map((phase, index) => {
            const active = phase.id === focused.id;
            return (
              <section
                className={`map-phase-row ${active ? "focused" : "context"}`}
                key={phase.id}
              >
                <button
                  className="map-phase-bezel"
                  onClick={() => onFocus(phase.id)}
                  aria-pressed={active}
                >
                  <span>
                    {phase.id} · {phase.title}
                  </span>
                  <small>
                    {phase.nodes.length} work packages ·{" "}
                    {
                      phase.nodes.filter((node) => node.status === "verified")
                        .length
                    }{" "}
                    proven
                  </small>
                </button>
                <div
                  className="map-branch"
                  aria-label={`${phase.title} work packages`}
                >
                  {phase.nodes.map((node) => (
                    <button
                      className={`map-node-pill side-${node.side}`}
                      key={node.id}
                      onClick={() => onNodeOpen(node)}
                    >
                      <span
                        className={`perimeter-worker map-worker ${node.status === "active" ? "running" : "stopped"}`}
                        aria-label={`${getModelMeta(node.model).label} assigned to ${node.owner}, ${node.status === "active" ? "working" : "waiting"}`}
                      >
                        <img
                          className="model-worker-image"
                          src={getModelWorkerAsset(
                            node.model,
                            workerStateForNode(node),
                            node.side === "right" ? "left" : "right",
                          )}
                          alt=""
                        />
                      </span>
                      <span className="map-node-top">
                        <code>{node.id}</code>
                        <OwnerBadge owner={node.owner} />
                        <span className="model-id-chip">
                          {getModelMeta(node.model).label}
                        </span>
                        <StatusChip status={node.status} />
                      </span>
                      <strong>{node.title}</strong>
                      {active && (
                        <small>
                          {node.items.length} proof-gated tasks ·{" "}
                          {node.estimate} · {node.owner}
                        </small>
                      )}
                    </button>
                  ))}
                </div>
                {index < phases.length - 1 && (
                  <span className="map-flow-label">
                    dependency context continues
                  </span>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function PlanWorkspace({
  selectedId,
  onNodeOpen,
  phaseFocus,
  onOpenMap,
  onCloseMap,
  collisionGate,
}) {
  const [briefOpen, setBriefOpen] = useState(false);
  const [briefCopied, setBriefCopied] = useState(false);
  const [nodeFilter, setNodeFilter] = useState("all");
  const briefRef = useRef(null);
  const canvasRef = useRef(null);
  const activeNode = phases
    .flatMap((phase) => phase.nodes.map((node) => ({ ...node, phase })))
    .find((node) => node.status === "active");
  const collisionSummary = collisionGate.ready
    ? "clear; every overlap has a ledgered order"
    : `${collisionGate.unresolved} unresolved; allocation remains blocked`;
  const nextAction = collisionGate.ready
    ? "Finish B07, attach screenshot and scoped code difference, then release B08."
    : "Open Collisions, approve every deterministic order, commit the assessment, then return to B07.";
  const handoffText = `PP-014 · Local Collaboration Workspace\nGoal: produce a collision-safe, evidence-backed build path.\nCurrent: ${activeNode?.phase.id ?? "P3"} ${activeNode?.phase.title ?? "Build Waves"} · ${activeNode?.id ?? "B07"} ${activeNode?.title ?? "Collision-safe plan capsule"}.\nOwner: ${activeNode?.owner ?? "Build Agent A"}.\nClaimed surfaces: src/plans/* and src/sync/plan.ts.\nCollision state: ${collisionSummary}.\nNext: ${nextAction}\nHard rule: no task is complete without matching screenshot and code-difference proof.`;
  useEffect(() => {
    if (!briefOpen) return undefined;
    const closeOnOutsideClick = (event) => {
      if (!briefRef.current?.contains(event.target)) setBriefOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () =>
      document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [briefOpen]);
  const movePlanPage = (direction) => {
    const scroller = canvasRef.current?.closest(".workspace-stage-coordinate") ?? canvasRef.current?.closest(".plan-workspace");
    if (!scroller) return;
    scroller.scrollBy({
      top: direction * Math.max(620, scroller.clientHeight * 0.88),
      behavior: "smooth",
    });
  };
  if (phaseFocus)
    return (
      <PhaseMap
        focusId={phaseFocus}
        onFocus={onOpenMap}
        onClose={onCloseMap}
        onNodeOpen={onNodeOpen}
      />
    );
  return (
    <section className="workspace plan-workspace" aria-label="Plan workspace">
      <div className="workspace-toolbar">
        <div className="filter-group">
          <button
            className={
              nodeFilter === "all" ? "filter-button active" : "filter-button"
            }
            onClick={() => setNodeFilter("all")}
          >
            All
          </button>
          <button
            className={
              nodeFilter === "unbuilt"
                ? "filter-button active"
                : "filter-button"
            }
            onClick={() => setNodeFilter("unbuilt")}
          >
            Unbuilt
          </button>
          <button
            className={
              nodeFilter === "untested"
                ? "filter-button active"
                : "filter-button"
            }
            onClick={() => setNodeFilter("untested")}
          >
            Untested
          </button>
          <span className="legend-dot verified" /> Built
          <span className="legend-dot tested" /> Tested
        </div>
        <div className="plan-toolbar-actions">
          <div className="quick-brief-control" ref={briefRef}>
            <button
              className="quick-brief-button"
              onClick={() => {
                setBriefOpen((value) => !value);
                setBriefCopied(false);
              }}
              aria-expanded={briefOpen}
            >
              <ListChecksIcon weight="bold" /> Quick brief <small>20 sec</small>
            </button>
            {briefOpen && (
              <section
                className="quick-brief-popover"
                aria-label="Model quick-start brief"
              >
                <header>
                  <div>
                    <span className="eyebrow">MODEL START BRIEF · PP-014</span>
                    <strong>Read once, then continue the plan</strong>
                  </div>
                  <StatusChip status="active">current</StatusChip>
                </header>
                <dl>
                  <div>
                    <dt>Goal</dt>
                    <dd>
                      Produce a collision-safe, evidence-backed build path
                      without re-analysis.
                    </dd>
                  </div>
                  <div>
                    <dt>Current</dt>
                    <dd>
                      <code>{activeNode?.phase.id ?? "P3"}</code>{" "}
                      {activeNode?.phase.title ?? "Build Waves"} ·{" "}
                      <code>{activeNode?.id ?? "B07"}</code>{" "}
                      {activeNode?.title ?? "Collision-safe plan capsule"}
                    </dd>
                  </div>
                  <div>
                    <dt>Owner</dt>
                    <dd>
                      <OwnerBadge
                        owner={activeNode?.owner ?? "Build Agent A"}
                        labeled
                        interactive
                      />
                    </dd>
                  </div>
                  <div>
                    <dt>Claims</dt>
                    <dd>
                      <code>src/plans/*</code> · <code>src/sync/plan.ts</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Collision</dt>
                    <dd>
                      <StatusChip
                        status={collisionGate.ready ? "verified" : "blocked"}
                      >
                        {collisionGate.ready ? "clear" : "blocked"}
                      </StatusChip>{" "}
                      {collisionSummary}.
                    </dd>
                  </div>
                  <div>
                    <dt>Next</dt>
                    <dd>{nextAction}</dd>
                  </div>
                  <div>
                    <dt>Hard rule</dt>
                    <dd>
                      No box closes until screenshot proof and code-difference
                      proof match.
                    </dd>
                  </div>
                </dl>
                <footer>
                  <span>Ledger: 27 sources · 17 commitments · 4 NO-GO</span>
                  <button
                    onClick={async () => {
                      await navigator.clipboard?.writeText(handoffText);
                      setBriefCopied(true);
                    }}
                  >
                    {briefCopied ? "Copied" : "Copy handoff"}
                  </button>
                </footer>
              </section>
            )}
          </div>
          <div className="integrity-chip proof-locked">
            <ShieldCheckIcon weight="fill" /> proof lock armed · 0 verified
            gates
          </div>
        </div>
      </div>
      <div className="plan-canvas" ref={canvasRef}>
        <nav
          className="plan-page-controls"
          aria-label="Move through plan pages"
        >
          <button
            onClick={() => movePlanPage(-1)}
            aria-label="Move up one plan page"
          >
            <CaretUpIcon weight="bold" />
          </button>
          <span>page</span>
          <button
            onClick={() => movePlanPage(1)}
            aria-label="Move down one plan page"
          >
            <CaretDownIcon weight="bold" />
          </button>
        </nav>
        <div className="spine-line" aria-hidden="true" />
        {phases.map((phase) => (
          <div className="phase-row" key={phase.id}>
            {phase.id === "P1" && <HeadOrchestrator />}
            <button
              className="phase-capsule"
              onClick={() => onOpenMap(phase.id)}
              aria-label={`Open ${phase.id} ${phase.title} in whole-plan map`}
            >
              <strong>
                {phase.id} · {phase.title}
              </strong>
              <span>{phase.description}</span>
              <small>
                {
                  phase.nodes.filter((node) => node.status === "verified")
                    .length
                }
                /{phase.nodes.length}
              </small>
            </button>
            <div className="phase-nodes">
              {phase.nodes
                .filter(
                  (node) =>
                    nodeFilter === "all" ||
                    (nodeFilter === "unbuilt"
                      ? !["done", "verified"].includes(node.status)
                      : node.status !== "verified"),
                )
                .map((node) => (
                  <div
                    className={`single-node-row row-${node.side}`}
                    key={node.id}
                  >
                    {node.side === "left" ? (
                      <div className="node-slot node-left has-node">
                        <PlanNode
                          node={node}
                          selected={selectedId === node.id}
                          onSelect={onNodeOpen}
                        />
                      </div>
                    ) : (
                      <div className="node-spacer" />
                    )}
                    <div className="spine-junction" aria-hidden="true" />
                    {node.side === "right" ? (
                      <div className="node-slot node-right has-node">
                        <PlanNode
                          node={node}
                          selected={selectedId === node.id}
                          onSelect={onNodeOpen}
                        />
                      </div>
                    ) : (
                      <div className="node-spacer" />
                    )}
                  </div>
                ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

const fixedIndexEntries = [
  {
    id: "GOAL-001",
    term: "Goal",
    kind: "Goal",
    locator: "Plan charter",
    description:
      "Turn a brief into a collision-safe, evidence-backed build path with honest cost, timing, risk, and proof.",
  },
  {
    id: "OUT-001",
    term: "Definitive outcome · viable path",
    kind: "Outcome",
    locator: "P1 → P2",
    description:
      "A supported go, reframe, or stop decision before architecture is frozen.",
  },
  {
    id: "OUT-002",
    term: "Definitive outcome · collision-safe delivery",
    kind: "Outcome",
    locator: "P3 → P4",
    description:
      "Every work package has an owner, dependency order, claim surface, contingency, and independent review.",
  },
  {
    id: "OUT-003",
    term: "Definitive outcome · release proof",
    kind: "Outcome",
    locator: "P5",
    description:
      "The release bundle states what passed, what remains unproven, current debt, costs, and handover limits.",
    phaseId: "P5",
  },
  {
    id: "UC-001",
    term: "Autopilot with guard rails",
    kind: "Use case",
    locator: "Whole plan",
    description:
      "Agents progress only when dependencies, collision checks, screenshot proof, and code-diff proof agree.",
  },
  {
    id: "UC-002",
    term: "Local collaboration handoff",
    kind: "Use case",
    locator: "Plan registry",
    description:
      "A local draft can be handed to another signed-in collaborator without losing provenance or order.",
  },
  {
    id: "UC-003",
    term: "Parallel developer allocation",
    kind: "Use case",
    locator: "Allocation",
    description:
      "People and agents work in parallel lanes while the planner exposes ownership and collisions.",
  },
  {
    id: "UC-004",
    term: "Peer-review CI",
    kind: "Use case",
    locator: "P4",
    description:
      "Two or three independently configured reviewers compare architecture, security, test, and debt findings.",
    phaseId: "P4",
  },
  {
    id: "MAP-001",
    term: "Whole-plan focus map",
    kind: "Mind map",
    locator: "Plan · silver phase bezel",
    description:
      "Shows the selected phase, its two work packages, and its exact position in P1–P5.",
    phaseId: "P3",
  },
  {
    id: "MAP-002",
    term: "Collision map",
    kind: "Mind map",
    locator: "B07",
    description:
      "Maps file, API, database, dependency, branch, and worktree claims before work begins.",
    nodeId: "B07",
    phaseId: "P3",
  },
  {
    id: "MAP-003",
    term: "Dependency map",
    kind: "Mind map",
    locator: "P2 → P5",
    description:
      "Separates hard prerequisites, safe parallel work, review gates, contingencies, and release order.",
    phaseId: "P2",
  },
  {
    id: "DEP-001",
    term: "Architecture contract before build",
    kind: "Dependency",
    locator: "B04 → B07/B08",
    description:
      "Build waves cannot claim files or interfaces until the architecture and plan capsule are frozen.",
    phaseId: "P2",
  },
  {
    id: "DEP-002",
    term: "Collision clearance before allocation",
    kind: "Dependency",
    locator: "B07 → Allocation",
    description:
      "Owners and dates are provisional until cross-plan and cross-repository claims have a safe order.",
    nodeId: "B07",
    phaseId: "P3",
  },
  {
    id: "DEP-003",
    term: "Proof before peer review",
    kind: "Dependency",
    locator: "P3 → P4",
    description:
      "Each completed box needs a current screenshot and scoped code difference before review can start.",
    phaseId: "P4",
  },
  {
    id: "CMP-001",
    term: "Competition and precedent comparison",
    kind: "Comparison",
    locator: "B02",
    description:
      "Compares market position, build time, team size, historic cost, running cost, and likely redundancy.",
    nodeId: "B02",
    phaseId: "P1",
  },
  {
    id: "CMP-002",
    term: "Runtime path comparison",
    kind: "Comparison",
    locator: "B03",
    description:
      "Scores PWA, web, Electron, Tauri, and native paths against the actual use case and rulebook.",
    nodeId: "B03",
    phaseId: "P2",
  },
];

const indexStatusCompletion = {
  verified: 100,
  done: 100,
  active: 55,
  ready: 30,
  risk: 20,
  blocked: 0,
  queued: 0,
};
const fixedIndexCompletion = {
  Goal: 100,
  Outcome: 45,
  "Use case": 35,
  "Mind map": 75,
  Dependency: 60,
  Comparison: 40,
};
const projectIndexEntries = [
  ...fixedIndexEntries.map((entry) => ({
    ...entry,
    completion: fixedIndexCompletion[entry.kind] ?? 0,
    worker: "Danie + Codex",
  })),
  ...phases.map((phase) => ({
    id: phase.id,
    term: phase.title,
    kind: "Stage",
    locator: phase.id,
    description: phase.description,
    phaseId: phase.id,
    completion: Math.round(
      phase.nodes.reduce(
        (sum, node) => sum + (indexStatusCompletion[node.status] ?? 0),
        0,
      ) / phase.nodes.length,
    ),
    worker: [...new Set(phase.nodes.map((node) => node.owner))].join(" + "),
  })),
  ...phases.flatMap((phase) =>
    phase.nodes.map((node) => ({
      id: node.id,
      term: node.title,
      kind: "Work package",
      locator: `${phase.id} · ${node.side} of spine`,
      description: `${node.items.length} proof-gated tasks · ${node.estimate}`,
      phaseId: phase.id,
      nodeId: node.id,
      completion: indexStatusCompletion[node.status] ?? 0,
      worker: node.owner,
    })),
  ),
  ...journeySteps.map((step) => ({
    id: step.id,
    term: step.title,
    kind: "Screen",
    locator: `${step.route} · Evidence journey`,
    description: `Depends on ${step.dependency} · ${step.notes}`,
    evidenceJourneyId: step.id,
    completion: step.completion,
    worker: "Codex",
  })),
  ...evidenceNodes.map((node, index) => ({
    id: `SHOT-${String(index + 1).padStart(3, "0")}`,
    term: node.title,
    kind: "Screenshot",
    locator: `${node.phase} · Evidence`,
    description: node.note,
    evidenceId: node.id,
    completion: indexStatusCompletion[node.status] ?? 0,
    worker: "Codex",
  })),
  ...documentLedger.map((document) => ({
    id: document.id,
    term: document.name,
    kind: "Reference",
    locator: "To-do / Ledger",
    description: document.progress,
    documentId: document.id,
    completion:
      document.state === "built" ? 100 : document.state === "traced" ? 65 : 0,
    worker: document.state === "built" ? "Codex" : "Danie + Codex",
  })),
].sort((a, b) => a.term.localeCompare(b.term));

function WorkspaceContextBar({
  workspace,
  onWorkspace,
  onToast,
  projectContext,
  onProjectSelect,
  onOpenDemo,
}) {
  const context = workspaceContext[workspace] ?? workspaceContext.home;
  const activeProject = projectContext.activeProject;
  const demoMode = isDemoProject(activeProject);
  const displayedContext = demoMode
    ? context
    : activeProject
      ? {
          purpose: `Inspect ${activeProject.name} using only project-scoped evidence.`,
          outcome: `Every result remains bound to ${activeProject.projectId}.`,
          unlock: activeProject.census
            ? `Generate and approve ${workspaceLabels[workspace] ?? "workspace"} evidence.`
            : "Run or recover the read-only folder census.",
        }
      : {
          purpose: "Choose a local app folder without inventing project facts.",
          outcome: "One stable project identity and a redacted census receipt.",
          unlock: "Add a project folder or open the clearly labelled Demo.",
        };
  const stage = stageNavigation.find((item) => item.id === context.stage);
  const subpages = stage?.workspaces ?? [];
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const projectMenuButtonRef = useRef(null);
  const projectMenuRef = useRef(null);
  const projects = projectContext.projects;
  const activeProjectId = projectContext.activeProjectId;
  const selectProject = (project) => {
    onProjectSelect(project.projectId);
    setProjectMenuOpen(false);
    onToast?.(`${project.name} selected.`);
  };
  useEffect(() => {
    if (!projectMenuOpen) return undefined;
    const frame = globalThis.requestAnimationFrame?.(() => {
      projectMenuRef.current?.querySelector("button")?.focus();
    });
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setProjectMenuOpen(false);
      globalThis.requestAnimationFrame?.(() => projectMenuButtonRef.current?.focus());
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      if (frame != null) globalThis.cancelAnimationFrame?.(frame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [projectMenuOpen]);
  return (
    <section
      className="workspace-context"
      aria-label="Current workspace context"
    >
      <div className="project-tab-system">
        <div className="project-folder-anchor">
          <button
            ref={projectMenuButtonRef}
            className="project-folder-button"
            type="button"
            aria-label="Open project folders"
            aria-expanded={projectMenuOpen}
            onClick={() => setProjectMenuOpen((open) => !open)}
          >
            <FolderIcon weight="duotone" />
            <PlusIcon weight="bold" />
          </button>
          {projectMenuOpen && (
            <div
              ref={projectMenuRef}
              className="project-folder-menu"
              role="dialog"
              aria-label="Project folders"
            >
              <header>
                <strong>Project folders</strong>
                <small>Open or add a local workspace</small>
              </header>
              {!projects.length && (
                <p className="project-folder-empty">
                  No project has been imported on this device.
                </p>
              )}
              {projects.map((project) => (
                <button
                  type="button"
                  key={project.projectId}
                  className={
                    activeProjectId === project.projectId ? "active" : ""
                  }
                  onClick={() => selectProject(project)}
                >
                  <span className={`project-folder-key state-${project.state}`}>
                    {project.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span>
                    <strong>{project.name}</strong>
                    <small>
                      {project.kind === "demo"
                        ? "Demo fixtures · not imported evidence"
                        : `${project.registration?.rootLabel ?? "Local folder"} · ${project.state}`}
                    </small>
                  </span>
                  {activeProjectId === project.projectId && (
                    <CheckCircleIcon weight="fill" />
                  )}
                </button>
              ))}
              <button
                type="button"
                className="add-project-folder"
                onClick={() => {
                  setProjectMenuOpen(false);
                  onWorkspace("structure");
                }}
              >
                <PlusIcon /> Add another project folder
              </button>
              {!projects.some((project) => project.kind === "demo") && (
                <button
                  type="button"
                  className="add-project-folder demo-project-entry"
                  onClick={() => {
                    setProjectMenuOpen(false);
                    onOpenDemo();
                  }}
                >
                  <RobotIcon /> Open clearly labelled Demo
                </button>
              )}
            </div>
          )}
        </div>
        <nav className="project-tabs" aria-label="Open projects">
          {!projects.length && (
            <button
              type="button"
              className="empty active"
              onClick={() => onWorkspace("structure")}
              title="Import a local app folder"
            >
              <FolderIcon />
              <span>No project selected</span>
            </button>
          )}
          {projects.map((project) => (
            <button
              type="button"
              key={project.projectId}
              className={activeProjectId === project.projectId ? "active" : ""}
              onClick={() => selectProject(project)}
              title={
                project.kind === "demo"
                  ? "Explicit demonstration project"
                  : (project.registration?.rootLabel ?? project.name)
              }
            >
              <FolderIcon />
              <span>
                {project.name}
                {project.kind === "demo" ? " · Demo" : ""}
              </span>
            </button>
          ))}
        </nav>
      </div>
      <div className="workspace-intent">
        <span>
          <small>PURPOSE</small>
          {displayedContext.purpose}
        </span>
        <span>
          <small>REQUIRED OUTCOME</small>
          {displayedContext.outcome}
        </span>
        <span>
          <small>UNLOCK NEXT</small>
          {displayedContext.unlock}
        </span>
      </div>
      <div className="workspace-route-controls">
        <div className="workspace-breadcrumb">
          <span>{stage ? `${stage.number} · ${stage.label}` : "Project"}</span>
          <CaretRightIcon />
          <strong>{workspaceLabels[workspace] ?? "Project Home"}</strong>
        </div>
        {subpages.length > 1 && stage.id !== "coordinate" && (
          <WorkspacePageNavigation stage={stage} workspace={workspace} onWorkspace={onWorkspace} />
        )}
      </div>
    </section>
  );
}

function WorkspacePageNavigation({ stage, workspace, onWorkspace }) {
  return <nav className={`stage-subnav stage-subnav-${stage.id}`} aria-label={`${stage.label} pages`}>
    {stage.workspaces.map((item) => <button type="button" key={item} className={workspace === item ? "active" : ""} aria-current={workspace === item ? "page" : undefined} onClick={() => onWorkspace(item)}>{workspaceLabels[item]}</button>)}
  </nav>;
}

function ProjectHomeWorkspace({
  collisionGate,
  intakeSummary,
  onWorkspace,
  activeProject,
  onOpenDemo,
}) {
  const projectContext = useOptionalProject();
  const architectureRefresh = projectContext?.architectureRefreshStatus;
  const folderRefresh = projectContext?.folderRefreshStatus;
  const componentRefresh = projectContext?.componentRefreshStatus;
  const planRefresh = projectContext?.planRefreshStatus;
  const demoMode = isDemoProject(activeProject);
  const workRecords = useProjectWorkRecords(demoMode ? null : activeProject?.projectId);
  usePlanTaskDriftWatch(activeProject, workRecords);
  const [homeActionError, setHomeActionError] = useState("");
  const homeModel = useMemo(
    () => deriveProjectHomeModel(activeProject, workRecords),
    [activeProject, workRecords],
  );
  const runHomeNextAction = (nextAction) => {
    setHomeActionError("");
    if (nextAction.id !== "confirm-project-ready") return onWorkspace(nextAction.workspace);
    try { confirmProjectReady(activeProject.projectId); } catch (error) { setHomeActionError(error?.message ?? "The confirmation could not be saved."); }
  };
  if (!demoMode) {
    const { binding, blockers, mode, nextAction, project, stage, summary } =
      homeModel;
    const hasProject = mode !== "empty";
    const unavailableValue = (value, state, suffix = "") => {
      if (value == null || state === "unavailable") return "Unavailable";
      const displayed = `${value}${suffix}`;
      return state === "stale" ? `Last known · ${displayed}` : displayed;
    };
    const digestValue = (value, state) =>
      unavailableValue(value ? value.slice(0, 12) : null, state);
    const verdictClass =
      stage.state === "ready"
        ? "truth-current"
        : ["empty", "blocked", "review", "stale", "unavailable"].includes(
              stage.state,
            )
          ? "truth-attention"
          : "truth-observed";
    const statusTone =
      stage.state === "ready"
        ? "verified"
        : ["blocked", "stale", "unavailable"].includes(stage.state)
          ? "risk"
          : stage.state === "review"
            ? "active"
            : "queued";
    return (
      <section
        className="workspace project-home-workspace project-home-truth"
        aria-label="Project Home workspace"
        data-home-mode={mode}
        data-home-project-id={binding.projectId ?? ""}
        data-home-generation={binding.sessionGeneration ?? ""}
      >
        <header className="project-home-hero">
          <div>
            <span className="eyebrow">
              {hasProject
                ? `${project.projectId} · scan ${project.generation} · ${mode}`
                : "No project selected · honest empty state"}
            </span>
            <h1>
              {hasProject ? project.name : "Bring in a real app to begin"}
            </h1>
            <p>{summary.message}</p>
          </div>
          <div
            className={`home-verdict ${verdictClass}`}
            aria-label="Current project stage"
          >
            {stage.state === "ready" ? (
              <ShieldCheckIcon weight="fill" />
            ) : (
              <WarningIcon weight="fill" />
            )}
            <span>
              <small>CURRENT STAGE</small>
              <strong>{stage.label}</strong>
              <em>{stage.state} · {blockers.length} blocking item{blockers.length === 1 ? "" : "s"}</em>
            </span>
          </div>
        </header>

        <section className="project-home-next-action" aria-label="Project next action">
          <div className="project-home-action-copy">
            <small>NEXT STEP</small>
            <strong>{nextAction.label}</strong>
            <p>{nextAction.reason}</p>
            {hasProject && <span>
              Bound to {binding.projectId} · scan {binding.sessionGeneration ?? "unavailable"} · registry {binding.registryRevision ?? "unavailable"}
            </span>}
          </div>
          <div className="project-home-action-buttons">
            <button
              className="primary-button"
              data-home-next-action={nextAction.id}
              onClick={() => runHomeNextAction(nextAction)}
            >
              {nextAction.label} <ArrowRightIcon />
            </button>
            {homeActionError && <p role="alert">{homeActionError}</p>}
            <button className="soft-button" onClick={onOpenDemo}>
              Explore the explicit Demo
            </button>
          </div>
        </section>

        <section
          className="home-intake-strip"
          aria-label="Project intake evidence"
        >
          <span>
            <FolderIcon weight="duotone" />
          </span>
          <div>
            <strong>
              {summary.census.fileCount == null ||
              summary.census.state === "unavailable"
                ? hasProject
                  ? "File scan unavailable"
                  : "No app folder registered"
                : `${summary.census.state === "stale" ? "Last known · " : ""}${summary.census.fileCount} files captured`}
            </strong>
            <small>
              Skipped {unavailableValue(summary.census.skippedCount, summary.census.state)} · fingerprint {digestValue(summary.census.digest, summary.census.state)} · registry revision {unavailableValue(binding.registryRevision, summary.registration.state)}
            </small>
          </div>
          <em>
            {summary.registration.state === "unavailable"
              ? "Registration unavailable"
              : `${summary.registration.adapter} · ${summary.registration.persistence}`}
          </em>
        </section>

        <section
          className="project-start-state"
          aria-label="Project evidence summary"
        >
          <header>
            <span>
              <small>PROJECT-BOUND EVIDENCE</small>
              <strong>{stage.label}</strong>
            </span>
            <StatusChip status={statusTone}>{stage.state}</StatusChip>
          </header>
          <div className="project-home-summary-grid">
            <article data-fact-state={summary.registration.state}>
              <small>REGISTRATION</small>
              <strong>{unavailableValue(summary.registration.rootLabel, summary.registration.state)}</strong>
              <p>{unavailableValue(summary.registration.access, summary.registration.state)} · {unavailableValue(summary.registration.adapter, summary.registration.state)}</p>
              <StatusChip status={summary.registration.state === "available" ? "verified" : summary.registration.state === "unavailable" ? "risk" : "active"}>{summary.registration.state}</StatusChip>
            </article>
            <article data-fact-state={summary.census.state}>
              <small>FOLDER SCAN</small>
              <strong>{unavailableValue(summary.census.fileCount, summary.census.state, " files")}</strong>
              <p>{unavailableValue(summary.census.skippedCount, summary.census.state, " skipped")} · fingerprint {digestValue(summary.census.digest, summary.census.state)}</p>
              <StatusChip status={summary.census.state === "available" ? "verified" : summary.census.state === "unavailable" || summary.census.state === "blocked" ? "risk" : "active"}>{summary.census.state}</StatusChip>
            </article>
            <article data-fact-state={summary.discovery.state}>
              <small>DISCOVERY</small>
              <strong>{unavailableValue(summary.discovery.observed, summary.discovery.state, " observed")}</strong>
              <p>{unavailableValue(summary.discovery.signals, summary.discovery.state, " review signals")} · {unavailableValue(summary.discovery.unanswered, summary.discovery.state, " unanswered")}</p>
              <StatusChip status={summary.discovery.state === "available" ? "verified" : summary.discovery.state === "unavailable" || summary.discovery.state === "stale" ? "risk" : "active"}>{summary.discovery.state}</StatusChip>
            </article>
            <article className="project-home-authorities">
              <small>SAVED RECORDS</small>
              <ul>
                {Object.entries(summary.authorities).map(([kind, authority]) => (
                  <li key={kind} data-fact-state={authority.state}>
                    <span>{kind === "plan" ? "Saved Plan record" : kind}</span>
                    <strong>{authority.state}</strong>
                    <em>{authority.revision == null ? "revision unavailable" : `${authority.state === "unavailable" || authority.state === "stale" ? "last known · " : ""}revision ${authority.revision}`}</em>
                  </li>
                ))}
              </ul>
            </article>
          </div>
          {activeProject?.kind === "imported" && <div className="project-home-approval-checks">
            <div aria-label="Saved architecture status">
              <p role="status">{architectureRefresh?.state === "refreshing" ? "Checking saved architecture…"
                : architectureRefresh?.state === "unavailable" ? "Saved architecture could not be checked. Any previous revision is last known, not current."
                : architectureRefresh?.state === "local-cache-unavailable" ? "Saved server state could not update the local project summary. Do not republish to fix this."
                : architectureRefresh?.state === "observed" ? "Architecture checked against the saved registry. Other approvals remain separate."
                : "Saved architecture has not been checked in this session."}</p>
              <button type="button" className="soft-button" disabled={!projectContext?.refreshArchitecture || architectureRefresh?.state === "refreshing"} onClick={() => { void projectContext?.refreshArchitecture(activeProject.projectId); }}>Refresh saved architecture</button>
            </div>
            <div aria-label="Saved folder status">
              <p role="status">{folderRefresh?.state === "refreshing" ? "Checking saved folders and their architecture revision…"
                : folderRefresh?.state === "unavailable" ? "Saved folders could not be checked. Any previous revision is last known, not current."
                : folderRefresh?.state === "stale" ? "Saved folders do not match the checked architecture. Review their binding before publishing a new revision."
                : folderRefresh?.state === "local-cache-unavailable" ? "Saved folder state could not update the local summary. Do not republish to fix this."
                : folderRefresh?.state === "observed" ? "Folder registry checked against its architecture parent. This does not create or move files."
                : "Saved folders have not been checked in this session."}</p>
              <button type="button" className="soft-button" disabled={!projectContext?.refreshFolder || folderRefresh?.state === "refreshing"} onClick={() => { void projectContext?.refreshFolder(activeProject.projectId); }}>Refresh saved folders</button>
            </div>
            <div aria-label="Saved component status">
              <p role="status">{componentRefresh?.state === "refreshing" ? "Checking saved components and their planning revisions…"
                : componentRefresh?.state === "unavailable" ? "Saved components could not be checked. Any previous revision is last known, not current."
                : componentRefresh?.state === "stale" ? "Saved components do not match the checked architecture and folders. Review their binding before publishing a new revision."
                : componentRefresh?.state === "local-cache-unavailable" ? "Saved component state could not update the local summary. Do not republish to fix this."
                : componentRefresh?.state === "observed" ? "Component registry checked against its saved planning parents. Plan approval and execution remain separate."
                : "Saved components have not been checked in this session."}</p>
              <button type="button" className="soft-button" disabled={!projectContext?.refreshComponent || componentRefresh?.state === "refreshing"} onClick={() => { void projectContext?.refreshComponent(activeProject.projectId); }}>Refresh saved components</button>
            </div>
            <div aria-label="Saved planning approval status">
              <p>Planning review check — separate from the saved Plan record above. A checked Ledger does not promote that authority or permit execution.</p>
              <p>{planRefresh?.state === "observed" && planRefresh.projectId === activeProject.projectId && planRefresh.rootIdentity === activeProject.registration?.rootIdentity && planRefresh.censusDigest === activeProject.census?.digest && !["stale", "unavailable"].includes(activeProject.state)
                ? `Checked planning approval revision ${planRefresh.revision} · saved Ledger revision ${planRefresh.ledgerRevision}. No execution or completion is authorized.`
                : planRefresh?.state === "refreshing" ? "Checking the saved plan and its complete Ledger…"
                : planRefresh?.state === "pending" ? "An original planning request needs reconciliation in Ledger."
                : planRefresh?.state === "unfinished" ? "Unfinished editor text needs recovery or an explicit decision in Ledger."
                : planRefresh?.state === "missing" ? "No saved planning approval. Review the complete Ledger."
                : planRefresh?.state === "unavailable" ? "Planning approval could not be checked. Previous history is not current."
                : "Planning approval is not checked for the current saved Ledger and references."}</p>
              <button type="button" className="soft-button" disabled={!projectContext?.refreshPlan || planRefresh?.state === "refreshing"} onClick={() => { void projectContext?.refreshPlan(activeProject.projectId); }}>Check planning approval</button>
              <button type="button" className="soft-button" onClick={() => onWorkspace("ledger")}>Review complete Ledger</button>
            </div>
          </div>}
        </section>

        <div className="project-home-resolution-grid">
          <section className="project-home-blockers" aria-label="Project blockers">
            <header>
              <span>
                <small>BLOCKING ITEMS</small>
                <strong>{blockers.length ? `${blockers.length} item${blockers.length === 1 ? "" : "s"} prevent promotion` : "No blockers for this revision"}</strong>
              </span>
            </header>
            {blockers.length ? (
              <ol>
                {blockers.map((item) => (
                  <li key={item.id} data-blocker-state={item.state}>
                    <code>{item.id}</code>
                    <span><strong>{item.scope}</strong><small>{item.reason}</small></span>
                    <StatusChip status={item.state === "unavailable" || item.state === "blocked" || item.state === "stale" ? "risk" : "active"}>{item.state}</StatusChip>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="project-home-no-blockers">All required records are current for this project scan.</p>
            )}
          </section>

        </div>
      </section>
    );
  }
  const nodeScore = (status) =>
    status === "verified" || status === "done"
      ? 100
      : status === "active"
        ? 50
        : status === "ready"
          ? 25
          : 0;
  const phaseProgress = phases.map((phase) =>
    Math.round(
      phase.nodes.reduce((sum, node) => sum + nodeScore(node.status), 0) /
        phase.nodes.length,
    ),
  );
  const stageProgress = [
    Math.round((phaseProgress[0] + phaseProgress[1]) / 2),
    phaseProgress[2],
    collisionGate.ready ? phaseProgress[2] : 0,
    phaseProgress[3],
    phaseProgress[4],
  ];
  const journeyCompletion = Math.round(
    journeySteps.reduce((sum, step) => sum + step.completion, 0) /
      journeySteps.length,
  );
  const activeWorkers = phases
    .flatMap((phase) => phase.nodes)
    .filter((node) => node.status === "active");
  const execution = deriveExecutionMap(guaranteeManifest);
  return (
    <section
      className="workspace project-home-workspace"
      aria-label="Project Home workspace"
    >
      <header className="project-home-hero">
        <div>
          <span className="eyebrow">
            PP-014 · single source of project truth
          </span>
          <h1>Local Collaboration Workspace</h1>
          <p>
            Plan and coordinate private local work without forcing Git, while
            keeping optional branches, worktrees, peer review, and CI available
            when a repository needs them.
          </p>
        </div>
        <div className="home-verdict">
          <WarningIcon weight="fill" />
          <span>
            <small>CURRENT VERDICT</small>
            <strong>BLOCKED BEFORE BUILD</strong>
            <em>{collisionGate.unresolved} collision claims need an order</em>
          </span>
        </div>
      </header>

      <section
        className="home-intake-strip"
        aria-label="Bring an app into Perfect Planner"
      >
        <span>
          <FolderIcon weight="duotone" />
        </span>
        <div>
          <strong>
            {intakeSummary
              ? `${intakeSummary.fileCount} files captured`
              : "Bring in your existing app"}
          </strong>
          <small>
            {intakeSummary
              ? `${intakeSummary.skippedCount} skipped · structure mapping ${intakeSummary.structureCompletion ?? "locked"}${intakeSummary.structureCompletion == null ? " until architecture approval" : "%"}`
              : "Select one local folder, approve a read-only index, then map every file to the numbered plan."}
          </small>
        </div>
        <em>
          {intakeSummary
            ? `Workspace ${intakeSummary.workspaceId}`
            : "Nothing moves during intake"}
        </em>
        <button
          className="primary-button"
          onClick={() => onWorkspace("structure")}
        >
          <FolderIcon /> {intakeSummary ? "Review intake" : "Drop your app"}{" "}
          <ArrowRightIcon />
        </button>
      </section>

      <section className="home-stage-map" aria-label="Project stage progress">
        {stageNavigation.map((stage, index) => (
          <button
            key={stage.id}
            className={`home-stage ${index === 1 ? "current" : ""} ${stageProgress[index] === 100 ? "complete" : ""}`}
            onClick={() => onWorkspace(stage.workspaces[0])}
          >
            <span>{stage.number}</span>
            <div>
              <strong>{stage.label}</strong>
              <small>{stageProgress[index]}% ledgered</small>
            </div>
            <div className="home-stage-progress">
              <i style={{ width: `${stageProgress[index]}%` }} />
            </div>
            {stageProgress[index] === 100 ? (
              <CheckCircleIcon weight="fill" />
            ) : (
              <ArrowRightIcon />
            )}
          </button>
        ))}
      </section>

      <div className="project-home-grid">
        <section className="home-primary-card">
          <header>
            <span className="eyebrow">Exact next action</span>
            <StatusChip status="blocked">required now</StatusChip>
          </header>
          <div className="home-action-title">
            <span>B07</span>
            <div>
              <h2>Resolve the collision-safe plan capsule</h2>
              <p>
                Choose the execution order for overlapping file and interface
                claims. Allocation remains informative but cannot create work
                until this decision is recorded.
              </p>
            </div>
          </div>
          <div className="home-action-proof">
            <span>
              <strong>{collisionGate.unresolved}</strong> unresolved claims
            </span>
            <span>
              <strong>{collisionGate.ready ? 1 : 0}</strong> safe leases issued
            </span>
            <span>
              <strong>{execution.peakParallelism}</strong> derived worker lanes
            </span>
          </div>
          <button
            className="primary-button"
            onClick={() => onWorkspace("collision")}
          >
            <WarningIcon /> Resolve collisions <ArrowRightIcon />
          </button>
        </section>

        <section className="home-activity-card">
          <header>
            <span className="eyebrow">Live responsibility</span>
            <strong>{activeWorkers.length} worker active</strong>
          </header>
          <div className="home-worker-row">
            <span className="worker-avatar worker-agent">
              <RobotIcon weight="fill" />
            </span>
            <div>
              <strong>{activeWorkers[0]?.owner ?? "No active worker"}</strong>
              <small>
                {activeWorkers[0]
                  ? `${activeWorkers[0].id} · ${activeWorkers[0].title}`
                  : "No package currently active"}
              </small>
            </div>
            <StatusChip status={activeWorkers.length ? "active" : "queued"}>
              {activeWorkers.length ? "working" : "idle"}
            </StatusChip>
          </div>
          <div className="home-worker-row">
            <span className="worker-avatar">D</span>
            <div>
              <strong>Danie</strong>
              <small>Orchestrator · decision owner</small>
            </div>
            <StatusChip status="ready">waiting</StatusChip>
          </div>
          <button
            className="soft-button"
            onClick={() => onWorkspace("allocation")}
          >
            <UsersThreeIcon /> Open allocation
          </button>
        </section>

        <section className="home-proof-card">
          <header>
            <span className="eyebrow">Proof position</span>
            <strong>Not release-ready</strong>
          </header>
          <div className="home-proof-meter">
            <span style={{ width: `${journeyCompletion}%` }} />
            <strong>{journeyCompletion}%</strong>
          </div>
          <p>
            The structure and component atlas are mapped. The active build
            package still needs collision clearance, screenshot proof, and a
            scoped code difference.
          </p>
          <button
            className="soft-button"
            onClick={() => onWorkspace("evidence")}
          >
            <CrosshairIcon /> View evidence journey
          </button>
        </section>
      </div>
    </section>
  );
}

function ProjectWorkspaceGate({ workspace, activeProject, onWorkspace }) {
  const label = workspaceLabels[workspace] ?? "Workspace";
  const hasProject = Boolean(activeProject);
  const projectState = !hasProject
    ? "empty"
    : ["stale", "unavailable"].includes(activeProject.state)
      ? activeProject.state
      : "unavailable";
  const reason = !hasProject
    ? `Select or import a project before opening ${label}.`
    : activeProject.state === "stale"
      ? `${label} is blocked because this project's last-known evidence is stale.`
      : activeProject.state === "unavailable"
        ? `${label} is blocked because the project authority is unavailable.`
        : `${label} has not been generated and approved for ${activeProject.name}. Demo data is intentionally hidden.`;
  const source = activeProject?.provenance?.["project.state"];
  return (
    <section
      className="workspace project-unavailable-workspace"
      aria-label={`${label} unavailable`}
    >
      <ProjectTruthGate
        projectSession={activeProject}
        provenance={
          activeProject
            ? {
                field: `${label} availability`,
                value: projectState,
                projectId: activeProject.projectId,
                generation: activeProject.generation,
                entityId: source?.sourceId,
                sourceType: source?.sourceType,
                digest: activeProject.census?.digest,
                schemaVersion: activeProject.schemaVersion,
                revision: activeProject.registration?.registryRevision,
                observedAt: source?.observedAt ?? activeProject.updatedAt,
                adapter: activeProject.registration?.adapter,
                authorityReason: source?.reason ?? "workspace-not-generated",
              }
            : null
        }
        workspaceLabel={label}
        workspaceState={projectState}
        reason={reason}
        actionLabel={hasProject ? "Return to Structure" : "Choose app folder"}
        onAction={() => onWorkspace("structure")}
      />
      <div className="project-unavailable-explanation">
        <span className="eyebrow">TRUTHFUL WORKSPACE BOUNDARY</span>
        <h1>{label} is not ready</h1>
        <p>{reason}</p>
        <ol>
          <li>
            <strong>Project identity</strong>
            <span>{activeProject?.projectId ?? "No project selected"}</span>
          </li>
          <li>
            <strong>Available evidence</strong>
            <span>
              {activeProject?.census
                ? `${activeProject.census.fileCount} indexed files · ${activeProject.census.digest.slice(0, 12)}`
                : "No authoritative census"}
            </span>
          </li>
          <li>
            <strong>Required next proof</strong>
            <span>
              Generate this surface from the active project and attach its
              project ID, source digest, revision, and timestamp.
            </span>
          </li>
        </ol>
      </div>
    </section>
  );
}

function IndexWorkspace({ onOpen, onClose }) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("All");
  const kinds = [
    "All",
    ...new Set(projectIndexEntries.map((entry) => entry.kind)),
  ];
  const filtered = projectIndexEntries.filter((entry) => {
    const matchesKind = kind === "All" || entry.kind === kind;
    const haystack =
      `${entry.id} ${entry.term} ${entry.kind} ${entry.locator} ${entry.description}`.toLowerCase();
    return matchesKind && haystack.includes(query.trim().toLowerCase());
  });
  const grouped = filtered.reduce((groups, entry) => {
    const letter = entry.term[0].toUpperCase();
    (groups[letter] ??= []).push(entry);
    return groups;
  }, {});

  return (
    <section className="workspace index-workspace" aria-label="Project index">
      <header className="index-header">
        <div>
          <span className="eyebrow">Dictionary of the build</span>
          <h1>Project Index</h1>
          <p>
            Every goal, stage, work package, use case, map, dependency,
            comparison, screenshot, outcome, and source has one stable address.
          </p>
        </div>
        <div className="index-header-actions">
          <div className="index-stats">
            <span>
              <strong>{projectIndexEntries.length}</strong> indexed terms
            </span>
            <span>
              <strong>{phases.length}</strong> ordered stages
            </span>
            <span>
              <strong>{documentLedger.length}</strong> source references
            </span>
          </div>
          <IconButton label="Close project index" onClick={onClose}>
            <XCircleIcon />
          </IconButton>
        </div>
      </header>
      <section className="index-goal">
        <span className="index-key">GOAL-001</span>
        <div>
          <span className="eyebrow">Definitive goal</span>
          <strong>
            A local GitHub-style control plane that helps you progress and stops
            the avoidable failures.
          </strong>
          <p>
            Plans become protected change sets. Branches and worktrees become
            safe lanes. Collision, compatibility, proof, review, CI, cost, debt,
            and release truth become visible guardrails.
          </p>
        </div>
        <button
          className="soft-button"
          onClick={() => onOpen({ phaseId: "P1" })}
        >
          Start at P1 <ArrowRightIcon />
        </button>
      </section>
      <div className="index-controls">
        <div className="index-control-block">
          <strong>Search the index</strong>
          <label className="index-search">
            <MagnifyingGlassIcon />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find an ID, term, worker, dependency, or source…"
            />
          </label>
        </div>
        <div className="index-control-block">
          <strong>Filter by type</strong>
          <div
            className="index-kinds"
            role="group"
            aria-label="Index categories"
          >
            {kinds.map((item) => (
              <button
                key={item}
                className={kind === item ? "active" : ""}
                onClick={() => setKind(item)}
              >
                {item}
                <small>
                  {item === "All"
                    ? projectIndexEntries.length
                    : projectIndexEntries.filter((entry) => entry.kind === item)
                        .length}
                </small>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="index-body">
        <aside className="index-alpha" aria-label="Alphabetical index">
          {Object.keys(grouped).map((letter) => (
            <a key={letter} href={`#index-${letter}`}>
              {letter}
              <small>{grouped[letter].length}</small>
            </a>
          ))}
        </aside>
        <div className="index-register">
          {Object.entries(grouped).map(([letter, entries]) => (
            <section
              className="index-letter-group"
              id={`index-${letter}`}
              key={letter}
            >
              <div className="index-letter">
                <strong>{letter}</strong>
                <span>{entries.length} terms</span>
              </div>
              <div className="index-entries">
                {entries.map((entry) => (
                  <button
                    className="index-entry"
                    key={`${entry.kind}-${entry.id}`}
                    onClick={() => onOpen(entry)}
                  >
                    <span>
                      <code>{entry.id}</code>
                      <StatusChip
                        status={entry.kind === "Outcome" ? "verified" : "ready"}
                      >
                        {entry.kind}
                      </StatusChip>
                    </span>
                    <span>
                      <strong>{entry.term}</strong>
                      <small>{entry.description}</small>
                      <em>{entry.locator}</em>
                    </span>
                    <span className="index-entry-proof">
                      <small>
                        <strong>{entry.completion}% complete</strong>
                        <em>by {entry.worker}</em>
                      </small>
                      <ArrowRightIcon />
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))}
          {!filtered.length && (
            <div className="index-empty">
              <MagnifyingGlassIcon />
              <strong>No indexed term matches.</strong>
              <span>
                Try an ID such as B07, a stage such as P3, or a word such as
                dependency.
              </span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function BuildWorkspace({ collisionGate, onWorkspace }) {
  const stations = [
    {
      id: "01",
      label: "READY",
      state: "done",
      detail: "Contract and task scope accepted",
    },
    {
      id: "02",
      label: "CLAIMED",
      state: collisionGate.ready ? "done" : "blocked",
      detail: collisionGate.ready
        ? "Files and interfaces leased"
        : "Collision order is unresolved",
    },
    {
      id: "03",
      label: "BUILDING",
      state: "queued",
      detail: "Bounded implementation",
    },
    {
      id: "04",
      label: "SCREENSHOT",
      state: "queued",
      detail: "Current UI proof",
    },
    {
      id: "05",
      label: "CODE DIFF",
      state: "queued",
      detail: "Scoped change proof",
    },
    {
      id: "06",
      label: "REVIEW",
      state: "queued",
      detail: "Independent review",
    },
    {
      id: "07",
      label: "CI",
      state: "queued",
      detail: "Merged-state verification",
    },
    {
      id: "08",
      label: "MERGED",
      state: "queued",
      detail: "Ledgered completion",
    },
  ];
  return (
    <section className="workspace build-workspace" aria-label="Build workspace">
      <header className="build-header">
        <div>
          <span className="eyebrow">Guarded execution conveyor</span>
          <h1>Build only what the plan has cleared</h1>
          <p>
            The build surface is deliberately separate from planning. A package
            advances one station at a time; screenshot and code-difference proof
            are mandatory.
          </p>
        </div>
        <div
          className={`build-gate ${collisionGate.ready ? "clear" : "blocked"}`}
        >
          {collisionGate.ready ? (
            <CheckCircleIcon weight="fill" />
          ) : (
            <WarningIcon weight="fill" />
          )}
          <span>
            <small>ENTRY GATE</small>
            <strong>{collisionGate.ready ? "CLEAR" : "BLOCKED"}</strong>
          </span>
        </div>
      </header>

      <section className="active-build-package">
        <div className="active-package-head">
          <span className="package-id">B07</span>
          <div>
            <strong>Collision-safe plan capsule</strong>
            <small>P3 · Build Waves · owner Build Agent A</small>
          </div>
          <StatusChip status={collisionGate.ready ? "active" : "blocked"}>
            {collisionGate.ready ? "ready to claim" : "claim blocked"}
          </StatusChip>
        </div>
        <div className="build-conveyor">
          {stations.map((station, index) => (
            <div key={station.id} className={`build-station ${station.state}`}>
              <span>{station.id}</span>
              <strong>{station.label}</strong>
              <small>{station.detail}</small>
              {index < stations.length - 1 && <ArrowRightIcon />}
            </div>
          ))}
        </div>
      </section>

      <div className="build-detail-grid">
        <section>
          <header>
            <GitBranchIcon />
            <strong>Reserved change surface</strong>
          </header>
          <dl>
            <div>
              <dt>Branch</dt>
              <dd>pp/pp-014/b07</dd>
            </div>
            <div>
              <dt>Worktree</dt>
              <dd>pp-014/b07</dd>
            </div>
            <div>
              <dt>Files</dt>
              <dd>Not issued until collision clearance</dd>
            </div>
            <div>
              <dt>Interfaces</dt>
              <dd>plan-registry:v2 · collision-order:v1</dd>
            </div>
          </dl>
        </section>
        <section>
          <header>
            <ShieldCheckIcon />
            <strong>Mandatory exit proof</strong>
          </header>
          <ul>
            <li>Screenshot shows the changed user state</li>
            <li>Scoped diff names only approved files</li>
            <li>Verification command and result are attached</li>
            <li>Reviewer identity and decision are journaled</li>
          </ul>
        </section>
        <section className="build-next-action">
          <header>
            <WarningIcon />
            <strong>Why work cannot start</strong>
          </header>
          <p>
            Two workers can reach the same planned surface. The planner must
            record who goes first, what the second worker waits for, and whether
            the second package must be replanned.
          </p>
          <button
            className="primary-button"
            onClick={() => onWorkspace("collision")}
          >
            Resolve before claim <ArrowRightIcon />
          </button>
        </section>
      </div>
    </section>
  );
}

const timelineDates = [
  "2 Wed",
  "3 Thu",
  "4 Fri",
  "5 Sat",
  "6 Sun",
  "7 Mon",
  "8 Tue",
  "9 Wed",
  "10 Thu",
  "11 Fri",
  "12 Sat",
  "13 Sun",
];
const allocationPolicy = {
  roster: [
    { name: "Danie", role: "Orchestrator", type: "human", capacityHours: 6 },
    { name: "Mira", role: "Backend lead", type: "human", capacityHours: 6 },
    { name: "Jon", role: "Frontend lead", type: "human", capacityHours: 6 },
    { name: "Build Agent A", role: "Builder", type: "agent", capacityHours: 6 },
    {
      name: "Review Agent B",
      role: "Reviewer",
      type: "agent",
      capacityHours: 4,
    },
  ],
  ownerByTask: {
    B01: "Danie",
    B02: "Mira",
    B03: "Danie",
    B04: "Jon",
    B07: "Build Agent A",
    B08: "Jon",
    B09: "Review Agent B",
    B10: "Build Agent A",
  },
};

function AllocationWorkspace({ onSelect, collisionGate, onOpenCollision }) {
  const execution = useMemo(() => deriveExecutionMap(guaranteeManifest), []);
  const allocation = useMemo(
    () =>
      buildAllocationWorkspaceModel(
        guaranteeManifest,
        execution,
        collisionGate,
        allocationPolicy,
      ),
    [execution, collisionGate],
  );
  return (
    <section
      className="workspace allocation-workspace"
      aria-label="Allocation workspace"
    >
      <div className="allocation-summary">
        <span>
          <TreeStructureIcon /> {allocation.metrics.safeLanes} derived lanes
        </span>
        <span>
          <ClockIcon /> critical path{" "}
          {Math.ceil(allocation.metrics.criticalPathMinutes / 60)}h
        </span>
        <span>
          <CalendarDotsIcon /> P80 {allocation.metrics.p80Days}d
        </span>
        <span>
          <UsersThreeIcon /> {allocation.metrics.dependencyCount} dependency
          edges
        </span>
      </div>
      <div className="timeline-heading">
        <div>
          <span className="eyebrow">Sample allocation · fixed example dates</span>
          <h1>Who is doing what, and when</h1>
        </div>
        <div className="timeline-actions">
          <button
            className="soft-button"
            onClick={() =>
              onSelect({
                id: "ROSTER",
                title: "Sample delivery roster",
                status: "active",
                estimate: `${allocation.rows.length} workers`,
                items: allocation.rows.map(
                  (row) =>
                    `${row.name} · ${row.role} · ${row.assignments.length} assignments`,
                ),
              })
            }
          >
            <UsersThreeIcon /> Roster
          </button>
          <button
            className="soft-button"
            onClick={() =>
              onSelect({
                id: "CAPACITY",
                title: "Sample capacity model",
                status: "ready",
                estimate: `P80 ${allocation.metrics.p80Days} days`,
                items: allocation.rows.map(
                  (row) =>
                    `${row.name} · ${row.assignments.length} scheduled packages`,
                ),
              })
            }
          >
            <ActivityIcon /> Capacity
          </button>
        </div>
      </div>
      <div className="timeline-grid">
        <div className="timeline-corner">Worker / lane</div>
        <div className="timeline-days" title="Example dates from the sample project, not today's calendar.">
          {timelineDates.map((date) => (
            <span key={date}>{date}</span>
          ))}
        </div>
        {allocation.rows.map((row) => (
          <div className="timeline-row" key={row.name}>
            <button
              className="worker-cell"
              onClick={() =>
                onSelect({
                  id: row.assignments[0].id,
                  title: row.assignments[0].label,
                  status: row.assignments[0].status,
                  estimate: "allocated",
                })
              }
            >
              <span className={`worker-avatar worker-${row.type}`}>
                {row.type === "agent" ? (
                  <RobotIcon weight="fill" />
                ) : (
                  row.name.slice(0, 1)
                )}
              </span>
              <span>
                <strong>{row.name}</strong>
                <small>{row.role}</small>
              </span>
            </button>
            <div className="schedule-track">
              {row.assignments.map((assignment) => (
                <button
                  key={`${row.name}-${assignment.id}`}
                  className={`assignment assignment-${assignment.status}`}
                  style={{
                    gridColumn: `${assignment.start} / span ${assignment.span}`,
                  }}
                  onClick={() =>
                    onSelect({
                      ...assignment,
                      title: assignment.label,
                      estimate: `${assignment.span} days`,
                      items: [
                        `Wave ${assignment.wave} · ${assignment.lane}`,
                        assignment.dependsOn.length
                          ? `Depends on ${assignment.dependsOn.join(", ")}`
                          : "No task dependencies",
                        `Reserved branch ${assignment.branch}`,
                        `Reserved worktree ${assignment.worktree}`,
                        allocation.gitCreation.reason,
                      ],
                    })
                  }
                >
                  <code>{assignment.id}</code>
                  <span>{assignment.label}</span>
                  {assignment.status === "done" ? (
                    <CheckCircleIcon weight="fill" />
                  ) : assignment.status === "blocked" ? (
                    <XCircleIcon weight="fill" />
                  ) : assignment.status === "risk" ? (
                    <WarningIcon weight="fill" />
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div
        className={`collision-strip ${allocation.collision.clear ? "collision-strip-clear" : ""}`}
      >
        {allocation.collision.clear ? (
          <CheckCircleIcon weight="fill" />
        ) : (
          <WarningIcon weight="fill" />
        )}
        <div>
          <strong>
            {allocation.collision.clear
              ? "Collision gate clear · derived allocation is eligible"
              : `Collision gate locked · ${allocation.collision.unresolved} unresolved`}
          </strong>
          <span>
            {allocation.collision.clear
              ? `Dependencies valid · ${allocation.dependencies.criticalPath.join(" → ")} is the measured critical path.`
              : "The schedule remains visible as a blocked derivation; no branch or worktree lease may advance."}
          </span>
        </div>
        <button className="soft-button" onClick={onOpenCollision}>
          {allocation.collision.clear
            ? "View ledgered orders"
            : "Resolve collisions"}
        </button>
      </div>
      <div className="forecast-row">
        <div>
          <span>Derived tasks</span>
          <strong>
            {allocation.rows.reduce(
              (sum, row) => sum + row.assignments.length,
              0,
            )}
          </strong>
        </div>
        <div>
          <span>Derived P50</span>
          <strong>{allocation.metrics.p50Days} days</strong>
        </div>
        <div>
          <span>Derived P80</span>
          <strong>{allocation.metrics.p80Days} days</strong>
        </div>
        <div>
          <span>Git creation</span>
          <strong>{allocation.gitCreation.state}</strong>
        </div>
        <button
          className="primary-button"
          disabled
          title={allocation.gitCreation.reason}
        >
          Create branches unavailable
        </button>
      </div>
    </section>
  );
}

function IntegrityWorkspace({ collisionGate, onSelect }) {
  const [truthGeneration, setTruthGeneration] = useState({
    state: "loading",
    report: null,
    reason: "Reading the current verified generation.",
  });
  const [truthReadAttempt, setTruthReadAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    setTruthGeneration({
      state: "loading",
      report: null,
      reason: "Reading the current verified generation.",
    });
    readCurrentTruthGeneration({ signal: controller.signal })
      .then((generation) => {
        if (current) {
          setTruthGeneration({
            state: "verified",
            report: generation.report,
            generationId: generation.generationId,
            generatedAt: generation.generatedAt,
            reason: "Pointer, byte size, and SHA-256 are verified.",
          });
        }
      })
      .catch((error) => {
        if (current) {
          setTruthGeneration({
            state:
              error instanceof TruthGenerationReadError
                ? error.state
                : "unavailable",
            report: null,
            reason:
              error instanceof TruthGenerationReadError
                ? error.message
                : "The current truth generation is unavailable.",
          });
        }
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [truthReadAttempt]);
  const truthReport =
    truthGeneration.state === "verified" ? truthGeneration.report : null;
  const truthCoreValid =
    truthGeneration.state === "verified" &&
    truthReport?.journal?.valid === true &&
    truthReport?.proofRunner?.proven === true &&
    truthReport?.sessionRegistry?.valid === true &&
    truthReport?.confirmationStore?.failClosed === true;
  const execution = useMemo(() => deriveExecutionMap(guaranteeManifest), []);
  const completion = useMemo(
    () =>
      assessCompletion(
        {
          approved: true,
          openGates: collisionGate.unresolved,
          ciTier3: "grey",
          truthCoreValid,
          completenessReview: false,
          items: guaranteeItems,
        },
        guaranteeJournal,
        guaranteeArtifacts,
      ),
    [collisionGate.unresolved, truthCoreValid],
  );
  const sessionNow = Date.parse("2026-09-02T10:00:00.000Z");
  return (
    <section
      className="workspace integrity-workspace"
      aria-label="Integrity and execution guarantees"
    >
      <div className="integrity-header">
        <div>
          <span className="eyebrow">Clean-room guarantee engine</span>
          <h1>Can this plan safely continue?</h1>
          <p>
            The answer is derived from sessions, claims, dependency order,
            captured proof, merged-state CI, and the honest limits record.
          </p>
        </div>
        <div
          className={`release-verdict ${completion.ready ? "clear" : "stop"}`}
        >
          {completion.ready ? (
            <CheckCircleIcon weight="fill" />
          ) : (
            <XCircleIcon weight="fill" />
          )}
          <span>
            <small>Release verdict</small>
            <strong>{completion.ready ? "GO" : "NO-GO"}</strong>
          </span>
        </div>
      </div>

      <div className="integrity-summary">
        <div>
          <strong>{truthReport?.census?.fileCount ?? "—"}</strong>
          <span>artifacts in current census</span>
        </div>
        <div>
          <strong>
            {truthReport?.mutationGate?.totals
              ? `${truthReport.mutationGate.totals.killed}/${truthReport.mutationGate.totals.total}`
              : "—"}
          </strong>
          <span>adversarial mutations killed</span>
        </div>
        <div>
          <strong>{execution.peakParallelism}</strong>
          <span>safe parallel lanes</span>
        </div>
        <div>
          <strong>
            {completion.proven}/{completion.total}
          </strong>
          <span>proof packs accepted</span>
        </div>
        <div>
          <strong>{completion.reasons.length}</strong>
          <span>release stops</span>
        </div>
      </div>

      <div className="integrity-grid">
        <section
          className={`guarantee-panel truth-panel ${truthCoreValid ? "truth-valid" : "truth-invalid"}`}
        >
          <div className="guarantee-title">
            <HardDrivesIcon />
            <strong>Local truth core</strong>
            <span>
              {truthGeneration.state === "verified"
                ? `verified ${new Date(truthGeneration.generatedAt).toLocaleString()}`
                : truthGeneration.state === "loading"
                  ? "checking current generation"
                  : `current generation ${truthGeneration.state}`}
            </span>
          </div>
          <p className="panel-note">
            {truthGeneration.state === "verified"
              ? `Immutable generation ${truthGeneration.generationId.slice(0, 12)} passed pointer, size, and SHA-256 verification. Missing data is a stop, never a confident zero.`
              : truthGeneration.reason}
          </p>
          {truthGeneration.state !== "verified" &&
            truthGeneration.state !== "loading" && (
              <button
                className="soft-button"
                type="button"
                onClick={() => setTruthReadAttempt((attempt) => attempt + 1)}
              >
                Retry current report
              </button>
            )}
          <div className="truth-metrics">
            <span>
              <strong>{truthReport?.census?.fileCount ?? "—"}</strong> readable
              artifacts
            </span>
            <span>
              <strong>{truthReport?.journal?.entries ?? "—"}</strong> atomic
              appends
            </span>
            <span>
              <strong>{truthReport?.journal?.concurrentWriters ?? "—"}</strong>{" "}
              concurrent writers
            </span>
            <span>
              <strong>
                {truthReport?.journal?.valid === true ? "VALID" : "NO-GO"}
              </strong>{" "}
              journal chain
            </span>
            <span>
              <strong>
                {truthReport?.proofRunner?.proven === true ? "PROVEN" : "NO-GO"}
              </strong>{" "}
              guarded proof run
            </span>
            <span>
              <strong>
                {truthReport?.sessionRegistry?.valid === true
                  ? "DURABLE"
                  : "NO-GO"}
              </strong>{" "}
              session claims
            </span>
            <span>
              <strong>
                {truthReport?.ciDerivation?.state?.toUpperCase?.() ?? "GREY"}
              </strong>{" "}
              repository CI
            </span>
            <span>
              <strong>
                {truthReport?.confirmationStore?.state?.toUpperCase?.() ??
                  "NO-GO"}
              </strong>{" "}
              human decision
            </span>
            <span>
              <code>
                {truthReport?.census?.digest?.slice(0, 12) ?? "unavailable"}
              </code>{" "}
              census digest
            </span>
          </div>
        </section>
        <div className="operational-integrity-grid">
          <section className="guarantee-panel session-panel">
            <div className="guarantee-title">
              <UsersThreeIcon />
              <strong>Session truth</strong>
              <span>ACTIVE ≤ 10m</span>
            </div>
            <p className="panel-note">
              A model name is not an identity. Each worker has a session and
              heartbeat; stale claims must be inspected before they are cleared.
            </p>
            <div className="session-list">
              {guaranteeSessions.map((session) => {
                const state = classifySession(session.heartbeat, sessionNow);
                return (
                  <button
                    key={session.id}
                    className="session-row"
                    onClick={() =>
                      onSelect({
                        id: session.id,
                        title: session.actor,
                        status:
                          state === "active"
                            ? "active"
                            : state === "stale"
                              ? "risk"
                              : "queued",
                        estimate: state,
                        items: [
                          session.claim,
                          `Heartbeat ${session.heartbeat}`,
                          state === "stale"
                            ? "Inspect diff before clearing"
                            : state === "active"
                              ? "Do not claim overlapping work"
                              : "Claim released",
                        ],
                      })
                    }
                  >
                    <span className={`session-light ${state}`} />
                    <span>
                      <strong>{session.actor}</strong>
                      <code>{session.id}</code>
                    </span>
                    <span>{session.claim}</span>
                    <StatusChip
                      status={
                        state === "active"
                          ? "active"
                          : state === "stale"
                            ? "risk"
                            : "queued"
                      }
                    >
                      {state}
                    </StatusChip>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="guarantee-panel execution-panel">
            <div className="guarantee-title">
              <TreeStructureIcon />
              <strong>Positive parallel map</strong>
              <span>{execution.criticalPath.minutes}m floor</span>
            </div>
            <p className="panel-note">
              Dependencies decide waves. Overlapping write surfaces share one
              sequential lane; independent work may run beside it.
            </p>
            <div className="wave-map">
              {execution.waves.map((wave) => (
                <div className="wave-column" key={wave.wave}>
                  <strong>Wave {wave.wave}</strong>
                  {wave.lanes.map((lane) => (
                    <div className="lane" key={lane.id}>
                      <code>{lane.id}</code>
                      {lane.tasks.map((task) => (
                        <span key={task.taskId}>
                          {task.taskId} · {task.title}
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <div className="execution-foot">
              <span>
                <strong>Critical path</strong>
                {execution.criticalPath.path.join(" → ")}
              </span>
              <span>
                <strong>Hotspots</strong>
                {execution.hotspots.length
                  ? execution.hotspots
                      .map((item) => `${item.surface} (${item.touches})`)
                      .join(" · ")
                  : "none"}
              </span>
            </div>
          </section>

          <section className="guarantee-panel proof-panel">
            <div className="guarantee-title">
              <ShieldCheckIcon />
              <strong>Proof-pack integrity</strong>
              <span>typed green is refused</span>
            </div>
            <div className="proof-audit-list">
              {completion.audits.map((audit) => {
                const item = guaranteeItems.find(
                  (candidate) => candidate.id === audit.itemId,
                );
                return (
                  <button
                    key={audit.itemId}
                    className={`proof-audit ${audit.ok ? "pass" : "fail"}`}
                    onClick={() =>
                      onSelect({
                        ...item,
                        status: audit.ok ? "verified" : "blocked",
                        estimate: audit.ok ? "proof accepted" : "NO-GO",
                        items: audit.ok
                          ? [
                              "Built stamp present",
                              "Artifact hash matches",
                              "Journal run exited 0",
                              "UI screenshot viewed",
                            ]
                          : audit.fatal,
                      })
                    }
                  >
                    <span>
                      {audit.ok ? (
                        <CheckCircleIcon weight="fill" />
                      ) : (
                        <XCircleIcon weight="fill" />
                      )}
                    </span>
                    <span>
                      <code>{audit.itemId}</code>
                      <strong>{item?.title}</strong>
                      <small>
                        {audit.ok
                          ? "captured output · hash · journal · screenshot attestation"
                          : audit.fatal.join(" · ")}
                      </small>
                    </span>
                    <StatusChip status={audit.ok ? "verified" : "blocked"}>
                      {audit.ok ? "proven" : "stop"}
                    </StatusChip>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="guarantee-panel completion-panel">
            <div className="guarantee-title">
              <ListChecksIcon />
              <strong>Completion contract</strong>
              <span>never round up</span>
            </div>
            <div className="completion-counts">
              <span>
                <strong>
                  {completion.built}/{completion.total}
                </strong>{" "}
                built
              </span>
              <span>
                <strong>
                  {completion.proven}/{completion.total}
                </strong>{" "}
                proven
              </span>
              <span>
                <strong>{collisionGate.unresolved}</strong> open gates
              </span>
            </div>
            <div className="stop-list">
              {completion.reasons.map((reason, index) => (
                <div key={reason}>
                  <code>{String(index + 1).padStart(2, "0")}</code>
                  <span>{reason}</span>
                </div>
              ))}
            </div>
            <div className="unproven-box">
              <strong>WHAT IS NOT PROVEN</strong>
              <p>
                The checklist may still be incomplete. No completeness review
                has been recorded, and Tier 3 has not verified the simulated
                merged state.
              </p>
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}

const journeyOwnership = {
  J01: {
    people: "Danie · Product",
    files: ["src/PerfectPlannerShell.jsx", "src/styles.css"],
  },
  J02: {
    people: "Danie · Identity agent",
    files: ["src/node/localIdentity.mjs", "src/node/identityVault.mjs"],
  },
  J03: {
    people: "Danie · Planning agent",
    files: ["src/engine/viabilityEngine.js", "src/engine/blueprintEngine.js"],
  },
  J04: {
    people: "Mira · Research agent",
    files: [
      "src/engine/sonarEngine.js",
      "src/node/readOnlyResearchAdapter.mjs",
    ],
  },
  J05: {
    people: "Jon · Architecture agent",
    files: [
      "src/engine/rulebookEngine.js",
      "src/engine/architectureContractVerification.js",
    ],
  },
  J06: {
    people: "Build Agent A · Danie",
    files: ["src/PerfectPlannerShell.jsx", "src/engine/collisionEngine.js"],
  },
  J07: {
    people: "Jon · Build Agent A",
    files: ["src/engine/conveyorEngine.js", "src/engine/executionEngine.js"],
  },
  J08: {
    people: "Review Agent B · Mira",
    files: ["src/node/providerReview.mjs", "src/node/ciDerivation.mjs"],
  },
  J09: {
    people: "Danie · Review Agent B",
    files: ["src/node/completionReport.mjs", "src/node/evidenceBundle.mjs"],
  },
};

function EvidenceWorkspace({ selectedId, onSelect, zoom, onZoom }) {
  const [evidenceView, setEvidenceView] = useState("journey");
  const [expandedJourney, setExpandedJourney] = useState(null);
  const [calendarScale, setCalendarScale] = useState("Days");
  const [calendarPosition, setCalendarPosition] = useState(12);
  const journeyViewportRef = useRef(null);
  const selectedEvidence =
    evidenceNodes.find((node) => node.id === selectedId) ?? evidenceNodes[3];
  const averageCompletion = Math.round(
    journeySteps.reduce((sum, step) => sum + step.completion, 0) /
      journeySteps.length,
  );
  const proofCount = journeySteps.filter((step) => step.proof).length;
  return (
    <section
      className="workspace evidence-workspace"
      aria-label="Evidence canvas"
    >
      <div className="evidence-toolbar">
        <div>
          <span className="eyebrow">Journey structure + visual proof</span>
          <h1>
            {evidenceView === "journey"
              ? "PP-014 · product journey skeleton"
              : "PP-014 · screenshot proof canvas"}
          </h1>
        </div>
        <div className="canvas-legend">
          <div
            className="evidence-view-toggle"
            role="group"
            aria-label="Evidence views"
          >
            <button
              className={evidenceView === "journey" ? "active" : ""}
              onClick={() => setEvidenceView("journey")}
            >
              <TreeStructureIcon /> Journey skeleton
            </button>
            <button
              className={evidenceView === "proof" ? "active" : ""}
              onClick={() => setEvidenceView("proof")}
            >
              <CrosshairIcon /> Screenshot proof
            </button>
          </div>
          <button
            className="ledger-button"
            onClick={() =>
              onSelect({
                id: "D01",
                title: "Source document ledger",
                status: "ready",
                estimate: `${documentLedger.length} sources`,
                items: documentLedger.map(
                  (document) => `${document.id} · ${document.name}`,
                ),
              })
            }
          >
            <ListChecksIcon /> Document ledger · {documentLedger.length} sources
          </button>
          {evidenceView === "proof" && (
            <>
              <span>
                <i className="line-solid" /> verified
              </span>
              <span>
                <i className="line-dashed" /> pending
              </span>
              <span>
                <i className="line-risk" /> risk
              </span>
            </>
          )}
        </div>
      </div>
      {evidenceView === "journey" ? (
        <div className="journey-viewport" ref={journeyViewportRef}>
          <div className="journey-summary">
            <div>
              <strong>{journeySteps.length}</strong>
              <span>ordered screens</span>
            </div>
            <div>
              <strong>{averageCompletion}%</strong>
              <span>journey completion</span>
            </div>
            <div>
              <strong>
                {proofCount}/{journeySteps.length}
              </strong>
              <span>screenshot proofs</span>
            </div>
            <div>
              <strong>5 people</strong>
              <span>Danie + four assigned workers</span>
            </div>
            <div>
              <strong>18 files</strong>
              <span>declared journey surfaces</span>
            </div>
            <p>
              Completion, people, and touched files are declared per screen.
              Proof supports completion; it does not replace it.
            </p>
          </div>
          <aside
            className="journey-calendar-rail"
            aria-label="Journey calendar scrubber"
          >
            <strong>
              <CalendarDotsIcon /> Calendar
            </strong>
            <div>
              {["Months", "Weeks", "Days"].map((scale) => (
                <button
                  key={scale}
                  className={calendarScale === scale ? "active" : ""}
                  onClick={() => setCalendarScale(scale)}
                >
                  {scale}
                </button>
              ))}
            </div>
            <label>
              <span>02 Sep 2026</span>
              <input
                type="range"
                min="0"
                max="100"
                value={calendarPosition}
                onChange={(event) =>
                  setCalendarPosition(Number(event.target.value))
                }
              />
              <small>
                {String(8 + Math.round(calendarPosition / 5)).padStart(2, "0")}
                :00 AEST · {calendarScale}
              </small>
            </label>
          </aside>
          <nav
            className="journey-spine-controls"
            aria-label="Quick journey rotation"
          >
            <button
              onClick={() =>
                journeyViewportRef.current?.scrollBy({
                  top: -journeyViewportRef.current.clientHeight * 0.82,
                  behavior: "smooth",
                })
              }
              aria-label="Previous journey page"
            >
              <CaretUpIcon />
            </button>
            <button
              onClick={() =>
                journeyViewportRef.current?.scrollBy({
                  top: journeyViewportRef.current.clientHeight * 0.82,
                  behavior: "smooth",
                })
              }
              aria-label="Next journey page"
            >
              <CaretDownIcon />
            </button>
          </nav>
          <div className="journey-map">
            <div className="journey-spine" aria-hidden="true" />
            <div
              className="journey-now-line"
              style={{ top: `${170 + calendarPosition * 12}px` }}
            >
              <span>
                02 SEP 2026 ·{" "}
                {String(8 + Math.round(calendarPosition / 5)).padStart(2, "0")}
                :00 AEST
              </span>
            </div>
            {journeySteps.map((step, index) => (
              <section
                className={`journey-row side-${step.side}`}
                key={step.id}
              >
                <span className="journey-sequence">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <button
                  className={`journey-card ${expandedJourney === step.id ? "expanded" : ""}`}
                  aria-expanded={expandedJourney === step.id}
                  onClick={() => {
                    setExpandedJourney((current) =>
                      current === step.id ? null : step.id,
                    );
                    onSelect({
                      id: step.id,
                      title: step.title,
                      status:
                        step.status === "built"
                          ? "ready"
                          : step.status === "partial"
                            ? "active"
                            : "queued",
                      estimate: `${step.completion}% complete`,
                      x: step.side === "left" ? 20 : 80,
                      image: step.proof,
                      items: [
                        step.notes,
                        `People: ${journeyOwnership[step.id].people}`,
                        ...journeyOwnership[step.id].files.map(
                          (file) => `File: ${file}`,
                        ),
                        `Route ${step.route}`,
                        `Depends on ${step.dependency}`,
                        step.proof
                          ? "Screenshot proof attached"
                          : "Screenshot proof missing",
                      ],
                    });
                  }}
                >
                  <span className="journey-card-head">
                    <code>{step.id}</code>
                    <strong>{step.title}</strong>
                    <StatusChip
                      status={
                        step.status === "built"
                          ? "verified"
                          : step.status === "partial"
                            ? "active"
                            : "queued"
                      }
                    >
                      {step.status}
                    </StatusChip>
                  </span>
                  <span className="journey-route">
                    {step.route} · after {step.dependency}
                  </span>
                  <span className="journey-responsibility">
                    <span>
                      <UsersThreeIcon /> {journeyOwnership[step.id].people}
                    </span>
                    <span>
                      <HardDrivesIcon />{" "}
                      {journeyOwnership[step.id].files.length} files touched
                    </span>
                  </span>
                  <span className="journey-card-body">
                    <span className="journey-placeholder">
                      <TreeStructureIcon />
                      <strong>{step.title}</strong>
                      <small>{step.notes}</small>
                    </span>
                    <span
                      className={`journey-proof ${step.proof ? "attached" : "missing"}`}
                    >
                      {step.proof ? (
                        <img
                          src={step.proof}
                          alt={`${step.title} screenshot proof`}
                          loading="lazy"
                          decoding="async"
                          width="640"
                          height="360"
                        />
                      ) : (
                        <>
                          <CrosshairIcon />
                          <small>Screenshot proof pending</small>
                        </>
                      )}
                    </span>
                  </span>
                  <span className="journey-progress">
                    <span>
                      <i style={{ width: `${step.completion}%` }} />
                    </span>
                    <strong>{step.completion}% complete</strong>
                  </span>
                  {expandedJourney === step.id && (
                    <span className="journey-expanded-detail">
                      <strong>Declared change surface</strong>
                      {journeyOwnership[step.id].files.map((file) => (
                        <code key={file}>{file}</code>
                      ))}
                      <small>
                        {step.proof
                          ? `Screenshot: ${step.proof}`
                          : "Screenshot: not attached"}{" "}
                        · click again to collapse
                      </small>
                    </span>
                  )}
                </button>
              </section>
            ))}
          </div>
        </div>
      ) : (
        <div className="evidence-viewport">
          <div
            className="evidence-canvas"
            style={{ transform: `scale(${zoom / 100})` }}
          >
            <div className="evidence-spine" aria-hidden="true" />
            {phases.map((phase, index) => (
              <div
                className="evidence-phase"
                key={phase.id}
                style={{ top: `${4 + index * 20}%` }}
              >
                <strong>
                  {phase.id} · {phase.title}
                </strong>
                <span>{phase.description}</span>
              </div>
            ))}
            {evidenceNodes.map((node) => (
              <button
                key={node.id}
                className={`evidence-node evidence-${node.status} ${selectedEvidence.id === node.id ? "selected" : ""}`}
                style={{
                  left: `${node.x}%`,
                  top: `${node.y}%`,
                  width: `${node.width}%`,
                }}
                onClick={() =>
                  onSelect({
                    ...node,
                    estimate: "proof set",
                    items: [
                      "Data stamp",
                      "Artifact hash",
                      "References resolve",
                      "Human view note",
                    ],
                  })
                }
              >
                <span className="evidence-node-header">
                  <code>{node.id}</code>
                  <strong>{node.title}</strong>
                  <StatusChip status={node.status} />
                </span>
                <img
                  src={node.image}
                  alt={`${node.title} visual evidence`}
                  loading="lazy"
                  decoding="async"
                  width="640"
                  height="360"
                />
                <span className="evidence-caption">{node.note}</span>
              </button>
            ))}
          </div>
          <div className="minimap" aria-label="Canvas minimap">
            <img
              src="/assets/evidence/selected-spine-canvas.png"
              alt="Whole evidence canvas minimap"
              loading="lazy"
              decoding="async"
              width="640"
              height="360"
            />
            <span className="minimap-window" />
          </div>
          <div className="zoom-controls">
            <IconButton label="Fit canvas" onClick={() => onZoom(90)}>
              <CrosshairIcon />
            </IconButton>
            <IconButton
              label="Zoom out"
              onClick={() => onZoom(Math.max(70, zoom - 10))}
            >
              <MinusIcon />
            </IconButton>
            <span>{zoom}%</span>
            <IconButton
              label="Zoom in"
              onClick={() => onZoom(Math.min(120, zoom + 10))}
            >
              <PlusIcon />
            </IconButton>
          </div>
        </div>
      )}
    </section>
  );
}

function LedgerWorkspace({ onSelect }) {
  const [expandedTask, setExpandedTask] = useState(null);
  const verifiedCount = ledgerTasks.filter(
    (task) => task.status === "verified",
  ).length;
  const queuedCount = ledgerTasks.length - verifiedCount;
  const documentCompletion = (document) =>
    document.state === "built" ? 100 : document.state === "traced" ? 65 : 0;
  const documentWorker = (document) =>
    document.state === "built" ? "Codex" : "Danie + Codex";
  return (
    <section
      className="workspace ledger-workspace"
      aria-label="To-do and document ledger"
    >
      <div className="ledger-page-header">
        <div>
          <span className="eyebrow">Single source of truth</span>
          <h1>To-do / Ledger</h1>
          <p>
            Documents feed requirements. Requirements feed proof-gated build
            tasks. Nothing crosses itself off.
          </p>
        </div>
        <div className="ledger-totals">
          <div>
            <strong>{documentLedger.length}</strong>
            <span>documents</span>
          </div>
          <div>
            <strong>
              {verifiedCount}/{ledgerTasks.length}
            </strong>
            <span>build proofs</span>
          </div>
          <div>
            <strong>{queuedCount}</strong>
            <span>NO-GO</span>
          </div>
        </div>
      </div>
      <div className="ledger-grid">
        <section className="ledger-panel">
          <div className="ledger-panel-title">
            <ListChecksIcon />
            <strong>Source document register</strong>
            <span>{documentLedger.length} indexed</span>
          </div>
          <div className="ledger-table ledger-doc-table">
            <div className="ledger-table-head">
              <span>ID</span>
              <span>Document</span>
              <span>Complete</span>
              <span>Worker</span>
              <span>Trace</span>
            </div>
            {documentLedger.map((document) => (
              <div className="ledger-table-row" key={document.id}>
                <code>{document.id}</code>
                <strong>{document.name}</strong>
                <span className="ledger-percent">
                  {documentCompletion(document)}%
                </span>
                <small>{documentWorker(document)}</small>
                <small>{document.progress}</small>
              </div>
            ))}
          </div>
        </section>
        <section className="ledger-panel">
          <div className="ledger-panel-title">
            <ShieldCheckIcon />
            <strong>Build commitments</strong>
            <span>
              {verifiedCount}/{ledgerTasks.length} proven
            </span>
          </div>
          <div className="ledger-task-list">
            {ledgerTasks.map((task) => (
              <article
                className={`ledger-task-card ${expandedTask === task.id ? "expanded" : ""}`}
                key={task.id}
              >
                <button
                  className={`ledger-task ${task.status === "verified" ? "proven" : "blocked"}`}
                  onClick={() =>
                    setExpandedTask((current) =>
                      current === task.id ? null : task.id,
                    )
                  }
                  aria-expanded={expandedTask === task.id}
                >
                  <span className="ledger-task-state">
                    {task.status === "verified" ? (
                      <CheckCircleIcon weight="fill" />
                    ) : (
                      <ClockIcon />
                    )}
                  </span>
                  <span>
                    <code>{task.id}</code>
                    <strong>{task.title}</strong>
                    <small>{task.items[0]}</small>
                  </span>
                  <span className="ledger-task-actions">
                    <StatusChip status={task.status}>
                      {task.status === "verified" ? "proof ready" : "NO-GO"}
                    </StatusChip>
                    {expandedTask === task.id ? (
                      <CaretUpIcon />
                    ) : (
                      <CaretDownIcon />
                    )}
                  </span>
                </button>
                {expandedTask === task.id && (
                  <div className="ledger-task-detail">
                    <header>
                      <div>
                        <span>OWNER</span>
                        <strong>{task.owner}</strong>
                      </div>
                      <div>
                        <span>COMMIT</span>
                        <strong>
                          No Git commit · local clean-room workspace
                        </strong>
                      </div>
                      <div>
                        <span>CI CHECK</span>
                        <strong>
                          {task.status === "verified"
                            ? "Local verification passed"
                            : "Not run · task remains NO-GO"}
                        </strong>
                      </div>
                    </header>
                    <div className="ledger-task-proof-grid">
                      <section>
                        <CrosshairIcon />
                        <span>
                          <strong>Screenshot reference</strong>
                          <small>
                            {task.status === "verified"
                              ? `Registered evidence capsule for ${task.id}`
                              : "No accepted screenshot attached"}
                          </small>
                        </span>
                      </section>
                      <section>
                        <GitBranchIcon />
                        <span>
                          <strong>Scoped code difference</strong>
                          <small>
                            {task.status === "verified"
                              ? "Registered in the evidence bundle"
                              : "No approved code difference attached"}
                          </small>
                        </span>
                      </section>
                      <section>
                        <WarningIcon />
                        <span>
                          <strong>Code errors</strong>
                          <small>
                            {task.status === "verified"
                              ? "0 blocking errors in the accepted local run"
                              : "Unknown until the guarded proof runner executes"}
                          </small>
                        </span>
                      </section>
                    </div>
                    <div className="ledger-task-files">
                      <strong>Commit information and file claims</strong>
                      {task.items.map((item, index) => (
                        <span key={item}>
                          <code>
                            {task.id}:{index + 1}
                          </code>
                          {item}
                        </span>
                      ))}
                      <small>
                        Exact touched files must be declared in the task dossier
                        before a build claim can advance.
                      </small>
                    </div>
                    <button
                      className="soft-button"
                      onClick={() => onSelect(task)}
                    >
                      Open complete task inspector <ArrowRightIcon />
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}

function BranchToolsUnavailable({ activeProject, onEvent }) {
  const callback = useRef(onEvent);
  callback.current = onEvent;
  useEffect(() => {
    if (!activeProject) return;
    callback.current?.({ projectId: activeProject.projectId, generation: activeProject.generation,
      severity: "error", message: "Branch tools could not be downloaded. No Git action was run.",
      payload: { phase: "load", code: "GIT_TOOLS_LOAD_FAILED", metadataOnly: true } });
  }, [activeProject?.projectId, activeProject?.generation]);
  return <p role="alert">Branch tools could not be loaded. Reload the app to try again. No Git action was run.</p>;
}

function OpsDock({
  onGitInventoryEvent,
  onRuntimeLoadError,
  open,
  activeTab,
  onTab,
  onToggle,
  onToast,
  diagnostics,
  diagnosticHealth,
  onExportDiagnostics,
  activeProject,
  demoMode,
  runtimeCapabilityReceipts,
  runtimeCapabilityNow,
  collisionGate,
  definitionObservation,
  plannerConnection,
  onCheckPlannerConnection,
  onDisconnectPlannerConnection,
}) {
  const [diagnosticQuery, setDiagnosticQuery] = useState("");
  const [diagnosticSeverity, setDiagnosticSeverity] = useState("all");
  const [copyTray, setCopyTray] = useState({ projectId: null, ids: [], draft: null });
  const [panelHeight, setPanelHeight] = useState(430);
  const [panelDragging, setPanelDragging] = useState(false);
  const [fallbackSelection, setFallbackSelection] = useState(0);
  const [copyFallback, setCopyFallback] = useState(null);
  const fallbackInput = useRef(null);
  const currentOpen = useRef(open);
  currentOpen.current = open;
  const clipboardRequest = useRef(0);
  const clipboardInput = useRef(null);
  const dragCleanup = useRef(null);
  const handleRef = useRef(null);
  const wasOpen = useRef(open);
  const mounted = useRef(true);
  const diagnosticTabs = ["logs", "errors", "mcp"];
  const projectId = activeProject?.projectId ?? GLOBAL_DIAGNOSTIC_PROJECT_ID;
  const currentProjectId = useRef(projectId);
  currentProjectId.current = projectId;
  const selectedDiagnosticIds = copyTray.projectId === projectId ? copyTray.ids : [];
  const clipboardDraft = copyTray.projectId === projectId ? copyTray.draft : null;
  const setSelectedDiagnosticIds = (update) => {
    clipboardRequest.current += 1;
    setCopyTray((current) => ({
      projectId,
      ids: typeof update === "function" ? update(current.projectId === projectId ? current.ids : []) : update,
      draft: current.projectId === projectId ? current.draft : null,
    }));
  };
  const setClipboardDraft = (draft) => {
    clipboardRequest.current += 1;
    setCopyTray((current) => ({ projectId, ids: current.projectId === projectId ? current.ids : [], draft }));
  };
  const panelBounds = () => {
    const max = Math.max(0, window.innerHeight - 82);
    return { min: Math.min(window.innerWidth <= 700 ? 420 : 260, max), max };
  };
  const clampPanelHeight = (height) => {
    const { min, max } = panelBounds();
    return Math.min(max, Math.max(min, height));
  };
  useEffect(() => {
    mounted.current = true;
    const resize = () => setPanelHeight((height) => clampPanelHeight(height));
    resize();
    window.addEventListener("resize", resize);
    return () => {
      mounted.current = false;
      clipboardRequest.current += 1;
      dragCleanup.current?.();
      window.removeEventListener("resize", resize);
    };
  }, []);
  useEffect(() => {
    clipboardRequest.current += 1;
    setCopyTray({ projectId, ids: [], draft: null });
    setCopyFallback(null);
    setDiagnosticQuery("");
    setDiagnosticSeverity("all");
  }, [projectId]);
  useEffect(() => {
    if (!open) {
      clipboardRequest.current += 1;
      setCopyFallback(null);
      dragCleanup.current?.();
      if (wasOpen.current) handleRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);
  useEffect(() => {
    if (!fallbackSelection) return;
    const input = fallbackInput.current ?? clipboardInput.current;
    input?.focus();
    input?.select();
  }, [fallbackSelection]);
  const scopedDiagnostics = diagnostics.filter(
    (entry) =>
      entry.projectId === GLOBAL_DIAGNOSTIC_PROJECT_ID ||
      entry.projectId === projectId,
  ).sort((left, right) => {
    const time = (entry) => {
      const value = Date.parse(entry.timestamp);
      return Number.isFinite(value) ? value : -Infinity;
    };
    return time(right) - time(left);
  });
  const tabDiagnostics =
    activeTab === "errors"
      ? scopedDiagnostics.filter(
          (entry) => entry.level === "error" || entry.level === "critical",
        )
      : activeTab === "mcp"
        ? scopedDiagnostics.filter((entry) => entry.source === "mcp")
        : scopedDiagnostics;
  const normalizedQuery = diagnosticQuery.trim().toLowerCase();
  const visibleDiagnostics = tabDiagnostics.filter(
    (entry) =>
      (diagnosticSeverity === "all" || entry.level === diagnosticSeverity) &&
      (!normalizedQuery ||
        `${entry.source} ${entry.adapter} ${entry.message} ${entry.code ?? ""} ${entry.runId ?? ""} ${entry.taskId ?? ""}`
          .toLowerCase()
          .includes(normalizedQuery)),
  );
  const errorCount = scopedDiagnostics.filter(
    (entry) => entry.level === "error" || entry.level === "critical",
  ).length;
  const operationalBlockerCount = collisionGate?.authorityAvailable === false ? 1 : 0;
  const historyUnavailable = diagnosticHealth?.state !== "ready";
  const historyNotice = diagnosticHealth?.reason === "history-loading"
    ? "Loading saved history. New events are retained in this session while storage opens."
    : diagnosticHealth?.reason === "events-saving"
      ? "Saving new events. They are not confirmed saved yet."
      : diagnosticHealth?.reason === "legacy-recovery-needed"
        ? "Older diagnostic history changed or could not be read. Its original storage is untouched and has not been automatically merged. Recovery needs review."
        : "Some history could not be loaded or saved. Unsaved events remain in this session; export them before closing or reloading. Previously stored data has not been reset.";
  const selectedDiagnostics = scopedDiagnostics.filter((entry) =>
    selectedDiagnosticIds.includes(entry.id),
  );
  const formatDiagnostic = (entry) =>
    [
      `[${entry.level.toUpperCase()}] ${entry.message}`,
      `Source: ${entry.source} · Adapter: ${entry.adapter}`,
      `Storage: ${entry.storageState ?? "unknown"}`,
      ...(entry.code ? [`Code: ${entry.code}`] : []),
      `Project: ${entry.projectId} · Generation: ${entry.generation}`,
      `Event: ${entry.eventId ?? entry.id}${entry.runId ? ` · Run: ${entry.runId}` : ""}${entry.taskId ? ` · Task: ${entry.taskId}` : ""}`,
      `Time: ${entry.timestamp}`,
      ...(entry.payload != null ? [`Details: ${JSON.stringify(entry.payload, null, 2)}`] : []),
    ].join("\n");
  const diagnosticBundle = selectedDiagnostics.map(formatDiagnostic).join("\n\n---\n\n");
  const trayText = clipboardDraft ?? diagnosticBundle;
  const copyText = async (value, successMessage, loadIntoTray = false) => {
    const preserveDraft = loadIntoTray && clipboardDraft !== null && value !== trayText;
    if (loadIntoTray && !preserveDraft) setClipboardDraft(value);
    setCopyFallback(null);
    const request = ++clipboardRequest.current;
    const stillCurrent = () => mounted.current && currentOpen.current && currentProjectId.current === projectId && clipboardRequest.current === request;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard-write-unavailable");
      await navigator.clipboard.writeText(value);
      if (stillCurrent()) onToast(successMessage, "success");
    } catch {
      if (stillCurrent()) {
        if (preserveDraft) setCopyFallback({ projectId, text: value });
        setFallbackSelection((current) => current + 1);
        onToast(preserveDraft
          ? "Clipboard access was blocked. Event text is selected below; your tray notes are unchanged. Use Ctrl+C or Command+C."
          : "Clipboard access was blocked. The text is selected in the Operations copy tray; use Ctrl+C or Command+C.", "warning");
      }
    }
  };
  const pasteFromClipboard = async () => {
    const request = ++clipboardRequest.current;
    const stillCurrent = () => mounted.current && currentOpen.current && currentProjectId.current === projectId && clipboardRequest.current === request;
    try {
      if (!navigator.clipboard?.readText) throw new Error("clipboard-read-unavailable");
      const text = await navigator.clipboard.readText();
      if (!stillCurrent()) return;
      setClipboardDraft(text);
      onToast("Clipboard text loaded into the Operations copy tray.", "success");
    } catch {
      if (!stillCurrent()) return;
      clipboardInput.current?.focus();
      onToast("Clipboard read was blocked. Paste directly into the editable copy tray.", "warning");
    }
  };
  let runtimeCapabilityMatrix = null;
  let mcpCapability = null;
  if (activeProject) {
    try {
      runtimeCapabilityMatrix = createRuntimeCapabilityMatrix({
        projectId: activeProject.projectId,
        receipts: Array.isArray(runtimeCapabilityReceipts) ? runtimeCapabilityReceipts : [],
        now: runtimeCapabilityNow ?? Date.now(),
      });
      mcpCapability = runtimeCapabilityMatrix.capabilities.find((item) => item.capabilityId === "mcp") ?? null;
    } catch {
      runtimeCapabilityMatrix = null;
      mcpCapability = null;
    }
  }
  const capability = (id) => runtimeCapabilityMatrix?.capabilities?.find((item) => item.capabilityId === id) ?? null;
  const gitCapability = capability("git");
  const ciCapability = capability("ci");
  const nativeCapability = capability("native-tauri");
  const observedDefinitions = selectOperationDefinitions(activeProject, definitionObservation)?.definitions;
  const hasGitHookDefinitions = observedDefinitions?.gitHooks === true;
  const hasSecretScanner = observedDefinitions?.secretScanner === true;
  const hasCiWorkflow = observedDefinitions?.ciWorkflow === true;
  const deliveryStages = [
    { id: "changes", label: "Local changes", detail: activeProject ? "No source-change receipt is available. Selecting or indexing a project does not prove local changes." : "Select a project first.", state: "unavailable" },
    { id: "catchers", label: "Pre-push catchers", detail: hasGitHookDefinitions && hasSecretScanner ? "Hook and credential-scanner definitions observed; execution receipts are still required." : "Secrets, credentials, malware and policy checks must all return separate receipts.", state: hasGitHookDefinitions && hasSecretScanner ? "observed" : "blocked" },
    { id: "local", label: "Local proof", detail: "Tests, build, scoped diff and screenshot evidence.", state: "blocked" },
    { id: "queue", label: "CI / merge queue", detail: ciCapability?.available ? "Verified CI adapter is available." : hasCiWorkflow ? "CI workflow definition observed; no current project-bound run receipt." : "No current project-bound CI receipt.", state: ciCapability?.available ? "ready" : hasCiWorkflow ? "observed" : "unavailable" },
    { id: "production", label: "Production", detail: "Requires green CI, merged-state proof, release approval and deployment receipt.", state: "blocked" },
  ];
  const guardSurfaces = [
    { id: "git-hooks", label: "Git hooks", tool: "Versioned pre-commit / pre-push", detail: hasGitHookDefinitions ? "Hook definitions observed. Installation and execution still require Git receipts." : "No hook definitions or installed-hook receipt is available for this project.", state: hasGitHookDefinitions ? "observed" : "unavailable" },
    { id: "secrets", label: "Secret & credential catcher", tool: "Bounded redacted secret scanner", detail: hasSecretScanner ? "Scanner definition observed; a passing execution receipt is still required for this revision." : "No live changed-file credential scanner has supplied proof.", state: hasSecretScanner ? "observed" : "blocked" },
    { id: "malware", label: "Malware catcher", tool: "ClamShield authenticated v2 adapter", detail: "Optional adapter contract exists; v1 availability is not malware-clean proof.", state: "unavailable" },
    { id: "mcp", label: "MCP tools", tool: "Perfect Planner MCP", detail: mcpCapability?.available ? "Project-bound read receipt verified." : "External MCP may be running, but this project has no in-app handshake receipt.", state: mcpCapability?.available ? "verified" : "unavailable" },
    { id: "git", label: "Git transport", tool: "Branch, push and merge adapter", detail: gitCapability?.available ? "Project-bound Git receipt verified." : "No verified Git receipt; push state cannot be claimed.", state: gitCapability?.available ? "verified" : "unavailable" },
    { id: "ci", label: "CI guardrail", tool: "Tests → build → package → merged-state proof", detail: ciCapability?.available ? "Project-bound CI receipt verified." : hasCiWorkflow ? "Workflow definition observed, but no current run receipt is connected." : "No CI workflow or current run receipt is connected.", state: ciCapability?.available ? "verified" : hasCiWorkflow ? "observed" : "blocked" },
  ];
  const startPanelDrag = (event) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    dragCleanup.current?.();
    event.preventDefault();
    const pointerId = event.pointerId;
    const target = event.currentTarget;
    const startY = event.clientY;
    const startHeight = panelHeight;
    setPanelDragging(true);
    target.setPointerCapture?.(pointerId);
    const move = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const nextHeight = startHeight + (startY - moveEvent.clientY);
      setPanelHeight(clampPanelHeight(nextHeight));
    };
    const stop = (stopEvent) => {
      if (stopEvent?.pointerId !== undefined && stopEvent.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
      target.removeEventListener("lostpointercapture", stop);
      if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
      dragCleanup.current = null;
      if (mounted.current) setPanelDragging(false);
    };
    dragCleanup.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
    target.addEventListener("lostpointercapture", stop);
  };
  const resizePanelWithKeyboard = (event) => {
    const { min, max } = panelBounds();
    const next = { ArrowUp: panelHeight + 30, ArrowDown: panelHeight - 30, PageUp: panelHeight + 100, PageDown: panelHeight - 100, Home: min, End: max }[event.key];
    if (next !== undefined) {
      event.preventDefault();
      setPanelHeight(clampPanelHeight(next));
    } else if (event.key === "Enter" || event.key === "Escape") {
      event.preventDefault();
      onToggle();
    }
  };
  return (
    <section className={`ops-dock ${open ? "open" : ""}`}>
      <button ref={handleRef} className="ops-handle" onClick={(event) => { if (event.detail < 2) onToggle(); }} onDoubleClick={(event) => event.preventDefault()} title="Click or double-click to expand or collapse Operations." aria-expanded={open} aria-controls="operations-panel">
        {open ? <CaretDownIcon /> : <CaretUpIcon />}
        <span>Operations</span>
        <span className="ops-status-explained" title={operationalBlockerCount ? `Blocked: ${collisionGate?.authorityReason ?? "The collision check is not connected."} Work cannot be cleared until it runs.` : undefined}>
          <StatusChip status={errorCount || operationalBlockerCount ? "blocked" : "unverified"}>
            {errorCount} diagnostic errors{operationalBlockerCount ? " · collision check not connected" : ""} · task outcomes unverified
          </StatusChip>
        </span>
        <span className="ops-mini-status">
          <GitBranchIcon />{" "}
          {demoMode ? "3 demo branches" : "branches unavailable"}
        </span>
        <span className="ops-mini-status">
          <GitMergeIcon /> {demoMode ? "1 demo queued" : "queue unavailable"}
        </span>
        {selectedDiagnostics.length > 0 && (
          <span className="ops-copy-status">{selectedDiagnostics.length} queued to copy</span>
        )}
      </button>
      {open && (
        <div id="operations-panel" className={`ops-panel${panelDragging ? " resizing" : ""}`} style={{ height: panelHeight, "--ops-panel-height": `${panelHeight}px` }}>
          <div className="ops-panel-dragbar" onPointerDown={startPanelDrag} onDoubleClick={onToggle} title="Drag vertically to resize. Double-click to collapse.">
            <div className="ops-panel-resize-handle" role="separator" tabIndex={0} aria-label="Resize Operations console" aria-orientation="horizontal" aria-controls="operations-panel" aria-valuemin={panelBounds().min} aria-valuemax={panelBounds().max} aria-valuenow={panelHeight} aria-valuetext={`${Math.round(panelHeight)} pixels high. Up and Down resize; Enter collapses.`} onKeyDown={resizePanelWithKeyboard}>
              <strong>Operations console</strong>
              <span>Drag up or down · double-click to collapse</span>
            </div>
            <button type="button" onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onClick={onToggle}>Collapse</button>
          </div>
          <nav className="ops-tabs" aria-label="Operations views">
            <button
              className={activeTab === "logs" ? "active" : ""}
              onClick={() => onTab("logs")}
            >
              <TerminalWindowIcon /> Logs
            </button>
            <button
              className={activeTab === "errors" ? "active" : ""}
              onClick={() => onTab("errors")}
            >
              <WarningIcon /> Errors
            </button>
            <button
              className={activeTab === "mcp" ? "active" : ""}
              onClick={() => onTab("mcp")}
            >
              <RobotIcon /> MCP events
            </button>
            <button
              className={activeTab === "branches" ? "active" : ""}
              onClick={() => onTab("branches")}
            >
              <GitBranchIcon /> Branches & worktrees
            </button>
            <button
              className={activeTab === "merge" ? "active" : ""}
              onClick={() => onTab("merge")}
            >
              <GitMergeIcon /> Merge queue
            </button>
            <button className={activeTab === "delivery" ? "active" : ""} onClick={() => onTab("delivery")}>
              <ArrowRightIcon /> Delivery pipeline
            </button>
            <button className={activeTab === "guards" ? "active" : ""} onClick={() => onTab("guards")}>
              <ShieldCheckIcon /> Hooks & catchers
            </button>
          </nav>
          <div className="ops-content">
            {diagnosticTabs.includes(activeTab) && (
              <div
                className="diagnostic-view"
                role="log"
                aria-label={
                  activeTab === "errors"
                    ? "Application errors"
                    : activeTab === "mcp"
                      ? "MCP events"
                      : "Application logs"
                }
              >
                <header>
                  <span>
                    <strong>
                      {activeTab === "errors"
                        ? "Application errors"
                        : activeTab === "mcp"
                          ? "MCP connection events"
                          : "Project event ledger"}
                    </strong>
                    <small>
                      {diagnosticHealth?.persistence === "durable"
                        ? "Local diagnostic history · not execution proof"
                        : "Unconfirmed or unsaved events · not execution proof"}
                    </small>
                  </span>
                  <span>{visibleDiagnostics.length} events</span>
                  <button
                    type="button"
                    onClick={onExportDiagnostics}
                    disabled={!scopedDiagnostics.length && !historyUnavailable}
                  >
                    Export diagnostics
                  </button>
                </header>
                {historyUnavailable && (
                  <div className="diagnostic-history-warning" role="status" aria-label="Operations history warning">
                    <WarningIcon weight="fill" />
                    <strong>History needs attention</strong>
                    <span>{historyNotice}</span>
                  </div>
                )}
                <div className="diagnostic-toolbar">
                  <label>
                    <MagnifyingGlassIcon />
                    <input
                      value={diagnosticQuery}
                      onChange={(event) =>
                        setDiagnosticQuery(event.target.value)
                      }
                      placeholder="Search events, source, run, or task…"
                      aria-label="Search operations events"
                    />
                  </label>
                  <select
                    value={diagnosticSeverity}
                    onChange={(event) =>
                      setDiagnosticSeverity(event.target.value)
                    }
                    aria-label="Filter operations severity"
                  >
                    <option value="all">All severities</option>
                    <option value="debug">Debug</option>
                    <option value="info">Info</option>
                    <option value="warning">Warning</option>
                    <option value="error">Error</option>
                    <option value="critical">Critical</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => setSelectedDiagnosticIds((current) => [...new Set([...current, ...visibleDiagnostics.map((entry) => entry.id)])])}
                    disabled={!visibleDiagnostics.length}
                  >
                    Select visible
                  </button>
                </div>
                {activeTab === "mcp" && (
                  <Suspense fallback={<p role="status">Opening connection tools…</p>}><BundledPlannerConnection connection={plannerConnection} onCheck={onCheckPlannerConnection} onDisconnect={onDisconnectPlannerConnection} onLoadError={() => onRuntimeLoadError?.()} /></Suspense>
                )}
                {activeTab === "mcp" && (
                  <div className={`mcp-diagnostic-status ${mcpCapability?.available ? "connected" : "disconnected"}`}>
                    <small>Separate external MCP capability evidence</small>
                    <strong>{mcpCapability?.available ? "MCP receipt verified" : "MCP is not connected to this project"}</strong>
                    <span>
                      {mcpCapability?.available
                        ? `${mcpCapability.source} · ${mcpCapability.scopes.join(", ")} scopes`
                        : (mcpCapability?.denialReasons ?? [activeProject ? "receipt-missing" : "project-binding-required"]).join(" · ")}
                    </span>
                  </div>
                )}
                {visibleDiagnostics.length === 0 ? (
                  <div className={`diagnostic-empty${historyUnavailable ? " history-unavailable" : ""}`}>
                    {historyUnavailable ? <WarningIcon weight="fill" /> : <ListChecksIcon />}
                    <strong>
                      No{" "}
                      {activeTab === "mcp"
                        ? "MCP events"
                        : activeTab === "errors"
                          ? "errors"
                          : "events"}{" "}
                      recorded
                    </strong>
                    <span>{historyUnavailable
                      ? "No matching events are available in this session. Saved history has not been verified."
                      : "No matching events have been recorded. This does not prove that the app or its connections are healthy."}</span>
                  </div>
                ) : (
                  visibleDiagnostics.map((entry) => (
                    <div
                      className={`diagnostic-row level-${entry.level} ${selectedDiagnosticIds.includes(entry.id) ? "selected" : ""}`}
                      key={entry.id}
                    >
                      <label className="diagnostic-copy-select">
                        <input
                          type="checkbox"
                          aria-label={`Queue ${entry.storageState === "unsaved · ID conflict" ? "conflicting unsaved " : ""}${entry.eventId ?? entry.id} for copying`}
                          checked={selectedDiagnosticIds.includes(entry.id)}
                          onChange={(event) => setSelectedDiagnosticIds((current) =>
                            event.target.checked
                              ? [...new Set([...current, entry.id])]
                              : current.filter((id) => id !== entry.id),
                          )}
                        />
                      </label>
                      <details className="diagnostic-event-details">
                      <summary>
                        <time>{entry.time}</time>
                        <span>{entry.source}</span>
                        <code>{entry.message}</code>
                        <small>{entry.storageState ?? "unconfirmed"}</small>
                      </summary>
                      <div>
                        <span>
                          <b>Adapter</b>
                          {entry.adapter}
                        </span>
                        <span>
                          <b>Project</b>
                          <code>{entry.projectId}</code>
                        </span>
                        <span>
                          <b>Generation</b>
                          {entry.generation}
                        </span>
                        <span>
                          <b>Event</b>
                          <code>{entry.eventId ?? entry.id}</code>
                        </span>
                        {entry.runId && (
                          <span>
                            <b>Run</b>
                            <code>{entry.runId}</code>
                          </span>
                        )}
                        {entry.code && <span><b>Result code</b><code>{entry.code}</code></span>}
                        {entry.taskId && (
                          <span>
                            <b>Task</b>
                            <code>{entry.taskId}</code>
                          </span>
                        )}
                        <small>{entry.timestamp}</small>
                        {entry.payload != null && <pre tabIndex={0} aria-label={`Details for ${entry.eventId ?? entry.id}`}>{JSON.stringify(entry.payload, null, 2)}</pre>}
                        <button type="button" onClick={() => copyText(formatDiagnostic(entry), "Diagnostic copied.", true)}>Copy this event</button>
                      </div>
                      </details>
                    </div>
                  ))
                )}
              </div>
            )}
            {!demoMode && <div hidden={activeTab !== "branches"}>
              <Suspense fallback={<p role="status">Opening branch tools…</p>}><GitInventoryPanel activeProject={activeProject} onEvent={onGitInventoryEvent} onCopy={(text) => copyText(text, "Git observation copied.", true)} /></Suspense>
            </div>}
            {activeTab === "branches" && demoMode && (
              <div className="branch-table">
                <div className="branch-table-head">
                  <span>Branch</span>
                  <span>Worktree</span>
                  <span>Owner</span>
                  <span>Station</span>
                </div>
                {branchRows.map((row) => (
                  <button
                    className="branch-table-row"
                    key={row.branch}
                    onClick={() => onToast(`${row.branch} is a sample branch. ${DEMO_ONLY_REASON}; no branch exists.`)}
                  >
                    <span>
                      <GitBranchIcon />
                      <code>{row.branch}</code>
                    </span>
                    <span>
                      <HardDrivesIcon />
                      <code>{row.worktree}</code>
                    </span>
                    <span>{row.owner}</span>
                    <StatusChip status={row.status}>{row.stage}</StatusChip>
                  </button>
                ))}
              </div>
            )}
            {activeTab === "merge" && !demoMode && (
              <div className="diagnostic-empty">
                <WarningIcon weight="fill" />
                <strong>Merge queue unavailable</strong>
                <span>
                  No project-scoped Git or CI receipt exists. Perfect Planner
                  will not fabricate a queue.
                </span>
              </div>
            )}
            {activeTab === "merge" && demoMode && (
              <div className="merge-conveyor">
                {[
                  "READY",
                  "CLAIMED",
                  "BUILDING",
                  "PROOF",
                  "REVIEW",
                  "CI",
                  "MERGE QUEUE",
                  "MERGED",
                ].map((stage, index) => (
                  <div
                    className={`merge-station ${index < 3 ? "complete" : index === 3 ? "current" : ""}`}
                    key={stage}
                  >
                    <span>
                      {index < 3 ? (
                        <CheckCircleIcon weight="fill" />
                      ) : index === 3 ? (
                        <ActivityIcon />
                      ) : (
                        <ClockIcon />
                      )}
                    </span>
                    <strong>{stage}</strong>
                    {index < 4 && <small>B07</small>}
                  </div>
                ))}
                <button className="primary-button" disabled title={`${DEMO_ONLY_REASON}: there is no repository to merge.`}>
                  <GitMergeIcon /> Run merge gate
                </button>
                <DemoOnlyReason>this conveyor is an example; there is no repository to merge.</DemoOnlyReason>
              </div>
            )}
            {activeTab === "delivery" && (
              <section className="ops-pipeline" aria-label="Local to production delivery pipeline">
                {!demoMode && <OperationTaskAccounting project={activeProject} diagnostics={scopedDiagnostics} />}
                <header><strong>Local → production</strong><span>Every transition requires its own evidence receipt.</span></header>
                <div className="ops-pipeline-stages">
                  {deliveryStages.map((stage, index) => (
                    <button type="button" key={stage.id} className={`ops-pipeline-stage state-${stage.state}`} onClick={() => onToast(`${stage.label}: ${stage.detail}`)}>
                      <small>{String(index + 1).padStart(2, "0")}</small><strong>{stage.label}</strong><span>{stage.detail}</span><b>{stage.state}</b>
                    </button>
                  ))}
                </div>
              </section>
            )}
            {activeTab === "guards" && (
              <section className="ops-guards" aria-label="Hooks tools and security catchers">
                <header><strong>Hooks, tools & catchers</strong><span>Security, integrity and CI remain independent verdicts.</span></header>
                <div>
                  {guardSurfaces.map((guard) => (
                    <button type="button" key={guard.id} className={`ops-guard-card state-${guard.state}`} onClick={() => onToast(`${guard.label}: ${guard.detail}`)}>
                      <span><ShieldCheckIcon /><strong>{guard.label}</strong><b>{guard.state}</b></span><small>{guard.tool}</small><p>{guard.detail}</p>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
          <div className="ops-copy-tray">
            {copyFallback?.projectId === projectId && <div className="ops-copy-fallback">
              <label htmlFor="operations-manual-copy">Event text — copy manually; tray notes are unchanged</label>
              <textarea id="operations-manual-copy" ref={fallbackInput} readOnly value={copyFallback.text} />
              <button type="button" onClick={() => { setCopyFallback(null); clipboardInput.current?.focus(); }}>Dismiss manual copy</button>
            </div>}
            <textarea
              ref={clipboardInput}
              value={trayText}
              onChange={(event) => setClipboardDraft(event.target.value)}
              placeholder="Select events or paste diagnostic text here…"
              aria-label="Operations copy tray"
            />
            <span>{selectedDiagnostics.length} selected</span>
            {clipboardDraft !== null && selectedDiagnostics.length > 0 && <button type="button" onClick={() => setClipboardDraft(null)}>Replace tray with selected events</button>}
            <button type="button" onClick={pasteFromClipboard}>Paste</button>
            <button type="button" disabled={!trayText} onClick={() => copyText(trayText, "Operations bundle copied.")}>Copy all</button>
            <button type="button" disabled={!selectedDiagnostics.length && !trayText} onClick={() => { setSelectedDiagnosticIds([]); setClipboardDraft(""); }}>Clear tray</button>
          </div>
        </div>
      )}
    </section>
  );
}

function PerfectPlannerShellCore({
  projectContext,
  runtimeCapabilityReceipts,
  runtimeCapabilityNow,
  diagnosticSession,
}) {
  const activeProject = projectContext.activeProject;
  const demoMode = isDemoProject(activeProject);
  const projectWorkflowReady = Boolean(activeProject) && !["stale", "unavailable"].includes(activeProject.state);
  const [workspace, setWorkspace] = useState(readInitialWorkspace);
  const startupLocationApplied=useRef(false);
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [inspectorSide, setInspectorSide] = useState("right");
  const [phaseFocus, setPhaseFocus] = useState(readInitialPhaseFocus);
  const [opsOpen, setOpsOpen] = useState(false);
  const [opsTab, setOpsTab] = useState("logs");
  const [selected, setSelected] = useState(() =>
    isDemoProject(projectContext.activeProject) ? phases[2].nodes[0] : null,
  );
  const [zoom, setZoom] = useState(90);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  useEffect(() => {
    setToast(null);
    return () => window.clearTimeout(toastTimer.current);
  }, [activeProject?.projectId]);
  const [collisionGate, setCollisionGate] = useState(initialCollisionGate);
  const [intakeSummary, setIntakeSummary] = useState(null);
  const [definitionObservations, setDefinitionObservations] = useState({});
  useEffect(() => {
    setDefinitionObservations((current) => {
      const kept = Object.fromEntries(Object.entries(current).filter(([id, observation]) =>
        selectOperationDefinitions(projectContext.projects.find((project) => project.projectId === id), observation)));
      return Object.keys(kept).length === Object.keys(current).length ? current : kept;
    });
  }, [projectContext.projects]);
  const [eventLedger] = useState(() =>
    diagnosticSession ?? getRuntimeEventSession(),
  );
  const [diagnostics, setDiagnostics] = useState([]);
  const plannerConnectionController = useRef(null);
  const plannerConnectionProject = useRef(activeProject);
  plannerConnectionProject.current = activeProject;
  const [plannerConnectionSnapshot, setPlannerConnectionSnapshot] = useState(null);
  // Never paint a previous project's observation while its selection effect catches up.
  const plannerConnection = plannerConnectionSnapshot?.projectId === (activeProject?.projectId ?? null)
    && plannerConnectionSnapshot?.generation === (activeProject?.generation ?? null)
    ? plannerConnectionSnapshot : null;
  const [diagnosticHealth, setDiagnosticHealth] = useState(() =>
    eventLedger.getHealth(),
  );
  const diagnosticScopeRef = useRef({
    projectId: projectContext.activeProjectId ?? GLOBAL_DIAGNOSTIC_PROJECT_ID,
    projectGeneration: activeProject?.generation ?? 0,
    adapter: activeProject?.registration?.adapter ?? "browser-ui",
  });
  diagnosticScopeRef.current = {
    projectId: projectContext.activeProjectId ?? GLOBAL_DIAGNOSTIC_PROJECT_ID,
    projectGeneration: activeProject?.generation ?? 0,
    adapter: activeProject?.registration?.adapter ?? "browser-ui",
  };

  const recordDiagnostic = (source, level, message, capturedScope = null) => {
    const scope = capturedScope ?? diagnosticScopeRef.current;
    try {
      eventLedger.append({
        adapter: scope.adapter,
        generation: scope.projectGeneration,
        message: String(
          message || "Diagnostic event recorded without a message.",
        ),
        payload: capturedScope ? capturedScope.payload : { workspace },
        projectId: scope.projectId,
        runId: capturedScope?.requestId ?? null,
        severity: runtimeEventSeveritiesForShell(level),
        source: String(source || "ui"),
        taskId: null,
      });
    } catch {
      const timestamp = new Date().toISOString();
      setDiagnostics((current) => [
        ...current.slice(-199),
        {
          adapter: "browser-ui",
          generation: 0,
          id: `evt_capture_failure_${Date.now()}`,
          level: "critical",
          message:
            "The operations ledger rejected an internal event. No raw event data was retained.",
          projectId: GLOBAL_DIAGNOSTIC_PROJECT_ID,
          runId: null,
          source: "diagnostics",
          taskId: null,
          time: new Date(timestamp).toLocaleTimeString("en-AU", {
            hour12: false,
          }),
          timestamp,
        },
      ]);
    }
  };

  const recordConnectionEvent = useRef(null);
  recordConnectionEvent.current = (event) => recordDiagnostic("mcp", event.severity, event.message, {
    adapter: "bundled-planner-mcp",
    projectId: event.projectId,
    projectGeneration: event.generation,
    requestId: event.requestId ?? null,
    payload: event.payload ?? null,
  });
  useEffect(() => {
    const controller = createPlannerMcpConnectionController({
      onEvent: (event) => recordConnectionEvent.current?.(event),
    });
    plannerConnectionController.current = controller;
    const unsubscribe = controller.subscribe(() => setPlannerConnectionSnapshot(controller.getSnapshot()));
    controller.setProject(plannerConnectionProject.current);
    setPlannerConnectionSnapshot(controller.getSnapshot());
    return () => {
      unsubscribe();
      if (plannerConnectionController.current === controller) plannerConnectionController.current = null;
      controller.dispose();
    };
  }, []);
  useEffect(() => {
    const controller = plannerConnectionController.current;
    controller?.setProject(activeProject);
    if (controller) setPlannerConnectionSnapshot(controller.getSnapshot());
  }, [activeProject]);
  const checkPlannerConnection = () => plannerConnectionController.current?.check();
  const disconnectPlannerConnection = () => plannerConnectionController.current?.disconnect();

  useEffect(() => {
    const scopeIds = [
      GLOBAL_DIAGNOSTIC_PROJECT_ID,
      ...(activeProject?.projectId ? [activeProject.projectId] : []),
    ];
    const refresh = () => {
      const events = scopeIds.flatMap((projectId) => {
        const snapshot = eventLedger.getSnapshot(projectId);
        const saved = new Map(snapshot.savedEvents.map(event => [JSON.stringify(event), event]));
        return [
          ...[...saved].map(([rowId, event]) => ({ ...event, rowId, storageState: "log entry saved locally" })),
          ...snapshot.pending.filter(item => !saved.has(JSON.stringify(item.event)))
            .map(item => ({ ...item.event, rowId: JSON.stringify(item.event), storageState: item.conflictsWithSaved ? "unsaved · ID conflict" : item.state })),
        ];
      });
      events.sort(
        (left, right) =>
          left.timestamp.localeCompare(right.timestamp) ||
          left.eventId.localeCompare(right.eventId),
      );
      setDiagnostics(
        events.map((entry) => ({
          adapter: entry.adapter,
          code: entry.source === "mcp" && /^MCP_[A-Z_]{1,60}$/.test(entry.payload?.code ?? "") ? entry.payload.code : null,
          generation: entry.generation,
          id: entry.rowId,
          eventId: entry.eventId,
          storageState: entry.storageState,
          level: entry.severity,
          message: entry.message,
          payload: entry.payload,
          projectId: entry.projectId,
          runId: entry.runId,
          source: entry.source,
          taskId: entry.taskId,
          time: new Date(entry.timestamp).toLocaleTimeString("en-AU", {
            hour12: false,
          }),
          timestamp: entry.timestamp,
        })),
      );
      setDiagnosticHealth(eventLedger.getHealth());
    };
    refresh();
    const unsubscribers = scopeIds.map((projectId) =>
      eventLedger.subscribe(projectId, refresh),
    );
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [activeProject?.projectId, eventLedger]);

  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== "hidden") void eventLedger.refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [eventLedger]);
  useEffect(() => { if (opsOpen) void eventLedger.refresh(); }, [opsOpen, eventLedger]);

  useEffect(() => {
    const captureError = (event) =>
      recordDiagnostic(
        "runtime",
        "error",
        event.message || "Unknown application error",
      );
    const captureRejection = (event) =>
      recordDiagnostic(
        "promise",
        "error",
        event.reason?.message ||
          String(event.reason || "Unhandled promise rejection"),
      );
    window.addEventListener("error", captureError);
    window.addEventListener("unhandledrejection", captureRejection);
    return () => {
      window.removeEventListener("error", captureError);
      window.removeEventListener("unhandledrejection", captureRejection);
    };
  }, []);

  useEffect(() => {
    if (projectContext.selectionInitialized === false) return;
    if (!startupLocationApplied.current) {
      startupLocationApplied.current=true;
      const view=projectContext.activeProject?.view;
      if (view) {
        setWorkspace(view.workspace);
        setPhaseFocus(view.workspace === "plan" ? view.phase : null);
        if (projectContext.historySyncEnabled !== false) writeProjectLocation({projectId:projectContext.activeProjectId,workspace:view.workspace,phase:view.workspace === "plan" ? view.phase : null},"replace");
        return;
      }
    }
    if (projectContext.historySyncEnabled === false) return;
    writeProjectLocation(
      {
        projectId: projectContext.activeProjectId,
        workspace,
        phase: workspace === "plan" ? phaseFocus : null,
      },
      "replace",
    );
  }, [projectContext.activeProjectId, projectContext.selectionInitialized, projectContext.historySyncEnabled, workspace, phaseFocus]);

  useEffect(() => {
    const restoreLocation = () => {
      const selection = readProjectSelection(window.location.href);
      setWorkspace(selection.workspace ?? "home");
      setPhaseFocus(selection.workspace === "plan" ? selection.phase : null);
      setLeftOpen(false);
      setRightOpen(false);
    };
    window.addEventListener("popstate", restoreLocation);
    return () => window.removeEventListener("popstate", restoreLocation);
  }, []);

  useEffect(() => {
    if (!activeProject?.census) {
      setIntakeSummary(null);
      return;
    }
    setIntakeSummary({
      schemaVersion: 1,
      workspaceId: activeProject.registration?.workspaceId,
      rootIdentity: activeProject.registration?.rootIdentity,
      registryRevision: activeProject.registration?.registryRevision,
      censusDigest: activeProject.census.digest,
      fileCount: activeProject.census.fileCount,
      skippedCount: activeProject.census.skippedCount,
      structureCompletion: null,
      mutationAuthorized: false,
    });
  }, [activeProject?.projectId, activeProject?.generation]);

  useEffect(() => {
    if (!demoMode) {
      setSelected(null);
      setCollisionGate(initialCollisionGate);
    } else if (!selected) setSelected(phases[2].nodes[0]);
  }, [demoMode, activeProject?.projectId]);

  const resetWorkspaceScroll = () => {
    const main = document.querySelector(".app-main");
    if (main && typeof main.scrollTo === "function") main.scrollTo({ top: 0, left: 0, behavior: "instant" });
    else if (main) main.scrollTop = 0;
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  };

  const navigateWorkspace = (nextWorkspace) => {
    if (!workspaceOrder.includes(nextWorkspace)) {
      recordDiagnostic(
        "route",
        "error",
        `Rejected unknown workspace: ${nextWorkspace}`,
      );
      setOpsTab("errors");
      setOpsOpen(true);
      return;
    }
    const nextPhase = nextWorkspace === "plan" ? null : phaseFocus;
    if (projectContext.activeProjectId)
      projectContext.selectProject(projectContext.activeProjectId, {
        workspace: nextWorkspace,
        phase: nextWorkspace === "plan" ? null : undefined,
        historyMode: "push",
      });
    else
      writeProjectLocation(
        {
          projectId: null,
          workspace: nextWorkspace,
          phase: nextWorkspace === "plan" ? null : undefined,
        },
        "push",
      );
    if (nextWorkspace === "plan") setPhaseFocus(null);
    setLeftOpen(false);
    setRightOpen(false);
    recordDiagnostic("route", "info", `${workspace} → ${nextWorkspace}`);
    setWorkspace(nextWorkspace);
    window.requestAnimationFrame(resetWorkspaceScroll);
  };

  const selectProject = (projectId) => {
    const target = projectContext.projects.find(
      (project) => project.projectId === projectId,
    );
    if (!target) {
      recordDiagnostic(
        "project",
        "error",
        `Rejected unknown project: ${projectId}`,
      );
      return;
    }
    const nextWorkspace = target.view?.workspace ?? "home";
    const nextPhase =
      nextWorkspace === "plan" ? (target.view?.phase ?? null) : null;
    projectContext.selectProject(projectId, {
      workspace: nextWorkspace,
      phase: nextPhase,
      historyMode: "push",
    });
    setWorkspace(nextWorkspace);
    setPhaseFocus(nextPhase);
    setSelected(isDemoProject(target) ? phases[2].nodes[0] : null);
    setLeftOpen(false);
    setRightOpen(false);
    window.requestAnimationFrame(resetWorkspaceScroll);
  };

  const openDemoProject = () => {
    let demo = projectContext.projects.find((project) =>
      isDemoProject(project),
    );
    if (!demo)
      demo = projectContext.registerProject(createDemoProjectSession(), {
        activate: true,
      });
    projectContext.selectProject(demo.projectId, {
      workspace: "home",
      phase: null,
      historyMode: "push",
    });
    setWorkspace("home");
    setPhaseFocus(null);
    setSelected(phases[2].nodes[0]);
    showToast(
      "Explicit Demo opened. Its fixtures are not imported-app evidence.",
    );
  };

  const registerCapturedProject = (input) => {
    const project = projectContext.registerImportedProject(input, {
      activate: true,
    });
    const selectedProject = projectContext.selectProject(project.projectId, {
      workspace: "structure",
      phase: null,
      historyMode: "replace",
    });
    const observation = captureOperationDefinitions(selectedProject, input.census);
    setDefinitionObservations((current) => {
      const next = { ...current };
      if (observation) next[project.projectId] = observation;
      else delete next[project.projectId];
      return next;
    });
    setWorkspace("structure");
    setSelected(null);
    recordDiagnostic(
      "project",
      "info",
      `${project.projectId} registered from a redacted census receipt.`,
    );
    return project;
  };

  const markCapturedProjectUnavailable = ({ registration, reason }) => {
    const project = projectContext.projects.find(
      (item) =>
        item.registration?.rootIdentity &&
        item.registration.rootIdentity === registration?.rootIdentity,
    );
    if (project && !isDemoProject(project))
      projectContext.markState(project.projectId, "unavailable", {
        reason: "workspace-authority-unavailable",
      });
    // StructureWorkspace owns the single scan diagnostic. This callback only
    // invalidates matching project state; logging here duplicates each failure.
  };

  const selectedForInspector = useMemo(() => {
    if (!demoMode) return selected;
    const phaseNode = phases
      .flatMap((phase) => phase.nodes)
      .find((node) => node.id === selected?.id);
    return phaseNode ?? selected;
  }, [selected, demoMode]);

  const showToast = (message, severity = "neutral") => {
    window.clearTimeout(toastTimer.current);
    setToast({ message, severity: ["success", "warning", "error"].includes(severity) ? severity : "neutral" });
    toastTimer.current = window.setTimeout(() => setToast(null), 6000);
  };

  const exportDiagnostics = async () => {
    const projectId = activeProject?.projectId ?? GLOBAL_DIAGNOSTIC_PROJECT_ID;
    const capturedScope = { ...diagnosticScopeRef.current, payload: { operation: "diagnostic-export" } };
    const stillCurrent = () => diagnosticScopeRef.current.projectId === capturedScope.projectId
      && diagnosticScopeRef.current.projectGeneration === capturedScope.projectGeneration;
    try {
      const payload = await eventLedger.exportReport(projectId, GLOBAL_DIAGNOSTIC_PROJECT_ID);
      const { downloadDiagnosticReport } = await import("./runtime/downloadDiagnosticReport.js");
      downloadDiagnosticReport(payload, projectId);
      if (stillCurrent()) showToast("A redacted diagnostic report was exported. It is not execution proof.");
    } catch {
      recordDiagnostic(
        "diagnostics",
        "error",
        "The diagnostic report could not be exported in this runtime.",
        capturedScope,
      );
      if (stillCurrent()) showToast(
        "Operations export is unavailable in this runtime. The failure was logged.",
      );
    }
  };

  const openIndexedItem = (entry) => {
    setLeftOpen(false);
    setRightOpen(false);
    if (entry.evidenceId) {
      const evidence = evidenceNodes.find(
        (node) => node.id === entry.evidenceId,
      );
      if (evidence) setSelected(evidence);
      setWorkspace("evidence");
      return;
    }
    if (entry.evidenceJourneyId) {
      const step = journeySteps.find(
        (item) => item.id === entry.evidenceJourneyId,
      );
      setSelected({
        id: step.id,
        title: step.title,
        status:
          step.status === "built"
            ? "ready"
            : step.status === "partial"
              ? "active"
              : "queued",
        estimate: `${step.completion}% complete`,
        x: step.side === "left" ? 20 : 80,
        image: step.proof,
        items: [
          step.notes,
          `Route ${step.route}`,
          `Depends on ${step.dependency}`,
          step.proof ? "Screenshot proof attached" : "Screenshot proof missing",
        ],
      });
      setWorkspace("evidence");
      return;
    }
    if (entry.documentId) {
      const document = documentLedger.find(
        (item) => item.id === entry.documentId,
      );
      setSelected({
        id: document.id,
        title: document.name,
        status: document.state === "built" ? "ready" : "active",
        estimate: document.progress,
        items: [
          "Source trace",
          "Requirement links",
          "Build references",
          "Proof references",
        ],
      });
      setWorkspace("ledger");
      return;
    }
    const node = entry.nodeId
      ? phases
          .flatMap((phase) => phase.nodes)
          .find((item) => item.id === entry.nodeId)
      : null;
    if (node) setSelected(node);
    setPhaseFocus(entry.phaseId ?? "P1");
    setWorkspace("plan");
  };

  return (
    <div
      className={`app-shell workspace-${workspace} ${opsOpen ? "ops-is-open" : ""}`}
    >
      <TopBar
        workspace={workspace}
        onWorkspace={navigateWorkspace}
        onToast={showToast}
        onDiagnostic={recordDiagnostic}
        onOpenDiagnostics={(tab = "logs") => {
          setOpsTab(tab);
          setOpsOpen(true);
        }}
        collisionGate={collisionGate}
        projectContext={projectContext}
        onProjectSelect={selectProject}
        onOpenDemo={openDemoProject}
        runtimeCapabilityReceipts={runtimeCapabilityReceipts}
        runtimeCapabilityNow={runtimeCapabilityNow}
        plannerConnection={plannerConnection}
        onCheckPlannerConnection={checkPlannerConnection}
        onDisconnectPlannerConnection={disconnectPlannerConnection}
      />
      <main className="app-main">
        {demoMode && <DemoSampleBadge />}
        <div className={`workspace-stage${stageForWorkspace(workspace)?.id === "coordinate" ? " workspace-stage-coordinate" : ""}`} key={workspace}>
          {stageForWorkspace(workspace)?.id === "coordinate" && <WorkspacePageNavigation stage={stageForWorkspace(workspace)} workspace={workspace} onWorkspace={navigateWorkspace} />}
          {workspace === "home" && (
            <ProjectHomeWorkspace
              collisionGate={collisionGate}
              intakeSummary={intakeSummary}
              onWorkspace={navigateWorkspace}
              activeProject={activeProject}
              onOpenDemo={openDemoProject}
            />
          )}
          {workspace === "blueprint" &&
            (projectWorkflowReady ? (
              <BlueprintWorkspace
                activeProject={activeProject}
                onOpenStructure={() => navigateWorkspace("structure")}
                onSelect={(item) => {
                  setSelected(item);
                  setInspectorSide("right");
                  setRightOpen(true);
                }}
              />
            ) : (
              <ProjectWorkspaceGate
                workspace="blueprint"
                activeProject={activeProject}
                onWorkspace={navigateWorkspace}
              />
            ))}
          {workspace === "structure" && (
            <StructureWorkspace
              activeProject={activeProject}
              onOpenBlueprint={() => navigateWorkspace("blueprint")}
              onToast={showToast}
              onIntakeSummary={setIntakeSummary}
              onProjectCaptured={registerCapturedProject}
              onProjectUnavailable={markCapturedProjectUnavailable}
              onDiagnostic={recordDiagnostic}
            />
          )}
          {workspace === "components" && (
            <ComponentPlansWorkspace
              onToast={showToast}
              activeProject={activeProject}
              onOpenStructure={() => navigateWorkspace("structure")}
            />
          )}
          {workspace === "plan" &&
            (demoMode ? (
              <PlanWorkspace
                collisionGate={collisionGate}
                selectedId={selected?.id}
                phaseFocus={phaseFocus}
                onOpenMap={setPhaseFocus}
                onCloseMap={() => setPhaseFocus(null)}
                onNodeOpen={(item) => {
                  setSelected(item);
                  setInspectorSide(item.side ?? "right");
                  setLeftOpen(false);
                  setRightOpen(true);
                }}
              />
            ) : projectWorkflowReady ? (
              <ImportedProjectWorkflowWorkspace
                workspace="plan"
                activeProject={activeProject}
                onWorkspace={navigateWorkspace}
                onSelect={(item) => {
                  setSelected(item);
                  setInspectorSide("right");
                  setRightOpen(true);
                }}
              />
            ) : (
              <ProjectWorkspaceGate
                workspace="plan"
                activeProject={activeProject}
                onWorkspace={navigateWorkspace}
              />
            ))}
          {workspace === "collision" &&
            (demoMode ? (
              <CollisionWorkspace
                onGateChange={setCollisionGate}
                onToast={showToast}
              />
            ) : projectWorkflowReady ? (
              <ImportedProjectWorkflowWorkspace
                workspace="collision"
                activeProject={activeProject}
                onWorkspace={navigateWorkspace}
                onSelect={(item) => {
                  setSelected(item);
                  setInspectorSide("right");
                  setRightOpen(true);
                }}
              />
            ) : (
              <ProjectWorkspaceGate
                workspace="collision"
                activeProject={activeProject}
                onWorkspace={navigateWorkspace}
              />
            ))}
          {workspace === "allocation" &&
            (demoMode ? (
              <AllocationWorkspace
                collisionGate={collisionGate}
                onOpenCollision={() => navigateWorkspace("collision")}
                onSelect={(item) => {
                  setSelected(item);
                  setInspectorSide("right");
                  setRightOpen(true);
                }}
              />
            ) : projectWorkflowReady ? (
              <ImportedProjectWorkflowWorkspace
                workspace="allocation"
                activeProject={activeProject}
                onWorkspace={navigateWorkspace}
                onSelect={(item) => {
                  setSelected(item);
                  setInspectorSide("right");
                  setRightOpen(true);
                }}
              />
            ) : (
              <ProjectWorkspaceGate
                workspace="allocation"
                activeProject={activeProject}
                onWorkspace={navigateWorkspace}
              />
            ))}
          {workspace === "build" &&
            (demoMode ? (
              <BuildWorkspace
                collisionGate={collisionGate}
                onWorkspace={navigateWorkspace}
              />
            ) : projectWorkflowReady ? (
              <ImportedProjectWorkflowWorkspace
                workspace="build"
                activeProject={activeProject}
                onWorkspace={navigateWorkspace}
                onSelect={(item) => {
                  setSelected(item);
                  setInspectorSide("right");
                  setRightOpen(true);
                }}
              />
            ) : (
              <ProjectWorkspaceGate
                workspace="build"
                activeProject={activeProject}
                onWorkspace={navigateWorkspace}
              />
            ))}
          {workspace === "integrity" &&
            (demoMode ? (
              <IntegrityWorkspace
                collisionGate={collisionGate}
                onSelect={(item) => {
                  setSelected(item);
                  setInspectorSide("right");
                  setRightOpen(true);
                }}
              />
            ) : projectWorkflowReady ? (
              <ImportedProjectWorkflowWorkspace
                workspace="integrity"
                activeProject={activeProject}
                onWorkspace={navigateWorkspace}
                onSelect={(item) => {
                  setSelected(item);
                  setInspectorSide("right");
                  setRightOpen(true);
                }}
              />
            ) : (
              <ProjectWorkspaceGate
                workspace="integrity"
                activeProject={activeProject}
                onWorkspace={navigateWorkspace}
              />
            ))}
          {workspace === "evidence" &&
            (demoMode ? (
              <EvidenceWorkspace
                selectedId={selected?.id}
                onSelect={(item) => {
                  setSelected(item);
                  setInspectorSide((item.x ?? 100) < 50 ? "left" : "right");
                  setLeftOpen(false);
                  setRightOpen(true);
                }}
                zoom={zoom}
                onZoom={setZoom}
              />
            ) : projectWorkflowReady ? (
              <ImportedProjectWorkflowWorkspace
                workspace="evidence"
                activeProject={activeProject}
                onWorkspace={navigateWorkspace}
                onSelect={(item) => {
                  setSelected(item);
                  setInspectorSide("right");
                  setRightOpen(true);
                }}
              />
            ) : (
              <ProjectWorkspaceGate
                workspace="evidence"
                activeProject={activeProject}
                onWorkspace={navigateWorkspace}
              />
            ))}
          {workspace === "ledger" &&
            (demoMode ? (
              <LedgerWorkspace
                onSelect={(item) => {
                  setSelected(item);
                  setInspectorSide("right");
                  setRightOpen(true);
                }}
              />
            ) : projectWorkflowReady ? (
              <ImportedProjectWorkflowWorkspace
                workspace="ledger"
                activeProject={activeProject}
                onWorkspace={navigateWorkspace}
                onSelect={(item) => {
                  setSelected(item);
                  setInspectorSide("right");
                  setRightOpen(true);
                }}
              />
            ) : (
              <ProjectWorkspaceGate
                workspace="ledger"
                activeProject={activeProject}
                onWorkspace={navigateWorkspace}
              />
            ))}
          {workspace === "index" && (
            <div className="index-overlay">
              {demoMode ? (
                <IndexWorkspace
                  onOpen={openIndexedItem}
                  onClose={() => navigateWorkspace("home")}
                />
              ) : projectWorkflowReady ? (
                <ImportedProjectWorkflowWorkspace
                  workspace="index"
                  activeProject={activeProject}
                  onWorkspace={navigateWorkspace}
                  onSelect={(item) => {
                    setSelected(item);
                    setInspectorSide("right");
                    setRightOpen(true);
                  }}
                />
              ) : (
                <ProjectWorkspaceGate
                  workspace="index"
                  activeProject={activeProject}
                  onWorkspace={navigateWorkspace}
                />
              )}
            </div>
          )}
        </div>
      </main>

      <EdgeHandle
        side="left"
        label="Repositories"
        onClick={() => {
          setRightOpen(false);
          setLeftOpen(true);
        }}
      />
      {selected && (
        <EdgeHandle
          side="right"
          label="Inspector"
          onClick={() => {
            setInspectorSide("right");
            setLeftOpen(false);
            setRightOpen(true);
          }}
        />
      )}
      <RepositoryDrawer
        open={leftOpen}
        onClose={() => setLeftOpen(false)}
        onWorkspace={navigateWorkspace}
        projectContext={projectContext}
        onProjectSelect={selectProject}
      />
      {selected && (
        <InspectorDrawer
          open={rightOpen}
          onClose={() => setRightOpen(false)}
          selected={selectedForInspector}
          demoMode={demoMode}
          side={inspectorSide}
        />
      )}
      {(leftOpen || rightOpen) && (
        <button
          className="drawer-scrim"
          aria-label="Close open drawer"
          onClick={() => {
            setLeftOpen(false);
            setRightOpen(false);
          }}
        />
      )}

      <DeveloperNotes project={activeProject}/>
      <OpsDock
        onRuntimeLoadError={() => recordDiagnostic("runtime", "error", "Connection tools could not be downloaded. No connection check was run.", { ...diagnosticScopeRef.current, adapter: "runtime-tools" })}
        onGitInventoryEvent={(event) => recordDiagnostic("git", event.severity, event.message, { adapter: "native-git-inventory", projectId: event.projectId, projectGeneration: event.generation, requestId: event.requestId, payload: event.payload })}
        open={opsOpen}
        activeTab={opsTab}
        onTab={setOpsTab}
        onToggle={() => setOpsOpen((value) => !value)}
        onToast={showToast}
        diagnostics={diagnostics}
        diagnosticHealth={diagnosticHealth}
        onExportDiagnostics={exportDiagnostics}
        activeProject={activeProject}
        demoMode={demoMode}
        runtimeCapabilityReceipts={runtimeCapabilityReceipts}
        runtimeCapabilityNow={runtimeCapabilityNow}
        collisionGate={collisionGate}
        definitionObservation={definitionObservations[activeProject?.projectId] ?? null}
        plannerConnection={plannerConnection}
        onCheckPlannerConnection={checkPlannerConnection}
        onDisconnectPlannerConnection={disconnectPlannerConnection}
      />
      {toast && (
        <div className={`toast toast-${toast.severity}`} role={toast.severity === "error" ? "alert" : "status"}>
          {toast.severity === "success" ? <CheckCircleIcon weight="fill" aria-hidden="true" /> : toast.severity === "neutral" ? <ChatsCircleIcon aria-hidden="true" /> : <WarningIcon weight="fill" aria-hidden="true" />}
          <span>{toast.message}</span>
          <button type="button" aria-label="Dismiss notification" onClick={() => { window.clearTimeout(toastTimer.current); setToast(null); }}><XCircleIcon aria-hidden="true" /></button>
        </div>
      )}
    </div>
  );
}

export function PerfectPlannerShell({
  runtimeCapabilityReceipts = EMPTY_RUNTIME_CAPABILITY_RECEIPTS,
  runtimeCapabilityNow,
  diagnosticSession,
}) {
  const projectContext = useOptionalProject();
  if (!projectContext)
    return (
      <ProjectProvider>
        <PerfectPlannerShellBridge
          diagnosticSession={diagnosticSession}
          runtimeCapabilityReceipts={runtimeCapabilityReceipts}
          runtimeCapabilityNow={runtimeCapabilityNow}
        />
      </ProjectProvider>
    );
  return (
    <PerfectPlannerShellCore
      diagnosticSession={diagnosticSession}
      projectContext={projectContext}
      runtimeCapabilityReceipts={runtimeCapabilityReceipts}
      runtimeCapabilityNow={runtimeCapabilityNow}
    />
  );
}

function PerfectPlannerShellBridge({
  runtimeCapabilityReceipts,
  runtimeCapabilityNow,
  diagnosticSession,
}) {
  const projectContext = useOptionalProject();
  return (
    <PerfectPlannerShellCore
      diagnosticSession={diagnosticSession}
      projectContext={projectContext}
      runtimeCapabilityReceipts={runtimeCapabilityReceipts}
      runtimeCapabilityNow={runtimeCapabilityNow}
    />
  );
}
