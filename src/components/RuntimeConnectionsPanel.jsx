import { ArrowLeftIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import {AgentSessionsPanel} from './AgentSessionsPanel.jsx';
import {BrowserInputMarkerControl} from './BrowserInputMarkers.jsx';

import {
  runtimeCapabilityCatalog,
  selectRuntimeActionEligibility,
} from "../runtime/runtimeCapabilities.js";

const primaryActions = Object.freeze({
  browser: Object.freeze({ actionId: "browser.inspect", label: "Check browser evidence" }),
  "native-tauri": Object.freeze({ actionId: "native.inspect", label: "Check native evidence" }),
  "hosted-static": Object.freeze({ actionId: "hosted.inspect", label: "Check deployment evidence" }),
  mcp: Object.freeze({ actionId: "mcp.invoke-read", label: "Check MCP read eligibility" }),
  git: Object.freeze({ actionId: "git.inspect", label: "Check Git evidence" }),
  provider: Object.freeze({ actionId: "provider.request", label: "Check provider eligibility" }),
  ci: Object.freeze({ actionId: "ci.run", label: "Check CI run eligibility" }),
  "computer-use": Object.freeze({ actionId: "computer-use.inspect", label: "Check computer-use evidence" }),
});

const reasonLabels = Object.freeze({
  MCP_REQUEST_INVALID: "The connection request was not accepted. Check this project's registration.",
  MCP_BUSY: "Another check is running. Try again shortly.",
  MCP_REGISTRATION_INVALID: "This folder registration is no longer valid. Select the folder again.",
  MCP_SERVICE_UNAVAILABLE: "The bundled service could not start. Check the desktop installation.",
  MCP_PROTOCOL_ERROR: "The service response could not be verified. No connection was accepted.",
  MCP_TIMEOUT: "The connection check timed out. No current access was verified.",
  MCP_OUTPUT_LIMIT: "The service exceeded its response limit. The check was stopped.",
  MCP_INTERRUPTED: "The check was interrupted. Run a new check when ready.",
  MCP_CLEANUP_FAILED: "The helper did not confirm cleanup. The connection was not accepted.",
  "receipt-missing": "No project-bound runtime receipt",
  "project-binding-required": "Select an active project before using runtime evidence",
  "project-binding-mismatch": "Receipt belongs to a different project",
  "project-binding-invalid": "Receipt has an invalid project binding",
  "receipt-observed-in-future": "Receipt observation is in the future",
  "receipt-expired": "Receipt has expired",
  "duplicate-receipts": "Conflicting receipts were rejected",
  "receipt-schema-invalid": "Receipt schema is invalid",
  "schema-version-unsupported": "Receipt schema version is unsupported",
  "capability-unknown": "Receipt names an unknown runtime",
});

function humanizeReason(reason) {
  if (reasonLabels[reason]) return reasonLabels[reason];
  if (reason.startsWith("scope-missing:")) {
    return `Required ${reason.slice("scope-missing:".length)} scope is missing`;
  }
  if (reason.startsWith("capability-")) {
    return `Capability health is ${reason.slice("capability-".length)}`;
  }
  return reason.replaceAll("-", " ");
}

function fallbackCapability(descriptor, projectId) {
  return {
    available: false,
    capabilityId: descriptor.capabilityId,
    denialReasons: [projectId ? "receipt-missing" : "project-binding-required"],
    expiresAt: null,
    health: "unavailable",
    label: descriptor.label,
    observedAt: null,
    projectId: projectId ?? null,
    receiptId: null,
    scopes: [],
    source: null,
  };
}

function fallbackEligibility(action, capability, projectId) {
  return {
    actionId: action.actionId,
    capabilityId: capability.capabilityId,
    denialReasons: [projectId ? "receipt-missing" : "project-binding-required"],
    eligible: false,
    grantedScopes: [],
    health: "unavailable",
    projectId: projectId ?? null,
    requiredScopes: [],
  };
}

function formatReceiptTime(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleString("en-AU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function BundledPlannerConnection({ connection, onCheck, onDisconnect, inMenu = false }) {
  const status = connection?.status ?? "unavailable";
  const labels = {
    unavailable: "Unavailable",
    idle: "Not checked",
    checking: "Checking connection…",
    connected: "Connection checked · metadata access verified",
    failed: "Connection failed",
    expired: "Connection check expired",
  };
  return (
    <section
      className={inMenu ? "topbar-action-view" : `mcp-diagnostic-status ${status === "connected" ? "connected" : "disconnected"}`}
      aria-label="Bundled planner service"
      aria-busy={status === "checking"}
    >
      <strong>Bundled planner service</strong>
      <span role="status">{labels[status] ?? "Unavailable"}</span>
      <span>{connection?.reason ? humanizeReason(connection.reason) : "Open this project in the desktop app with a native folder registration to check its connection."}</span>
      <small>One-time check; the helper exits afterward. This does not connect an external MCP host or verify arbitrary tools, computer use, CI or deployment.</small>
      {connection?.observedAt && <small>Checked {formatReceiptTime(connection.observedAt)} · expires {formatReceiptTime(connection.expiresAt) ?? "unavailable"}</small>}
      <div>
      <button type="button" className="runtime-action-button" disabled={!connection?.canCheck || status === "checking" || !onCheck} onClick={onCheck}>
        {status === "checking" ? "Checking connection…" : "Check connection"}
      </button>{" "}
      <button type="button" className="runtime-action-button" disabled={!["checking", "connected", "expired"].includes(status) || !onDisconnect} onClick={onDisconnect}>
        Clear result
      </button>
      </div>
      <small>Clears this check result. Your folder stays registered.</small>
    </section>
  );
}

function RuntimeCapabilityCard({
  descriptor,
  matrix,
  projectId,
  mcpContextAllowed,
  onAction,
}) {
  const capability =
    matrix?.capabilities?.find(
      (candidate) => candidate.capabilityId === descriptor.capabilityId,
    ) ?? fallbackCapability(descriptor, projectId);
  const action = primaryActions[descriptor.capabilityId];
  let eligibility = fallbackEligibility(action, capability, projectId);
  if (matrix && projectId) {
    try {
      eligibility = selectRuntimeActionEligibility(matrix, action.actionId, {
        projectId,
      });
    } catch {
      eligibility = fallbackEligibility(action, capability, projectId);
    }
  }
  const reasons = capability.denialReasons.length
    ? capability.denialReasons
    : ["Current project-bound receipt"];
  const observedAt = formatReceiptTime(capability.observedAt);
  const expiresAt = formatReceiptTime(capability.expiresAt);

  return (
    <article
      className={`runtime-capability-card runtime-health-${capability.health}`}
      aria-label={`${descriptor.label} runtime capability`}
      data-runtime-capability={descriptor.capabilityId}
    >
      <header>
        <span>
          <strong>{descriptor.label}</strong>
          <small>{capability.source ?? "No project-bound receipt"}</small>
        </span>
        <b className="runtime-health-label">{capability.health}</b>
      </header>

      {descriptor.capabilityId === "mcp" && (
        <p className="runtime-preference-note">
          Context preference: {mcpContextAllowed ? "allowed" : "paused"} ·
          receipt still required
        </p>
      )}

      <div className="runtime-scope-list" aria-label="Runtime scopes">
        {descriptor.supportedScopes.map((scope) => {
          const granted = capability.scopes.includes(scope);
          return (
            <span
              key={scope}
              className={granted ? "scope-granted" : "scope-denied"}
            >
              {scope} {granted ? "granted" : "denied"}
            </span>
          );
        })}
      </div>

      <p className="runtime-reason">
        <b>Reason:</b>{" "}
        {reasons.map((reason) => humanizeReason(reason)).join(" · ")}
      </p>

      {capability.receiptId && (
        <dl className="runtime-receipt-meta">
          <div>
            <dt>Observed</dt>
            <dd>{observedAt ?? "Unavailable"}</dd>
          </div>
          <div>
            <dt>Expires</dt>
            <dd>{expiresAt ?? "Unavailable"}</dd>
          </div>
        </dl>
      )}

      <button
        type="button"
        className="runtime-action-button"
        disabled={!eligibility.eligible}
        data-runtime-action={action.actionId}
        title={
          eligibility.eligible
            ? "Project-bound runtime evidence is current."
            : eligibility.denialReasons.map(humanizeReason).join("; ")
        }
        onClick={() => onAction?.(eligibility, capability)}
      >
        {action.label}
      </button>
    </article>
  );
}

export function RuntimeConnectionsPanel({
  activeProject,
  onAgentObservation,
  onOpenProjectSetup,
  browserInput,
  matrix,
  mcpContextAllowed = false,
  onBack,
  onOpenDiagnostics,
  onAction,
  plannerConnection,
  onCheckPlannerConnection,
  onDisconnectPlannerConnection,
}) {
  const projectId = activeProject?.projectId ?? null;
  const availableCount = matrix?.counts?.available ?? 0;

  return (
    <section
      className="topbar-action-view runtime-connections-view"
      role="region"
      aria-label="Runtime and connections"
    >
      <header>
        <button
          type="button"
          className="popover-back"
          aria-label="Back to more actions"
          onClick={onBack}
        >
          <ArrowLeftIcon />
        </button>
        <span>
          <strong>Runtime &amp; connections</strong>
          <small>
            {activeProject
              ? `${activeProject.name} · ${availableCount} of 8 available`
              : "No active project · 0 of 8 available"}
          </small>
        </span>
      </header>

      <p className="runtime-contract-note">
        Receipts are project-bound and time-limited. Preferences and configured
        settings never establish availability.
      </p>

      <section className="runtime-capability-card" aria-label="Connect your agent">
        <header><strong>Connect your agent</strong><b>Start with your app folder</b></header>
        <p>Connect your IDE to the selected app in the desktop Planner. The header shows checked session observations and stops treating them as live when they expire.</p>
        <ol>
          <li>Choose your app folder in Planner. Scan it to enable submitted-plan access.</li>
          <li>Choose the access below, select Connect an IDE agent, and review the desktop approval.</li>
          <li>Add the generated configuration to your IDE's MCP settings, keeping its existing entries. Refresh its tools, then check agent sessions here.</li>
        </ol>
        <p>Task proposals and exchange reports require the corresponding access choice. Connecting an agent does not approve work or allow it to execute code.</p>
        <small>The bundled service check below is separate. Passing it does not connect your IDE.</small>
        <small>Only need read-only search across your apps? Use <strong>Connect agent</strong> in the top bar instead; it needs no desktop approval but cannot propose tasks or report exchanges.</small>
      </section>

      <BundledPlannerConnection connection={plannerConnection} onCheck={onCheckPlannerConnection} onDisconnect={onDisconnectPlannerConnection} inMenu />
      <AgentSessionsPanel project={activeProject} onObservation={onAgentObservation} onOpenProjectSetup={onOpenProjectSetup} />
      <BrowserInputMarkerControl control={browserInput}/>

      <div className="runtime-capability-grid">
        {runtimeCapabilityCatalog.map((descriptor) => (
          <RuntimeCapabilityCard
            key={descriptor.capabilityId}
            descriptor={descriptor}
            matrix={matrix}
            projectId={projectId}
            mcpContextAllowed={mcpContextAllowed}
            onAction={onAction}
          />
        ))}
      </div>

      <button
        type="button"
        className="runtime-diagnostics-link"
        onClick={onOpenDiagnostics}
      >
        <TerminalWindowIcon /> Open project runtime logs
      </button>
    </section>
  );
}
