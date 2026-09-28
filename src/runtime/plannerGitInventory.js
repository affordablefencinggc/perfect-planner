import { isTauriRuntime } from "../native/runtimeSnapshot.js";

const fields = (v, keys) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join() === keys.split(" ").sort().join();
const uint = (n, min = 0) => Number.isSafeInteger(n) && n >= min && n <= 0xffffffff;
const text = (s, max) => typeof s === "string" && s.length > 0 && s.length <= max && !/[\u0000-\u001f\u007f-\u009f\ufffd]/u.test(s);
const sha = (s) => typeof s === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(s);
const ref = (s) => text(s, 1024) && s.startsWith("refs/heads/");
const fail = () => { throw new Error("GIT_PROTOCOL_ERROR"); };
// Admission belongs to the webview runtime, not a disposable panel instance.
// Closing Operations must not clear an in-flight request or an uncertain cleanup.
// This intentionally remains session-only; durable recovery is a native concern.
const runtimeGates = new WeakMap();
function gateFor(runtime) {
  if (!runtime || typeof runtime !== "object") return { pending: false, quarantined: false, listeners: new Set() };
  if (!runtimeGates.has(runtime)) runtimeGates.set(runtime, { pending: false, quarantined: false, listeners: new Set() });
  return runtimeGates.get(runtime);
}
const bindingOf = (p) => {
  const r = p?.registration;
  if (p?.kind !== "imported" || ["stale", "unavailable"].includes(p.state) || r?.adapter !== "native" || r.access !== "metadata-read-only") return null;
  if (typeof p.projectId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(p.projectId) || !uint(p.generation) || !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(r.workspaceId ?? "") || !uint(r.registryRevision, 1) || !/^[a-f0-9]{64}$/.test(r.rootIdentity ?? "")) return null;
  return { projectId: p.projectId, generation: p.generation, workspaceId: r.workspaceId, registryRevision: r.registryRevision, rootIdentity: r.rootIdentity };
};

export function validateGitInventory(value, request, { now, startedAt }) {
  if (!fields(value, "schemaVersion requestId projectId generation workspaceId registryRevision rootIdentity code observedAt expiresAt durationMs observation cleanupComplete metadataOnly executionAuthorized computerUse")) fail();
  for (const key of Object.keys(request)) if (value[key] !== request[key]) fail();
  if (value.metadataOnly !== true || value.executionAuthorized !== false || value.computerUse !== false || typeof value.cleanupComplete !== "boolean") fail();
  if (![now, startedAt, value.observedAt, value.expiresAt, value.durationMs].every(Number.isSafeInteger) || now < startedAt || value.durationMs < 0 || value.durationMs > 25_000 || value.observedAt < startedAt - 1000 || value.observedAt > now + 1000) fail();
  if (typeof value.code !== "string" || !/^GIT_[A-Z_]{1,48}$/.test(value.code)) fail();
  if (value.code !== "GIT_OBSERVED") {
    if (value.observation !== null || value.expiresAt !== value.observedAt) fail();
    return Object.freeze({ ...value });
  }
  if (!value.cleanupComplete || value.expiresAt <= now || value.expiresAt <= value.observedAt || value.expiresAt - value.observedAt > 30_000) fail();
  const o = value.observation;
  if (!fields(o, "schemaVersion kind state localOnly worktrees branches cleanState ciState productionState promotionAuthority canAutomaticallyDelete consistency") || o.schemaVersion !== 1 || o.kind !== "git-inventory" || o.localOnly !== true || o.promotionAuthority !== false || o.canAutomaticallyDelete !== false || [o.cleanState, o.ciState, o.productionState].some((s) => s !== "not-inspected")) fail();
  if (!Array.isArray(o.worktrees) || o.worktrees.length > 128 || !Array.isArray(o.branches) || o.branches.length > 500) fail();
  if (o.state === "no-git-marker") {
    if (o.worktrees.length || o.branches.length || o.consistency !== "root-marker-observation") fail();
  } else if (o.state !== "observed" || !o.worktrees.length || o.consistency !== "two-matching-reads-not-atomic") fail();
  const paths = new Set(), refs = new Set();
  for (const w of o.worktrees) {
    if (!fields(w, "path headSha branchRef mode locked prunable cleanState canAutomaticallyDelete") || !text(w.path, 4096) || !/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(w.path) || typeof w.locked !== "boolean" || typeof w.prunable !== "boolean" || w.cleanState !== "not-inspected" || w.canAutomaticallyDelete !== false) fail();
    const path = w.path.replaceAll("\\", "/").toLowerCase();
    if (paths.has(path)) fail(); paths.add(path);
    if (w.mode === "bare") { if (w.headSha !== null || w.branchRef !== null) fail(); }
    else if (!sha(w.headSha) || (w.mode === "detached" ? w.branchRef !== null : w.mode !== "branch" || !ref(w.branchRef))) fail();
  }
  for (const b of o.branches) {
    if (!fields(b, "ref headSha") || !ref(b.ref) || !sha(b.headSha) || refs.has(b.ref)) fail();
    refs.add(b.ref);
  }
  // Copy only validated data; no native object can subsequently mutate the view.
  return Object.freeze({ ...value, observation: Object.freeze({ ...o, worktrees: Object.freeze(o.worktrees.map((w) => Object.freeze({ ...w }))), branches: Object.freeze(o.branches.map((b) => Object.freeze({ ...b }))) }) });
}

