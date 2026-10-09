// Collision and allocation planning for an imported project's own task drafts.
// Inputs are saved Ledger drafts; outputs are plain records for the
// `collisions` and `allocation` work-record sections. Nothing here is inferred
// from Demo data, and a task that lists no files is reported as "not checked".
import { assessCollisions, canonicalize, validateManifest } from "../engine/collisionEngine.js";
import { inspectTaskDraft } from "./taskDraftLedger.js";

export const COORDINATION_SCHEMA_VERSION = 1;
export const RESOLUTION_CHOICES = Object.freeze(["order", "split", "accept"]);
export const OWNER_MAX = 120;
export const WAVE_MAX = 999;

export const activeTasks = (ledger) => (ledger?.tasks ?? []).filter((task) => !task.archived);

/** Stable change-detection fingerprint of what overlap checks and allocation depend on. */
export function taskSnapshot(ledger) {
  const shape = activeTasks(ledger)
    .map((task) => ({ id: task.id, claims: task.claims.map((c) => `${c.access} ${c.path.toLowerCase()}`).sort(), dependsOn: [...task.dependsOn].sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const text = canonicalize(shape);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = (n) => (n >>> 0).toString(16).padStart(8, "0");
  return `tasks-${shape.length}-${hex(h2)}${hex(h1)}`;
}

function ancestorsOf(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const memo = new Map();
  const visit = (id, trail = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (trail.has(id)) return new Set();
    trail.add(id);
    const result = new Set();
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue;
      result.add(dep);
      for (const inner of visit(dep, trail)) result.add(inner);
    }
    trail.delete(id);
    memo.set(id, result);
    return result;
  };
  return (id) => visit(id);
}

const pairKey = (a, b) => [a, b].sort().join("|");
const claimList = (task) => (task?.claims ?? []).map((c) => `${c.access} ${c.path.toLowerCase()}`).sort();
// Fingerprint of both tasks' complete file scopes. A decision made against one
// pair of scopes stops applying as soon as either task's scope is edited.
const pairScopes = (byId, a, b) => canonicalize({ [a]: claimList(byId.get(a)), [b]: claimList(byId.get(b)) });

/**
 * Runs the collision engine over the active drafts. Each task is its own
 * manifest so the engine compares tasks against each other.
 */
export function evaluateTaskCollisions(ledger) {
  const tasks = activeTasks(ledger);
  const unchecked = [], invalid = [], manifests = [];
  for (const task of tasks) {
    if (!task.claims.length) { unchecked.push(task.id); continue; }
    const manifest = { schemaVersion: 1, planId: task.id, title: task.title, tasks: [{ taskId: task.id, title: task.title, claims: task.claims.map((claim) => ({ kind: "file", surface: claim.path, access: claim.access })) }] };
    const errors = validateManifest(manifest);
    if (errors.length) invalid.push({ taskId: task.id, reason: "One of its file paths cannot be compared (for example a name ending in a dot or space)." });
    else manifests.push(manifest);
  }
  const titles = Object.fromEntries(tasks.map((task) => [task.id, task.title]));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const ancestors = ancestorsOf(tasks);
  const result = manifests.length > 1 ? assessCollisions(manifests) : { collisions: [], manifestErrors: [] };
  const groups = new Map();
  for (const item of result.collisions) {
    const a = item.left.taskId, b = item.right.taskId, key = pairKey(a, b);
    if (!groups.has(key)) groups.set(key, { key, tasks: [a, b].sort(), files: new Map() });
    // Comparison is case-insensitive; displayed paths keep the author's letter case.
    const files = groups.get(key).files, paths = [...new Set([item.left.displaySurface, item.right.displaySurface])].sort();
    const fileKey = [...new Set([item.left.surface, item.right.surface])].sort().join("|"), prior = files.get(fileKey);
    files.set(fileKey, { path: item.displaySurface, paths, severity: prior?.severity === "hard-stop" ? "hard-stop" : item.severity });
  }
  const collisions = [...groups.values()].map((group) => {
    const [a, b] = group.tasks;
    const files = [...group.files.values()].sort((x, y) => x.path.localeCompare(y.path) || x.paths.join().localeCompare(y.paths.join()));
    const severity = files.some((file) => file.severity === "hard-stop") ? "hard-stop" : "ordered";
    // Dependencies already decide the order; otherwise the earlier task goes first.
    const suggestedFirst = ancestors(b).has(a) ? a : ancestors(a).has(b) ? b : a;
    const dependencyOrdered = ancestors(b).has(a) || ancestors(a).has(b);
    // The signature ignores letter case so earlier decisions keep matching.
    const signatureFiles = files.map((file) => ({ path: file.path.toLowerCase(), paths: [...new Set(file.paths.map((path) => path.toLowerCase()))].sort(), severity: file.severity })).sort((x, y) => x.path.localeCompare(y.path) || x.paths.join().localeCompare(y.paths.join()));
    return { key: group.key, tasks: group.tasks, titles: { [a]: titles[a], [b]: titles[b] }, severity, files, suggestedFirst, dependencyOrdered, signature: canonicalize({ severity, files: signatureFiles }), scopes: pairScopes(byId, a, b) };
  }).sort((x, y) => (x.severity === y.severity ? 0 : x.severity === "hard-stop" ? -1 : 1) || x.key.localeCompare(y.key));
  return {
    checkedTaskIds: manifests.map((manifest) => manifest.planId),
    uncheckedTaskIds: unchecked,
    invalid,
    collisions,
  };
}

/**
 * Keeps only decisions that still apply: the same overlap, against the same two
 * task scopes. A "split" decision is kept while the pair still overlaps, because
 * it only settles the overlap once the scopes are edited apart.
 */
export function carryResolutions(collisions, previous = {}) {
  const byKey = new Map(collisions.map((item) => [item.key, item]));
  return Object.fromEntries(Object.entries(previous ?? {}).filter(([key, resolution]) => resolutionState(byKey.get(key), resolution) !== "open"));
}

/**
 * Where one overlap stands given its saved decision:
 * - "open": no decision, or the decision was made against different scopes;
 * - "split-pending": "split" was chosen but the two tasks still overlap;
 * - "decided": an order or "accept" decision that matches the current scopes.
 */
export function resolutionState(collision, resolution) {
  if (!collision || !validResolution(collision, resolution)) return "open";
  if (resolution.choice === "split") return "split-pending";
  if (resolution.signature !== collision.signature) return "open";
  if (resolution.scopes != null && collision.scopes != null && resolution.scopes !== collision.scopes) return "open";
  return "decided";
}

export function validResolution(collision, resolution) {
  if (!resolution || !RESOLUTION_CHOICES.includes(resolution.choice)) return false;
  if (resolution.choice === "order") return collision.tasks.includes(resolution.first);
  return true;
}

export function createResolution(collision, choice, first, now = new Date().toISOString()) {
  const resolution = { choice, signature: collision.signature, ...(collision.scopes ? { scopes: collision.scopes } : {}), resolvedAt: now, ...(choice === "order" ? { first } : {}) };
  if (!validResolution(collision, resolution)) throw new Error("Choose which task goes first.");
  return resolution;
}

export function buildCollisionRecord({ ledger, censusDigest, previous = null, now = new Date().toISOString() }) {
  const evaluation = evaluateTaskCollisions(ledger);
  return {
    schemaVersion: COORDINATION_SCHEMA_VERSION,
    taskSnapshot: taskSnapshot(ledger),
    ledgerRevision: ledger?.revision ?? null,
    censusDigest: censusDigest ?? null,
    evaluatedAt: now,
    ...evaluation,
    resolutions: carryResolutions(evaluation.collisions, previous?.resolutions),
  };
}

/** Summary of a saved `collisions` section's data. */
export function collisionStatus(data) {
  const collisions = Array.isArray(data?.collisions) ? data.collisions : [];
  const resolutions = data?.resolutions ?? {};
  const state = (item) => resolutionState(item, resolutions[item.key]);
  const hardStops = collisions.filter((item) => item.severity === "hard-stop");
  // One rule everywhere: any undecided pair (hard stop or "needs an order") blocks Build.
  return {
    checked: data?.checkedTaskIds?.length ?? 0,
    unchecked: (data?.uncheckedTaskIds?.length ?? 0) + (data?.invalid?.length ?? 0),
    total: collisions.length,
    hardStops: hardStops.length,
    openHardStops: hardStops.filter((item) => state(item) !== "decided").length,
    open: collisions.filter((item) => state(item) !== "decided").length,
    decided: collisions.filter((item) => state(item) === "decided").length,
    splitPending: collisions.filter((item) => state(item) === "split-pending").length,
  };
}

/**
 * Live view of every overlap in the current saved tasks, joined with the
 * decisions saved on the Collision page. Plan and Ledger read this so a
 * decision made in Collision shows up there, and an edit that changes either
 * task's scope re-opens it. `otherFindings` are the remaining (non-overlap)
 * Ledger findings such as unanswered task details.
 */
export function overlapReview(ledger, collisionData = null) {
  let findings;
  try { findings = inspectTaskDraft(ledger).findings; } catch { return null; }
  const live = new Map(evaluateTaskCollisions(ledger).collisions.map((item) => [item.key, item]));
  const keys = new Set(findings.filter((item) => item.kind === "file-overlap").map((item) => pairKey(...item.taskIds)));
  for (const key of live.keys()) keys.add(key);
  const resolutions = collisionData?.resolutions && typeof collisionData.resolutions === "object" ? collisionData.resolutions : {};
  const items = [...keys].sort().map((key) => {
    const resolution = resolutions[key];
    const state = resolutionState(live.get(key), resolution);
    return { key, taskIds: key.split("|"), state, choice: state === "open" ? null : resolution.choice, first: state === "decided" ? resolution.first ?? null : null };
  });
  // A split chosen for a checked overlap that has since been carried out (the
  // pair no longer overlaps) counts as settled.
  const active = new Set(activeTasks(ledger).map((task) => task.id));
  const checked = new Set((Array.isArray(collisionData?.collisions) ? collisionData.collisions : []).map((item) => item?.key));
  for (const [key, resolution] of Object.entries(resolutions).sort(([a], [b]) => a.localeCompare(b))) {
    const taskIds = key.split("|");
    if (resolution?.choice === "split" && !keys.has(key) && checked.has(key) && taskIds.length === 2 && taskIds.every((id) => active.has(id))) items.push({ key, taskIds, state: "separated", choice: "split", first: null });
  }
  const count = (state) => items.filter((item) => item.state === state).length;
  return {
    items,
    total: items.length,
    settled: count("decided") + count("separated"),
    open: count("open"),
    splitPending: count("split-pending"),
    otherFindings: findings.filter((item) => item.kind !== "file-overlap"),
  };
}

/**
 * The same shape as `overlapReview`, read from a saved `collisions` record
 * alone (for pages without the live task list, such as Home). Only reflects
 * the tasks as they were when last checked.
 */
export function recordOverlapReview(data) {
  const collisions = Array.isArray(data?.collisions) ? data.collisions.filter((item) => typeof item?.key === "string" && Array.isArray(item.tasks)) : [];
  const resolutions = data?.resolutions && typeof data.resolutions === "object" ? data.resolutions : {};
  const items = collisions.map((item) => {
    const resolution = resolutions[item.key];
    const state = resolutionState(item, resolution);
    return { key: item.key, taskIds: [...item.tasks], state, choice: state === "open" ? null : resolution.choice, first: state === "decided" ? resolution.first ?? null : null };
  });
  const count = (state) => items.filter((item) => item.state === state).length;
  return { items, total: items.length, settled: count("decided"), open: count("open"), splitPending: count("split-pending"), otherFindings: [] };
}

/** Plain-language headline and per-overlap lines for `overlapReview`. */
export function overlapReviewText(review) {
  if (!review?.total) return { headline: null, lines: [] };
  const remaining = review.total - review.settled;
  const headline = remaining
    ? `${remaining} of ${review.total} overlap${review.total === 1 ? "" : "s"} still ${remaining === 1 ? "needs" : "need"} a decision`
    : `${review.total} overlap${review.total === 1 ? "" : "s"} decided`;
  const lines = review.items.map(({ taskIds: [a, b], state, choice, first }) => {
    if (state === "split-pending") return `Split chosen: edit the file scopes of ${a} or ${b} so they no longer overlap.`;
    if (state === "separated") return `${a} and ${b}: split done — their file scopes no longer overlap.`;
    if (state === "decided") return choice === "order" ? `${a} and ${b}: decided — ${first} goes first.` : `${a} and ${b}: decided — they may run at the same time.`;
    return `${a} and ${b} change the same files and still need a decision on the Collision page.`;
  });
  return { headline, lines };
}

/**
 * Default waves: a task runs after its dependencies and after the task that
 * goes first in an overlap (decided order, or the suggestion while undecided).
 * "Split" and "accept" decisions let the two tasks share a wave.
 */
export function suggestedWaves(ledger, collisionData = null) {
  const tasks = activeTasks(ledger);
  const ids = new Set(tasks.map((task) => task.id));
  const before = new Map(tasks.map((task) => [task.id, new Set(task.dependsOn.filter((id) => ids.has(id)))]));
  for (const item of collisionData?.collisions ?? []) {
    if (!item.tasks.every((id) => ids.has(id))) continue;
    const resolution = collisionData.resolutions?.[item.key];
    const current = resolution?.signature === item.signature && validResolution(item, resolution) ? resolution : null;
    if (current && current.choice !== "order") continue;
    const first = current?.first ?? item.suggestedFirst;
    const then = item.tasks.find((id) => id !== first);
    before.get(then).add(first);
  }
  const waves = {}, remaining = new Set(ids);
  let progressed = true;
  while (remaining.size && progressed) {
    progressed = false;
    for (const id of [...remaining].sort()) {
      const deps = [...before.get(id)];
      if (deps.every((dep) => waves[dep] != null)) {
        waves[id] = deps.reduce((max, dep) => Math.max(max, waves[dep] + 1), 1);
        remaining.delete(id);
        progressed = true;
      }
    }
  }
  return { waves, blocked: [...remaining].sort() };
}

const cleanOwner = (value) => String(value ?? "").trim().replace(/\s+/g, " ");
const bareAgent = (owner) => /^agent\s*:\s*$/i.test(owner);

export function normalizeAssignment(input) {
  const owner = cleanOwner(input?.owner).slice(0, OWNER_MAX);
  const wave = Number(input?.wave);
  return { owner: bareAgent(owner) ? "" : owner, wave: Number.isInteger(wave) && wave >= 1 && wave <= WAVE_MAX ? wave : null };
}

/** Field errors for one row of the assignment form; an empty field is allowed (it stays "missing"). */
export function assignmentErrors(input) {
  const errors = {};
  const owner = cleanOwner(input?.owner), wave = String(input?.wave ?? "").trim();
  if (bareAgent(owner)) errors.owner = "Name the agent after “agent:”, or clear the field.";
  else if (owner.length > OWNER_MAX) errors.owner = `Owner names can be at most ${OWNER_MAX} characters (this one is ${owner.length}).`;
  if (wave && normalizeAssignment({ wave }).wave == null) errors.wave = `Wave must be a whole number from 1 to ${WAVE_MAX}.`;
  return errors;
}

export const ownerKind = (owner) => /^agent\s*:\s*\S/i.test(owner ?? "") ? "agent" : owner && !bareAgent(owner) ? "person" : null;

/**
 * Waves that contradict a dependency or a recorded "do X first" decision:
 * [{taskId, before, reason}] where `before` must be in an earlier wave than `taskId`.
 */
export function waveConflicts(ledger, collisionData, assignments) {
  const tasks = activeTasks(ledger), ids = new Set(tasks.map((task) => task.id));
  const wave = (id) => normalizeAssignment(assignments?.[id]).wave;
  const out = [];
  const check = (before, after, reason) => { const a = wave(before), b = wave(after); if (a != null && b != null && a >= b) out.push({ taskId: after, before, reason }); };
  for (const task of tasks) for (const dep of task.dependsOn ?? []) if (ids.has(dep)) check(dep, task.id, `${task.id} depends on ${dep}`);
  for (const item of collisionData?.collisions ?? []) {
    const resolution = collisionData.resolutions?.[item.key];
    if (!item.tasks?.every((id) => ids.has(id)) || resolutionState(item, resolution) !== "decided" || resolution.choice !== "order") continue;
    check(resolution.first, item.tasks.find((id) => id !== resolution.first), `the overlap decision says ${resolution.first} goes first`);
  }
  return out;
}

/**
 * The Ledger's "Proposed owner" for each active task that has no allocated
 * owner yet. These are proposals, not decisions: an owner already allocated is
 * kept, and a proposal is recorded only after the person confirms it.
 */
export function ledgerOwnerProposals(ledger, allocation = null) {
  const proposals = {};
  for (const task of activeTasks(ledger)) {
    const proposed = normalizeAssignment({ owner: task.owner }).owner;
    if (proposed && !normalizeAssignment(allocation?.assignments?.[task.id]).owner) proposals[task.id] = proposed;
  }
  return proposals;
}

/** Allocation form values with unconfirmed Ledger proposals removed, so only confirmed owners are saved. */
export function confirmedAssignments(form) {
  return Object.fromEntries(Object.entries(form ?? {}).map(([id, value]) => [id, { owner: value?.fromLedger ? "" : value?.owner ?? "", wave: value?.wave ?? "" }]));
}


export function buildAllocationRecord({ ledger, censusDigest, collisionData, assignments, now = new Date().toISOString() }) {
  const ids = activeTasks(ledger).map((task) => task.id);
  return {
    schemaVersion: COORDINATION_SCHEMA_VERSION,
    taskSnapshot: taskSnapshot(ledger),
    collisionSnapshot: collisionData?.taskSnapshot ?? null,
    ledgerRevision: ledger?.revision ?? null,
    censusDigest: censusDigest ?? null,
    savedAt: now,
    taskIds: ids,
    assignments: Object.fromEntries(ids.map((id) => [id, normalizeAssignment(assignments?.[id])])),
  };
}

export function allocationStatus(data) {
  const ids = Array.isArray(data?.taskIds) ? data.taskIds : [];
  const assignments = data?.assignments ?? {};
  const owned = ids.filter((id) => normalizeAssignment(assignments[id]).owner);
  const waves = new Set(ids.map((id) => assignments[id]?.wave).filter(Boolean));
  return { tasks: ids.length, owned: owned.length, missing: ids.length - owned.length, waves: waves.size, missingWave: ids.filter((id) => !assignments[id]?.wave).length };
}
