import { ArrowClockwiseIcon, LockSimpleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useViewMode } from "../project/viewMode.js";
import { claimPersonSession, hasPersonSession } from "./coreApi.js";
import "./coreScreens.css";

// Shared frame for the core loop screens: heading, purpose line, and the
// loading / empty / error states every screen must show the same way.
export function CoreScreen({ id, title, purpose, actions = null, resource, empty, children }) {
  const status = resource?.status ?? "ready";
  return (
    <section className={`core-screen core-screen-${id}`} aria-labelledby={`core-screen-${id}-title`} data-core-screen={id} data-state={status}>
      <header className="core-screen-head">
        <div>
          <h2 id={`core-screen-${id}-title`}>{title}</h2>
          {purpose && <p className="core-screen-purpose">{purpose}</p>}
        </div>
        {actions && <div className="core-screen-actions">{actions}</div>}
      </header>
      <ReadOnlyNotice />
      {status === "loading" && <CoreLoading label={`Loading ${title.toLowerCase()}`} />}
      {status === "error" && <CoreError error={resource.error} onRetry={resource.reload} />}
      {status === "empty" && <div className="core-empty" role="status">{empty}</div>}
      {status === "ready" && children}
    </section>
  );
}

/** Whether this window may make changes (it was opened from the launcher's one-time link). */
export function usePersonSession() {
  const [person, setPerson] = useState(hasPersonSession);
  useEffect(() => {
    let live = true;
    claimPersonSession().then((ok) => { if (live) setPerson(ok); }, () => undefined);
    return () => { live = false; };
  }, []);
  return person;
}

function ReadOnlyNotice() {
  if (usePersonSession()) return null;
  return (
    <p className="core-readonly" role="note">
      <LockSimpleIcon aria-hidden="true" /> This window can only read. To make changes, open a one-time link from the terminal running Perfect Planner: press Enter there for a new one, or restart it.
    </p>
  );
}

export function CoreLoading({ label = "Loading" }) {
  return (
    <div className="core-loading" role="status" aria-live="polite" aria-label={label}>
      <span className="core-skeleton" /><span className="core-skeleton" /><span className="core-skeleton short" />
    </div>
  );
}

export function CoreError({ error, onRetry }) {
  return (
    <div className="core-error" role="alert">
      <WarningCircleIcon weight="fill" aria-hidden="true" />
      <div>
        <strong>This screen could not load.</strong>
        <p>{error?.message || "Something went wrong reading the ledger."}</p>
      </div>
      {onRetry && <button type="button" className="core-button" onClick={onRetry}><ArrowClockwiseIcon aria-hidden="true" /> Try again</button>}
    </div>
  );
}

/** Text that only shows in Advanced view (ids, fingerprints, ledger numbers). */
export function AdvancedOnly({ children, as: Tag = "span", className = "" }) {
  const { mode } = useViewMode();
  if (mode !== "advanced") return null;
  return <Tag className={`core-advanced ${className}`.trim()}>{children}</Tag>;
}

export function useAdvanced() {
  return useViewMode().mode === "advanced";
}

/** Confidence 0..1 as a labelled meter. */
export function ConfidenceMeter({ value, label = "Confidence" }) {
  const pct = Math.max(0, Math.min(100, Math.round((Number(value) || 0) * 100)));
  const band = pct >= 75 ? "high" : pct >= 50 ? "medium" : "low";
  return (
    <span className={`core-confidence core-confidence-${band}`} title={`${label}: ${pct}%`}>
      <span className="core-confidence-track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><span style={{ width: `${pct}%` }} /></span>
      <span className="core-confidence-value">{pct}%</span>
    </span>
  );
}
