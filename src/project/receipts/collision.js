// Collision page requirements derived from the `collisions` work-record section.
import { collisionStatus } from "../taskCoordination.js";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const day = (iso) => (typeof iso === "string" ? iso.slice(0, 10) : "an unknown date");

function saved(sections, project) {
  const data = sections?.collisions?.data;
  if (!data || typeof data !== "object") return null;
  const stale = data.censusDigest && project?.census?.digest && data.censusDigest !== project.census.digest;
  return { data, status: collisionStatus(data), stale };
}

const STALE = { state: "stale", detail: "The project folder changed since tasks were checked. Check the tasks again." };

function evaluation(sections, { project } = {}) {
  const found = saved(sections, project);
  if (!found) return null;
  if (found.stale) return STALE;
  const { status, data } = found;
  if (!status.checked) return { state: "review", detail: `Checked on ${day(data.evaluatedAt)}, but no task lists the files it changes, so nothing could be compared.` };
  const overlaps = status.total ? `${plural(status.total, "overlap")} found (${status.hardStops} must not run at the same time)` : "no overlapping files found";
  if (status.unchecked) return { state: "review", detail: `Checked ${plural(status.checked, "task")} on ${day(data.evaluatedAt)}: ${overlaps}. ${plural(status.unchecked, "task")} could not be checked because ${status.unchecked === 1 ? "it lists" : "they list"} no usable files.` };
  return { state: "recorded", detail: `Checked ${plural(status.checked, "task")} on ${day(data.evaluatedAt)}: ${overlaps}.` };
}

function clearance(sections, { project } = {}) {
  const found = saved(sections, project);
  if (!found) return null;
  if (found.stale) return STALE;
  const { status } = found;
  if (!status.checked) return { state: "review", detail: "No task lists the files it changes yet, so overlaps cannot be cleared." };
  if (status.openHardStops) return { state: "review", detail: `${status.openHardStops} of ${plural(status.hardStops, "must-not-overlap conflict")} still ${status.openHardStops === 1 ? "needs" : "need"} a decision.` };
  if (status.unchecked) return { state: "review", detail: `Every conflict found has a decision, but ${plural(status.unchecked, "task")} could not be checked.` };
  return { state: "recorded", detail: status.hardStops ? `All ${plural(status.hardStops, "must-not-overlap conflict")} have a decision.` : `No must-not-overlap conflicts among ${plural(status.checked, "checked task")}.` };
}

export const receiptDerivers = Object.freeze({
  "COL-EVALUATION": evaluation,
  "ALLOC-CLEARANCE": clearance,
  "BUILD-CLEARANCE": clearance,
});
