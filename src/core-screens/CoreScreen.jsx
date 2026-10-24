import { ArrowClockwiseIcon, LockSimpleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useViewMode } from "../project/viewMode.js";
import { claimPersonSession, CORE_SESSION_EVENT, coreReadAccess, hasPersonSession, useCoreResource } from "./coreApi.js";
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
      <StartHistoryNotice />
      {status === "loading" && <CoreLoading label={`Loading ${title.toLowerCase()}`} />}
      {status === "error" && <CoreError error={resource.error} onRetry={resource.reload} />}
      {status === "empty" && <div className="core-empty" role="status">{empty}</div>}
      {/* "no-session": nothing to show; the notice above says how to open the window properly. */}
      {status === "ready" && children}
    </section>
  );
}

/** Whether this window may make changes (it was opened from the launcher's one-time link). */
export function usePersonSession() {
  return useCoreSession().person;
}

/** { person, readAccess }: whether this window can make changes, and whether the host serves it reads. */
export function useCoreSession() {
  const [state, setState] = useState(() => ({ person: hasPersonSession(), readAccess: coreReadAccess() }));
  useEffect(() => {
    let live = true;
    const refresh = () => { if (live) setState({ person: hasPersonSession(), readAccess: coreReadAccess() }); };
    claimPersonSession().then(refresh, () => undefined);
    globalThis.addEventListener?.(CORE_SESSION_EVENT, refresh);
    return () => {
      live = false;
      globalThis.removeEventListener?.(CORE_SESSION_EVENT, refresh);
    };
  }, []);
  return state;
}

const HOW_TO_OPEN = "Go to the terminal where Perfect Planner is running and press Enter (with npm run dev, type l then Enter) to print a new link, or restart it. Then open that link.";

export function ReadOnlyNotice() {
  const { person, readAccess } = useCoreSession();
  if (person) return null;
  // A window that has the session cookie but not this tab's write token can still read.
  const canRead = readAccess === "yes";
  return (
    <p className="core-readonly" role="note" data-session={canRead ? "read-only" : "none"}>
      <LockSimpleIcon aria-hidden="true" />{" "}
      {canRead
        ? <>You can look but not change anything in this window. For a window that can make changes: {HOW_TO_OPEN}</>
        : <>This window is not connected to Perfect Planner yet, so it cannot show your project. It has to be opened from a one-time link. {HOW_TO_OPEN}</>}
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

const INTEGRITY_PROBLEMS = {
  "rolled-back": "This project's history is missing work this computer saw written: an older copy of it was put back, or its end was cut off. Nothing here can be approved or changed until that is sorted out.",
  damaged: "This project's history fails its tamper check, so nothing here can be approved or changed until that is sorted out.",
};

const INTEGRITY_NEXT = {
  "rolled-back": "Its history stays readable. Restore the missing entries from git or a backup, then restart Perfect Planner.",
  damaged: "Its history stays readable. Restore it from git or a backup, then restart Perfect Planner. The Ledger screen in Advanced view shows where it breaks.",
};

/** A project whose owner cannot sign here, or whose history was rolled back, is a hard stop: say so and what to do, instead of failing on every click. */
export function OwnerNotice() {
  const status = useCoreResource("/status");
  const integrity = status.data?.integrity;
  const broken = integrity && INTEGRITY_PROBLEMS[integrity.state];
  if (broken) {
    return (
      <div className="core-owner-stop" role="alert" data-integrity-state={integrity.state}>
        <WarningCircleIcon weight="fill" aria-hidden="true" />
        <div>
          <strong>{broken}</strong>
          <p>{INTEGRITY_NEXT[integrity.state]}</p>
          {integrity.reason && <AdvancedOnly as="p">{integrity.reason}</AdvancedOnly>}
        </div>
      </div>
    );
  }
  const owner = status.data?.owner;
  const problem = owner && OWNER_PROBLEMS[owner.state];
  if (!problem) return null;
  return (
    <div className="core-owner-stop" role="alert" data-owner-state={owner.state}>
      <WarningCircleIcon weight="fill" aria-hidden="true" />
      <div>
        <strong>{problem}</strong>
        <p>{OWNER_NEXT[owner.state] ?? OWNER_NEXT.default}</p>
        {owner.reason && (owner.state === "unavailable" ? <p>{owner.reason}</p> : <AdvancedOnly as="p">{owner.reason}</AdvancedOnly>)}
      </div>
    </div>
  );
}

/**
 * A folder nobody has written to here: nothing is written until the person starts its history. When the
 * folder's repo shows earlier Perfect Planner use (a history may have been wiped), say so first.
 */
export function StartHistoryNotice({ onStarted } = {}) {
  const status = useCoreResource("/status");
  const person = usePersonSession();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const owner = status.data?.owner;
  if (!person || owner?.state !== "new" || owner.started) return null;
  const signals = Array.isArray(owner.signals) ? owner.signals : [];
  const start = async () => {
    setBusy(true);
    setError("");
    try {
      await status.post("/owner/start", {});
      onStarted?.();
    } catch (failure) {
      setError(failure?.message ?? "The history could not be started.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={signals.length ? "core-owner-stop core-start-history" : "core-start-history"} role={signals.length ? "alert" : "region"} aria-label="Start a new history" data-start-history={signals.length ? "warn" : "new"}>
      {signals.length ? <WarningCircleIcon weight="fill" aria-hidden="true" /> : null}
      <div>
        <strong>{signals.length ? "This folder may have had a Perfect Planner history before." : "This folder has no Perfect Planner history yet."}</strong>
        {signals.length > 0 && (
          <>
            <p>These are signs, not proof. If you did not delete its history yourself, stop and check the folder before starting again:</p>
            <ul>{signals.map((signal) => <li key={signal}>{signal}</li>)}</ul>
          </>
        )}
        <p>Nothing is written to this project until you start its history. You become its owner on this computer.</p>
        {error && <p role="alert">{error}</p>}
        <button type="button" className="core-button primary" onClick={start} disabled={busy}>
          {busy ? "Starting…" : "Start a new history for this folder"}
        </button>
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
