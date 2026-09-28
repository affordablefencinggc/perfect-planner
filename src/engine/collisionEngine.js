const allowedKinds = new Set(["file", "api", "database", "dependency"]);
const allowedAccess = new Set(["read", "write"]);

export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : canonicalize(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function normalizeSurface(kind, surface) {
  let normalized = String(surface ?? "").trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (kind === "file") normalized = normalized.replace(/\/+/g, "/").replace(/\/$/, "").toLowerCase();
  if (kind === "api") normalized = normalized.replace(/\s+/g, " ").toUpperCase();
  if (kind === "database" || kind === "dependency") normalized = normalized.toLowerCase();
  return normalized;
}

function dependencyCycles(tasks) {
  const taskIds = new Set(tasks.map((task) => task.taskId));
  const incoming = new Map(tasks.map((task) => [task.taskId, new Set((task.dependsOn ?? []).filter((id) => taskIds.has(id)))]));
  const ready = [...incoming].filter(([, deps]) => deps.size === 0).map(([id]) => id).sort();
  const visited = [];
  while (ready.length) {
    const id = ready.shift();
    visited.push(id);
    for (const [candidate, deps] of incoming) {
      if (!deps.delete(id) || deps.size !== 0 || visited.includes(candidate) || ready.includes(candidate)) continue;
      ready.push(candidate);
      ready.sort();
    }
  }
  return visited.length === tasks.length ? [] : [...incoming.keys()].filter((id) => !visited.includes(id));
}

export function validateManifest(manifest) {
  const errors = [];
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const identifier = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/.test(value);
  if (!object(manifest)) return ["Manifest must be a JSON object."];
  if (manifest.schemaVersion !== 1) errors.push("schemaVersion must equal 1.");
  if (!identifier(manifest.planId)) errors.push("planId must be a non-empty string identifier.");
  if (manifest.createdAt !== undefined && (typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt)) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(manifest.createdAt))) errors.push('createdAt must be a UTC ISO timestamp when supplied.');
  if (manifest.priority !== undefined && (typeof manifest.priority !== 'number' || !Number.isFinite(manifest.priority))) errors.push('priority must be a finite number when supplied.');
  if (!Array.isArray(manifest.tasks) || manifest.tasks.length === 0 || manifest.tasks.length > 10_000) return [...errors, "tasks must contain 1 to 10000 tasks."];
  const seenTaskIds = new Set();
  for (const [index, task] of manifest.tasks.entries()) {
    if (!object(task)) { errors.push(`tasks[${index}] must be an object.`); continue; }
    if (!identifier(task.taskId)) errors.push(`tasks[${index}].taskId must be a non-empty string identifier.`);
    if (seenTaskIds.has(task.taskId)) errors.push(`Duplicate taskId ${task.taskId}.`);
    seenTaskIds.add(task.taskId);
    if (task.dependsOn !== undefined && (!Array.isArray(task.dependsOn) || task.dependsOn.length > 1000 || task.dependsOn.some(id => !identifier(id)))) errors.push(`Task ${task.taskId ?? index} dependsOn must be a bounded identifier array.`);
    else if (new Set(task.dependsOn ?? []).size !== (task.dependsOn ?? []).length) errors.push(`Task ${task.taskId} repeats a dependency.`);
    if (!Array.isArray(task.claims) || task.claims.length > 256) { errors.push(`Task ${task.taskId ?? index} claims must be an array of at most 256 claims.`); continue; }
    for (const [claimIndex, claim] of task.claims.entries()) {
      if (!object(claim)) { errors.push(`Task ${task.taskId} claim ${claimIndex + 1} must be an object.`); continue; }
      if (!allowedKinds.has(claim.kind)) errors.push(`Task ${task.taskId} claim ${claimIndex + 1} has invalid kind.`);
      if (!allowedAccess.has(claim.access)) errors.push(`Task ${task.taskId} claim ${claimIndex + 1} has invalid access.`);
      if (typeof claim.surface !== 'string' || !claim.surface.trim() || claim.surface.length > 1024 || /[\u0000-\u001f]/.test(claim.surface)) { errors.push(`Task ${task.taskId} claim ${claimIndex + 1} requires a bounded text surface.`); continue; }
      if (claim.kind === 'file') {
        const relative = claim.surface.trim().replaceAll('\\', '/').replace(/^\.\//, '');
        const base = relative.replace(/\/\*\*?$/, '').replace(/\/$/, '');
        if (!base || /[:*?<>|\[\]{}]/.test(base) || base.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) errors.push(`Task ${task.taskId} file claim must be a relative path, optionally ending in /* or /**; other wildcards, traversal and trailing dot/space aliases are unsupported.`);
      }
    }
  }
  if (errors.length) return errors;
  for (const task of manifest.tasks) for (const dependency of task.dependsOn ?? []) {
    if (!seenTaskIds.has(dependency)) errors.push(`Task ${task.taskId} has unknown dependency ${dependency}.`);
  }
  if (!errors.length) for (const cycleId of dependencyCycles(manifest.tasks)) errors.push(`Dependency cycle includes ${cycleId}.`);
  return errors;
}

function stripGlob(surface) {
  return surface.replace(/\/\*\*?$/, "");
}

