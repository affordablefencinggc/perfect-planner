// Allocation page requirements derived from the `allocation` work-record section.
import { allocationStatus } from "../taskCoordination.js";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function owners(sections, { project } = {}) {
  const data = sections?.allocation?.data;
  if (!data || typeof data !== "object") return null;
  if (data.censusDigest && project?.census?.digest && data.censusDigest !== project.census.digest) {
    return { state: "stale", detail: "The project folder changed since owners were assigned. Review the assignments again." };
  }
  const checked = sections?.collisions?.data?.taskSnapshot ?? null;
  if (checked && data.taskSnapshot !== checked) {
    return { state: "stale", detail: "Tasks changed between the overlap check and the owner assignments. Check overlaps, then save owners again." };
  }
  const status = allocationStatus(data);
  if (!status.tasks) return { state: "review", detail: "No tasks were saved when owners were assigned." };
  if (status.missing) return { state: "review", detail: `${status.missing} of ${plural(status.tasks, "task")} still ${status.missing === 1 ? "needs" : "need"} an owner.` };
  if (status.missingWave) return { state: "review", detail: `Every task has an owner, but ${plural(status.missingWave, "task")} still ${status.missingWave === 1 ? "needs" : "need"} an order.` };
  return { state: "recorded", detail: `All ${plural(status.tasks, "task")} have an owner, in ${plural(status.waves, "wave")}.` };
}

export const receiptDerivers = Object.freeze({
  "ALLOC-OWNERS": owners,
  "BUILD-ALLOCATION": owners,
});
