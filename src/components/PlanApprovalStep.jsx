import { useMemo, useState } from "react";
import { ArrowRightIcon, CheckCircleIcon, SealCheckIcon, WarningIcon } from "@phosphor-icons/react";
import { sameTaskDraftBinding } from "../project/taskDraftLedger.js";
import { overlapReview, overlapReviewText } from "../project/taskCoordination.js";
import { activePlanTasks, planApprovalStatus } from "../project/planApproval.js";
import { usePlanApproval } from "../project/usePlanApproval.js";
import "./PlanApprovalStep.css";

const SHOWN = 8;
const when = (iso) => { try { return new Date(iso).toLocaleString(); } catch { return iso; } };
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * Plan page panel: approve the saved tasks as this project's plan. Approval saves
 * a snapshot (ids, titles, fingerprint) on this device; it does not run anything.
 */
export function PlanApprovalStep({ project, records, onWorkspace, store }) {
  const status = planApprovalStatus(project, records);
  const { ledger, digest, error, loading, binding, approve } = usePlanApproval(project, records, { store, watch: false });
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [failure, setFailure] = useState("");
  const tasks = useMemo(() => activePlanTasks(ledger?.tasks), [ledger]);
  // Overlaps are decided on the Collision page; they are not missing task details.
  const collisionData = records?.sections?.collisions?.data ?? null;
  const overlaps = useMemo(() => (ledger ? overlapReview(ledger, collisionData) : null), [ledger, collisionData]);
  const missing = overlaps?.otherFindings ?? [];
  const overlapText = overlapReviewText(overlaps);
  if (!binding) return null;

  const projectBlocked = ["stale", "unavailable"].includes(project.state);
  const oldScan = Boolean(ledger && !sameTaskDraftBinding(ledger.binding, binding));
  const upToDate = status?.state === "recorded" && digest === status.record?.planDigest;
  const disabled = busy || loading || !ledger || !tasks.length || projectBlocked || oldScan || upToDate;
  const tone = status?.state === "recorded" ? "done" : status ? "attention" : "open";

  async function onApprove() {
    if (disabled) return;
    setBusy(true); setFailure(""); setNotice("");
    try {
      const record = await approve();
      setNotice(`Plan approved with ${plural(record.data.taskCount, "task")}. Nothing was run; this only records which tasks make up the plan.`);
    } catch (err) {
      setFailure(err?.message ?? "The plan could not be approved. Nothing was saved.");
    } finally { setBusy(false); }
  }

  return <section className={`plan-approval-step tone-${tone}`} aria-label="Approve this plan" data-requirement-target="AUTH-PLAN LEDGER-TASKS" tabIndex={-1}>
    <header>
      <span><SealCheckIcon aria-hidden="true" /><strong>Approve this plan</strong></span>
      <small>{status?.state === "recorded" ? "Approved" : status?.state === "review" ? "Tasks changed" : status?.state === "stale" ? "Out of date" : status ? "Needs approval again" : "Not approved yet"}</small>
    </header>
    <div className="plan-approval-step-body">
      {!status && <p>No plan is approved yet. Approving saves a snapshot of the saved tasks below on this device, so later pages can tell if the tasks change.</p>}
      {status?.core && <p className="plan-approval-step-state is-done"><CheckCircleIcon weight="fill" aria-hidden="true" />{status.detail} · {when(status.core.at)}.{status.confirmed ? " Project confirmed ready." : ""}</p>}
      {status?.state === "recorded" && status.record && <p className="plan-approval-step-state is-done"><CheckCircleIcon weight="fill" aria-hidden="true" />{plural(status.record.taskCount, "task")} approved {when(status.record.approvedAt)}{status.record.source === "planning-ledger" ? " through the planning ledger" : " on this device"}.{status.confirmed ? " Project confirmed ready." : ""}</p>}
      {status && status.state !== "recorded" && <p className="plan-approval-step-state is-attention"><WarningIcon weight="fill" aria-hidden="true" />{status.state === "review" ? "Tasks changed since approval." : status.detail}{status.state === "review" ? " Review them and approve again." : ""}</p>}
      {status?.state === "recorded" && status.record && digest && !upToDate && <p className="plan-approval-step-state is-attention"><WarningIcon weight="fill" aria-hidden="true" />The saved tasks no longer match the approved plan.</p>}

      {loading && <p role="status">Reading saved tasks…</p>}
      {error && <p role="alert" className="plan-approval-step-error">Saved tasks could not be read: {error}</p>}
      {oldScan && <p className="plan-approval-step-state is-attention"><WarningIcon aria-hidden="true" />These tasks were saved against an older folder scan. Review them in the Ledger first.</p>}
      {projectBlocked && <p className="plan-approval-step-state is-attention"><WarningIcon aria-hidden="true" />Refresh the project before approving its plan.</p>}

      {ledger && !tasks.length && <p>There are no saved tasks yet. Add the work as tasks in the Ledger, then come back to approve it.</p>}
      {tasks.length > 0 && <ol className="plan-approval-step-tasks" aria-label="Saved tasks in this plan">
        {tasks.slice(0, SHOWN).map((task) => <li key={task.id}><code>{task.id}</code><span>{task.title || "Untitled task"}</span></li>)}
        {tasks.length > SHOWN && <li className="more">+{tasks.length - SHOWN} more in the Ledger</li>}
      </ol>}
      {missing.length > 0 && <details className="plan-approval-step-missing"><summary>{plural(missing.length, "task detail")} still missing</summary><p>You can approve now, but these gaps stay visible until the tasks are completed in the Ledger.</p><ul>{missing.slice(0, 6).map((item, index) => <li key={index}>{item.detail}</li>)}</ul></details>}
      {overlapText.headline && <details className="plan-approval-step-missing" aria-label="Plan overlaps"><summary>{overlapText.headline}</summary><p>{overlaps.settled === overlaps.total ? "Every overlap between tasks has a decision on the Collision page." : "Tasks that change the same files need a decision on the Collision page. A split only counts once the two tasks’ file scopes no longer overlap."}</p><ul>{overlapText.lines.slice(0, 8).map((line) => <li key={line}>{line}</li>)}</ul>{overlaps.total > 8 && <p>+{overlaps.total - 8} more on the Collision page.</p>}{overlaps.splitPending > 0 && <button type="button" className="soft-button" onClick={() => onWorkspace?.("ledger")}>Edit file scopes in the Ledger <ArrowRightIcon aria-hidden="true" /></button>}{overlaps.open > 0 && <button type="button" className="soft-button" onClick={() => onWorkspace?.("collision")}>Decide overlaps on the Collision page <ArrowRightIcon aria-hidden="true" /></button>}</details>}

      {failure && <p role="alert" className="plan-approval-step-error">{failure}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="plan-approval-step-actions">
        <button type="button" className="primary-button" onClick={onApprove} disabled={disabled}><SealCheckIcon aria-hidden="true" />{busy ? "Approving…" : status ? "Approve the current tasks" : "Approve this plan"}</button>
        <button type="button" className="soft-button" onClick={() => onWorkspace?.("ledger")}>Edit tasks in the Ledger <ArrowRightIcon aria-hidden="true" /></button>
      </div>
      <small>Approval records which saved tasks make up the plan. It does not assign, build, or run anything. Unsaved edits in the Ledger are not included.</small>
    </div>
  </section>;
}
