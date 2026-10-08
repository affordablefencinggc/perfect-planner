// Receipts derived from the approved plan (planAuthority work record).
import { planApprovalStatus } from "../planApproval.js";

export const receiptDerivers = Object.freeze({
  // The task list this project works from: the approved snapshot of saved task drafts.
  "LEDGER-TASKS": (sections, { project } = {}) => {
    if (!sections.planAuthority) return null;
    const status = planApprovalStatus(project, { sections });
    if (!status?.record) return status ? { state: status.state, detail: status.detail } : null;
    const titles = status.record.tasks.slice(0, 3).map((task) => `${task.id} ${task.title}`.trim()).join(" · ");
    const more = status.record.taskCount > 3 ? ` · +${status.record.taskCount - 3} more` : "";
    return { state: status.state, detail: status.state === "recorded" ? `${status.record.taskCount} approved task${status.record.taskCount === 1 ? "" : "s"}: ${titles}${more}` : status.detail };
  },
});
