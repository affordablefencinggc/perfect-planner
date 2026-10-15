// Approved plan for an imported project (v1). The approval is a snapshot of the
// saved task drafts at the moment someone explicitly approved them, stored in the
// project's `planAuthority` work-record section. Nothing here infers approval:
// no record means "unanswered", and a record whose tasks no longer match is "review".
import { canonicalArchitectureJson as canonical, architectureSha256 as sha256 } from "../engine/architectureContractVerification.js";
import { readSection, writeSection } from "./projectWorkRecords.js";

export const PLAN_APPROVAL_SOURCES = Object.freeze(["local-approval", "planning-ledger"]);
const HEX64 = /^[0-9a-f]{64}$/;
const isIso = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const optionalIso = (value) => value == null || isIso(value);

/** Active (non-archived) tasks only; archiving a task changes the approved plan. */
export function activePlanTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : []).filter((task) => task && !task.archived);
}

/** SHA-256 of the canonical JSON of the active task drafts. */
export async function digestPlanTasks(tasks) {
  if (!globalThis.crypto?.subtle) throw new Error("This browser cannot check task changes, so the plan cannot be approved here.");
  return sha256(canonical(activePlanTasks(tasks)));
}

export function validPlanApproval(data) {
  if (!data || typeof data !== "object") return false;
  const { planDigest, taskIds, tasks, taskCount, approvedAt, source, ledgerRevision, censusDigest, confirmedAt, confirmedDigest, tasksChangedAt } = data;
  return HEX64.test(planDigest ?? "")
    && Array.isArray(taskIds) && taskIds.every((id) => typeof id === "string" && id)
    && Array.isArray(tasks) && tasks.length === taskIds.length && tasks.every((task, index) => task?.id === taskIds[index] && typeof task.title === "string")
    && taskCount === taskIds.length && taskCount > 0
    && isIso(approvedAt)
    && PLAN_APPROVAL_SOURCES.includes(source)
    && (ledgerRevision == null || (Number.isSafeInteger(ledgerRevision) && ledgerRevision > 0))
    && (censusDigest == null || typeof censusDigest === "string")
    && optionalIso(confirmedAt) && (confirmedDigest == null || HEX64.test(confirmedDigest))
    && optionalIso(tasksChangedAt);
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * Current status of the approved plan, derived only from the recorded section.
 * Returns null when nothing is recorded (absence stays unanswered).
 *   state: recorded | review (tasks changed) | stale (folder scan changed) | unavailable
 */
export function planApprovalStatus(project, records) {
  const section = records?.sections?.planAuthority ?? null;
  if (!section) return null;
  const data = section.data;
  if (!validPlanApproval(data)) return { state: "unavailable", detail: "The saved plan approval could not be read. Approve the plan again.", record: null, revision: section.revision ?? null, confirmed: false };
  const base = { record: data, revision: section.revision, recordedAt: section.recordedAt };
  if (data.censusDigest && project?.census?.digest && data.censusDigest !== project.census.digest) {
    return { ...base, state: "stale", detail: "The folder scan changed since this plan was approved. Review the tasks and approve again.", confirmed: false };
  }
  if (data.tasksChangedAt) return { ...base, state: "review", detail: "Tasks changed since approval. Review them and approve the plan again.", confirmed: false };
  const how = data.source === "planning-ledger" ? `through the planning ledger${data.ledgerRevision ? ` (revision ${data.ledgerRevision})` : ""}` : "on this device";
  return {
    ...base,
    state: "recorded",
    detail: `${plural(data.taskCount, "task")} approved ${how} · ${data.planDigest.slice(0, 12)}…`,
    confirmed: isIso(data.confirmedAt) && data.confirmedDigest === data.planDigest,
  };
}

// Two separate things, named differently everywhere they appear:
// - "Plan approved by you": the person's decision, saved above (planApprovalStatus).
// - "Saved-plan check": the ledger-bound check run by planRefresh. It adds proof
//   that the approval matches this exact saved Ledger revision and the saved
//   architecture, folder and component records. It never changes the approval.
export const SAVED_PLAN_CHECK_ACTION = "Run saved-plan check";
export const SAVED_PLAN_CHECK_EXPLAINER = "Saved-plan check: an extra step after you approve. It confirms the approved plan is this exact saved Ledger revision, built on the saved architecture, folder and component records. It never runs work and does not replace your approval.";

/**
 * Plain wording for the saved-plan check next to the person's approval.
 * `check` is the planning refresh status, `approval` is planApprovalStatus(),
 * `checked` is the caller's exact-match test for an observed check.
 */
export function savedPlanCheckText({ check = null, approval = null, checked = false } = {}) {
  const approvedByYou = approval?.state === "recorded";
  const base = { approvedByYou, explainer: SAVED_PLAN_CHECK_EXPLAINER, action: SAVED_PLAN_CHECK_ACTION };
  const lead = approvedByYou ? "Plan approved. " : "";
  const unapproved = !approval ? "No plan approved yet. Approve the plan on the Plan page first."
    : approval.state === "recorded" ? null
      : `Plan approval needs attention: ${approval.detail}`;
  let text;
  if (!approval && !["refreshing", "pending", "unfinished"].includes(check?.state) && !(checked && check?.state === "observed")) text = unapproved;
  else if (checked && check?.state === "observed") text = `Saved-plan check passed: planning approval revision ${check.revision} matches this exact saved Ledger${check.ledgerRevision != null ? ` (revision ${check.ledgerRevision})` : ""}. Planning only; nothing was run.`;
  else if (check?.state === "refreshing") text = `${lead}Running the saved-plan check…`;
  else if (check?.state === "pending") text = `${lead}The saved-plan check is on hold: an original planning request needs reconciliation in the Ledger.`;
  else if (check?.state === "unfinished") text = `${lead}The saved-plan check is on hold: unfinished editor text needs recovery or a decision in the Ledger.`;
  else if (check?.state === "unavailable") text = `${lead}The saved-plan check could not run. Earlier results are not current.`;
  else if (check?.state === "missing") text = approvedByYou ? "Plan approved. The saved-plan check found no Ledger approval to compare yet. Use “Review and approve the plan” in the Ledger to lock it to this exact Ledger." : unapproved;
  // A check that ran (it names the folder) but could not match current records.
  else if (check?.state === "stale" && check.rootIdentity) text = approvedByYou ? "Plan approved. The saved-plan check could not lock it: the saved Ledger, architecture, folder or component records do not match the current ones yet." : unapproved;
  else text = approvedByYou ? "Plan approved. Run the saved-plan check to lock it to this exact Ledger." : unapproved;
  return { ...base, text };
}

const defaultNow = () => new Date().toISOString();

/**
 * Records an explicit approval of `tasks` (the saved drafts). Idempotent: an
 * identical, unchanged approval is not rewritten. Returns the stored section.
 */
export async function recordPlanApproval(projectId, { tasks, censusDigest = null, source = "local-approval", ledgerRevision = null }, { storage, now = defaultNow } = {}) {
  if (!PLAN_APPROVAL_SOURCES.includes(source)) throw new Error("Unknown plan approval source.");
  const active = activePlanTasks(tasks);
  if (!active.length) throw new Error("Add at least one task before approving the plan.");
  const planDigest = await digestPlanTasks(active);
  const previous = readSection(projectId, "planAuthority", storage);
  const prior = validPlanApproval(previous?.data) ? previous.data : null;
  if (prior && prior.planDigest === planDigest && prior.source === source && (prior.ledgerRevision ?? null) === (ledgerRevision ?? null) && (prior.censusDigest ?? null) === (censusDigest ?? null) && !prior.tasksChangedAt) return previous;
  const data = {
    planDigest,
    taskIds: active.map((task) => task.id),
    tasks: active.map((task) => ({ id: task.id, title: String(task.title ?? "") })),
    taskCount: active.length,
    approvedAt: now(),
    source,
    censusDigest: censusDigest ?? null,
    ...(ledgerRevision != null ? { ledgerRevision } : {}),
    confirmedAt: null,
    confirmedDigest: null,
    tasksChangedAt: null,
  };
  return writeSection(projectId, "planAuthority", data, { storage, now });
}

/**
 * Compares the current saved drafts with the approval and records whether they
 * still match. Returns the new section record, or null when nothing changed.
 */
export async function notePlanTaskDrift(projectId, tasks, { storage, now = defaultNow } = {}) {
  const previous = readSection(projectId, "planAuthority", storage);
  if (!validPlanApproval(previous?.data)) return null;
  const changed = (await digestPlanTasks(tasks)) !== previous.data.planDigest;
  if (changed === Boolean(previous.data.tasksChangedAt)) return null;
  return writeSection(projectId, "planAuthority", { ...previous.data, tasksChangedAt: changed ? now() : null }, { storage, now });
}

/** Records the explicit "project is ready" confirmation against the current approved plan. */
export function confirmProjectReady(projectId, { storage, now = defaultNow } = {}) {
  const previous = readSection(projectId, "planAuthority", storage);
  if (!validPlanApproval(previous?.data)) throw new Error("Approve the plan before confirming the project is ready.");
  if (previous.data.tasksChangedAt) throw new Error("Tasks changed since approval. Approve the plan again first.");
  return writeSection(projectId, "planAuthority", { ...previous.data, confirmedAt: now(), confirmedDigest: previous.data.planDigest }, { storage, now });
}

/**
 * Session-authority-shaped view of the plan for Home/workflow selectors. A work
 * record, when present, is the source of truth; otherwise the session's own
 * plan authority (if any) is used unchanged.
 */
export function effectivePlanAuthority(project, records) {
  const status = planApprovalStatus(project, records);
  if (!status) return { authority: project?.authorities?.plan ?? null, status: null };
  if (!status.record) return { authority: { state: "unavailable", entityId: null, digest: null, revision: status.revision, recordedAt: null }, status };
  const state = status.state === "recorded" ? "authoritative" : status.state === "review" ? "generated" : status.state;
  return {
    authority: { state, entityId: null, digest: status.record.planDigest, revision: status.revision, recordedAt: status.record.approvedAt },
    status,
  };
}
