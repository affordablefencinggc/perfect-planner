// Tolerant readers over other features' work-record sections. Each feature owns
// its own section shape, so these readers accept the plausible forms and return
// empty results (never invented values) when a shape is not recognised.

import { resolutionState, uniquePaths } from "./taskCoordination.js";

const list = (value) => Array.isArray(value) ? value : [];
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const taskKey = (item) => text(item?.taskId) ?? text(item?.task) ?? text(item?.id);
const KIND_LABELS = { screenshot: "Screenshot", diff: "Code change", test: "Test result", note: "Note", skip: "Not needed" };
const RESOLVED = new Set(["resolved", "serialized", "accepted", "cleared", "ordered", "dismissed", "sequenced", "allowed"]);

function keyed(value) {
  // {T0001: {...}} or [{taskId:'T0001', ...}] → Map(taskId → entry)
  const result = new Map();
  if (Array.isArray(value)) for (const item of value) { const id = taskKey(item); if (id) result.set(id, item); }
  else if (value && typeof value === "object") for (const [id, item] of Object.entries(value)) if (/^T\d{4,6}$/.test(id)) result.set(id, item && typeof item === "object" ? item : { owner: item });
  return result;
}

/** Task ids approved by a recorded plan approval, or null when none is recognisable. */
export function approvedTaskIdsFrom(sections) {
  const data = sections?.planAuthority?.data;
  if (!data || typeof data !== "object") return null;
  const raw = data.approvedTaskIds ?? data.taskIds ?? data.tasks ?? data.ledger?.tasks ?? null;
  if (!Array.isArray(raw)) return null;
  const ids = raw.map((item) => typeof item === "string" ? item : item && !item.archived ? text(item.id) : null).filter(Boolean);
  return [...new Set(ids)];
}

/** Map(taskId → {owner, wave}) from the allocation section. */
export function allocationByTask(sections) {
  const data = sections?.allocation?.data;
  if (!data || typeof data !== "object") return new Map();
  const source = data.tasks ?? data.owners ?? data.assignments ?? data.byTask ?? data.allocations ?? data;
  const result = new Map();
  for (const [id, item] of keyed(source)) {
    const owner = text(item.owner) ?? text(item.ownerName) ?? text(item.assignee) ?? text(item.name);
    const wave = item.wave ?? item.order ?? item.sequence ?? item.round ?? null;
    result.set(id, { owner, wave: Number.isFinite(wave) || text(wave) ? wave : null });
  }
  return result;
}

/** Recorded collisions as [{taskIds, paths, resolved, note}], or null when nothing was recorded. */
export function recordedCollisions(sections) {
  const data = sections?.collisions?.data;
  if (!data || typeof data !== "object") return null;
  const raw = Array.isArray(data) ? data : data.collisions ?? data.pairs ?? data.items ?? data.findings ?? [];
  return list(raw).map((item) => {
    const ids = list(item?.taskIds ?? item?.tasks).map((t) => typeof t === "string" ? t : text(t?.id)).filter(Boolean);
    const pair = ids.length ? ids : [text(item?.left), text(item?.right), text(item?.a), text(item?.b)].filter(Boolean);
    const paths = list(item?.paths ?? item?.files).map((p) => typeof p === "string" ? p : text(p?.path)).filter(Boolean);
    if (text(item?.path)) paths.push(item.path.trim());
    // A folder overlapping several files inside it is stored once per file; name it once.
    const distinctPaths = uniquePaths(paths);
    const decision = String(item?.resolution ?? item?.decision ?? item?.state ?? item?.status ?? "").toLowerCase();
    // The Collision page saves decisions beside the list, keyed by collision; a decision
    // only counts while it still matches that collision's current signature.
    const saved = text(item?.key) && data.resolutions && typeof data.resolutions === "object" ? data.resolutions[item.key] : null;
    const state = Boolean(saved) && Array.isArray(item?.tasks) ? resolutionState(item, saved) : "open";
    const decided = state === "decided";
    return { taskIds: pair, paths: distinctPaths, first: decided && saved.choice === "order" ? text(saved.first) : null, resolved: item?.resolved === true || RESOLVED.has(decision) || decided, note: text(item?.note) ?? text(item?.resolutionNote) ?? (decided && saved.choice === "order" ? `${saved.first} goes first` : state === "split-pending" ? "split chosen; file scopes still overlap" : null) };
  }).filter((item) => item.taskIds.length);
}

/** Proof items as [{taskId, label, kind}]. */
export function proofItems(sections) {
  const data = sections?.proof?.data;
  if (!data || typeof data !== "object") return [];
  const out = [];
  const push = (taskId, item) => {
    if (!taskId || !item) return;
    const kind = text(item.kind) ?? text(item.type) ?? null;
    const label = text(item.label) ?? text(item.title) ?? text(item.name) ?? text(item.summary) ?? (kind ? KIND_LABELS[kind] ?? kind : null);
    if (label) out.push({ taskId, label, kind });
  };
  const flat = Array.isArray(data) ? data : data.items ?? data.proof ?? data.entries ?? null;
  if (Array.isArray(flat)) for (const item of flat) push(text(item?.taskId) ?? text(item?.task), item);
  // The Evidence page saves proof as { items: { T0001: [...] } }, keyed by task.
  const grouped = data.tasks ?? data.byTask ?? (flat && typeof flat === "object" && !Array.isArray(flat) ? flat : null);
  if (grouped && typeof grouped === "object" && !Array.isArray(grouped)) for (const [id, items] of Object.entries(grouped)) for (const item of (Array.isArray(items) ? items : list(items?.items))) push(id, item);
  return out;
}
