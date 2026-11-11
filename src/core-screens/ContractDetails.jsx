import "./ContractDetails.css";

// One task's contract, collapsed: the files it may change and how much. Every rule runs on the server
// (core/planning signs it, core/gate checks the work); this only shows what the ledger says.
export default function ContractDetails({ contract, children }) {
  const { files, sizeCap, clauses = [], doneWhen, warnings = [], widened = [], check = null } = contract;
  const count = files.length;
  return (
    <details className="core-contract">
      <summary>
        Contract
        <span className="core-muted"> · {count === 0 ? "no files named" : `${count} file${count === 1 ? "" : "s"} or folder${count === 1 ? "" : "s"}`} · up to {sizeCap.maxFiles} files and {sizeCap.maxLines} lines</span>
      </summary>
      {warnings.map((text) => <p key={text} className="core-contract-warn" role="alert">{text}</p>)}
      {clauses.length > 0 && <ul className="core-contract-clauses">{clauses.map((clause) => <li key={clause}>{clause}</li>)}</ul>}
      <p className="core-contract-label">May change only</p>
      {count > 0
        ? <ul className="core-contract-files">{files.map((file) => <li key={file}><code>{file}</code></li>)}</ul>
        : <p>Nothing yet. The worker has to ask you before it changes any file.</p>}
      <p className="core-muted">Anything else is refused, including dependency files such as package.json and lockfiles unless they are named exactly.</p>
      {doneWhen && <p>Done when {doneWhen}</p>}
      {widened.map((w) => (
        <p key={w.decision} className="core-muted">You allowed {w.files.join(", ")} ({w.decision}){w.reason ? `: ${w.reason}` : ""}</p>
      ))}
      {check && (
        <p className={check.ok ? "core-contract-good" : "core-contract-warn"}>
          {check.ok ? `Last check: stayed inside its contract at ${check.commit.slice(0, 12)} (${check.files} files, ${check.lines} lines).` : (check.reason ?? `Last check: broke its contract at ${check.commit.slice(0, 12)}.`)}
        </p>
      )}
      {children}
    </details>
  );
}
