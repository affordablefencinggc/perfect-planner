import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PerfectPlannerShell } from "../src/PerfectPlannerShell.jsx";
import { ProjectProvider } from "../src/project/ProjectProvider.jsx";
import { createMemoryStorage, createProjectRegistry } from "../src/project/projectRegistry.js";
import { createImportedProjectSession, withProjectState } from "../src/project/projectSession.js";

const FIXED_TIME = "2026-09-04T04:00:00.000Z";

function importedProject({ name, rootCharacter, digestCharacter, fileCount }) {
  const workspaceId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return createImportedProjectSession({
    name,
    adapter: "native",
    now: FIXED_TIME,
    registration: {
      access: "metadata-read-only",
      canonicalRoot: `C:\\private\\acceptance\\${name}`,
      registryRevision: 7,
      rootIdentity: rootCharacter.repeat(64),
      workspaceId,
    },
    census: {
      digest: digestCharacter.repeat(64),
      fileCount,
      generatedEpochMs: Date.parse(FIXED_TIME),
      registryRevision: 7,
      rootIdentity: rootCharacter.repeat(64),
      skipped: [],
      totalBytesHashed: fileCount * 128,
      workspaceId,
    },
  });
}

function registryWith(...projects) {
  const registry = createProjectRegistry({
    storage: createMemoryStorage(),
    now: () => Date.parse(FIXED_TIME),
  });
  projects.forEach((project) => registry.upsert(project));
  return registry;
}

function renderShell(registry, url) {
  window.history.replaceState({}, "", url);
  return render(
    <ProjectProvider registry={registry} initialUrl={window.location.href}>
      <PerfectPlannerShell />
    </ProjectProvider>,
  );
}

