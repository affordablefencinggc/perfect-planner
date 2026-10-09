// Collision and allocation planning for an imported project's own task drafts.
// Inputs are saved Ledger drafts; outputs are plain records for the
// `collisions` and `allocation` work-record sections. Nothing here is inferred
// from Demo data, and a task that lists no files is reported as "not checked".
import { assessCollisions, canonicalize, validateManifest } from "../engine/collisionEngine.js";

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
  const ancestors = ancestorsOf(tasks);
  const result = manifests.length > 1 ? assessCollisions(manifests) : { collisions: [], manifestErrors: [] };
  const groups = new Map();
  for (const item of result.collisions) {
    const a = item.left.taskId, b = item.right.taskId, key = pairKey(a, b);
    if (!groups.has(key)) groups.set(key, { key, tasks: [a, b].sort(), files: new Map() });
    const files = groups.get(key).files, paths = [...new Set([item.left.surface, item.right.surface])].sort();
    const fileKey = paths.join("|"), prior = files.get(fileKey);
    files.set(fileKey, { path: item.surface, paths, severity: prior?.severity === "hard-stop" ? "hard-stop" : item.severity });
  }
  const collisions = [...groups.values()].map((group) => {
    const [a, b] = group.tasks;
    const files = [...group.files.values()].sort((x, y) => x.path.localeCompare(y.path) || x.paths.join().localeCompare(y.paths.join()));
    const severity = files.some((file) => file.severity === "hard-stop") ? "hard-stop" : "ordered";
    // Dependencies already decide the order; otherwise the earlier task goes first.
    const suggestedFirst = ancestors(b).has(a) ? a : ancestors(a).has(b) ? b : a;
    const dependencyOrdered = ancestors(b).has(a) || ancestors(a).has(b);
    return { key: group.key, tasks: group.tasks, titles: { [a]: titles[a], [b]: titles[b] }, severity, files, suggestedFirst, dependencyOrdered, signature: canonicalize({ severity, files }) };
  }).sort((x, y) => (x.severity === y.severity ? 0 : x.severity === "hard-stop" ? -1 : 1) || x.key.localeCompare(y.key));
  return {
    checkedTaskIds: manifests.map((manifest) => manifest.planId),
    uncheckedTaskIds: unchecked,
    invalid,
    collisions,
  };
}

/** Keeps only decisions whose overlap still exists with the same files and severity. */
export function carryResolutions(collisions, previous = {}) {
  const byKey = new Map(collisions.map((item) => [item.key, item]));
  return Object.fromEntries(Object.entries(previous ?? {}).filter(([key, resolution]) => {
    const collision = byKey.get(key);
    return collision && resolution?.signature === collision.signature && validResolution(collision, resolution);
  }));
}

export function validResolution(collision, resolution) {
  if (!resolution || !RESOLUTION_CHOICES.includes(resolution.choice)) return false;
  if (resolution.choice === "order") return collision.tasks.includes(resolution.first);
  return true;
}

export function createResolution(collision, choice, first, now = new Date().toISOString()) {
  const resolution = { choice, signature: collision.signature, resolvedAt: now, ...(choice === "order" ? { first } : {}) };
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
  const decided = (item) => resolutions[item.key]?.signature === item.signature && validResolution(item, resolutions[item.key]);
  const hardStops = collisions.filter((item) => item.severity === "hard-stop");
  // One rule everywhere: any undecided pair (hard stop or "needs an order") blocks Build.
  return {
    checked: data?.checkedTaskIds?.length ?? 0,
    unchecked: (data?.uncheckedTaskIds?.length ?? 0) + (data?.invalid?.length ?? 0),
    total: collisions.length,
    hardStops: hardStops.length,
    openHardStops: hardStops.filter((item) => !decided(item)).length,
    open: collisions.filter((item) => !decided(item)).length,
    decided: collisions.filter(decided).length,
  };
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
    if (!item.tasks?.every((id) => ids.has(id)) || resolution?.signature !== item.signature || !validResolution(item, resolution) || resolution.choice !== "order") continue;
    check(resolution.first, item.tasks.find((id) => id !== resolution.first), `the overlap decision says ${resolution.first} goes first`);
  }
  return out;
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
