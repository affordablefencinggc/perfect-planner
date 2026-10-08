import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Parent planning services are out of scope here: each check observes exactly the
// session's recorded architecture/folder/component heads. The planning service is idle.
const { checked } = vi.hoisted(() => {
  const head = (authority) => ({ contractDigest: authority.digest, revision: authority.revision });
  const service = (receipt) => ({ registry }) => ({
    refresh: async (id) => { const a = registry.get(id).authorities; return a.architecture ? { status: "observed", ...receipt(a, head) } : null; },
    subscribe: () => () => {}, invalidate() {}, dispose() {},
  });
  return { checked: {
    architecture: service((a, h) => ({ receipt: { head: h(a.architecture) } })),
    folder: service((a, h) => ({ receipt: { head: h(a.folder) }, architectureReceipt: { head: h(a.architecture) } })),
    component: service((a, h) => ({ receipt: { catalogHead: h(a.component), architectureHead: h(a.architecture), folderHead: h(a.folder) } })),
    plan: () => ({ refresh: async () => null, subscribe: () => () => {}, invalidate() {}, dispose() {} }),
  } };
});
vi.mock("../src/project/architectureRefresh.js", () => ({ createArchitectureRefresh: checked.architecture }));
vi.mock("../src/project/folderRefresh.js", () => ({ createFolderRefresh: checked.folder }));
vi.mock("../src/project/componentRefresh.js", () => ({ createComponentRefresh: checked.component }));
vi.mock("../src/project/planRefresh.js", () => ({ createPlanRefresh: checked.plan }));

import { PerfectPlannerShell } from "../src/PerfectPlannerShell.jsx";
import { ProjectProvider } from "../src/project/ProjectProvider.jsx";
import { createMemoryStorage, createProjectRegistry } from "../src/project/projectRegistry.js";
import { createProjectEntityId } from "../src/project/projectIds.js";
import { createImportedProjectSession, createProjectSession, projectAuthorityKinds } from "../src/project/projectSession.js";
import { readSection } from "../src/project/projectWorkRecords.js";
import { notePlanTaskDrift, recordPlanApproval } from "../src/project/planApproval.js";

const AT = "2026-10-03T09:00:00.000Z";

function session() {
  const rootIdentity = "5".repeat(64);
  const base = createImportedProjectSession({
    name: "Ready Home App",
    adapter: "native",
    now: AT,
    registration: { access: "metadata-read-only", canonicalRoot: "C:\\private\\ready-home", registryRevision: 2, rootIdentity, workspaceId: "ready-home" },
    census: { digest: "6".repeat(64), fileCount: 5, generatedEpochMs: Date.parse(AT), registryRevision: 2, rootIdentity, skipped: [], totalBytesHashed: 500, workspaceId: "ready-home" },
    discovery: {
      state: "generated", generatedAt: AT, counts: { observed: 8, signals: 0, unanswered: 0 },
      categories: Array.from({ length: 8 }, (_, index) => ({ id: `A${String(index + 1).padStart(2, "0")}`, state: "observed", findings: [{ id: `S${String(index + 1).padStart(3, "0")}` }] })),
    },
  });
  const types = { architecture: "map", folder: "folder", component: "component", plan: "plan" };
  const authorities = Object.fromEntries(projectAuthorityKinds.map((kind, index) => [kind, kind === "plan" ? null : {
    digest: String(index + 2).repeat(64), entityId: createProjectEntityId(base.projectId, types[kind], kind), recordedAt: AT, revision: index + 1, state: "authoritative",
  }]));
  return createProjectSession({ projectId: base.projectId, name: base.name, kind: base.kind, state: "generated", registration: base.registration, census: base.census, discovery: base.discovery, authorities, generation: base.generation + 1, createdAt: base.createdAt, updatedAt: AT, view: base.view });
}

const TASKS = [{ id: "T0001", title: "Add login form", description: "d", owner: "Dana", acceptance: "a", recovery: "r", claims: [], dependsOn: [], archived: false }];

function renderHome(project) {
  const registry = createProjectRegistry({ storage: createMemoryStorage(), now: () => Date.parse(AT) });
  registry.upsert(project);
  window.history.replaceState({}, "", `/?project=${project.projectId}&workspace=home`);
  return render(<ProjectProvider registry={registry} initialUrl={window.location.href}><PerfectPlannerShell /></ProjectProvider>);
}
const homeAction = (container) => container.querySelector("[data-home-next-action]");

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: "unavailable in test" }) })));
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });

test("without an approved plan Home sends the user to approve it on the Plan page", async () => {
  const user = userEvent.setup();
  const { container } = renderHome(session());
  await waitFor(() => expect(homeAction(container)?.dataset.homeNextAction).toBe("approve-plan"));
  expect(screen.getByLabelText("Current project stage").textContent).toContain("Plan approval required");
  await user.click(homeAction(container));
  expect(window.location.search).toContain("workspace=plan");
});

test("an approved plan reaches promotion and Confirm project is ready records Ready", async () => {
  const user = userEvent.setup();
  const project = session();
  await recordPlanApproval(project.projectId, { tasks: TASKS, censusDigest: project.census.digest });
  const { container } = renderHome(project);

  await waitFor(() => expect(homeAction(container)?.dataset.homeNextAction).toBe("confirm-project-ready"));
  expect(homeAction(container).textContent).toContain("Confirm project is ready");
  await user.click(homeAction(container));
  expect(readSection(project.projectId, "planAuthority").data.confirmedAt).toBeTruthy();
  await waitFor(() => expect(screen.getByLabelText("Current project stage").textContent).toContain("Project status ready"));
  expect(window.location.search).toContain("workspace=home");
});

test("tasks changed after approval show on Home instead of Ready", async () => {
  const project = session();
  await recordPlanApproval(project.projectId, { tasks: TASKS, censusDigest: project.census.digest });
  await notePlanTaskDrift(project.projectId, [{ ...TASKS[0], title: "Add sign-in form" }]);
  const { container } = renderHome(project);
  await waitFor(() => expect(homeAction(container)?.dataset.homeNextAction).toBe("reapprove-plan"));
  expect(screen.getByLabelText("Current project stage").textContent).toContain("Tasks changed since approval");
});
