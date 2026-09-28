import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { BlueprintWorkspace } from "../src/components/BlueprintWorkspace.jsx";
import { createDemoProjectSession } from "../src/demo/demoProject.js";
import { createImportedProjectSession, createProjectSession } from "../src/project/projectSession.js";

const observedAt = "2026-09-04T03:00:00.000Z";

function importedProject() {
  return createImportedProjectSession({
    name: "Atlas App",
    adapter: "native",
    now: observedAt,
    registration: {
      access: "metadata-read-only",
      canonicalRoot: "C:\\private\\customer-work\\Atlas App",
      registryRevision: 7,
      rootIdentity: "a".repeat(64),
      workspaceId: "atlas-app",
    },
    census: {
      digest: "b".repeat(64),
      fileCount: 42,
      generatedEpochMs: Date.parse(observedAt),
      registryRevision: 7,
      rootIdentity: "a".repeat(64),
      skipped: [{ reason: "permission-denied" }, { reason: "too-large" }],
      totalBytesHashed: 4096,
      workspaceId: "atlas-app",
    },
    discovery: {
      categories: [
        { id: "A01", state: "observed", findings: [{ id: "S001" }] },
        { id: "A02", state: "signal", findings: [{ id: "S013" }] },
        { id: "A03", state: "unanswered", findings: [] },
        { id: "A04", state: "unanswered", findings: [] },
        { id: "A05", state: "unanswered", findings: [] },
        { id: "A06", state: "unanswered", findings: [] },
        { id: "A07", state: "unanswered", findings: [] },
        { id: "A08", state: "unanswered", findings: [] },
      ],
      counts: { observed: 1, signals: 1, unanswered: 6 },
    },
  });
}

afterEach(() => cleanup());

describe("Blueprint workspace imported-project truth boundary", () => {
  test("keeps the existing Demo blueprint when no real project or an explicit Demo project is supplied", () => {
    const props = { onSelect: vi.fn(), onOpenStructure: vi.fn() };
    const { container, rerender } = render(<BlueprintWorkspace {...props} />);

    expect(screen.getByRole("heading", { name: "Blueprint Gate" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Blueprint gate status" })).toBeTruthy();
    expect(container.querySelector(".imported-blueprint-workspace")).toBeNull();

    rerender(<BlueprintWorkspace {...props} activeProject={createDemoProjectSession({ now: observedAt })} />);
    expect(screen.getByRole("heading", { name: "Blueprint Gate" })).toBeTruthy();
    expect(container.querySelectorAll(".blueprint-gate")).toHaveLength(4);
    expect(container.querySelector(".imported-blueprint-workspace")).toBeNull();
  });

  test("renders only persisted census and discovery receipts plus explicit review questions", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onOpenStructure = vi.fn();
    const project = importedProject();
    const { container } = render(<BlueprintWorkspace activeProject={project} onSelect={onSelect} onOpenStructure={onOpenStructure} />);

    expect(screen.getByRole("region", { name: "Atlas App blueprint evidence" }).getAttribute("data-project-id")).toBe(project.projectId);
    expect(screen.getByRole("heading", { name: "Atlas App" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Observed project facts" }).textContent).toContain("42 files indexed");
    expect(screen.getByRole("region", { name: "Observed project facts" }).textContent).toContain("17 open review questions · 6 areas without metadata findings");
    expect(screen.getByRole("region", { name: "Observed project facts" }).textContent).toContain("2 skipped");
    expect(screen.getByRole("region", { name: "Observed project facts" }).textContent).toContain("4.0 KB hashed");
    expect(screen.getByRole("region", { name: "Observed project facts" }).textContent).toContain("bbbbbbbbbbbb…");
    expect(screen.getByText("S001", { exact: false })).toBeTruthy();
    expect(screen.getByText("S013", { exact: false })).toBeTruthy();
    expect(screen.getByText("Is the app single-tenant or multi-tenant?")).toBeTruthy();
    expect(screen.getAllByText("Observed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Needs review").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("C:\\private\\customer-work");
    expect(container.textContent).not.toContain("Template & compatibility");
    // Available authoring choices are not observed project facts or selections.
    expect(screen.getByRole("region", { name: "Observed project facts" }).textContent).not.toContain("AI autopilot");
    expect(container.querySelector(".imported-review-grid").textContent).not.toContain("AI autopilot");
    expect(screen.getByLabelText("Architecture template").value).toBe("");
    expect(screen.getByRole("button", { name: "Publish architecture" }).disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: /Runtime & framework/ }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
      id: "A02",
      title: "Runtime & framework",
      status: "active",
      items: expect.arrayContaining(["Provenance: Needs review", "Finding receipts: S013", "Review question: Which runtime and framework are present?"]),
    }));

    await user.click(screen.getByRole("button", { name: "Open Structure evidence" }));
    expect(onOpenStructure).toHaveBeenCalledTimes(1);
  });

  test("shows unavailable rather than zero or invented architecture when a generated session has no receipts", () => {
    const project = createProjectSession({
      name: "Generated Draft",
      kind: "generated",
      state: "generated",
      now: observedAt,
    });
    const { container } = render(<BlueprintWorkspace activeProject={project} onSelect={vi.fn()} onOpenStructure={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Generated Draft" })).toBeTruthy();
    expect(screen.getByText("No redacted workspace registration receipt is present.")).toBeTruthy();
    expect(screen.getByText("No authoritative metadata census receipt is present.")).toBeTruthy();
    expect(screen.getByText("No sanitized discovery snapshot is present.")).toBeTruthy();
    expect(screen.getAllByText("No authority receipt recorded")).toHaveLength(4);
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(4);
    expect(container.textContent).not.toMatch(/0 files indexed/i);
    expect(container.textContent).not.toContain("exact architecture template");
    expect(container.textContent).not.toContain("Seven-stage top-down architecture map");
  });
});
