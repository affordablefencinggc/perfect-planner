import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// One plan approval for every screen: the core ledger's person-signed
// plan.approved (GET /api/core/plan). Approving in Deep planning must show as
// approved on Home and on the Build page's "Plan approval" requirement, and the
// Plan page's approve must write that same core approval.
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
vi.mock("../../src/project/architectureRefresh.js", () => ({ createArchitectureRefresh: checked.architecture }));
vi.mock("../../src/project/folderRefresh.js", () => ({ createFolderRefresh: checked.folder }));
vi.mock("../../src/project/componentRefresh.js", () => ({ createComponentRefresh: checked.component }));
vi.mock("../../src/project/planRefresh.js", () => ({ createPlanRefresh: checked.plan }));

import { PerfectPlannerShell } from "../../src/PerfectPlannerShell.jsx";
import { PlanApprovalStep } from "../../src/components/PlanApprovalStep.jsx";
import { ProjectProvider } from "../../src/project/ProjectProvider.jsx";
import { createMemoryStorage, createProjectRegistry } from "../../src/project/projectRegistry.js";
import { createProjectEntityId } from "../../src/project/projectIds.js";
import { createImportedProjectSession, createProjectSession, projectAuthorityKinds } from "../../src/project/projectSession.js";
import { readSection, readWorkRecords } from "../../src/project/projectWorkRecords.js";
import { emptyTaskDraftLedger, taskDraftBinding, updateTaskDraft } from "../../src/project/taskDraftLedger.js";
import { corePost } from "../../src/core-screens/coreApi.js";

const AT = "2026-10-03T09:00:00.000Z";

function session() {
  const rootIdentity = "5".repeat(64);
  const base = createImportedProjectSession({
    name: "Core Plan App",
    adapter: "native",
    now: AT,
    registration: { access: "metadata-read-only", canonicalRoot: "C:\\private\\core-plan", registryRevision: 2, rootIdentity, workspaceId: "core-plan" },
    census: { digest: "6".repeat(64), fileCount: 5, generatedEpochMs: Date.parse(AT), registryRevision: 2, rootIdentity, skipped: [], totalBytesHashed: 500, workspaceId: "core-plan" },
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

const NOT_APPROVED = { approved: false, latest: null, count: 0, tasks: [] };
const APPROVED = { approved: true, latest: { plan: "P-1", entry: "L-000040", at: AT, by: "owner", summary: "Plan approved: Core plan app", source: "planning" }, count: 1, tasks: ["T-1", "T-2"] };

let core;
let calls;
function stubCore() {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
    const path = String(url);
    calls.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
    const ok = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
    if (path.startsWith("/api/core/session")) return ok({ person: true });
    if (path.startsWith("/api/core/plan/approve")) { core = APPROVED; return ok({ plan: "P-1", entry: "L-000040", approval: APPROVED }); }
    if (path.startsWith("/api/core/planning/approve")) { core = APPROVED; return ok({ plan: "P-1", entry: "L-000040", tasks: {} }); }
    if (path.startsWith("/api/core/plan?")) return ok(core);
    return { ok: false, status: 503, json: async () => ({ error: "unavailable in test" }) };
  }));
}

function renderShell(project, workspace) {
  const registry = createProjectRegistry({ storage: createMemoryStorage(), now: () => Date.parse(AT) });
  registry.upsert(project);
  window.history.replaceState({}, "", `/?project=${project.projectId}&workspace=${workspace}`);
  return render(<ProjectProvider registry={registry} initialUrl={window.location.href}><PerfectPlannerShell /></ProjectProvider>);
}
const homeAction = (container) => container.querySelector("[data-home-next-action]");
const planRequirement = (container) => container.querySelector('[data-requirement-id="AUTH-PLAN"]');

beforeEach(() => {
  localStorage.clear();
  core = NOT_APPROVED;
  stubCore();
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });

