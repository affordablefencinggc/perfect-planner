import { isProjectId } from "./projectIds.js";
import { projectWorkspaceNames } from "./projectSession.js";

const BASE = "http://perfect-planner.local";

function asUrl(value) {
  if (value instanceof URL) return new URL(value.href);
  return new URL(String(value ?? "/"), BASE);
}

export function readProjectSelection(urlLike) {
  const url = asUrl(urlLike);
  const projectId = url.searchParams.get("project");
  const workspace = url.searchParams.get("workspace");
  const phase = url.searchParams.get("phase");
  return Object.freeze({
    projectId: isProjectId(projectId) ? projectId : null,
    workspace: projectWorkspaceNames.includes(workspace) ? workspace : null,
    phase: phase && /^[a-zA-Z0-9._:-]{1,96}$/.test(phase) ? phase : null,
  });
}

export function withProjectSelection(urlLike, { projectId, workspace, phase } = {}) {
  const url = asUrl(urlLike);
  if (projectId == null) url.searchParams.delete("project");
  else if (isProjectId(projectId)) url.searchParams.set("project", projectId);
  else throw new TypeError("History project ID is invalid.");
  if (workspace == null) url.searchParams.delete("workspace");
  else if (projectWorkspaceNames.includes(workspace)) url.searchParams.set("workspace", workspace);
  else throw new TypeError("History workspace is invalid.");
  if (phase == null) url.searchParams.delete("phase");
  else if (typeof phase === "string" && /^[a-zA-Z0-9._:-]{1,96}$/.test(phase)) url.searchParams.set("phase", phase);
  else throw new TypeError("History phase is invalid.");
  return url;
}

export function projectHistoryHref(urlLike, selection) {
  const url = withProjectSelection(urlLike, selection);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function resolveProjectSelection(snapshot, urlLike) {
  const requested = readProjectSelection(urlLike);
  const ids = Array.isArray(snapshot?.projectOrder) ? snapshot.projectOrder : [];
  const projectId = requested.projectId && ids.includes(requested.projectId)
    ? requested.projectId
    : snapshot?.activeProjectId && ids.includes(snapshot.activeProjectId)
      ? snapshot.activeProjectId
      : ids[0] ?? null;
  const project = Array.isArray(snapshot?.projects) ? snapshot.projects.find((item) => item.projectId === projectId) ?? null : null;
  return Object.freeze({
    projectId,
    workspace: requested.workspace ?? project?.view?.workspace ?? "home",
    phase: requested.phase ?? project?.view?.phase ?? null,
    source: requested.projectId && requested.projectId === projectId ? "url" : projectId ? "registry" : "empty",
  });
}

export function createProjectHistoryState(currentState, selection) {
  const prior = currentState && typeof currentState === "object" && !Array.isArray(currentState) ? currentState : {};
  return Object.freeze({ ...prior, perfectPlanner: Object.freeze({
    projectId: selection?.projectId ?? null,
    workspace: selection?.workspace ?? "home",
    phase: selection?.phase ?? null,
  }) });
}
