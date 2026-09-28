import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ImportedProjectWorkflowWorkspace } from "../src/components/ImportedProjectWorkflowWorkspace.jsx";
import { createProjectEntityId } from "../src/project/projectIds.js";
import { createImportedProjectSession, createProjectSession, projectAuthorityKinds } from "../src/project/projectSession.js";

const AT = "2026-09-04T12:00:00.000Z";

function importedProject({ authorities = false } = {}) {
  const rootIdentity = "c".repeat(64);
  const project = createImportedProjectSession({
    name: "Live Customer App",
    adapter: "native",
    now: AT,
    registration: {
      access: "metadata-read-only",
      canonicalRoot: "C:\\private\\live-customer-app",
      registryRevision: 9,
      rootIdentity,
      workspaceId: "live-customer-app",
    },
    census: {
      digest: "d".repeat(64),
      fileCount: 463,
      generatedEpochMs: Date.parse(AT),
      registryRevision: 9,
      rootIdentity,
      skipped: [],
      totalBytesHashed: 4096,
      workspaceId: "live-customer-app",
    },
    discovery: {
      state: "generated",
      generatedAt: AT,
      counts: { observed: 1, signals: 1, unanswered: 6 },
      categories: [
        { id: "A01", state: "observed", findings: [{ id: "S001" }] },
        { id: "A02", state: "signal", findings: [{ id: "S013" }] },
      ],
    },
  });
  if (!authorities) return project;
  const entityTypes = { architecture: "map", folder: "folder", component: "component", plan: "plan" };
  const authoritySet = Object.fromEntries(projectAuthorityKinds.map((kind, index) => [kind, {
    digest: String(index + 4).repeat(64),
    entityId: createProjectEntityId(project.projectId, entityTypes[kind], kind),
    recordedAt: AT,
    revision: index + 1,
    state: "authoritative",
  }]));
  return createProjectSession({
    projectId: project.projectId,
    name: project.name,
    kind: project.kind,
    state: "authoritative",
    registration: project.registration,
    census: project.census,
    discovery: project.discovery,
    authorities: authoritySet,
    generation: 2,
    createdAt: project.createdAt,
    updatedAt: "2026-09-04T12:01:00.000Z",
    view: project.view,
  });
}

afterEach(() => cleanup());

describe("ImportedProjectWorkflowWorkspace", () => {
  test.each([
    ["plan", "Planning intake"],
    ["collision", "Collision review"],
    ["allocation", "Allocation readiness"],
    ["build", "Build readiness"],
    ["evidence", "Evidence register"],
    ["integrity", "Integrity readiness"],
    ["ledger", "Project receipt ledger"],
    ["index", "Project evidence index"],
  ])("renders the %s route from one project-bound model", (workspace, heading) => {
    const project = importedProject();
    const { container } = render(<ImportedProjectWorkflowWorkspace workspace={workspace} activeProject={project} onWorkspace={vi.fn()} />);
    expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
    expect(container.querySelector(".imported-workflow-workspace").getAttribute("data-project-id")).toBe(project.projectId);
    expect(container.textContent).not.toContain("Build Agent A");
    expect(container.textContent).not.toContain("Perfect Planner sample");
  });

  test("renders a project-bound unanswered Plan instead of Demo fixtures", async () => {
    const user = userEvent.setup();
    const onWorkspace = vi.fn();
    const onSelect = vi.fn();
    const project = importedProject();
    const { container } = render(<ImportedProjectWorkflowWorkspace workspace="plan" activeProject={project} onWorkspace={onWorkspace} onSelect={onSelect} />);

    const region = screen.getByRole("region", { name: "Live Customer App plan workflow" });
    expect(region.getAttribute("data-project-id")).toBe(project.projectId);
    expect(region.getAttribute("data-page-state")).toBe("unanswered");
    expect(screen.getByRole("heading", { name: "Planning intake" })).toBeTruthy();
    expect(screen.getByText("EXPLICITLY UNANSWERED")).toBeTruthy();
    expect(screen.getByText("463 files", { exact: false })).toBeTruthy();
    expect(screen.getByText("Which runtime and framework are present?")).toBeTruthy();
    expect(screen.getByText("S013", { exact: false })).toBeTruthy();
    expect(container.textContent).not.toContain("C:\\private");
    expect(container.textContent).not.toContain("Build Agent A");
    expect(container.textContent).not.toContain("B01");
    expect(container.textContent).not.toContain("0 collisions");

    await user.click(screen.getByRole("button", { name: /A02 Runtime & framework/ }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "A02", title: "Runtime & framework", items: expect.arrayContaining(["Unanswered: Which runtime and framework are present?"]) }));

    await user.click(screen.getByRole("button", { name: "Open Structure" }));
    expect(onWorkspace).toHaveBeenCalledWith("structure");
  });

  test("states that collisions are not evaluated even when prerequisite authorities exist", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const project = importedProject({ authorities: true });
    const { container } = render(<ImportedProjectWorkflowWorkspace workspace="collision" activeProject={project} onWorkspace={vi.fn()} onSelect={onSelect} />);

    expect(screen.getByRole("heading", { name: "Collision review" })).toBeTruthy();
    expect(screen.getByText("collisions not evaluated")).toBeTruthy();
    expect(screen.getAllByText("A project-bound collision authority receipt is not represented by the current ProjectSession schema.")).toHaveLength(2);
    expect(container.textContent).not.toMatch(/0 collisions|collision-free|clear to build/i);

    await user.click(screen.getByRole("button", { name: "Review Collision evaluation" }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "COL-EVALUATION", status: "queued" }));
  });

  test("Ledger and Index search only current-project receipts and questions", async () => {
    const user = userEvent.setup();
    const project = importedProject();
    const first = render(<ImportedProjectWorkflowWorkspace workspace="ledger" activeProject={project} onWorkspace={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Project receipt ledger" })).toBeTruthy();
    const search = screen.getByPlaceholderText("Search this project’s recorded receipts and questions…");
    await user.type(search, "task ledger");
    expect(screen.getByText("Task ledger authority")).toBeTruthy();
    expect(screen.queryByText("Folder registration")).toBeNull();
    first.unmount();

    render(<ImportedProjectWorkflowWorkspace workspace="index" activeProject={project} onWorkspace={vi.fn()} />);
    const indexSearch = screen.getByPlaceholderText("Search this project’s recorded receipts and questions…");
    await user.type(indexSearch, "tenancy");
    expect(screen.getByText("Data, tenancy & auth")).toBeTruthy();
    expect(screen.getByText("Is the app single-tenant or multi-tenant?")).toBeTruthy();
    expect(screen.queryByText("App identity")).toBeNull();
  });
});