export function surfacesOverlap(left, right) {
  if (left.kind !== right.kind) return false;
  const a = normalizeSurface(left.kind, left.surface);
  const b = normalizeSurface(right.kind, right.surface);
  if (a === b) return true;
  if (left.kind !== "file") return false;
  const baseA = stripGlob(a);
  const baseB = stripGlob(b);
  // File claims are hierarchical (including the supported trailing /* and
  // /** forms). Compare both normalized bases: overlap cannot depend on order.
  return baseA === baseB || baseA.startsWith(`${baseB}/`) || baseB.startsWith(`${baseA}/`);
}

export function claimsConflict(left, right) {
  return !(left.access === "read" && right.access === "read") && surfacesOverlap(left, right);
}

function flattenClaims(manifests) {
  return manifests.flatMap((manifest) => manifest.tasks.flatMap((task) => task.claims.map((claim, claimIndex) => ({
    planId: manifest.planId,
    planTitle: manifest.title ?? manifest.planId,
    priority: Number(manifest.priority ?? 0),
    createdAt: manifest.createdAt ?? "9999-12-31T23:59:59.999Z",
    taskId: task.taskId,
    taskTitle: task.title ?? task.taskId,
    claimIndex,
    kind: claim.kind,
    access: claim.access,
    surface: normalizeSurface(claim.kind, claim.surface),
  }))));
}

function orderClaims(left, right) {
  const order = [left, right].sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt) || a.planId.localeCompare(b.planId) || a.taskId.localeCompare(b.taskId));
  return { first: order[0], then: order[1] };
}

export function assessCollisions(manifests) {
  if (!Array.isArray(manifests) || manifests.length > 1000) return { manifests: [], claims: [], collisions: [], safeClaims: [], manifestErrors: [{ planId: 'unknown', message: 'Collision assessment requires an array of at most 1000 manifests.' }], unresolved: 0, hardStops: 0 };
  const manifestErrors = manifests.flatMap((manifest, index) => validateManifest(manifest).map((message) => ({ planId: manifest?.planId ?? `manifest-${index + 1}`, message })));
  const planIds = new Set();
  for (const manifest of manifests) {
    if (manifest && planIds.has(manifest.planId)) manifestErrors.push({ planId: manifest.planId, message: 'Duplicate plan identity; combine its tasks in one validated manifest before assessment.' });
    planIds.add(manifest?.planId);
  }
  if (manifestErrors.length) return { manifests, claims: [], collisions: [], safeClaims: [], manifestErrors, unresolved: 0, hardStops: 0 };
  const claims = flattenClaims(manifests);
  const collisions = [];
  const collidedClaimKeys = new Set();
  for (let leftIndex = 0; leftIndex < claims.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < claims.length; rightIndex += 1) {
      const left = claims[leftIndex];
      const right = claims[rightIndex];
      if (left.planId === right.planId || !claimsConflict(left, right)) continue;
      const ordered = orderClaims(left, right);
      const severity = left.access === "write" && right.access === "write" ? "hard-stop" : "ordered";
      collidedClaimKeys.add(`${left.planId}:${left.taskId}:${left.claimIndex}`);
      collidedClaimKeys.add(`${right.planId}:${right.taskId}:${right.claimIndex}`);
      collisions.push({
        id: "",
        kind: left.kind,
        surface: left.surface.length <= right.surface.length ? left.surface : right.surface,
        severity,
        left,
        right,
        first: ordered.first,
        then: ordered.then,
        reason: severity === "hard-stop" ? "Both tasks write to an overlapping surface." : "A writer and reader overlap; serialize them to preserve a stable contract.",
        contingency: `${ordered.first.planId}/${ordered.first.taskId} proceeds first → freeze ${left.kind} contract → ${ordered.then.planId}/${ordered.then.taskId} rescans and resumes`,
      });
    }
  }
  collisions.sort((a, b) => a.surface.localeCompare(b.surface) || a.first.planId.localeCompare(b.first.planId));
  collisions.forEach((collision, index) => { collision.id = `COL-${String(index + 1).padStart(3, "0")}`; });
  return {
    manifests,
    claims,
    collisions,
    safeClaims: claims.filter((claim) => !collidedClaimKeys.has(`${claim.planId}:${claim.taskId}:${claim.claimIndex}`)),
    manifestErrors,
    unresolved: collisions.length,
    hardStops: collisions.filter((collision) => collision.severity === "hard-stop").length,
  };
}

export async function appendLedgerEntry(ledger, type, payload, options = {}) {
  const previousHash = ledger.at(-1)?.hash ?? "GENESIS";
  const entry = {
    sequence: ledger.length + 1,
    timestamp: options.timestamp ?? new Date().toISOString(),
    actor: options.actor ?? "local-collision-engine",
    type,
    payload,
    previousHash,
  };
  return [...ledger, { ...entry, hash: await sha256Hex(entry) }];
}

export async function verifyLedger(ledger) {
  let previousHash = "GENESIS";
  for (let index = 0; index < ledger.length; index += 1) {
    const { hash, ...entry } = ledger[index];
    if (entry.sequence !== index + 1 || entry.previousHash !== previousHash || await sha256Hex(entry) !== hash) {
      return { valid: false, brokenAt: index + 1 };
    }
    previousHash = hash;
  }
  return { valid: true, brokenAt: null };
}

export async function collisionCensusDigest(manifests) {
  return sha256Hex({ schemaVersion: 1, manifests });
}
