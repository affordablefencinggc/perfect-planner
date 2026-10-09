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
// sessionStorage and goes with every write. A window opened any other way can only read.
export const CSRF_HEADER = "x-pp-csrf";
const CSRF_KEY = "pp.core.csrf";
const LAUNCH_PATTERN = /(?:^#|&)pp-launch=([\w-]{20,})/;

function readCsrf() {
  try { return globalThis.sessionStorage?.getItem(CSRF_KEY) || null; } catch { return null; }
}

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

let personClaim = null;
/** Claims this window's launch secret once per page load. Resolves true when the window can make changes. */
export function claimPersonSession(fetchImpl = globalThis.fetch) {
  if (!personClaim) {
    const launch = takeLaunchSecret();
    personClaim = !launch
      ? Promise.resolve(Boolean(readCsrf()))
      : Promise.resolve()
        .then(() => fetchImpl(`${CORE_API}/session/claim`, { method: "POST", credentials: "same-origin", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ launch }) }))
        .then((response) => response.json().then((payload) => (response.ok && payload?.result?.csrf ? payload.result.csrf : null)))
        .then((csrf) => { if (csrf) writeCsrf(csrf); return Boolean(csrf || readCsrf()); }, () => Boolean(readCsrf()));
  }
  return personClaim;
}

/** True when this window holds the person's CSRF token (it was opened from the launcher). */
export function hasPersonSession() {
  return Boolean(readCsrf());
}

/** For tests: forget this page load's claim. */
export function resetPersonSession() {
  personClaim = null;
  writeCsrf(null);
}

const READ_ONLY_MESSAGE = "This window can only read. To make changes, open Perfect Planner from its launcher (the one-time link npm start prints).";

async function call(path, project, options = {}) {
  const { method = "GET", fetchImpl = globalThis.fetch } = options;
  if (method === "GET") return send(path, project, options);
  await claimPersonSession(fetchImpl);
  const csrf = readCsrf();
  try {
    return await send(path, project, { ...options, csrf });
  } catch (error) {
    if (error?.code === "PERSON_REQUIRED") {
      // The local service restarted (sessions are per launch) or the window was never claimed.
      writeCsrf(null);
      throw new CoreApiError(READ_ONLY_MESSAGE, { status: error.status, code: "PERSON_REQUIRED" });
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
export const corePost = (path, project, body, options) => call(path, project, { ...options, method: "POST", body: body ?? {} });

/**
 * Reads one core resource. status is "loading" | "ready" | "empty" | "error".
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
