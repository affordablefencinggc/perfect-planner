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

// Writes need the person cookie that GET /session hands to this app window (see core/host/host.ts).
// One request per page load; a 401 PERSON_REQUIRED (the local service restarted) asks again once.
let personSession = null;
function ensurePersonSession(fetchImpl, renew = false) {
  if (renew || !personSession) {
    personSession = Promise.resolve()
      .then(() => fetchImpl(`${CORE_API}/session`, { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } }))
      .then(() => true, () => { personSession = null; return false; });
  }
  return personSession;
}

async function call(path, project, options = {}) {
  const { method = "GET", fetchImpl = globalThis.fetch } = options;
  if (method !== "GET") await ensurePersonSession(fetchImpl);
  try {
    return await send(path, project, options);
  } catch (error) {
    if (method === "GET" || error?.code !== "PERSON_REQUIRED" || options.renewed) throw error;
    await ensurePersonSession(fetchImpl, true);
    return send(path, project, { ...options, renewed: true });
  }
}

async function send(path, project, { method = "GET", body, fetchImpl = globalThis.fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(coreUrl(path, project), {
      method,
      credentials: "same-origin",
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
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
    const result = await corePost(postPath, project, body);
    await load({ quiet: true });
    return result;
  }, [project, load]);

  return { ...state, project, reload: () => load(), post, setData: (data) => setState({ status: emptyRef.current(data) ? "empty" : "ready", data, error: null }) };
}
