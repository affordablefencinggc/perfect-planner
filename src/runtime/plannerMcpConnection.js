import { isTauriRuntime } from "../native/runtimeSnapshot.js";

const SERVICE = "perfect-planner-bundled-metadata";
const COMMAND = "check_bundled_mcp_connection";
const MAX_TTL = 30_000;
const CODES = new Set(["MCP_CONNECTED", "MCP_REQUEST_INVALID", "MCP_BUSY", "MCP_REGISTRATION_INVALID", "MCP_SERVICE_UNAVAILABLE", "MCP_PROTOCOL_ERROR", "MCP_TIMEOUT", "MCP_OUTPUT_LIMIT", "MCP_INTERRUPTED", "MCP_CLEANUP_FAILED"]);
const RESPONSE_KEYS = ["schemaVersion", "requestId", "projectId", "generation", "workspaceId", "registryRevision", "rootIdentity", "state", "code", "observedAt", "expiresAt", "durationMs", "service", "protocolVersion", "capabilities", "metadataOnly", "executionAuthorized", "computerUse", "cleanupComplete"].sort();
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum && value <= 0xffffffff;
// A disposable view does not own the native request. Keep admission shared by
// the webview runtime; uncertain cleanup requires native reconciliation.
const runtimeGates = new WeakMap();
function gateFor(runtime) {
  if (!runtime || typeof runtime !== "object") throw new Error("Invalid MCP runtime");
  if (!runtimeGates.has(runtime)) runtimeGates.set(runtime, { pending: false, quarantined: false, listeners: new Set() });
  return runtimeGates.get(runtime);
}

function projectBinding(project) {
  const registration = project?.registration;
  if (project?.kind !== "imported" || ["stale", "unavailable"].includes(project.state) || registration?.adapter !== "native" || registration.access !== "metadata-read-only") return null;
  if (typeof project.projectId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(project.projectId) || !integer(project.generation)) return null;
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(registration.workspaceId ?? "") || !integer(registration.registryRevision, 1) || !/^[a-f0-9]{64}$/.test(registration.rootIdentity ?? "")) return null;
  return Object.freeze({ projectId: project.projectId, generation: project.generation, workspaceId: registration.workspaceId, registryRevision: registration.registryRevision, rootIdentity: registration.rootIdentity });
}

export function validateBundledMcpObservation(value, request, { now = Date.now(), startedAt = now } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(RESPONSE_KEYS)) throw new Error("MCP_PROTOCOL_ERROR");
  for (const key of ["schemaVersion", "requestId", "projectId", "generation", "workspaceId", "registryRevision", "rootIdentity"]) if (value[key] !== request[key]) throw new Error("MCP_PROTOCOL_ERROR");
  if (value.service !== SERVICE || value.protocolVersion !== "2025-11-25" || value.metadataOnly !== true || value.executionAuthorized !== false || value.computerUse !== false || typeof value.cleanupComplete !== "boolean") throw new Error("MCP_PROTOCOL_ERROR");
  if (!Array.isArray(value.capabilities) || value.capabilities.length !== 1 || value.capabilities[0] !== "workspace-registration:read") throw new Error("MCP_PROTOCOL_ERROR");
  if (!CODES.has(value.code) || !["connected", "failed"].includes(value.state) || (value.state === "connected") !== (value.code === "MCP_CONNECTED")) throw new Error("MCP_PROTOCOL_ERROR");
  if (![value.observedAt, value.expiresAt, value.durationMs].every(Number.isSafeInteger) || value.durationMs < 0 || value.durationMs > 10_000 || value.observedAt < startedAt - 1000 || value.observedAt > now + 1000) throw new Error("MCP_PROTOCOL_ERROR");
  if (value.state === "connected" && (!value.cleanupComplete || value.expiresAt <= now || value.expiresAt <= value.observedAt || value.expiresAt - value.observedAt > MAX_TTL)) throw new Error("MCP_PROTOCOL_ERROR");
  if (value.state === "failed" && value.expiresAt !== value.observedAt) throw new Error("MCP_PROTOCOL_ERROR");
  return Object.freeze({ ...value, capabilities: Object.freeze([...value.capabilities]) });
}

