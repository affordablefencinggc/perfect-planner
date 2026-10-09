import { ArrowClockwiseIcon, LockSimpleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useViewMode } from "../project/viewMode.js";
import { claimPersonSession, hasPersonSession, useCoreResource } from "./coreApi.js";
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
      <OwnerNotice />
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
      <LockSimpleIcon aria-hidden="true" /> This window can only read. To make changes, open a new one-time link: press Enter in the terminal running Perfect Planner (l and Enter with npm run dev), or restart it, then open the link it prints.
    </p>
  );
}

const OWNER_PROBLEMS = {
  "key-missing": "This project's owner key is not on this computer, so nothing here can be approved or changed in it.",
  tampered: "This project's owner record does not check out on this computer, so nothing here can be approved or changed in it.",
  missing: "This computer has no owner record for this project, so nothing here can be approved or changed in it.",
  unavailable: "This computer's key store is not available, so nothing you approve can be signed.",
  replaced: "This folder's project history was deleted or swapped since you last worked here, so nothing here can be approved or changed in it.",
};

const OWNER_NEXT = {
  unavailable: "Unlock or set up the system keychain, then restart Perfect Planner.",
  default: "Its history stays readable. To keep working, open Perfect Planner on the computer that started this project, or start a new project in a new folder, which gets its own owner.",
};

/** A project whose owner cannot sign here is a hard stop: say so and what to do, instead of failing on every click. */
export function OwnerNotice() {
  const status = useCoreResource("/status");
  const owner = status.data?.owner;
  const problem = owner && OWNER_PROBLEMS[owner.state];
  if (!problem) return null;
  return (
    <div className="core-owner-stop" role="alert" data-owner-state={owner.state}>
      <WarningCircleIcon weight="fill" aria-hidden="true" />
      <div>
        <strong>{problem}</strong>
        <p>{OWNER_NEXT[owner.state] ?? OWNER_NEXT.default}</p>
        {owner.reason && <AdvancedOnly as="p">{owner.reason}</AdvancedOnly>}
      </div>
    </div>
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
