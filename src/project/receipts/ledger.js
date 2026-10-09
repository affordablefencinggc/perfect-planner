// LEDGER-TASKS: the Ledger is the project's saved task drafts. Recorded once at
// least one task draft is saved for this project and its current folder scan.
import { readTaskDraftPresence } from "../taskDraftPresence.js";

export function ledgerTasksReceipt(_sections, { project } = {}, storage) {
  const presence = readTaskDraftPresence(project?.projectId, storage);
  if (!presence || presence.total < 1) return null;
  const plural = (count) => `${count} task draft${count === 1 ? "" : "s"}`;
  if (presence.censusDigest && project?.census?.digest && presence.censusDigest !== project.census.digest) {
    return { state: "review", detail: `${plural(presence.total)} saved against an earlier folder scan. Review them in the Ledger.` };
  }
  return { state: "recorded", detail: `${plural(presence.active)} active${presence.total > presence.active ? ` · ${presence.total - presence.active} archived` : ""} · Ledger revision ${presence.revision}` };
}

export const receiptDerivers = Object.freeze({
  "LEDGER-TASKS": (sections, context) => ledgerTasksReceipt(sections, context),
});