function activeProjectTab(container) {
  return container.querySelector(".project-tabs button.active");
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: false,
    status: 503,
    json: async () => ({ error: "Authority unavailable in acceptance test" }),
  })));
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("PP-FOUNDATION-100 shell acceptance", () => {
  test("a fresh registry renders honest project-empty UI without PP-014 fixtures", async () => {
    const { container } = renderShell(registryWith(), "/?workspace=home");

    await screen.findByRole("heading", { name: "Bring in a real app to begin" });
    const stage = container.querySelector(".workspace-stage");
    expect(stage.textContent).toContain("Choose app folder");
    expect(stage.textContent).not.toContain("PP-014");
    expect(stage.textContent).not.toContain("PP-CLEANROOM");
    expect(stage.textContent).not.toContain("Resolve the collision-safe plan capsule");
    expect(container.querySelector('[data-project-kind="demo"]')).toBeNull();
    expect(activeProjectTab(container)?.textContent).toContain("No project selected");
  });

  test("fixture content returns only after the user explicitly opens the labelled Demo", async () => {
    const user = userEvent.setup();
    const { container } = renderShell(registryWith(), "/?workspace=home");

    await user.click(await screen.findByRole("button", { name: "Try the demo" }));
    await screen.findByRole("heading", { name: "Local Collaboration Workspace" });
    expect(container.querySelector(".workspace-stage").textContent).toContain("PP-014");
    expect(container.querySelector('.project-truth-gate[data-project-kind="demo"]')).toBeTruthy();
    expect(activeProjectTab(container)?.textContent).toMatch(/Perfect Planner Demo.*Demo/);
    expect(screen.getAllByText("Demo").length).toBeGreaterThan(0);
  });

  test("switching two imported projects replaces all active identity and census facts", async () => {
    const user = userEvent.setup();
    const alpha = importedProject({ name: "Alpha Acceptance App", rootCharacter: "a", digestCharacter: "1", fileCount: 3 });
    const beta = importedProject({ name: "Beta Acceptance App", rootCharacter: "b", digestCharacter: "2", fileCount: 8 });
    const { container } = renderShell(registryWith(alpha, beta), `/?project=${alpha.projectId}&workspace=home`);

    await screen.findByRole("heading", { name: "Alpha Acceptance App" });
    let stageText = container.querySelector(".workspace-stage").textContent;
    expect(stageText).toContain("3 files captured");
    expect(stageText).toContain("111111111111");
    expect(stageText).not.toContain("8 files captured");
    expect(container.querySelector(`.topbar-project-truth[data-project-id="${alpha.projectId}"]`)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Beta Acceptance App" }));
    await screen.findByRole("heading", { name: "Beta Acceptance App" });
    stageText = container.querySelector(".workspace-stage").textContent;
    expect(stageText).toContain("8 files captured");
    expect(stageText).toContain("222222222222");
    expect(stageText).not.toContain("3 files captured");
    expect(stageText).not.toContain("111111111111");
    expect(container.querySelector(`.topbar-project-truth[data-project-id="${beta.projectId}"]`)).toBeTruthy();
    expect(activeProjectTab(container)?.textContent).toContain("Beta Acceptance App");

    await user.click(screen.getByRole("button", { name: "Alpha Acceptance App" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Alpha Acceptance App" })).toBeTruthy());
    stageText = container.querySelector(".workspace-stage").textContent;
    expect(stageText).toContain("3 files captured");
    expect(stageText).not.toContain("8 files captured");
    expect(activeProjectTab(container)?.textContent).toContain("Alpha Acceptance App");
  });

  test("the URL selects the intended project and workspace from a persisted registry", async () => {
    const storage = createMemoryStorage();
    const alpha = importedProject({ name: "Persisted Alpha", rootCharacter: "c", digestCharacter: "3", fileCount: 13 });
    const beta = importedProject({ name: "Persisted Beta", rootCharacter: "d", digestCharacter: "4", fileCount: 21 });
    const writer = createProjectRegistry({ storage, now: () => Date.parse(FIXED_TIME) });
    writer.upsert(alpha);
    writer.upsert(beta);
    expect(writer.getSnapshot().activeProjectId).toBe(beta.projectId);

    const hydratedRegistry = createProjectRegistry({ storage, now: () => Date.parse(FIXED_TIME) });
    const { container } = renderShell(hydratedRegistry, `/?project=${alpha.projectId}&workspace=evidence`);

    await screen.findByRole("region", { name: "Persisted Alpha evidence workflow" });
    expect(hydratedRegistry.list()).toHaveLength(2);
    expect(hydratedRegistry.getSnapshot().activeProjectId).toBe(alpha.projectId);
    expect(activeProjectTab(container)?.textContent).toContain("Persisted Alpha");
    expect(container.querySelector(".workspace-stage").textContent).toContain("13 files · 0 skipped");
    expect(container.querySelector(".workspace-stage").textContent).not.toContain("21 files · 0 skipped");
    expect(window.location.search).toContain(`project=${alpha.projectId}`);
    expect(window.location.search).toContain("workspace=evidence");

    const persistedAgain = createProjectRegistry({ storage, now: () => Date.parse(FIXED_TIME) });
    expect(persistedAgain.getSnapshot().activeProjectId).toBe(alpha.projectId);
    expect(persistedAgain.get(alpha.projectId)?.view.workspace).toBe("evidence");
  });

  test("an unavailable project is explicit and offers a working return-to-intake action", async () => {
    const user = userEvent.setup();
    const imported = importedProject({ name: "Disconnected App", rootCharacter: "e", digestCharacter: "5", fileCount: 34 });
    const unavailable = withProjectState(imported, "unavailable", {
      now: "2026-09-04T05:00:00.000Z",
      reason: "workspace-authority-unavailable",
    });
    const { container } = renderShell(registryWith(unavailable), `/?project=${unavailable.projectId}&workspace=build`);

    await screen.findByRole("region", { name: "Build unavailable" });
    expect(container.querySelector(".project-truth-workspace-state--unavailable")?.textContent).toContain(
      "Build is blocked because the project authority is unavailable.",
    );
    expect(container.querySelector(`.topbar-project-truth[data-project-id="${unavailable.projectId}"]`)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Return to Structure" }));
    await screen.findByRole("region", { name: "Strict folder contract workspace" });
    expect(window.location.search).toContain("workspace=structure");
  });
});
