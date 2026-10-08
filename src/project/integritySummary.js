// Plain summaries of other features' records for the Integrity page. Shapes from
// Collision and Allocation are read defensively: an unknown shape is reported as
// "recorded, details unknown", never as resolved or assigned.

import { validResolution } from "./taskCoordination.js";

const RESOLVED = new Set(["resolved", "serialized", "accepted", "dismissed", "cleared", "ordered", "waived"]);
const day = (value) => { const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : "an unknown date"; };

export function collisionSummary(section) {
  if (!section) return { state: "none", text: "File conflicts between tasks have not been checked yet." };
  const data = section.data ?? {};
  const list = [data.collisions, data.pairs, data.items, data.conflicts].find(Array.isArray);
  if (!list) return { state: "unknown", text: `Conflicts were checked on ${day(section.recordedAt)}, but the result could not be summarised here. Open Collision for details.` };
  if (!list.length) return { state: "done", text: `Checked on ${day(section.recordedAt)}: no tasks change the same files.` };
  // The Collision page keeps decisions in data.resolutions, keyed by collision and bound to its signature.
  const decided = (item) => { const saved = typeof item?.key === "string" ? data.resolutions?.[item.key] : null; return Boolean(saved) && Array.isArray(item.tasks) && saved.signature === item.signature && validResolution(item, saved); };
  const resolved = list.filter((item) => RESOLVED.has(String(item?.status ?? item?.resolution ?? item?.state ?? "").toLowerCase()) || item?.resolved === true || decided(item)).length;
  return { state: resolved === list.length ? "done" : "open", text: `${resolved} of ${list.length} conflict${list.length === 1 ? "" : "s"} resolved (checked ${day(section.recordedAt)}).` };
}

function ownerMap(data) {
  const source = [data.owners, data.tasks, data.assignments, data.items].find((value) => value && typeof value === "object");
  if (!source) return null;
  const entries = Array.isArray(source)
    ? source.map((item) => [item?.taskId ?? item?.id, item?.owner ?? item?.ownerName])
    : Object.entries(source).map(([taskId, value]) => [taskId, typeof value === "string" ? value : value?.owner ?? value?.ownerName]);
  return new Map(entries.filter(([taskId, owner]) => typeof taskId === "string" && typeof owner === "string" && owner.trim()));
}

export function ownerSummary(section, taskIds, ledger) {
  const total = taskIds.length;
  if (section) {
    const owners = ownerMap(section.data ?? {});
    if (!owners) return { state: "unknown", text: `Owners were recorded on ${day(section.recordedAt)}, but could not be summarised here. Open Allocation for details.` };
    const named = taskIds.filter((id) => owners.has(id)).length;
    return { state: total && named === total ? "done" : "open", text: `${named} of ${total} tasks have an owner assigned in Allocation.` };
  }
  const draftOwners = new Map((ledger?.tasks ?? []).map((task) => [task.id, task.owner]));
  const named = taskIds.filter((id) => draftOwners.get(id)?.trim()).length;
  return { state: "none", text: ledger ? `Owners are not assigned in Allocation yet. ${named} of ${total} task drafts name an owner.` : "Owners are not assigned in Allocation yet." };
}
