import { useMemo, useState } from "react";
import { CheckCircleIcon, CircleDashedIcon, SealCheckIcon, WarningIcon } from "@phosphor-icons/react";
import { writeSection } from "../project/projectWorkRecords.js";
import { latestMergedTest, proofCoverage, proofItems, proofScope, saveErrorMessage, signOffRecord } from "../project/proofRecords.js";
import { collisionSummary, ownerSummary } from "../project/integritySummary.js";
import { useProjectTaskDrafts } from "./useProjectTaskDrafts.js";
import { KindChecks, scopeSentence } from "./ProjectEvidencePanel.jsx";
import "./ProjectProofPanels.css";

const when = (value) => { const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toLocaleString() : "unknown time"; };
const STATUS_LABELS = { complete: "Complete", partial: "Partial", none: "No proof" };

function Check({ state, title, children, action }) {
  const Icon = state === "done" ? CheckCircleIcon : state === "open" || state === "stale" ? WarningIcon : CircleDashedIcon;
  return <li className={`integrity-check is-${state}`}><Icon weight={state === "done" ? "fill" : "regular"} aria-hidden="true" /><span><strong>{title}</strong><small>{children}</small></span>{action}</li>;
}

export function ProjectIntegrityPanel({ project, records, onWorkspace, store, storage, now }) {
  const drafts = useProjectTaskDrafts(project, store);
  const sections = records?.sections ?? {};
  const scope = useMemo(() => proofScope(sections, drafts.ledger), [sections, drafts.ledger]);
  const items = proofItems(sections);
  const coverage = useMemo(() => proofCoverage(scope, items), [scope, items]);
  const titles = useMemo(() => new Map((drafts.ledger?.tasks ?? []).map((task) => [task.id, task.title])), [drafts.ledger]);
  const collisions = collisionSummary(sections.collisions);
  const owners = ownerSummary(sections.allocation, scope.taskIds, drafts.ledger);
  const merged = latestMergedTest(items);
  const review = sections.review?.data ?? null;
  const signedCurrent = Boolean(review?.planDigest) && review.planDigest === scope.digest;
  const [reviewer, setReviewer] = useState("");
  const [notes, setNotes] = useState("");
  const [message, setMessage] = useState({ text: "", error: false });
  const proofDone = coverage.total > 0 && coverage.complete === coverage.total;

  function signOff(event) {
    event.preventDefault();
    try {
      const record = { ...signOffRecord({ scope, reviewer, notes, now: now?.() }), proofAtSignOff: { complete: coverage.complete, total: coverage.total } };
      writeSection(project.projectId, "review", record, storage ? { storage } : undefined);
      setMessage({ text: `Signed off by ${record.reviewer}.`, error: false });
      setNotes("");
    } catch (cause) {
      setMessage({ text: saveErrorMessage(cause), error: true });
    }
  }

  if (!drafts.binding) return <section className="proof-panel" aria-label="Plan check"><h2>Plan check</h2><p>Choose your app folder in Structure before checking the plan.</p></section>;

  return <section className="proof-panel integrity-panel" aria-label="Plan check">
    <header className="proof-panel-head">
      <div><h2>Plan check</h2><p>{drafts.busy && !drafts.ledger ? "Reading your tasks…" : scopeSentence(scope)}</p></div>
      <dl className="proof-tally" aria-label="Proof coverage">
        <div><dt>Complete</dt><dd>{coverage.complete}</dd></div>
        <div><dt>Partial</dt><dd>{coverage.partial}</dd></div>
        <div><dt>No proof</dt><dd>{coverage.none}</dd></div>
      </dl>
    </header>
    {drafts.error && <p role="alert" className="proof-error">Tasks could not be read: {drafts.error}</p>}

    <ul className="integrity-checks" aria-label="Checks before sign-off">
      <Check state={!coverage.total ? "none" : proofDone ? "done" : "open"} title="Proof for every task" action={<button type="button" onClick={() => onWorkspace?.("evidence")}>Open Evidence</button>}>
        {coverage.total ? `${coverage.complete} of ${coverage.total} tasks have complete proof.` : "There are no tasks to prove yet."}
      </Check>
      <Check state={collisions.state === "unknown" ? "none" : collisions.state} title="File conflicts resolved" action={<button type="button" onClick={() => onWorkspace?.("collision")}>Open Collision</button>}>{collisions.text}</Check>
      <Check state={owners.state === "unknown" ? "none" : owners.state} title="Owners assigned" action={<button type="button" onClick={() => onWorkspace?.("allocation")}>Open Allocation</button>}>{owners.text}</Check>
      <Check state={!merged ? "none" : merged.outcome === "passed" ? "done" : "open"} title="Tests passed on the merged code">
        {!merged ? "No test result on the merged code has been added. Add one in Evidence and tick “These tests ran on the merged code”." : `${merged.outcome === "passed" ? "Passed" : "Failed"}: ${merged.label || "test run"} (${merged.taskId}), added by ${merged.addedBy} on ${when(merged.addedAt)}.`}
      </Check>
    </ul>

    {coverage.total > 0 && <div className="integrity-table-wrap" role="region" aria-label="Proof by task" tabIndex={0}><table className="integrity-table">
      <thead><tr><th scope="col">Task</th><th scope="col">Proof</th><th scope="col">Status</th></tr></thead>
      <tbody>{coverage.tasks.map((task) => <tr key={task.taskId} className={`status-${task.status}`}>
        <th scope="row"><code>{task.taskId}</code> {titles.get(task.taskId) ?? ""}</th>
        <td><KindChecks task={task} /></td>
        <td><span className={`integrity-status status-${task.status}`}>{STATUS_LABELS[task.status]}</span></td>
      </tr>)}</tbody>
    </table></div>}

    <section className="integrity-signoff" aria-label="Sign off">
      <h3><SealCheckIcon aria-hidden="true" />Sign off this plan version</h3>
      {review?.planDigest
        ? <p className={signedCurrent ? "proof-status" : "proof-error"}>{signedCurrent
          ? `Signed off by ${review.reviewer} on ${when(review.signedAt)} for this version of the plan.`
          : `Signed off by ${review.reviewer} on ${when(review.signedAt)}, but the plan has changed since. Sign off again to cover the current tasks.`}
          {review.notes ? ` Notes: ${review.notes}` : ""}</p>
        : <p>No one has signed off this plan yet.</p>}
      {coverage.total > 0 && !proofDone && <p className="proof-warn"><WarningIcon aria-hidden="true" />Not every task has complete proof. A sign-off now will record that only {coverage.complete} of {coverage.total} tasks were fully proven.</p>}
      <form onSubmit={signOff} className="proof-form">
        <div className="proof-form-grid">
          <div className="proof-form-row"><label htmlFor="integrity-reviewer">Reviewer name</label><input id="integrity-reviewer" value={reviewer} maxLength={120} autoComplete="name" onChange={(event) => setReviewer(event.target.value)} /></div>
          <div className="proof-form-row"><label htmlFor="integrity-notes">Notes (optional)</label><input id="integrity-notes" value={notes} maxLength={4000} onChange={(event) => setNotes(event.target.value)} /></div>
        </div>
        <p role="status" className={message.error ? "proof-error" : "proof-status"}>{message.text}</p>
        <div className="proof-actions"><button type="submit" className="proof-primary" disabled={!scope.taskIds.length || records?.unreadable}>{signedCurrent ? "Sign off again" : "Sign off this plan version"}</button></div>
      </form>
    </section>
  </section>;
}