// Only an actual invoke response can populate this session-only observation.
// It cannot authorize tool execution, content access, mutation, CI or deployment.
export function createPlannerMcpConnectionController({ runtime = globalThis, invoke, onEvent = () => {}, now = Date.now, requestId = () => `request-${globalThis.crypto.randomUUID()}`, timeoutMs = 12_000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 12_000) throw new Error("Invalid MCP request deadline");
  const listeners = new Set();
  const gate = gateFor(runtime);
  let binding = null, currentKey = "", ticket = 0, disposed = false, expiryTimer = null, cancelWait = null;
  let snapshot = Object.freeze({ status: "unavailable", canCheck: false, reason: "Choose a registered desktop project.", projectId: null, generation: null, requestId: null, observedAt: null, expiresAt: null, service: SERVICE });
  function publish(fields) {
    snapshot = Object.freeze({ ...snapshot, ...fields });
    for (const listener of listeners) { try { listener(); } catch { /* One view cannot interrupt observation cleanup. */ } }
    return snapshot;
  }
  function refreshGate() {
    if (disposed) return;
    if (gate.quarantined && expiryTimer !== null) { clearTimer(expiryTimer); expiryTimer = null; }
    publish({ canCheck: Boolean(binding) && !gate.pending && !gate.quarantined,
      ...(binding && gate.quarantined ? { status: "failed", reason: "MCP_CLEANUP_FAILED", observedAt: null, expiresAt: null } : {}),
    });
  }
  gate.listeners.add(refreshGate);
  const notifyGate = () => { for (const listener of gate.listeners) listener(); };
  function event(captured, id, code, phase, durationMs = 0) {
    const success = code === "MCP_CONNECTED";
    try { onEvent(Object.freeze({ projectId: captured.projectId, generation: captured.generation, requestId: id, adapter: "bundled-planner-mcp", severity: phase === "start" || success ? "info" : code === "MCP_INTERRUPTED" ? "warning" : "error", message: phase === "start" ? "Checking bundled planner metadata access." : success ? "Bundled planner metadata access verified; one-shot check completed." : "Bundled planner connection check did not establish current metadata access.", payload: Object.freeze({ code, phase, durationMs, metadataOnly: true }) })); } catch { /* Diagnostics cannot change the native observation result. */ }
  }
  function invalidate() {
    ticket += 1;
    if (expiryTimer !== null) clearTimer(expiryTimer);
    expiryTimer = null;
    cancelWait?.(); cancelWait = null;
  }
  function setProject(project) {
    if (disposed) return snapshot;
    const next = isTauriRuntime(runtime) ? projectBinding(project) : null;
    const key = JSON.stringify([next, project?.projectId ?? null, project?.generation ?? null]);
    if (key === currentKey) return snapshot;
    invalidate(); binding = next; currentKey = key;
    publish({ status: binding ? "idle" : "unavailable", canCheck: Boolean(binding) && !gate.pending && !gate.quarantined, projectId: binding?.projectId ?? project?.projectId ?? null, generation: binding?.generation ?? project?.generation ?? null, requestId: null, observedAt: null, expiresAt: null, reason: binding ? gate.pending ? "Waiting for the previous native check to finish." : "Not checked yet." : isTauriRuntime(runtime) ? "Choose a current, registered desktop project." : "Bundled connection checks require the desktop app." });
    if (gate.quarantined) refreshGate();
    return snapshot;
  }
  async function check() {
    if (disposed || !binding || gate.pending || gate.quarantined || snapshot.status === "checking") return snapshot;
    invalidate();
    const ownTicket = ticket;
    const captured = binding;
    const startedAt = now();
    let id;
    try {
      id = requestId();
      if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{3,96}$/.test(id)) throw new Error("Invalid identity");
    } catch {
      event(captured, null, "MCP_REQUEST_INVALID", "finish");
      return publish({ status: "failed", canCheck: true, reason: "MCP_REQUEST_INVALID", requestId: null, observedAt: null, expiresAt: null });
    }
    const request = Object.freeze({ schemaVersion: 1, requestId: id, ...captured });
    gate.pending = true; notifyGate();
    publish({ status: "checking", canCheck: false, reason: "Checking bundled metadata service…", requestId: id, observedAt: null, expiresAt: null });
    event(captured, id, "MCP_REQUEST_STARTED", "start");
    let timer;
    try {
      const interrupted = new Promise((_, reject) => { cancelWait = () => reject(new Error("MCP_INTERRUPTED")); });
      const timedOut = new Promise((_, reject) => { timer = setTimer(() => reject(new Error("MCP_TIMEOUT")), timeoutMs); });
      const call = (async () => { const nativeInvoke = invoke ?? (await import("@tauri-apps/api/core")).invoke; return nativeInvoke(COMMAND, { request }); })();
      // Cancelling the view's wait must not cancel this independent lifecycle
      // deadline or release admission while native work may still be running.
      const tracked = Promise.race([call, timedOut]).then(wire => {
        const result = validateBundledMcpObservation(wire, request, { now: now(), startedAt });
        if (!result.cleanupComplete) {
          gate.quarantined = true;
          if (disposed || ownTicket !== ticket) event(captured, id, "MCP_CLEANUP_FAILED", "cleanup");
        }
        return result;
      }).catch(error => {
        gate.quarantined = true;
        if (disposed || ownTicket !== ticket) event(captured, id, "MCP_CLEANUP_FAILED", "cleanup");
        throw error;
      }).finally(() => {
        if (timer !== undefined) clearTimer(timer);
        gate.pending = false; notifyGate();
      });
      const result = await Promise.race([tracked, interrupted]);
      if (disposed || ownTicket !== ticket) return snapshot;
      event(captured, id, result.code, "finish", result.durationMs);
      publish({ status: result.state === "connected" ? "connected" : "failed", canCheck: !gate.pending && !gate.quarantined, reason: result.state === "connected" ? "Metadata access verified by a completed one-shot check." : result.code, observedAt: result.observedAt, expiresAt: result.expiresAt });
      if (result.state === "connected") {
        expiryTimer = setTimer(() => { if (!disposed && ownTicket === ticket) publish({ status: "expired", reason: "The previous connection check has expired. Check again." }); }, Math.max(0, result.expiresAt - now()));
        expiryTimer?.unref?.();
      }
    } catch (error) {
      const code = ["MCP_INTERRUPTED", "MCP_TIMEOUT", "MCP_PROTOCOL_ERROR"].includes(error?.message) ? error.message : "MCP_SERVICE_UNAVAILABLE";
      event(captured, id, code, "finish", Math.max(0, Math.min(12_000, now() - startedAt)));
      if (!disposed && ownTicket === ticket) publish({ status: "failed", canCheck: !gate.pending && !gate.quarantined, reason: code, observedAt: null, expiresAt: null });
    } finally {
      if (ownTicket === ticket) cancelWait = null;
    }
    return snapshot;
  }
  return Object.freeze({
    setProject, check, getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    disconnect() { if (disposed) return; invalidate(); publish({ status: binding ? "idle" : "unavailable", canCheck: Boolean(binding) && !gate.pending && !gate.quarantined, reason: gate.pending ? "Observation cleared; the previous native check is still pending." : "Local observation cleared; workspace registration unchanged.", requestId: null, observedAt: null, expiresAt: null }); if (gate.quarantined) refreshGate(); },
    dispose() { if (disposed) return; disposed = true; invalidate(); gate.listeners.delete(refreshGate); listeners.clear(); },
  });
}