test("a plan approved in Deep planning is the approved plan on Home, and readiness can be confirmed", async () => {
  core = APPROVED;
  const user = userEvent.setup();
  const project = session();
  const { container } = renderShell(project, "home");
  await waitFor(() => expect(homeAction(container)?.dataset.homeNextAction).toBe("confirm-project-ready"));
  expect(screen.getByLabelText("Current project stage").textContent).not.toContain("Plan approval required");
  await user.click(homeAction(container));
  await waitFor(() => expect(screen.getByLabelText("Current project stage").textContent).toContain("Project status ready"));
  expect(readSection(project.projectId, "planReady").data).toMatchObject({ plan: "P-1", entry: "L-000040" });
});

test("the Build page's Plan approval requirement reads the core approval instead of Unanswered", async () => {
  core = APPROVED;
  const { container } = renderShell(session(), "build");
  await waitFor(() => expect(planRequirement(container)?.className).toContain("state-recorded"));
  expect(planRequirement(container).textContent).toContain("P-1");
  expect(planRequirement(container).textContent).not.toContain("Unanswered");
  // The Build board says the plan is approved instead of "No approved plan yet".
  expect(await screen.findByText(/Plan P-1 is approved/)).toBeTruthy();
  expect(screen.queryByText(/No approved plan yet/)).toBeNull();
});

test("without a core approval the plan stays unapproved, and approving in Deep planning updates Home without a reload", async () => {
  const project = session();
  const { container } = renderShell(project, "home");
  await waitFor(() => expect(homeAction(container)?.dataset.homeNextAction).toBe("approve-plan"));
  expect(screen.getByLabelText("Current project stage").textContent).toContain("Plan approval required");
  await act(async () => { await corePost("/planning/approve", "default", {}); });
  await waitFor(() => expect(homeAction(container)?.dataset.homeNextAction).toBe("confirm-project-ready"));
});

const draft = (title) => ({ id: null, title, description: `${title} in detail`, owner: "Dana", acceptance: "It works", recovery: "Revert", claims: [{ access: "write", path: "src/app.js" }], dependsOn: [], archived: false });

test("approving on the Plan page writes the same core approval", async () => {
  const user = userEvent.setup();
  const project = session();
  const ledger = updateTaskDraft(emptyTaskDraftLedger(taskDraftBinding(project)), draft("Add login form"));
  const store = { read: vi.fn(async () => ledger), subscribe: () => () => {} };
  render(<PlanApprovalStep project={project} records={readWorkRecords(project.projectId)} store={store} onWorkspace={vi.fn()} />);
  await user.click(await screen.findByRole("button", { name: "Approve this plan" }));
  await screen.findByText(/Plan approved with 1 task/);
  const post = calls.find((call) => call.path.startsWith("/api/core/plan/approve"));
  expect(post).toMatchObject({ method: "POST", body: { tasks: [{ id: "T0001", title: "Add login form" }] } });
  expect(readSection(project.projectId, "planAuthority").data.taskIds).toEqual(["T0001"]);
});

test("a core refusal on the Plan page saves nothing locally and says why", async () => {
  const user = userEvent.setup();
  const project = session();
  const ledger = updateTaskDraft(emptyTaskDraftLedger(taskDraftBinding(project)), draft("Add login form"));
  const store = { read: vi.fn(async () => ledger), subscribe: () => () => {} };
  const base = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (url, init) => String(url).startsWith("/api/core/plan/approve")
    ? { ok: false, status: 409, json: async () => ({ ok: false, code: "BLOCKERS_OPEN", message: "The plan cannot be approved yet: 1 blocking question is still open (Q-1). Answer it in Deep planning first." }) }
    : base(url, init)));
  render(<PlanApprovalStep project={project} records={readWorkRecords(project.projectId)} store={store} onWorkspace={vi.fn()} />);
  await user.click(await screen.findByRole("button", { name: "Approve this plan" }));
  expect((await screen.findByRole("alert")).textContent).toContain("1 blocking question is still open (Q-1)");
  expect(readSection(project.projectId, "planAuthority")).toBeNull();
});
