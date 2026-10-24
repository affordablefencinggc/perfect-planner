import { useCallback, useEffect, useRef, useState } from "react";
import { useOptionalProject } from "../project/ProjectProvider.jsx";

// Client for the core host (/api/core, see core/host). Every core screen reads
// through useCoreResource so loading, empty and error states behave the same.
export const CORE_API = "/api/core";

export function coreProjectKey(projectId) {
  const key = String(projectId ?? "").trim();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(key) ? key : "default";
}

export function useCoreProjectKey() {
  return coreProjectKey(useOptionalProject()?.activeProjectId);
}

export class CoreApiError extends Error {
  constructor(message, { status = 0, code = "ERROR" } = {}) {
    super(message);
    this.name = "CoreApiError";
    this.status = status;
    this.code = code;
  }
}

function coreUrl(path, project) {
  const url = new URL(`${CORE_API}${path}`, "http://local");
  url.searchParams.set("project", project);
  return `${url.pathname}${url.search}`;
}

// Writes are made in the person's name, so only the person's own window may make them
// (core/host/session.ts). The launcher opens this window with a one-time secret in the
// URL fragment (#pp-launch=...). On load the window strips it from the address bar and
// claims it once for an HttpOnly cookie plus a CSRF token; the token lives in this tab's
// sessionStorage and goes with every write. Reads need the cookie too (the host answers
// 401 PERSON_REQUIRED without it), so a window opened any other way shows nothing.
export const CSRF_HEADER = "x-pp-csrf";
const CSRF_KEY = "pp.core.csrf";
const LAUNCH_PATTERN = /(?:^#|&)pp-launch=([\w-]{20,})/;

function readCsrf() {
  try { return globalThis.sessionStorage?.getItem(CSRF_KEY) || null; } catch { return null; }
}

/** The window's CSRF token, for the local service's other person-only routes (the typed folder). */
export const personCsrfToken = readCsrf;

function writeCsrf(value) {
  try { if (value) globalThis.sessionStorage?.setItem(CSRF_KEY, value); else globalThis.sessionStorage?.removeItem(CSRF_KEY); } catch { /* the window then stays read-only */ }
}

/** Takes the launch secret out of the address bar (so it is not bookmarked, shared or kept in history). */
export function takeLaunchSecret(location = globalThis.location, history = globalThis.history) {
  const hash = String(location?.hash ?? "");
  const match = hash.match(LAUNCH_PATTERN);
  if (!match) return null;
  const rest = hash.replace(/^#/, "").split("&").filter((part) => !part.startsWith("pp-launch=")).join("&");
  try { history?.replaceState(history.state, "", `${location.pathname}${location.search}${rest ? `#${rest}` : ""}`); } catch { /* best effort */ }
  return match[1];
}

/**
 * In the desktop shell the secret comes over IPC instead: the shell read it once from the process
 * that started it and hands it out once (src-tauri/src/core_launch.rs). Null outside the shell.
 */
export async function takeDesktopLaunch(runtime = globalThis, invoke) {
  if (!runtime || typeof runtime !== "object" || !("__TAURI_INTERNALS__" in runtime)) return null;
  try {
    const call = invoke ?? (await import("@tauri-apps/api/core")).invoke;
    const secret = await call("take_core_launch");
    return typeof secret === "string" && secret ? secret : null;
  } catch {
    return null;
  }
}

// What this window last learned about reads: "unknown" until a read answers, "yes" when the
// host served one, "no" when it refused one for lack of a session (PERSON_REQUIRED).
export const CORE_SESSION_EVENT = "perfect-planner:core-session";
let readAccess = "unknown";
export function coreReadAccess() {
  return readAccess;
}
function setReadAccess(value) {
  if (readAccess === value) return;
  readAccess = value;
  try { globalThis.dispatchEvent?.(new CustomEvent(CORE_SESSION_EVENT, { detail: { readAccess: value } })); } catch { /* no window */ }
}
/** The host said this window has no session: forget the CSRF token and tell the screens. */
function loseSession() {
  writeCsrf(null);
  setReadAccess("no");
}

let personClaim = null;
/** Claims this window's launch secret once per page load. Resolves true when the window can make changes. */
export function claimPersonSession(fetchImpl = globalThis.fetch, desktopLaunch = takeDesktopLaunch) {
  if (!personClaim) {
    const fromLink = takeLaunchSecret();
    personClaim = Promise.resolve(fromLink ?? desktopLaunch()).then((launch) => (!launch
      ? Boolean(readCsrf())
      : Promise.resolve()
        .then(() => fetchImpl(`${CORE_API}/session/claim`, { method: "POST", credentials: "same-origin", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ launch }) }))
        .then((response) => response.json().then((payload) => (response.ok && payload?.result?.csrf ? payload.result.csrf : null)))
        .then((csrf) => { if (csrf) writeCsrf(csrf); return Boolean(csrf || readCsrf()); }, () => Boolean(readCsrf()))));
  }
  // A claimed session can be lost later (the local service restarted), so answer from the token now held.
  return personClaim.then(() => hasPersonSession());
}

/** True when this window holds the person's CSRF token (it was opened from the launcher). */
export function hasPersonSession() {
  return Boolean(readCsrf());
}

/** For tests: forget this page load's claim. */
export function resetPersonSession() {
  personClaim = null;
  readAccess = "unknown";
  writeCsrf(null);
}

/** True for the host's answer to a window without a session (it cannot read or write). */
export const isNoSession = (error) => error?.code === "PERSON_REQUIRED";

/**
 * A one-time link for another window that can make changes, asked for by this window (it must hold
 * the person's session). Returns the URL to open, e.g. with window.open or the desktop shell.
 */
export async function newWindowLink(project, options) {
  const { launch } = await corePost("/session/new-window", project, {}, options);
  return `${globalThis.location?.origin ?? ""}/#pp-launch=${launch}`;
}

export const NO_SESSION_MESSAGE = "This window is not connected to Perfect Planner yet, so it cannot show your project. Open it from a one-time link: in the terminal where Perfect Planner is running press Enter (l then Enter with npm run dev) for a new one, or restart it.";
const READ_ONLY_MESSAGE = "You can look but not change anything in this window. To make changes, open a one-time link: in the terminal where Perfect Planner is running press Enter (l then Enter with npm run dev) for a new one, or restart it.";

async function call(path, project, options = {}) {
  const { method = "GET", fetchImpl = globalThis.fetch } = options;
  // Claim the launch secret first (if the window has one), so the first read already carries the cookie.
  await claimPersonSession(fetchImpl);
  if (method === "GET") {
    try {
      const result = await send(path, project, options);
      setReadAccess("yes");
      return result;
    } catch (error) {
      if (!isNoSession(error)) throw error;
      loseSession();
      throw new CoreApiError(NO_SESSION_MESSAGE, { status: error.status, code: "PERSON_REQUIRED" });
    }
  }
  const csrf = readCsrf();
  try {
    return await send(path, project, { ...options, csrf });
  } catch (error) {
    if (error?.code === "PERSON_REQUIRED") {
      // The local service restarted (sessions are per launch) or the window was never claimed.
      writeCsrf(null);
      throw new CoreApiError(readAccess === "yes" ? READ_ONLY_MESSAGE : NO_SESSION_MESSAGE, { status: error.status, code: "PERSON_REQUIRED" });
    }
    throw error;
  }
}

async function send(path, project, { method = "GET", body, csrf, fetchImpl = globalThis.fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(coreUrl(path, project), {
      method,
      credentials: "same-origin",
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...(csrf ? { [CSRF_HEADER]: csrf } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new CoreApiError("Perfect Planner's local service is not reachable. Start the app with npm start.", { code: "OFFLINE" });
  }
  let payload = null;
  try { payload = await response.json(); } catch { /* handled below */ }
  if (!payload || typeof payload !== "object") throw new CoreApiError("The local service sent an answer this screen cannot read.", { status: response.status, code: "BAD_RESPONSE" });
  if (!response.ok || payload.ok === false) throw new CoreApiError(payload.message || `The local service refused (${response.status}).`, { status: response.status, code: payload.code || "ERROR" });
  return payload.result;
}

export const coreGet = (path, project, options) => call(path, project, options);
export const corePost = async (path, project, body, options) => {
  const result = await call(path, project, { ...options, method: "POST", body: body ?? {} });
  if (PLAN_WRITES.has(path)) notifyCorePlanChanged(project);
  return result;
};

// Plan approval has one source of truth: the core ledger's latest person-signed
// plan.approved (GET /plan). Home, Build and the Plan page read it through
// useCorePlanApproval; every approve (Deep planning or the Plan page) re-reads it.
export const CORE_PLAN_CHANGED_EVENT = "perfect-planner:core-plan";
const PLAN_WRITES = new Set(["/planning/approve", "/plan/approve"]);
export function notifyCorePlanChanged(project) {
  try { globalThis.dispatchEvent?.(new CustomEvent(CORE_PLAN_CHANGED_EVENT, { detail: { project } })); } catch { /* no window */ }
}
export const fetchCorePlanApproval = (project, options) => coreGet("/plan", project, options);
export const approveCorePlan = (project, tasks, options) => corePost("/plan/approve", project, { tasks }, options);

/**
 * The core plan approval for an app project id: { approved, latest, count, tasks },
 * or null while it is unknown (loading, or the local service is not reachable).
 */
export function useCorePlanApproval(projectId, { pollMs = 15000 } = {}) {
  const project = projectId ? coreProjectKey(projectId) : null;
  const [view, setView] = useState(null);
  useEffect(() => {
    setView(null);
    if (!project) return undefined;
    let live = true;
    const load = () => fetchCorePlanApproval(project).then(
      (result) => { if (live) setView(result && typeof result === "object" && typeof result.approved === "boolean" ? result : null); },
      (error) => {
        // Without a session nothing is known: show no approval rather than an old one as live truth.
        if (live && isNoSession(error)) setView(null);
        /* otherwise keep what was read: an approval, once written, stays in the ledger */
      },
    );
    load();
    const timer = pollMs ? setInterval(load, pollMs) : null;
    globalThis.addEventListener?.(CORE_PLAN_CHANGED_EVENT, load);
    globalThis.addEventListener?.("focus", load);
    return () => {
      live = false;
      if (timer) clearInterval(timer);
      globalThis.removeEventListener?.(CORE_PLAN_CHANGED_EVENT, load);
      globalThis.removeEventListener?.("focus", load);
    };
  }, [project, pollMs]);
  return view;
}

/**
 * Reads one core resource. status is "loading" | "ready" | "empty" | "error" | "no-session"
 * ("no-session": the window was not opened from a one-time link, so the host shows it nothing;
 * screens show the shared notice instead of an error).
 * isEmpty(data) decides "empty"; pollMs re-reads quietly in the background.
 */
export function useCoreResource(path, { isEmpty = (data) => data == null, pollMs = 0, enabled = true } = {}) {
  const project = useCoreProjectKey();
  const [state, setState] = useState({ status: "loading", data: null, error: null });
  const emptyRef = useRef(isEmpty);
  emptyRef.current = isEmpty;
  const seq = useRef(0);

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!enabled || !path) return;
    const id = ++seq.current;
    if (!quiet) setState((current) => ({ ...current, status: "loading", error: null }));
    try {
      const data = await coreGet(path, project);
      if (id !== seq.current) return;
      setState({ status: emptyRef.current(data) ? "empty" : "ready", data, error: null });
    } catch (error) {
      if (id !== seq.current) return;
      if (isNoSession(error)) return setState({ status: "no-session", data: null, error });
      if (quiet) return;
      setState({ status: "error", data: null, error });
    }
  }, [path, project, enabled]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!pollMs || !enabled) return undefined;
    const timer = setInterval(() => load({ quiet: true }), pollMs);
    return () => clearInterval(timer);
  }, [load, pollMs, enabled]);

  const post = useCallback(async (postPath, body) => {
    try {
      const result = await corePost(postPath, project, body);
      await load({ quiet: true });
      return result;
    } catch (error) {
      // The item changed since the person looked: show them the new version.
      if (error?.code === "STALE") await load({ quiet: true });
      throw error;
    }
  }, [project, load]);

  return { ...state, project, reload: () => load(), post, setData: (data) => setState({ status: emptyRef.current(data) ? "empty" : "ready", data, error: null }) };
}

// Claim as soon as the app loads, so the secret leaves the address bar right away.
if (typeof window !== "undefined" && typeof window.location !== "undefined" && LAUNCH_PATTERN.test(String(window.location.hash ?? ""))) {
  claimPersonSession();
}
