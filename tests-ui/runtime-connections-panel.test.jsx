import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PerfectPlannerShell } from "../src/PerfectPlannerShell.jsx";
import { ProjectProvider } from "../src/project/ProjectProvider.jsx";
import {
  createMemoryStorage,
  createProjectRegistry,
} from "../src/project/projectRegistry.js";
import { createImportedProjectSession } from "../src/project/projectSession.js";
import {
  RUNTIME_CAPABILITY_RECEIPT_SCHEMA_VERSION,
  createRuntimeCapabilityReceipt,
} from "../src/runtime/runtimeCapabilities.js";

const NOW = "2026-09-04T04:00:00.000Z";

function importedProject() {
  return createImportedProjectSession({
    name: "Runtime truth project",
    adapter: "native",
    now: NOW,
    registration: {
      access: "metadata-read-only",
      canonicalRoot: "C:\\private\\runtime-truth-project",
      registryRevision: 3,
      rootIdentity: "a".repeat(64),
      workspaceId: "runtime-truth-project",
    },
    census: {
      digest: "b".repeat(64),
      fileCount: 12,
      generatedEpochMs: Date.parse(NOW),
      registryRevision: 3,
      rootIdentity: "a".repeat(64),
      skipped: [],
      totalBytesHashed: 2048,
      workspaceId: "runtime-truth-project",
    },
  });
}

function registryWith(project) {
  const registry = createProjectRegistry({
    storage: createMemoryStorage(),
    now: () => Date.parse(NOW),
  });
  if (project) registry.upsert(project);
  return registry;
}

function renderShell({ project = null, receipts = [] } = {}) {
  const url = project
    ? `/?project=${project.projectId}&workspace=home`
    : "/?workspace=home";
  window.history.replaceState({}, "", url);
  return render(
    <ProjectProvider
      registry={registryWith(project)}
      initialUrl={window.location.href}
    >
      <PerfectPlannerShell
        runtimeCapabilityReceipts={receipts}
        runtimeCapabilityNow={NOW}
      />
    </ProjectProvider>,
  );
}

function receipt(projectId, capabilityId, source, scopes, overrides = {}) {
  return createRuntimeCapabilityReceipt({
    capabilityId,
    denialReasons: [],
    expiresAt: "2026-09-04T04:10:00.000Z",
    health: "available",
    observedAt: "2026-09-04T03:59:00.000Z",
    projectId,
    receiptId: `rcpt_${capabilityId.replaceAll("-", "_")}_ui_001`,
    schemaVersion: RUNTIME_CAPABILITY_RECEIPT_SCHEMA_VERSION,
    scopes,
    source,
    ...overrides,
  });
}

async function openRuntimePanel(user) {
  await user.click(screen.getByRole("button", { name: "More actions" }));
  await user.click(
    screen.getByRole("button", { name: /Runtime & connections/ }),
  );
  return screen.findByRole("region", { name: "Runtime and connections" });
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: "Runtime authority unavailable" }),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("project-scoped Runtime & Connections surface", () => {
  test("missing-project connection setup opens Structure and closes the connection menu", async () => {
    const user = userEvent.setup();
    renderShell();
    const panel = await openRuntimePanel(user);
    await user.click(within(panel).getByRole("button", {name: "Choose an app folder"}));
    expect(new URL(window.location.href).searchParams.get("workspace")).toBe("structure");
    expect(screen.queryByRole("region", {name: "Runtime and connections"})).toBeNull();
    expect(await screen.findByRole("button", {name: "Choose app folder"})).toBeTruthy();
    expect(screen.queryByRole("textbox", {name: "IDE MCP configuration"})).toBeNull();
  });

  test("is reachable from More actions and fails all eight runtimes closed without a project", async () => {
    const user = userEvent.setup();
    const { container } = renderShell();
    const panel = await openRuntimePanel(user);

    expect(within(panel).getByText("No active project · 0 of 8 available")).toBeTruthy();
    expect(container.querySelectorAll("[data-runtime-capability]")).toHaveLength(8);
    expect(container.querySelectorAll(".runtime-health-unavailable")).toHaveLength(8);
    expect(container.querySelectorAll("[data-runtime-action]:disabled")).toHaveLength(8);
    expect(panel.textContent).toContain(
      "Select an active project before using runtime evidence",
    );
  });

  test("an allowed MCP context preference remains unavailable without a receipt", async () => {
    const user = userEvent.setup();
    const project = importedProject();
    renderShell({ project });
    const panel = await openRuntimePanel(user);
    const mcp = within(panel).getByRole("article", {
      name: "MCP runtime capability",
    });

    expect(mcp.className).toContain("runtime-health-unavailable");
    expect(mcp.textContent).toContain(
      "Context preference: allowed · receipt still required",
    );
    expect(mcp.textContent).toContain("No project-bound runtime receipt");
    expect(
      within(mcp).getByRole("button", {
        name: "Check MCP read eligibility",
      }).disabled,
    ).toBe(true);
    expect(mcp.textContent.toLowerCase()).not.toContain("connected");
  });

  test("only a current project-bound receipt grants scopes and enables its eligible action", async () => {
    const user = userEvent.setup();
    const project = importedProject();
    const browserReceipt = receipt(
      project.projectId,
      "browser",
      "browser-runtime-probe",
      ["read"],
    );
    const { container } = renderShell({ project, receipts: [browserReceipt] });
    const panel = await openRuntimePanel(user);
    const browser = within(panel).getByRole("article", {
      name: "Browser runtime capability",
    });

    expect(browser.className).toContain("runtime-health-available");
    expect(browser.textContent).toContain("read granted");
    expect(browser.textContent).toContain("content denied");
    expect(within(browser).getByText("browser-runtime-probe")).toBeTruthy();
    expect(
      within(browser).getByRole("button", {
        name: "Check browser evidence",
      }).disabled,
    ).toBe(false);
    expect(container.querySelectorAll("[data-runtime-action]:disabled")).toHaveLength(7);
    expect(within(panel).getByText(/1 of 8 available/)).toBeTruthy();
  });

  test("foreign and expired receipts render explicit reasons and keep actions disabled", async () => {
    const user = userEvent.setup();
    const project = importedProject();
    const foreignGit = receipt(
      "pp_foreign_runtime",
      "git",
      "git-runtime-probe",
      ["read", "content", "mutate"],
    );
    const expiredCi = receipt(
      project.projectId,
      "ci",
      "ci-run-receipt",
      ["execute"],
      { expiresAt: NOW },
    );
    renderShell({ project, receipts: [foreignGit, expiredCi] });
    const panel = await openRuntimePanel(user);
    const git = within(panel).getByRole("article", {
      name: "Git runtime capability",
    });
    const ci = within(panel).getByRole("article", {
      name: "CI runtime capability",
    });

    expect(git.className).toContain("runtime-health-incompatible");
    expect(git.textContent).toContain("Receipt belongs to a different project");
    expect(within(git).getByRole("button").disabled).toBe(true);
    expect(ci.className).toContain("runtime-health-stale");
    expect(ci.textContent).toContain("Receipt has expired");
    expect(within(ci).getByRole("button").disabled).toBe(true);
  });
});
