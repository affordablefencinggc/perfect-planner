import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { ViewModeToggle } from "../src/components/ViewModeToggle.jsx";
import { ImportedProjectWorkflowWorkspace } from "../src/components/ImportedProjectWorkflowWorkspace.jsx";
import { ProjectTruthGate } from "../src/components/ProjectTruthGate.jsx";
import { PerfectPlannerShell } from "../src/PerfectPlannerShell.jsx";
import { ProjectProvider } from "../src/project/ProjectProvider.jsx";
import { createMemoryStorage, createProjectRegistry } from "../src/project/projectRegistry.js";
import { createImportedProjectSession } from "../src/project/projectSession.js";
import {
  readStoredViewMode,
  useViewMode,
  VIEW_MODE_STORAGE_KEY,
  ViewModeProvider,
  writeStoredViewMode,
} from "../src/project/viewMode.js";
import { diagnosticSessionFixture } from "./diagnosticSessionFixture.js";

const AT = "2026-09-04T12:00:00.000Z";

afterEach(() => { cleanup(); window.localStorage.clear(); });

function importedProject() {
  const rootIdentity = "c".repeat(64);
  return createImportedProjectSession({
    name: "Live Customer App",
    adapter: "native",
    now: AT,
    registration: { access: "metadata-read-only", canonicalRoot: "C:\\private\\live-customer-app", registryRevision: 9, rootIdentity, workspaceId: "live-customer-app" },
    census: { digest: "d".repeat(64), fileCount: 463, generatedEpochMs: Date.parse(AT), registryRevision: 9, rootIdentity, skipped: [], totalBytesHashed: 4096, workspaceId: "live-customer-app" },
    discovery: { state: "generated", generatedAt: AT, counts: { observed: 1, signals: 1, unanswered: 6 }, categories: [{ id: "A01", state: "observed", findings: [{ id: "S001" }] }] },
  });
}

function ModeRoot({ children }) {
  const { mode } = useViewMode();
  return <div data-testid="root" data-view-mode={mode}>{children}</div>;
}

function renderWithMode(children) {
  return render(<ViewModeProvider><ModeRoot><ViewModeToggle />{children}</ModeRoot></ViewModeProvider>);
}

describe("Simple/Advanced view toggle", () => {
  test("defaults to Simple and persists a switch to Advanced", () => {
    renderWithMode(null);
    const simple = screen.getByRole("button", { name: "Simple" });
    const advanced = screen.getByRole("button", { name: "Advanced" });
    expect(screen.getByTestId("root").getAttribute("data-view-mode")).toBe("simple");
    expect(simple.getAttribute("aria-pressed")).toBe("true");
    expect(advanced.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(advanced);
    expect(screen.getByTestId("root").getAttribute("data-view-mode")).toBe("advanced");
    expect(advanced.getAttribute("aria-pressed")).toBe("true");
    expect(window.localStorage.getItem(VIEW_MODE_STORAGE_KEY)).toBe("advanced");

    cleanup();
    renderWithMode(null);
    expect(screen.getByTestId("root").getAttribute("data-view-mode")).toBe("advanced");

    fireEvent.click(screen.getByRole("button", { name: "Simple" }));
    expect(window.localStorage.getItem(VIEW_MODE_STORAGE_KEY)).toBe("simple");
  });

  test("unknown or unreadable stored values fall back to Simple", () => {
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, "expert");
    expect(readStoredViewMode()).toBe("simple");
    const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readStoredViewMode(throwing)).toBe("simple");
    expect(writeStoredViewMode("advanced", throwing)).toBe(false);
  });

  test("toggle buttons are keyboard reachable native buttons", () => {
    renderWithMode(null);
    const group = screen.getByRole("group", { name: "View detail level" });
    for (const button of within(group).getAllByRole("button")) {
      expect(button.tagName).toBe("BUTTON");
      expect(button.getAttribute("type")).toBe("button");
    }
  });

  test("technical detail is marked advanced-only while blockers and next actions stay visible", () => {
    const project = importedProject();
    const { container } = renderWithMode(<ImportedProjectWorkflowWorkspace workspace="plan" activeProject={project} onWorkspace={vi.fn()} />);
    const root = screen.getByTestId("root");
    expect(root.getAttribute("data-view-mode")).toBe("simple");

    const binding = container.querySelector(".imported-workflow-binding");
    expect(binding.classList.contains("advanced-only")).toBe(true);
    for (const code of container.querySelectorAll(".imported-workflow-requirement code")) expect(code.classList.contains("advanced-only")).toBe(true);
    const next = container.querySelector(".imported-workflow-next");
    expect(next.closest(".advanced-only")).toBeNull();
    expect(container.querySelector(".imported-workflow-caveats").closest(".advanced-only")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(root.getAttribute("data-view-mode")).toBe("advanced");
    // Switching view never changes the data shown, only how much detail is displayed.
    expect(container.querySelector(".imported-workflow-workspace").getAttribute("data-project-id")).toBe(project.projectId);
    expect(binding.textContent).toContain("Registry revision");
  });

  test("ProjectTruthGate marks identifier rows as advanced-only", () => {
    const project = importedProject();
    render(<ProjectTruthGate projectSession={project} provenance={{ field: "Name", value: project.name, digest: "d".repeat(64), revision: 9 }} defaultOpen />);
    const row = (field) => document.querySelector(`[data-provenance-field="${field}"]`);
    for (const field of ["project-id", "generation", "digest", "revision", "schema"]) expect(row(field).classList.contains("advanced-only")).toBe(true);
    for (const field of ["field", "value", "source", "timestamp"]) expect(row(field).classList.contains("advanced-only")).toBe(false);
  });

  test("the shell exposes the toggle in the top bar and sets data-view-mode on the app root", () => {
    const registry = createProjectRegistry({ storage: createMemoryStorage() });
    registry.upsert(importedProject(), { activate: true });
    window.history.replaceState({}, "", "/");
    const { container } = render(<ProjectProvider registry={registry}><PerfectPlannerShell diagnosticSession={diagnosticSessionFixture()} /></ProjectProvider>);
    const shell = container.querySelector(".app-shell");
    expect(shell.getAttribute("data-view-mode")).toBe("simple");
    const topbar = container.querySelector("header.topbar");
    fireEvent.click(within(topbar).getByRole("button", { name: "Advanced" }));
    expect(shell.getAttribute("data-view-mode")).toBe("advanced");
    expect(window.localStorage.getItem(VIEW_MODE_STORAGE_KEY)).toBe("advanced");
  });
});
