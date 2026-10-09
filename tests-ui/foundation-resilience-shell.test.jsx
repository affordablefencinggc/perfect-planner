import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PerfectPlannerShell } from "../src/PerfectPlannerShell.jsx";
import { createDemoProjectSession } from "../src/demo/demoProject.js";
import { ProjectProvider } from "../src/project/ProjectProvider.jsx";
import { createMemoryStorage, createProjectRegistry } from "../src/project/projectRegistry.js";
import { createImportedProjectSession, withProjectState } from "../src/project/projectSession.js";

const at = "2026-09-04T01:00:00.000Z";
const routes = ["home", "blueprint", "structure", "components", "plan", "collision", "allocation", "build", "integrity", "evidence", "ledger", "index"];

function imported(name, rootIdentity, digest, fileCount) {
  const workspaceId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return createImportedProjectSession({
    name,
    adapter: "native",
    now: at,
    registration: {
      access: "metadata-read-only",
      canonicalRoot: `C:\\private\\${name}`,
      registryRevision: 2,
      rootIdentity,
      workspaceId,
    },
    census: {
      digest,
      fileCount,
      generatedEpochMs: Date.parse(at),
      registryRevision: 2,
      rootIdentity,
      skipped: [],
      totalBytesHashed: fileCount * 100,
      workspaceId,
    },
  });
}

function registryWith(...projects) {
  const registry = createProjectRegistry({ storage: createMemoryStorage(), now: () => Date.parse(at) });
  projects.forEach((project) => registry.upsert(project));
  return registry;
}

function renderShell(registry, url) {
  window.history.replaceState({}, "", url);
  return render(<ProjectProvider registry={registry} initialUrl={window.location.href}><PerfectPlannerShell /></ProjectProvider>);
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: "Authority unavailable in UI test" }) })));
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("foundation resilience shell truth boundaries", () => {
  test.each(routes)("fresh %s route exposes an honest empty boundary with zero visible fixture leakage", async (route) => {
    const { container } = renderShell(registryWith(), `/?workspace=${route}`);
    await waitFor(() => expect(screen.getAllByText(/No (active )?project selected|No active project/i).length).toBeGreaterThan(0));
    expect(container.textContent).not.toContain("PP-014");
    expect(container.textContent).not.toContain("PP-CLEANROOM");
    expect(container.textContent).not.toContain("Local Collaboration Workspace");
    expect(container.textContent).not.toContain("Shared Sync Engine");
    expect(container.querySelectorAll(".project-tabs button.active")).toHaveLength(1);
  });

  test.each(routes)("imported %s route shows only the active imported identity and never Demo fixtures", async (route) => {
    const alpha = imported("Alpha App", "a".repeat(64), "1".repeat(64), 3);
    const registry = registryWith(alpha);
    const { container } = renderShell(registry, `/?project=${alpha.projectId}&workspace=${route}`);
    await waitFor(() => expect(screen.getAllByText("Alpha App").length).toBeGreaterThan(0));
    expect(container.querySelectorAll(`.project-truth-gate[data-project-id="${alpha.projectId}"]`).length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".project-tabs button.active")).toHaveLength(1);
    expect(container.querySelector(".project-tabs button.active")?.textContent).toContain("Alpha App");
    expect(container.textContent).not.toContain("PP-014");
    expect(container.textContent).not.toContain("PP-CLEANROOM");
    expect(container.textContent).not.toContain("Perfect Planner Demo");
  });

  test("provenance dialog exposes the active project, census digest, revision, adapter, and timestamp", async () => {
    const alpha = imported("Alpha App", "a".repeat(64), "1".repeat(64), 3);
    renderShell(registryWith(alpha), `/?project=${alpha.projectId}&workspace=components`);
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole("button", { name: /ACTIVE PROJECT.*Alpha App/i }))[0]);
    const dialog = screen.getByRole("dialog", { name: "Identity and source" });
    expect(dialog.textContent).toContain(alpha.projectId);
    expect(dialog.textContent).toContain("1".repeat(64));
    expect(dialog.textContent).toContain("native");
    expect(dialog.textContent).toContain("2");
    expect(dialog.textContent).toContain("2026-09-04");
  });

  test("Demo fixtures appear only while the explicitly labelled Demo project is active", async () => {
    const alpha = imported("Alpha App", "a".repeat(64), "1".repeat(64), 3);
    const demo = createDemoProjectSession({ now: at });
    const registry = registryWith(alpha, demo);
    registry.setActive(alpha.projectId);
    const { container } = renderShell(registry, `/?project=${alpha.projectId}&workspace=home`);
    const user = userEvent.setup();

    expect(container.textContent).not.toContain("PP-014");
    await user.click(screen.getByRole("button", { name: /Perfect Planner Demo.*Demo/i }));
    await waitFor(() => expect(container.textContent).toContain("PP-014"));
    expect(container.querySelectorAll('.project-truth-gate[data-project-kind="demo"]').length).toBeGreaterThan(0);
    expect(container.querySelector(".project-tabs button.active")?.textContent).toContain("Demo");

    await user.click(screen.getByRole("button", { name: "Alpha App" }));
    await waitFor(() => expect(container.textContent).not.toContain("PP-014"));
    expect(container.textContent).not.toContain("PP-CLEANROOM");
    expect(container.querySelector(".project-tabs button.active")?.textContent).toContain("Alpha App");
  });

  test("popstate changes both the route and the active project without cross-project counts", async () => {
    const alpha = imported("Alpha App", "a".repeat(64), "1".repeat(64), 3);
    const beta = imported("Beta App", "b".repeat(64), "2".repeat(64), 8);
    const registry = registryWith(alpha, beta);
    const { container } = renderShell(registry, `/?project=${beta.projectId}&workspace=structure`);

    await act(async () => {
      window.history.pushState({}, "", `/?project=${alpha.projectId}&workspace=evidence`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(screen.getByRole("region", { name: "Alpha App evidence workflow" })).toBeTruthy());
    expect(screen.getAllByText("Alpha App").length).toBeGreaterThan(0);
    expect(screen.getByText(/3 files · 0 skipped/)).toBeTruthy();
    expect(container.querySelector(".workspace-stage").textContent).not.toContain("8 files · 0 skipped");

    await act(async () => {
      window.history.pushState({}, "", `/?project=${beta.projectId}&workspace=components`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(screen.getByRole("region", { name: "Project component catalog start" })).toBeTruthy());
    expect(screen.getAllByText("Beta App").length).toBeGreaterThan(0);
    expect(screen.getByText("8 files")).toBeTruthy();
    expect(container.querySelector(".workspace-stage").textContent).not.toContain("3 files");
  });

  test.each([
    ["unavailable", "folder-permission-lost"],
    ["stale", "census-outdated"],
  ])("%s imported truth blocks downstream pages and exposes its reason", async (state, reason) => {
    const alpha = imported("Alpha App", "a".repeat(64), "1".repeat(64), 3);
    const affected = withProjectState(alpha, state, { now: "2026-09-04T02:00:00.000Z", reason });
    const { container } = renderShell(registryWith(affected), `/?project=${affected.projectId}&workspace=build`);
    await waitFor(() => expect(screen.getByRole("region", { name: "Build unavailable" })).toBeTruthy());
    expect(container.querySelector(`.project-truth-workspace-state--${state}`)).toBeTruthy();
    expect(screen.getAllByText(new RegExp(state, "i")).length).toBeGreaterThan(0);
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole("button", { name: /ACTIVE PROJECT.*Alpha App/i }))[0]);
    expect(screen.getByRole("dialog", { name: "Identity and source" }).textContent).toContain(reason);
  });
});
