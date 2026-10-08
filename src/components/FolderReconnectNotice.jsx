import { ArrowClockwiseIcon, ClockCounterClockwiseIcon } from "@phosphor-icons/react";
import "./FolderReconnectNotice.css";

// Shown for a browser project after a reload: the saved scan is labelled
// "last scan" and the folder can be reconnected from a click.
export function FolderReconnectNotice({ status, busy = false, error = "", onReconnect }) {
  if (!status) return null;
  return (
    <section className={`folder-reconnect ${status.state}`} aria-label="Folder connection">
      <ClockCounterClockwiseIcon weight="duotone" aria-hidden="true" />
      <div>
        <strong>{status.title}</strong>
        {status.lastScan
          ? <small data-scan="last">{status.lastScan.text} · not current</small>
          : <small data-scan="none">No scan has been saved for this project yet.</small>}
        <p>{status.detail}</p>
        {error && <p role="alert" className="folder-reconnect-error">{error}</p>}
      </div>
      {status.action && onReconnect && (
        <button type="button" className="primary-button" onClick={onReconnect} disabled={busy}>
          <ArrowClockwiseIcon /> {busy ? "Reconnecting…" : status.action}
        </button>
      )}
    </section>
  );
}
