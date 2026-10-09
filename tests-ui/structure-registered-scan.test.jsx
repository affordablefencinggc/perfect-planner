import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { StructureWorkspace } from "../src/components/StructureWorkspace.jsx";
import { createImportedProjectSession } from "../src/project/projectSession.js";

// Gap 6: a project registered from an earlier 764-file scan must not look as if nothing was imported.
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: "Local registry unavailable in static mode" }) })));
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const root = "b".repeat(64);
const digest = "c".repeat(64);
function registeredProject(adapter) {
  return createImportedProjectSession({
    name: "perfect-planner",
    adapter,
    registration: { workspaceId: "ws_pp", registryRevision: 1, rootIdentity: root, access: "metadata-read-only", canonicalRoot: adapter === "browser" ? "browser://perfect-planner/abc" : "C:\\repos\\perfect-planner" },
    census: { workspaceId: "ws_pp", registryRevision: 1, rootIdentity: root, digest, fileCount: 764, generatedAt: "2026-10-09T08:00:00.000Z", skipped: [] },
    discovery: {
      state: "generated",
      counts: { observed: 8, signals: 5, unanswered: 1 },
      categories: [{ id: "A01", state: "observed", findings: [{ id: "S001" }, { id: "S010" }] }],
    },
    now: Date.parse("2026-10-09T08:00:00.000Z"),
  });
}

const adapter = (mode) => ({
  mode,
  selectWorkspaceFolder: vi.fn(),
  rememberedFolder: vi.fn(async () => ({ remembered: false, open: false, name: null })),
  registerWorkspaceReadOnly: vi.fn(),
  censusRegisteredWorkspace: vi.fn(),
});

describe("Structure for a project registered from an earlier scan", () => {
  for (const mode of ["browser", "native"]) {
    test(`shows the saved scan instead of an empty intake (${mode})`, async () => {
      render(<StructureWorkspace activeProject={registeredProject(mode)} workspaceAdapter={adapter(mode)} />);
      const metrics = document.querySelector(".structure-metrics");
      expect(metrics.textContent).toContain("764");
      expect(metrics.textContent).not.toMatch(/\b0\s*indexed files/i);
      expect(metrics.textContent).toMatch(/8\s*observed facts/);
      expect(metrics.textContent).toMatch(/5\s*review signals/);

      const map = screen.getByRole("region", { name: "Progressive app discovery map" });
      expect(map.textContent).not.toContain("Empty until a folder is indexed");
      expect(map.textContent).toContain("Scanned earlier: 764 files. Scan again to see live details.");

      const steps = within(screen.getByRole("list", { name: "App intake progress" })).getAllByRole("listitem");
      expect(steps.slice(0, 3).map((step) => step.className)).toEqual(["complete", "complete", "complete"]);
      expect(document.querySelector(".intake-state").textContent).toMatch(/scanned earlier/i);
      expect(document.querySelector(".intake-state").textContent).not.toMatch(/idle/i);
    });
  }

  test("a demo or brand-new project still starts empty", () => {
    render(<StructureWorkspace activeProject={null} workspaceAdapter={adapter("browser")} />);
    const map = screen.getByRole("region", { name: "Progressive app discovery map" });
    expect(map.textContent).toContain("Empty until a folder is indexed");
    expect(document.querySelector(".intake-state").textContent).toMatch(/idle/);
  });
});
