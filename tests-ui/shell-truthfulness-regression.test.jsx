import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PerfectPlannerShell } from "../src/PerfectPlannerShell.jsx";
import { ProjectProvider } from "../src/project/ProjectProvider.jsx";
import { createMemoryStorage, createProjectRegistry } from "../src/project/projectRegistry.js";
import { createImportedProjectSession, withProjectState } from "../src/project/projectSession.js";
import { diagnosticSessionFixture } from './diagnosticSessionFixture.js';

const FIXED_TIME = "2026-09-04T06:00:00.000Z";

function importedProject(name, rootCharacter, digestCharacter, fileCount = 5) {
  const workspaceId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return createImportedProjectSession({
    name,
    adapter: "native",
    now: FIXED_TIME,
    registration: {
      access: "metadata-read-only",
      canonicalRoot: `C:\\private\\truthfulness\\${name}`,
      registryRevision: 9,
      rootIdentity: rootCharacter.repeat(64),
      workspaceId,
    },
    census: {
      digest: digestCharacter.repeat(64),
      fileCount,
      generatedEpochMs: Date.parse(FIXED_TIME),
      registryRevision: 9,
      rootIdentity: rootCharacter.repeat(64),
      skipped: [],
      totalBytesHashed: fileCount * 256,
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
      <PerfectPlannerShell diagnosticSession={diagnosticSessionFixture(createMemoryStorage())} />
    </ProjectProvider>,
  );
}

function scenarioProject(state) {
  if (state === "empty") return null;
  const project = importedProject(`${state} truth project`, state === "imported" ? "a" : state === "stale" ? "b" : "c", state === "imported" ? "1" : state === "stale" ? "2" : "3");
  if (state === "imported") return project;
  return withProjectState(project, state, {
    now: "2026-09-04T07:00:00.000Z",
    reason: `${state}-authority-regression`,
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: false,
    status: 503,
    json: async () => ({ error: "Authority unavailable in truthfulness regression" }),
  })));
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("shared-shell truthfulness outside explicit Demo mode", () => {
  test.each(["empty", "imported", "stale", "unavailable"])(
    "%s chrome and Operations expose unavailable integrations instead of Demo facts",
    async (state) => {
      const user = userEvent.setup();
      const project = scenarioProject(state);
      const registry = project ? registryWith(project) : registryWith();
      const url = project ? `/?project=${project.projectId}&workspace=home` : "/?workspace=home";
      const { container } = renderShell(registry, url);

      if (project) await screen.findByRole("heading", { name: project.name });
      else await screen.findByRole("heading", { name: "Bring in a real app to begin" });

      const operations = screen.getByRole("button", { name: /Operations/ });
      expect(operations.textContent).toContain("branches unavailable");
      expect(operations.textContent).toContain("queue unavailable");
      await user.click(operations);

      await user.click(screen.getByRole("button", { name: "Branches & worktrees" }));
      expect(screen.getByRole("button", { name: "Inspect local Git" }).disabled).toBe(true);
      expect(screen.getByText("Git inspection requires a current registered project in the desktop app.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Copy observation" })).toBeNull();
      expect(container.querySelectorAll(".branch-table-row")).toHaveLength(0);

      await user.click(screen.getByRole("button", { name: "Merge queue" }));
      expect(screen.getByText("Merge queue unavailable")).toBeTruthy();
      expect(container.querySelector(".merge-conveyor")).toBeNull();

      await user.click(screen.getByRole("button", { name: "More actions" }));
      await user.click(screen.getByRole("button", { name: /MCP access/ }));
      expect(screen.getByText(/connection unverified/i)).toBeTruthy();

      const sharedText = `${container.querySelector(".topbar").textContent} ${container.querySelector(".ops-dock").textContent}`;
      expect(sharedText).not.toContain("PP-014");
      expect(sharedText).not.toContain("B07");
      expect(sharedText).not.toMatch(/\b3 (?:demo )?branches\b/i);
      expect(sharedText).not.toMatch(/\b1 (?:demo )?queued\b/i);
      expect(sharedText).not.toMatch(/\b\d+\s+(?:developers|agents|people)\b/i);
      expect(sharedText).not.toMatch(/MCP\s+(?:configured|connected|online|ready)/i);
      expect(sharedText).not.toContain("Build Agent A");
      expect(sharedText).not.toContain("Review Agent B");
      expect(sharedText).not.toContain("Demo fixtures");
    },
  );

  test("diagnostic rows follow the active project and never leak across a project switch", async () => {
    const user = userEvent.setup();
    const alpha = importedProject("Diagnostic Alpha", "d", "4", 11);
    const beta = importedProject("Diagnostic Beta", "e", "5", 17);
    const { container } = renderShell(registryWith(alpha, beta), `/?project=${alpha.projectId}&workspace=home`);

    await screen.findByRole("heading", { name: "Diagnostic Alpha" });
    await user.click(container.querySelector('.workspace-nav button[aria-label="Build"]'));
    await screen.findByRole("region", { name: "Diagnostic Alpha build workflow" });

    await user.click(screen.getByRole("button", { name: "Diagnostic Beta" }));
    await screen.findByRole("heading", { name: "Diagnostic Beta" });
    await user.click(container.querySelector('.workspace-nav button[aria-label="Prove"]'));
    await screen.findByRole("region", { name: "Diagnostic Beta integrity workflow" });

    await user.click(screen.getByRole("button", { name: /Operations/ }));
    let log = screen.getByRole("log", { name: "Application logs" });
    expect(log.textContent).toContain("home → integrity");
    expect(log.textContent).not.toContain("home → build");

    await user.click(screen.getByRole("button", { name: "Diagnostic Alpha" }));
    await screen.findByRole("region", { name: "Diagnostic Alpha build workflow" });
    await waitFor(() => {
      log = screen.getByRole("log", { name: "Application logs" });
      expect(log.textContent).toContain("home → build");
      expect(log.textContent).not.toContain("home → integrity");
    });
  });
});
