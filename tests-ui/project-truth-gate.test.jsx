import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectTruthGate } from "../src/components/ProjectTruthGate.jsx";

afterEach(() => cleanup());

const importedProject = {
  schemaVersion: 1,
  projectId: "project-alpha",
  displayName: "Alpha App",
  kind: "imported",
  state: "ready",
  generation: 3,
  canonicalRoot: "C:\\Users\\private\\alpha-app",
  workspace: { adapter: "tauri", registryRevision: 4, rootIdentity: "a".repeat(64) },
  census: { digest: "b".repeat(64), generatedAt: "2026-09-04T06:10:00.000Z" },
  updatedAt: "2026-09-04T06:11:00.000Z",
};

describe("ProjectTruthGate", () => {
  test("opens an accessible provenance dialog and returns focus on Escape", async () => {
    const user = userEvent.setup();
    render(<ProjectTruthGate
      projectSession={importedProject}
      provenance={{
        field: "Indexed files",
        value: 463,
        entity: "workspace-census",
        source: "native census receipt",
        revision: 4,
        authorityReason: "Exact registered root and census digest verified.",
      }}
    />);

    const trigger = screen.getByRole("button", { name: /Alpha App/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.textContent).toContain("project-alpha");
    expect(trigger.textContent).toContain("scan 3");
    expect(document.body.textContent).not.toContain(importedProject.canonicalRoot);

    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Identity and source" });
    expect(dialog).toBeTruthy();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Indexed files")).toBeTruthy();
    expect(screen.getByText("463")).toBeTruthy();
    expect(screen.getByText("workspace-census")).toBeTruthy();
    expect(screen.getByText("native census receipt")).toBeTruthy();
    expect(screen.getByText("project-alpha", { selector: "dd" })).toBeTruthy();
    expect(screen.getByText("tauri", { selector: "dd" })).toBeTruthy();
    expect(screen.getByText("b".repeat(64))).toBeTruthy();
    expect(screen.getByText("2026-09-04T06:10:00.000Z")).toBeTruthy();

    await waitFor(() => expect(screen.getByRole("button", { name: "Close project truth details" })).toBe(document.activeElement));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Identity and source" })).toBeNull();
    expect(trigger).toBe(document.activeElement);
  });

  test("shows an explicit Demo badge on the persistent identity and dialog", async () => {
    const user = userEvent.setup();
    render(<ProjectTruthGate projectSession={{ ...importedProject, projectId: "demo-pp-014", displayName: "Perfect Planner sample", kind: "demo" }} />);

    expect(screen.getByText("Demo")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Perfect Planner sample/ }));
    expect(screen.getByRole("dialog", { name: "Identity and source" })).toBeTruthy();
    expect(screen.getAllByText("Demo")).toHaveLength(2);
  });

  test.each([
    ["empty", null, "No project loaded", "Choose a project"],
    ["unavailable", { ...importedProject, state: "unavailable" }, "Native authority is offline.", "Reconnect"],
    ["stale", { ...importedProject, state: "stale" }, "The census changed after this view was generated.", "Refresh census"],
  ])("renders an honest %s workspace state and its configured action", async (state, projectSession, reason, actionLabel) => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<ProjectTruthGate
      projectSession={projectSession}
      workspaceLabel="Blueprint workspace"
      workspaceState={state}
      reason={reason}
      actionLabel={actionLabel}
      onAction={onAction}
    />);

    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Blueprint workspace");
    expect(status.textContent).toContain(reason);
    await user.click(screen.getByRole("button", { name: actionLabel }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  test("redacts absolute paths supplied through provenance values and reasons", async () => {
    const user = userEvent.setup();
    render(<ProjectTruthGate
      projectSession={{ ...importedProject, state: "unavailable", authorityReason: "Root C:\\Users\\private\\alpha-app is offline" }}
      provenance={{ field: "Root", value: "C:\\Users\\private\\alpha-app", source: "/home/private/alpha-app" }}
    />);

    await user.click(screen.getByRole("button", { name: /Alpha App/ }));
    expect(document.body.textContent).not.toContain("C:\\Users\\private");
    expect(document.body.textContent).not.toContain("/home/private");
    expect(screen.getAllByText(/Local path hidden/).length).toBeGreaterThanOrEqual(2);
  });

  test("keeps a label with a spaced slash instead of hiding it as a path", () => {
    render(<ProjectTruthGate workspaceState="ready" workspaceLabel="To-do / Ledger" />);
    expect(document.body.textContent).toContain("To-do / Ledger");
    expect(document.body.textContent).not.toContain("Local path hidden");
  });

  test("keeps workspace labels with a spaced slash separator readable (proverel-01)", () => {
    render(<ProjectTruthGate workspaceState="empty" workspaceLabel="To-do / Ledger" reason="Open /home/private/app and C:\\Users\\x" />);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("To-do / Ledger");
    expect(status.textContent).not.toContain("/home/private");
    expect(status.textContent).toContain("Local path hidden");
  });

  test("never presents a ready workspace when no project authority exists", () => {
    render(<ProjectTruthGate workspaceState="ready" workspaceLabel="Build workspace" />);

    expect(screen.getByRole("status").textContent).toContain("No active project has been selected.");
    expect(screen.getByRole("button", { name: /No active project/ }).getAttribute("data-project-state")).toBeNull();
    expect(screen.getByRole("button", { name: /No active project/ }).textContent).not.toContain("Current");
  });
});
