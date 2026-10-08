import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PlanApprovalStep } from "../src/components/PlanApprovalStep.jsx";
import { ImportedProjectWorkflowWorkspace } from "../src/components/ImportedProjectWorkflowWorkspace.jsx";
import { createProjectEntityId } from "../src/project/projectIds.js";
import { createImportedProjectSession, createProjectSession, projectAuthorityKinds } from "../src/project/projectSession.js";
import { readSection, readWorkRecords, workRecordsKey } from "../src/project/projectWorkRecords.js";
import { emptyTaskDraftLedger, taskDraftBinding, updateTaskDraft } from "../src/project/taskDraftLedger.js";

const AT = "2026-10-02T09:00:00.000Z";

function session() {
  const rootIdentity = "7".repeat(64);
  const base = createImportedProjectSession({
    name: "Approval Step App",
    adapter: "native",
    now: AT,
    registration: { access: "metadata-read-only", canonicalRoot: "C:\\private\\approval-step", registryRevision: 3, rootIdentity, workspaceId: "approval-step" },
    census: { digest: "8".repeat(64), fileCount: 9, generatedEpochMs: Date.parse(AT), registryRevision: 3, rootIdentity, skipped: [], totalBytesHashed: 900, workspaceId: "approval-step" },
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

const draft = (title) => ({ id: null, title, description: `${title} in detail`, owner: "Dana", acceptance: "It works", recovery: "Revert", claims: [{ access: "write", path: "src/app.js" }], dependsOn: [], archived: false });

function fakeStore(initial) {
  let ledger = initial, listener = null;
  return {
    read: vi.fn(async () => ledger),
    subscribe: (_binding, fn) => { listener = fn; return () => { listener = null; }; },
    change(next) { ledger = next; listener?.(); },
  };
}

const live = (project) => readWorkRecords(project.projectId);

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });

describe("PlanApprovalStep", () => {
  test("approves the saved tasks, then flags later task changes", async () => {
    const user = userEvent.setup();
    const project = session();
    const binding = taskDraftBinding(project);
    const first = updateTaskDraft(updateTaskDraft(emptyTaskDraftLedger(binding), draft("Add login form")), draft("Store sessions"));
    const store = fakeStore(first);
    const view = render(<PlanApprovalStep project={project} records={live(project)} store={store} onWorkspace={vi.fn()} />);

    expect(await screen.findByText("Add login form")).toBeTruthy();
    expect(screen.getByText(/No plan is approved yet/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Approve this plan" }));
    expect(await screen.findByText(/Plan approved with 2 tasks/)).toBeTruthy();

    const saved = readSection(project.projectId, "planAuthority");
    expect(saved.data).toMatchObject({ taskIds: ["T0001", "T0002"], taskCount: 2, source: "local-approval", censusDigest: project.census.digest });
    expect(saved.data.planDigest).toMatch(/^[0-9a-f]{64}$/);

    view.rerender(<PlanApprovalStep project={project} records={live(project)} store={store} onWorkspace={vi.fn()} />);
    expect(screen.getByText(/2 tasks approved/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve the current tasks" }).disabled).toBe(true);

    // The workspace-level watcher records that the tasks changed after approval.
    const watcherStore = fakeStore(first);
    const { usePlanTaskDriftWatch } = await import("../src/project/usePlanApproval.js");
    function Watcher() { usePlanTaskDriftWatch(project, live(project), { store: watcherStore }); return null; }
    render(<Watcher />);
    await waitFor(() => expect(watcherStore.read).toHaveBeenCalled());
    await act(async () => watcherStore.change(updateTaskDraft(first, { ...first.tasks[0], title: "Add sign-in form" })));
    await waitFor(() => expect(readSection(project.projectId, "planAuthority").data.tasksChangedAt).toBeTruthy());

    view.rerender(<PlanApprovalStep project={project} records={live(project)} store={store} onWorkspace={vi.fn()} />);
    expect(screen.getByText(/Tasks changed since approval/)).toBeTruthy();
  });

  test("refuses to approve when there are no saved tasks and points to the Ledger", async () => {
    const user = userEvent.setup();
    const project = session();
    const onWorkspace = vi.fn();
    render(<PlanApprovalStep project={project} records={live(project)} store={fakeStore(emptyTaskDraftLedger(taskDraftBinding(project)))} onWorkspace={onWorkspace} />);
    expect(await screen.findByText(/There are no saved tasks yet/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve this plan" }).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: /Edit tasks in the Ledger/ }));
    expect(onWorkspace).toHaveBeenCalledWith("ledger");
    expect(localStorage.getItem(workRecordsKey(project.projectId))).toBeNull();
  });
});

describe("Next honest action on the page that owns the requirement", () => {
  test("Plan focuses its own approval panel instead of navigating to Plan", async () => {
    const user = userEvent.setup();
    const onWorkspace = vi.fn(), onSelect = vi.fn();
    const project = session();
    render(<ImportedProjectWorkflowWorkspace workspace="plan" activeProject={project} onWorkspace={onWorkspace} onSelect={onSelect} />);
    const panel = screen.getByRole("region", { name: "Approve this plan" });
    await user.click(screen.getByRole("button", { name: "Review Plan authority" }));
    expect(onWorkspace).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(panel);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "AUTH-PLAN" }));
  });
});
