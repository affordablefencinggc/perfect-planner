import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InspectorDrawer, PerfectPlannerShell } from "../src/PerfectPlannerShell.jsx";
import { BlueprintWorkspace } from "../src/components/BlueprintWorkspace.jsx";
import { ComponentPlansWorkspace } from "../src/components/ComponentPlansWorkspace.jsx";
import { ProjectProvider } from "../src/project/ProjectProvider.jsx";
import { createMemoryStorage, createProjectRegistry } from "../src/project/projectRegistry.js";
import { createDemoProjectSession } from "../src/demo/demoProject.js";
import { evidenceNodes, phases } from "../src/plannerWorkspaceData.js";
import { diagnosticSessionFixture } from "./diagnosticSessionFixture.js";

afterEach(() => { cleanup(); window.localStorage.clear(); vi.unstubAllGlobals(); });

function renderShell({ demo = true, route = "plan" } = {}) {
  const registry = createProjectRegistry({ storage: createMemoryStorage() });
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("workspace", route);
  if (demo) {
    const session = registry.upsert(createDemoProjectSession(), { activate: true });
    url.searchParams.set("project", session.projectId);
  }
  window.history.replaceState({}, "", `${url.pathname}${url.search}`);
  return render(<ProjectProvider registry={registry}><PerfectPlannerShell diagnosticSession={diagnosticSessionFixture()} /></ProjectProvider>);
}

