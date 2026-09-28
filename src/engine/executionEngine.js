import { claimsConflict, normalizeSurface, validateManifest } from "./collisionEngine.js";

export const SESSION_ACTIVE_MS = 10 * 60 * 1000;
export const SESSION_GONE_MS = 24 * 60 * 60 * 1000;

export function classifySession(lastHeartbeat, now = Date.now()) {
  const age = Math.max(0, now - new Date(lastHeartbeat).getTime());
  if (!Number.isFinite(age)) return "gone";
  if (age <= SESSION_ACTIVE_MS) return "active";
  if (age <= SESSION_GONE_MS) return "stale";
  return "gone";
}

function taskConflicts(left, right) {
  return (left.claims ?? []).some((a) => (right.claims ?? []).some((b) => claimsConflict(a, b)));
}

function topologicalOrder(tasks) {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const pending = new Map(tasks.map((task) => [task.taskId, new Set(task.dependsOn ?? [])]));
  const order = [];
  while (pending.size) {
    const ready = [...pending].filter(([, deps]) => [...deps].every((id) => !pending.has(id))).map(([id]) => id).sort();
    if (!ready.length) return [];
    for (const id of ready) { order.push(byId.get(id)); pending.delete(id); }
  }
  return order;
}

function buildWaves(tasks) {
  const level = new Map();
  for (const task of topologicalOrder(tasks)) {
    level.set(task.taskId, (task.dependsOn ?? []).reduce((max, id) => Math.max(max, (level.get(id) ?? -1) + 1), 0));
  }
  const groups = new Map();
  for (const task of tasks) {
    const wave = level.get(task.taskId) ?? 0;
    if (!groups.has(wave)) groups.set(wave, []);
    groups.get(wave).push(task);
  }
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([wave, members]) => {
    const lanes = [];
    for (const task of [...members].sort((a, b) => a.taskId.localeCompare(b.taskId))) {
      // A task can bridge multiple previously independent lanes. Join every
      // touched component so no conflicting pair remains parallel.
      const joined = [task];
      for (let index = lanes.length - 1; index >= 0; index -= 1) {
        if (lanes[index].some(other => taskConflicts(task, other))) {
          joined.push(...lanes.splice(index, 1)[0]);
        }
      }
      lanes.push(joined.sort((a, b) => a.taskId.localeCompare(b.taskId)));
      lanes.sort((a, b) => a[0].taskId.localeCompare(b[0].taskId));
    }
    return { wave: wave + 1, lanes: lanes.map((lane, index) => ({ id: `W${wave + 1}-L${index + 1}`, tasks: lane })) };
  });
}

function criticalPath(tasks) {
  const best = new Map();
  for (const task of topologicalOrder(tasks)) {
    const duration = Number(task.estimateMinutes ?? 0);
    const predecessors = (task.dependsOn ?? []).map((id) => best.get(id)).filter(Boolean);
    const prior = predecessors.sort((a, b) => b.minutes - a.minutes)[0] ?? { minutes: 0, path: [] };
    best.set(task.taskId, { minutes: prior.minutes + duration, path: [...prior.path, task.taskId] });
  }
  return [...best.values()].sort((a, b) => b.minutes - a.minutes)[0] ?? { minutes: 0, path: [] };
}

function hotspots(tasks) {
  const touches = new Map();
  for (const task of tasks) {
    for (const claim of task.claims ?? []) {
      const key = `${claim.kind}:${normalizeSurface(claim.kind, claim.surface)}`;
      if (!touches.has(key)) touches.set(key, new Set());
      touches.get(key).add(task.taskId);
    }
  }
  return [...touches.entries()].map(([surface, taskIds]) => ({ surface, taskIds: [...taskIds].sort(), touches: taskIds.size })).filter((item) => item.touches > 1).sort((a, b) => b.touches - a.touches || a.surface.localeCompare(b.surface));
}

export function deriveExecutionMap(manifest) {
  const errors = validateManifest(manifest);
  if (errors.length) return { valid: false, errors, waves: [], hotspots: [], criticalPath: { minutes: 0, path: [] }, peakParallelism: 0 };
  const waves = buildWaves(manifest.tasks);
  return {
    valid: true,
    errors: [],
    waves,
    hotspots: hotspots(manifest.tasks),
    criticalPath: criticalPath(manifest.tasks),
    peakParallelism: Math.max(0, ...waves.map((wave) => wave.lanes.length)),
  };
}