export function createPlannerGitInventoryController({ runtime = globalThis, invoke, onEvent = () => {}, now = Date.now, requestId = () => `git-${globalThis.crypto.randomUUID()}`, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let binding = null, key = "", revision = 0, disposed = false, expiry;
  const gate = gateFor(runtime);
  let snapshot = Object.freeze({ status: "unavailable", canCheck: false, reason: "Choose a registered desktop project.", result: null });
  const listeners = new Set();
  const publish = (next) => { snapshot = Object.freeze({ ...snapshot, ...next }); for (const l of listeners) { try { l(); } catch { /* Views cannot change request ownership. */ } } return snapshot; };
  const refreshGate = () => { if (!disposed) { if (gate.quarantined) clearExpiry(); publish({ canCheck: Boolean(binding) && !gate.pending && !gate.quarantined, ...(gate.quarantined ? { result: null, status: "failed", reason: "Previous request cleanup is uncertain. Reconcile the desktop runtime before retrying." } : {}) }); } };
  gate.listeners.add(refreshGate);
  const notifyGate = () => { for (const listener of gate.listeners) listener(); };
  const clearExpiry = () => { if (expiry !== undefined) clearTimer(expiry); expiry = undefined; };
  const emit = (captured, id, phase, code) => {
    try { onEvent(Object.freeze({ projectId: captured.projectId, generation: captured.generation, requestId: id, severity: phase === "start" || code === "GIT_OBSERVED" ? "info" : "error", message: phase === "start" ? "Local Git metadata inspection started." : code === "GIT_OBSERVED" ? "Local Git metadata observed; CI and production remain unverified." : "Local Git metadata inspection failed or could not be verified.", payload: Object.freeze({ phase, code, metadataOnly: true }) })); } catch { /* Log failures cannot change inspection authority. */ }
  };
  function setProject(project) {
    const next = isTauriRuntime(runtime) ? bindingOf(project) : null;
    const nextKey = JSON.stringify([next, project?.projectId, project?.generation]);
    if (disposed || key === nextKey) return snapshot;
    revision++; clearExpiry(); key = nextKey; binding = next;
    return publish({ status: next ? "idle" : "unavailable", canCheck: Boolean(next) && !gate.pending && !gate.quarantined, result: null, reason: gate.quarantined ? "Previous request cleanup is uncertain. Reconcile the desktop runtime before retrying." : next ? "Local branches have not been inspected." : "Git inspection requires a current registered project in the desktop app." });
  }
  async function check() {
    if (disposed || !binding || gate.pending || gate.quarantined) return snapshot;
    const own = ++revision, captured = { ...binding }, startedAt = now();
    clearExpiry();
    let id;
    try { id = requestId(); if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,96}$/.test(id)) throw new Error(); }
    catch { return publish({ status: "failed", reason: "Could not create a request identity.", result: null }); }
    const request = { schemaVersion: 1, requestId: id, ...captured };
    gate.pending = true;
    notifyGate();
    publish({ status: "checking", canCheck: false, reason: "Inspecting local branches and working copies…", result: null });
    emit(captured, id, "start", "GIT_REQUEST_STARTED");
    let timeout;
    try {
      const call = (async () => (invoke ?? (await import("@tauri-apps/api/core")).invoke)("inspect_registered_git_inventory", { request }))();
      const wire = await Promise.race([call, new Promise((_, reject) => { timeout = setTimer(() => reject(new Error("GIT_TIMEOUT")), 25_000); })]);
      const result = validateGitInventory(wire, request, { now: now(), startedAt });
      gate.quarantined = !result.cleanupComplete;
      emit(captured, id, "finish", result.code);
      if (disposed || own !== revision) return snapshot;
      publish({ status: result.code === "GIT_OBSERVED" ? "observed" : "failed", reason: result.code === "GIT_OBSERVED" ? "Read-only local observation. Clean files, CI and production have not been checked." : result.code, result: result.code === "GIT_OBSERVED" ? result : null });
      if (result.code === "GIT_OBSERVED") {
        expiry = setTimer(() => { if (!disposed && own === revision) publish({ status: "expired", result: null, reason: "This observation has expired. Inspect again for current branches." }); }, result.expiresAt - now());
        expiry?.unref?.();
      }
    } catch {
      // Rejection/timeout is not evidence that the native job was stopped.
      gate.quarantined = true;
      emit(captured, id, "finish", "GIT_CLEANUP_UNCERTAIN");
      if (!disposed && own === revision) publish({ status: "failed", result: null, reason: "Git inspection could not be verified; cleanup is uncertain. Reconcile the desktop runtime before retrying." });
    } finally {
      if (timeout !== undefined) clearTimer(timeout);
      gate.pending = false;
      notifyGate();
    }
    return snapshot;
  }
  return Object.freeze({ setProject, check, getSnapshot: () => snapshot, subscribe(l) { listeners.add(l); return () => listeners.delete(l); }, dispose() { disposed = true; revision++; clearExpiry(); gate.listeners.delete(refreshGate); listeners.clear(); } });
}