describe("Demo controls are honest about being sample data", () => {
  test("a persistent badge marks the Demo, and only the Demo", () => {
    renderShell({ demo: true, route: "plan" });
    expect(screen.getByRole("status", { name: "Demo — sample data" })).toBeTruthy();
    cleanup();
    renderShell({ demo: false, route: "home" });
    expect(screen.queryByRole("status", { name: "Demo — sample data" })).toBeNull();
  });

  test("evidence ids never collide with plan package ids, so the inspector shows the clicked item", async () => {
    const planIds = new Set(phases.flatMap((phase) => phase.nodes.map((node) => node.id)));
    for (const node of evidenceNodes) expect(planIds.has(node.id)).toBe(false);
    const user = userEvent.setup();
    renderShell({ route: "evidence" });
    await user.click(within(screen.getByRole("group", { name: "Evidence views" })).getByRole("button", { name: /Screenshot proof/ }));
    await user.click(screen.getByRole("button", { name: /EV-01\s*Market map/ }));
    expect(screen.getByRole("heading", { name: /EV-01 · Market map/ })).toBeTruthy();
  });

  test("the sample orchestrator feed is labelled sample, with no unread pip or fake timestamps", async () => {
    const user = userEvent.setup();
    const { container } = renderShell({ route: "plan" });
    expect(container.querySelector(".orchestrator-message-pip")).toBeNull();
    const orchestrator = container.querySelector(".head-orchestrator-character");
    expect(orchestrator).toBeTruthy();
    await user.click(orchestrator);
    const feed = container.querySelector(".orchestrator-popover");
    expect(feed.textContent).toContain("sample");
    expect(feed.textContent).not.toMatch(/\blive\b/);
    expect(feed.textContent).not.toMatch(/\d\d:\d\d ·/);
  });

  test("allocation is labelled as a sample with example dates", () => {
    const { container } = renderShell({ route: "allocation" });
    expect(container.textContent).not.toContain("Live allocation");
    expect(container.textContent).toContain("Sample allocation");
    expect(container.querySelector(".today-line")).toBeNull();
  });

  test("Operations explains its blocker and the sample merge gate cannot pretend to run", async () => {
    const user = userEvent.setup();
    const { container } = renderShell({ route: "plan" });
    const handle = container.querySelector(".ops-handle");
    expect(handle.textContent).not.toMatch(/1 blocker/);
    expect(handle.textContent).toContain("collision check not connected");
    expect(container.querySelector(".ops-status-explained").getAttribute("title")).toMatch(/The collision check has not returned a saved record/);
    fireEvent.click(handle);
    await user.click(screen.getByRole("button", { name: /Merge queue/ }));
    const run = screen.getByRole("button", { name: /Run merge gate/ });
    expect(run.getAttribute("aria-disabled")).toBe("true");
    await user.click(run);
    expect(container.querySelector(".toast").textContent).toContain("there is no repository to merge");
    expect(run.closest(".merge-conveyor").textContent).toContain("Demo only — sample data");
  });

  test("sample plans and sample people cannot pretend to open", async () => {
    const user = userEvent.setup();
    const { container } = renderShell({ route: "plan" });
    await user.click(screen.getByRole("button", { name: "Open Repositories" }));
    const rows = container.querySelectorAll(".plan-row");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.disabled).toBe(true);
    expect(container.querySelector(".repository-drawer, aside")?.textContent ?? container.textContent).toContain("Demo only — sample data");
    expect(container.querySelector(".toast")).toBeNull();
  });

  test("the Demo inspector shows only what the sample item carries and cannot approve", () => {
    const node = phases[2].nodes[0];
    const onToast = vi.fn();
    const { container } = render(<InspectorDrawer open demoMode onClose={vi.fn()} selected={node} onToast={onToast} />);
    const dialog = screen.getByRole("dialog", { name: "Work item inspector" });
    expect(within(dialog).getByText(node.owner)).toBeTruthy();
    expect(within(dialog).getByText(node.branch)).toBeTruthy();
    // Worktree is laid out like a real task but never invented for a sample item.
    expect(within(dialog).getByText("Worktree").nextElementSibling.textContent).toBe("Not recorded in the sample");
    for (const invented of ["B04 · Architecture contract", "src/sync/plan.ts", "plan-registry:v2", "Wave 4", "NO-GO"]) expect(container.textContent).not.toContain(invented);
    const approve = within(dialog).getByRole("button", { name: /Approve next gate/ });
    expect(approve.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(approve);
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining("not recorded in the Demo"), "warning");
    expect(dialog.textContent).toContain("Demo only — sample data");
    expect(dialog.textContent).toContain("None of its checks are proven yet");
  });

  test("the Demo inspector says plainly when a field is not in the sample", () => {
    const { container } = render(<InspectorDrawer open demoMode onClose={vi.fn()} selected={{ id: "EV-02", title: "Sample", status: "ready" }} />);
    expect(container.textContent).toContain("Not recorded in the sample");
    expect(container.textContent).not.toContain("Danie");
  });

  test("the Demo blueprint never shows the sample debt scan as cleared and explains the locked entry", () => {
    const { container } = render(<BlueprintWorkspace onSelect={vi.fn()} onOpenStructure={vi.fn()} />);
    const debtGate = [...container.querySelectorAll(".blueprint-gate")].find((gate) => gate.textContent.includes("G-DEBT"));
    expect(debtGate.className).not.toContain("gate-clear");
    expect(debtGate.textContent).toContain("SAMPLE ONLY");
    expect(container.textContent).not.toMatch(/clippy/i);
    expect(container.textContent).not.toContain("All four required surfaces are covered");
    const enter = screen.getByRole("button", { name: /Enter planning spine/ });
    expect(enter.disabled).toBe(true);
    expect(enter.parentElement.textContent).toContain("Demo only — sample data");
  });

  test("the Demo component catalog cannot pretend to freeze a revision", () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: "unavailable in test" }) })));
    render(<ComponentPlansWorkspace activeProject={{ kind: "demo" }} />);
    const freeze = screen.getByRole("button", { name: /Freeze revision/ });
    expect(freeze.disabled).toBe(true);
    expect(freeze.parentElement.textContent).toContain("Demo only — sample data");
  });

  test("Demo canvas, calendar, ledger and merge queue stay consistent (proverel-12, 13, 16, 17, 27)", async () => {
    const user = userEvent.setup();
    try { window.sessionStorage.clear(); } catch { /* ignore */ }
    const { container, unmount } = renderShell({ route: "evidence" });
    const slider = screen.getByRole("slider", { name: /Journey time/ });
    fireEvent.change(slider, { target: { value: "100" } });
    expect(slider.getAttribute("aria-valuetext")).toBe("02 Sep 2026 · 18:00 AEST");
    fireEvent.change(slider, { target: { value: "0" } });
    expect(slider.getAttribute("aria-valuetext")).toBe("02 Sep 2026 · 08:00 AEST");
    expect(container.textContent).not.toMatch(/2[4-9]:00/);

    await user.click(within(screen.getByRole("group", { name: "Evidence views" })).getByRole("button", { name: /Screenshot proof/ }));
    const zoom = screen.getByRole("group", { name: "Canvas zoom" });
    const zoomIn = within(zoom).getByRole("button", { name: "Zoom in" });
    for (let step = 0; step < 6 && !zoomIn.disabled; step += 1) await user.click(zoomIn);
    expect(zoomIn.disabled).toBe(true);
    expect(zoom.textContent).toContain("120%");
    // The zoom controls are outside the scrolling canvas.
    expect(screen.getByRole("region", { name: "Screenshot proof canvas" }).contains(zoom)).toBe(false);
    unmount();

    // 27: the chosen Evidence view survives leaving the page.
    renderShell({ route: "evidence" });
    expect(screen.getByRole("group", { name: "Canvas zoom" })).toBeTruthy();
    cleanup();
    try { window.sessionStorage.clear(); } catch { /* ignore */ }

    const ledger = renderShell({ route: "ledger" });
    const register = within(ledger.container).getByRole("region", { name: "Source document register" });
    expect(register.textContent).not.toMatch(/\d+%/);
    expect(register.textContent).not.toContain("Danie + Codex");
    cleanup();

    const ops = renderShell({ route: "plan" });
    fireEvent.click(ops.container.querySelector(".ops-handle"));
    await user.click(screen.getByRole("button", { name: /Merge queue/ }));
    const conveyor = ops.container.querySelector(".merge-conveyor");
    expect(conveyor.querySelectorAll(".merge-station.complete")).toHaveLength(0);
    const stationText = [...conveyor.querySelectorAll(".merge-station")].map((station) => station.textContent);
    expect(stationText).toContain("READYB09");
    expect(stationText).toContain("BUILDINGB07");
    expect(stationText).toContain("PROOFB08");
  });
});

describe("Plan quick brief copy and demo drawer labels", () => {
  test("Copy handoff says so when the clipboard is unavailable instead of claiming Copied", async () => {
    vi.stubGlobal("navigator", { ...window.navigator, clipboard: undefined });
    renderShell({ demo: true, route: "plan" });
    fireEvent.click(screen.getByRole("button", { name: /Quick brief/ }));
    fireEvent.click(screen.getByRole("button", { name: "Copy handoff" }));
    expect(await screen.findByRole("button", { name: /Copy failed/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
  });

  test("Copy handoff reports Copied only after the clipboard write resolves", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...window.navigator, clipboard: { writeText } });
    renderShell({ demo: true, route: "plan" });
    fireEvent.click(screen.getByRole("button", { name: /Quick brief/ }));
    fireEvent.click(screen.getByRole("button", { name: "Copy handoff" }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(writeText).toHaveBeenCalledTimes(1);
  });
});
