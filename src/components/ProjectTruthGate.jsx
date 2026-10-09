import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ClockIcon, ShieldCheckIcon, WarningIcon, XCircleIcon } from "@phosphor-icons/react";

const NON_READY_STATES = new Set(["empty", "unavailable", "stale"]);
const KNOWN_STATES = new Set(["empty", "demo", "imported", "generated", "authoritative", "ready", "unavailable", "stale"]);
// Exact identifiers stay available in Advanced view; Simple view hides them with CSS only.
const TECHNICAL_ROWS = new Set(["Project ID", "Generation", "Entity", "Digest", "Schema", "Revision", "Adapter"]);
const ROW_LABEL_OVERRIDES = { Generation: "Scan", Digest: "Fingerprint", "Authority reason": "Approval reason" };
const WINDOWS_PATH = /(?:[a-zA-Z]:[\\/]|\\\\)[^\n\r]*/g;
// A POSIX path starts with "/" followed directly by a path character, so a
// separator such as "To-do / Ledger" is not mistaken for a path.
const POSIX_PATH = /(^|[\s("'=])\/(?=[^\s/])[^\n\r]*/g;

function safeText(value) {
  if (value === null || value === undefined || value === "") return "Not available";
  if (typeof value === "object") return "Structured value withheld";

  return String(value)
    .replace(WINDOWS_PATH, "Local path hidden")
    .replace(POSIX_PATH, "$1Local path hidden");
}

function stateCopy(state, hasProject) {
  if (!hasProject || state === "empty") return "No active project has been selected.";
  if (state === "stale") return "This project is stale and must be refreshed before its values are trusted.";
  if (state === "unavailable") return "The project's saved status is unavailable. Existing values are not being presented as current.";
  if (state === "demo") return "This is an explicit demonstration project. Its fixtures are not imported-app evidence.";
  if (state === "imported") return "A folder check was recorded for this project. Planning approval has not been granted.";
  if (state === "generated") return "Generated project evidence is ready for human review, not yet approved.";
  if (state === "authoritative") return "Project status is approved for this recorded scan.";
  return "Project status is available for this recorded scan.";
}

function stateLabel(state, hasProject) {
  if (!hasProject || state === "empty") return "No active project";
  if (state === "stale") return "Stale";
  if (state === "unavailable") return "Unavailable";
  if (state === "demo") return "Demo";
  if (state === "imported") return "Observed";
  if (state === "generated") return "Needs review";
  if (state === "authoritative") return "Verified";
  return "Current";
}

function StateIcon({ state, hasProject }) {
  if (state === "stale") return <ClockIcon aria-hidden="true" />;
  if (hasProject && ["ready", "authoritative"].includes(state)) return <ShieldCheckIcon aria-hidden="true" />;
  return <WarningIcon aria-hidden="true" />;
}

/**
 * A project-scoped truth affordance for shared application chrome and workspace
 * empty states. It intentionally reads only safe, explicitly named fields from
 * projectSession and provenance; canonicalRoot/rootPath values are never used.
 */
export function ProjectTruthGate({
  projectSession = null,
  provenance = null,
  workspaceLabel = "Current workspace",
  workspaceState,
  reason,
  actionLabel,
  onAction,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  showWorkspaceState = true,
  className = "",
}) {
  const generatedId = useId();
  const dialogId = `project-truth-dialog-${generatedId.replace(/:/g, "")}`;
  const headingId = `${dialogId}-title`;
  const triggerRef = useRef(null);
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const previousFocusRef = useRef(null);
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const dialogOpen = isControlled ? controlledOpen : internalOpen;

  const hasProject = Boolean(projectSession?.projectId);
  const normalizedState = hasProject ? (workspaceState ?? projectSession?.state ?? "ready") : "empty";
  const state = KNOWN_STATES.has(normalizedState) ? normalizedState : "unavailable";
  const isDemo = String(projectSession?.kind ?? "").toLowerCase() === "demo";
  const projectName = hasProject ? safeText(projectSession?.displayName ?? projectSession?.name) : "No active project";
  const projectId = hasProject ? safeText(projectSession.projectId) : "Not available";
  const statusReason = safeText(reason ?? projectSession?.authorityReason ?? stateCopy(state, hasProject));

  const setDialogOpen = (nextOpen) => {
    if (!isControlled) setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };

  const rows = useMemo(() => {
    const detail = provenance ?? {};
    const workspace = projectSession?.registration ?? projectSession?.workspace ?? {};
    const census = projectSession?.census ?? {};
    const sessionProvenance = projectSession?.provenance ?? {};

    return [
      ["Field", detail.field],
      ["Value", detail.value],
      ["Project ID", detail.projectId ?? projectSession?.projectId],
      ["Generation", detail.generation ?? projectSession?.generation],
      ["Entity", detail.entity ?? detail.entityId],
      ["Source", detail.source ?? detail.sourceType ?? sessionProvenance.source],
      ["Digest", detail.digest ?? census.digest],
      ["Schema", detail.schema ?? detail.schemaVersion ?? projectSession?.schemaVersion],
      ["Revision", detail.revision ?? workspace.registryRevision],
      ["Timestamp", detail.timestamp ?? detail.observedAt ?? census.generatedAt ?? projectSession?.updatedAt],
      ["Adapter", detail.adapter ?? workspace.adapter],
      ["Authority reason", detail.authorityReason ?? projectSession?.authorityReason ?? (["ready", "authoritative"].includes(state) ? null : statusReason)],
    ].map(([label, value]) => ({
      key: label.toLowerCase().replaceAll(" ", "-"),
      label: ROW_LABEL_OVERRIDES[label] ?? label,
      value: safeText(value),
      technical: TECHNICAL_ROWS.has(label),
    }));
  }, [projectSession, provenance, state, statusReason]);

  useEffect(() => {
    if (!dialogOpen) return undefined;

    previousFocusRef.current = document.activeElement;
    queueMicrotask(() => closeRef.current?.focus());

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setDialogOpen(false);
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = [...(dialogRef.current?.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [])].filter((element) => !element.hasAttribute("hidden"));
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current?.focus();
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

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      const returnTarget = previousFocusRef.current === document.body ? triggerRef.current : previousFocusRef.current;
      returnTarget?.focus?.();
    };
  }, [dialogOpen]);

  return (
    <div
      className={`project-truth-gate project-truth-gate--persistent state-${state}${isDemo ? " is-demo" : ""}${className ? ` ${className}` : ""}`}
      data-project-id={hasProject ? projectSession.projectId : undefined}
      data-project-kind={isDemo ? "demo" : projectSession?.kind}
      data-project-state={state}
    >
      <button
        ref={triggerRef}
        type="button"
        className="project-truth-trigger"
        aria-haspopup="dialog"
        aria-expanded={dialogOpen}
        aria-controls={dialogId}
        onClick={() => setDialogOpen(true)}
      >
        <span className="project-truth-trigger-icon"><StateIcon state={state} hasProject={hasProject} /></span>
        <span className="project-truth-trigger-copy">
          <small>ACTIVE PROJECT</small>
          <strong>{projectName}</strong>
          <span className={hasProject ? "advanced-only" : undefined}>{hasProject ? projectId : stateLabel(state, hasProject)}{projectSession?.generation !== null && projectSession?.generation !== undefined ? ` · scan ${safeText(projectSession.generation)}` : ""}</span>
        </span>
        {isDemo && <span className="project-truth-demo-badge">Demo</span>}
        <span className={`project-truth-state-badge state-${state}`}>{stateLabel(state, hasProject)}</span>
      </button>

      {showWorkspaceState && NON_READY_STATES.has(state) && (
        <section className={`project-truth-workspace-state project-truth-workspace-state--${state}`} role="status" aria-live="polite">
          <StateIcon state={state} hasProject={hasProject} />
          <span>
            <strong>{safeText(workspaceLabel)}</strong>
            <small>{statusReason}</small>
          </span>
          {actionLabel && typeof onAction === "function" && <button type="button" className="project-truth-action" onClick={onAction}>{safeText(actionLabel)}</button>}
        </section>
      )}

      {dialogOpen && (
        <div className="project-truth-dialog-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) setDialogOpen(false); }}>
          <section
            ref={dialogRef}
            id={dialogId}
            className="project-truth-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={headingId}
            tabIndex={-1}
          >
            <header className="project-truth-dialog-header">
              <span>
                <small>PROJECT STATUS</small>
                <strong id={headingId}>Identity and source</strong>
              </span>
              {isDemo && <span className="project-truth-demo-badge">Demo</span>}
              <button ref={closeRef} type="button" className="project-truth-dialog-close" aria-label="Close project truth details" onClick={() => setDialogOpen(false)}><XCircleIcon aria-hidden="true" /></button>
            </header>

            <div className="project-truth-dialog-summary">
              <StateIcon state={state} hasProject={hasProject} />
              <span><strong>{projectName}</strong><small>{stateLabel(state, hasProject)} · {statusReason}</small></span>
            </div>

            <dl className="project-truth-provenance-list">
              {rows.map((row) => (
                <div key={row.key} className={`project-truth-provenance-row${row.technical ? " advanced-only" : ""}`} data-provenance-field={row.key}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      )}
    </div>
  );
}
