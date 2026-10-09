import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { PerfectPlannerShell } from "../src/PerfectPlannerShell.jsx";
import { ProjectProvider } from "../src/project/ProjectProvider.jsx";
import { createMemoryStorage, createProjectRegistry } from "../src/project/projectRegistry.js";
import { createDemoProjectSession, DEMO_PROJECT_ID } from "../src/demo/demoProject.js";
import { createRuntimeEventLedger, DEFAULT_RUNTIME_EVENT_STORAGE_KEY } from "../src/runtime/runtimeEventLedger.js";
import { diagnosticSessionFixture } from './diagnosticSessionFixture.js';

afterEach(() => { cleanup(); window.localStorage.clear(); });

function renderDemoShell() {
  const registry = createProjectRegistry({ storage: createMemoryStorage() });
  const demo = registry.upsert(createDemoProjectSession(), { activate: true });
  const url = new URL(window.location.href);
  url.searchParams.set("project", demo.projectId);
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  const diagnosticSession = diagnosticSessionFixture();
  return { ...render(<ProjectProvider registry={registry}><PerfectPlannerShell diagnosticSession={diagnosticSession} /></ProjectProvider>), registry, demo, diagnosticSession };
}

describe("Perfect Planner shell interaction and accessibility", () => {
  test("Operations explains stale diagnostic writes without claiming newer history was erased", async () => {
    const { container } = renderDemoShell();
    const newer = createRuntimeEventLedger({ storage: window.localStorage });
    newer.append({ projectId: DEMO_PROJECT_ID, generation: 1, adapter: "fixture", source: "test", severity: "info", eventId: "evt_new_instance", message: "Newer instance event" });
    const saved = window.localStorage.getItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY);
    act(() => window.dispatchEvent(new ErrorEvent("error", { message: "Late old instance event" })));
    fireEvent.click(container.querySelector(".ops-handle"));
    expect(await screen.findByText(/Older diagnostic history changed or could not be read/)).toBeTruthy();
    expect(window.localStorage.getItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY)).toBe(saved);
    expect(screen.getByRole("button", { name: "Export diagnostics" }).disabled).toBe(false);
  });
  test("notifications default to neutral and older timers cannot erase a new clipboard warning", async () => {
    window.history.replaceState({}, "", "/?workspace=plan");
    const { container } = renderDemoShell();
    fireEvent.click(container.querySelector(".project-tabs button"));
    await waitFor(() => expect(container.querySelector(".toast-neutral")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(container.querySelector(".toast")).toBeNull();
    fireEvent.click(container.querySelector(".ops-handle"));
    const paste = await screen.findByRole("button", { name: "Paste", exact: true });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: vi.fn(async () => { throw new Error("Denied fixture"); }) } });
    vi.useFakeTimers();
    try {
      await act(async () => fireEvent.click(paste));
      expect(container.querySelector(".toast-warning").textContent).toContain("Clipboard read was blocked");
      act(() => vi.advanceTimersByTime(5500));
      await act(async () => fireEvent.click(paste));
      act(() => vi.advanceTimersByTime(500));
      expect(container.querySelector(".toast-warning")).toBeTruthy();
      act(() => vi.advanceTimersByTime(5500));
      expect(container.querySelector(".toast")).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  test("navigates the staged journey, synchronizes deep links, and keeps Allocation blocked", async () => {
    window.history.replaceState({}, "", "/?workspace=plan");
    const user = userEvent.setup(); renderDemoShell();
    expect(await screen.findByRole("region", { name: "Plan workspace" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Coordinate pages" })).toBeTruthy();
    const pages = screen.getByRole("navigation", { name: "Coordinate pages" });
    // Coordinate pages use the same tab row in the context strip as every other stage.
    expect(pages.closest(".workspace-context")).toBeTruthy();
    expect(within(pages).getByRole("button", { name: "Plan", exact: true }).getAttribute("aria-current")).toBe("page");
    await user.click(screen.getByRole("button", { name: "Allocation" }));
    expect(await screen.findByRole("region", { name: "Allocation workspace" })).toBeTruthy();
    expect(window.location.search).toContain("workspace=allocation");
    expect(screen.getByText(/Collision gate locked/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Create branches unavailable/ }).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Index" }));
    expect(await screen.findByRole("region", { name: "Project index" })).toBeTruthy();
    expect(window.location.search).toContain("workspace=index");
    await user.click(screen.getByRole("button", { name: "Close project index" }));
    expect(await screen.findByRole("region", { name: "Project Home workspace" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Drop your app/ }));
    expect(await screen.findByRole("region", { name: "Strict folder contract workspace" })).toBeTruthy();
    expect(window.location.search).toContain("workspace=structure");
    await user.click(screen.getByRole("button", { name: "Build" }));
    expect(await screen.findByRole("region", { name: "Build workspace" })).toBeTruthy();
    expect(window.location.search).toContain("workspace=build");
  });

  test("edge drawers start concealed and remain keyboard-operable", async () => {
    window.history.replaceState({}, "", "/?workspace=plan");
    const user = userEvent.setup(); renderDemoShell();
    const close = screen.getByLabelText("Close repository drawer");
    const drawer = close.closest("aside");
    const trigger = screen.getByRole("button", { name: "Open Repositories" });
    expect(drawer?.className).not.toContain("open");
    expect(drawer?.hasAttribute("inert")).toBe(true);
    await user.click(trigger);
    expect(drawer?.className).toContain("open");
    expect(drawer?.hasAttribute("inert")).toBe(false);
    await user.keyboard("{Escape}");
    expect(drawer?.className).not.toContain("open");
    expect(drawer?.hasAttribute("inert")).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test("workspace navigation closes stale inspector state", async () => {
    window.history.replaceState({}, "", "/?workspace=evidence");
    const user = userEvent.setup(); renderDemoShell();
    await user.click(screen.getByRole("button", { name: /J02Authentication/ }));
    expect(screen.getByRole("heading", { name: /J02.*Authentication/ })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Release" }));
    expect(screen.getByRole("region", { name: "To-do and document ledger" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /J02.*Authentication/ })).toBeNull();
  });

  test("Coordinate always lands on the execution spine and keeps the whole-plan map as drill-down", async () => {
    window.history.replaceState({}, "", "/?workspace=plan&phase=P1");
    const user = userEvent.setup(); renderDemoShell();
    expect(screen.getByRole("region", { name: "Whole-plan phase map" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Coordinate" }));
    expect(screen.getByRole("region", { name: "Plan workspace" })).toBeTruthy();
    expect(screen.getByText("P1 · Brief & Viability")).toBeTruthy();
    expect(screen.getByText("B01-1")).toBeTruthy();
    expect(window.location.search).toContain("workspace=plan");
    expect(window.location.search).toContain(`project=`);
    expect(window.location.search).not.toContain("phase=");
  });

  test("top bar identity and delivery controls open useful destinations", async () => {
    window.history.replaceState({}, "", "/?workspace=ledger");
    const user = userEvent.setup(); renderDemoShell();
    const developerTrigger = screen.getByRole("button", { name: /3 developers/ });
    await user.click(developerTrigger);
    expect(screen.getByRole("dialog", { name: "Developer roster" })).toBeTruthy();
    expect(screen.getByText("Mira")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Developer roster" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(developerTrigger));
    await user.click(screen.getByRole("button", { name: /P80.*18 days/ }));
    expect(screen.getByRole("dialog", { name: "Plan calendar" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Open allocation calendar/ }));
    expect(screen.getByRole("region", { name: "Allocation workspace" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open Perfect Planner home" }));
    expect(screen.getByRole("region", { name: "Project Home workspace" })).toBeTruthy();
  });

  test("every primary header destination opens its own workspace", async () => {
    window.history.replaceState({}, "", "/?workspace=home");
    const user = userEvent.setup(); renderDemoShell();
    const destinations = [
      ["Define", "Blueprint decision gates", "blueprint"],
      ["Coordinate", "Plan workspace", "plan"],
      ["Build", "Build workspace", "build"],
      ["Prove", "Integrity and execution guarantees", "integrity"],
      ["Release", "To-do and document ledger", "ledger"],
    ];
    for (const [button, region, route] of destinations) {
      await user.click(screen.getByRole("button", { name: button }));
      expect(await screen.findByRole("region", { name: region })).toBeTruthy();
      expect(window.location.search).toContain(`workspace=${route}`);
    }
    await user.click(screen.getByRole("button", { name: /2 demo agents/ }));
    expect(await screen.findByRole("region", { name: "Runtime and connections" })).toBeTruthy();
    const connectCard = await screen.findByRole("region", { name: "Connect your agent" });
    expect(connectCard.textContent).not.toMatch(/Antigravity/);
    expect(connectCard.textContent).toMatch(/Use Connect agent in the top bar instead/);
    expect(window.location.search).toContain("workspace=ledger");
  });

  test("more actions exposes MCP, organization invitations, settings, and export", async () => {
    window.history.replaceState({}, "", "/?workspace=structure");
    const user = userEvent.setup(); renderDemoShell();
    await user.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("dialog", { name: "More actions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /MCP access/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Diagnostics console/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Invite to organization/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Organization settings/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Export project record/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /People & roster/ }).className).toContain("responsive-topbar-action");
    expect(screen.getByRole("button", { name: /Delivery calendar/ }).className).toContain("responsive-topbar-action");

    await user.click(screen.getByRole("button", { name: /MCP access/ }));
    expect(screen.getByText("Allow MCP context in this session")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Back to more actions" }));
    await user.click(screen.getByRole("button", { name: /Invite to organization/ }));
    expect(screen.getByRole("button", { name: /Create invitation draft/ })).toBeTruthy();
  });

  test("owner profiles open above the avatar with keyboard and close with Escape", async () => {
    window.history.replaceState({}, "", "/?workspace=plan&phase=P1");
    const user = userEvent.setup(); renderDemoShell();
    const trigger = screen.getAllByRole("button", { name: /View .* profile/ })[0];
    trigger.focus();
    await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
    expect(screen.getByRole("dialog", { name: /profile/ })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  test("diagnostics console separates runtime errors and MCP events", async () => {
    window.history.replaceState({}, "", "/?workspace=structure");
    const user = userEvent.setup(); renderDemoShell();
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("button", { name: /Diagnostics console/ }));
    expect(screen.getByRole("log", { name: "Application errors" })).toBeTruthy();
    window.dispatchEvent(new ErrorEvent("error", { message: "Rendered test failure" }));
    expect(await screen.findByText("Rendered test failure")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "MCP events" }));
    expect(screen.getByRole("log", { name: "MCP events" })).toBeTruthy();
  });

  test("operations console is draggable and supports an editable copy-and-paste tray", async () => {
    window.history.replaceState({}, "", "/?workspace=structure");
    const writeText = vi.fn().mockResolvedValue(undefined);
    const readText = vi.fn().mockResolvedValue("pasted diagnostic bundle");
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText, writeText },
    });
    renderDemoShell();
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("button", { name: /Diagnostics console/ }));
    window.dispatchEvent(new ErrorEvent("error", { message: "Copyable failure" }));
    expect(await screen.findByText("Copyable failure")).toBeTruthy();
    expect(screen.getByText(/Drag up or down/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Select visible" }));
    expect(screen.getByText(/queued to copy/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Copy all" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Copyable failure"));
    await user.click(screen.getByRole("button", { name: "Paste" }));
    expect(readText).toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Operations copy tray" }).value).toBe("pasted diagnostic bundle");
    await user.click(screen.getByRole("button", { name: "Copy all" }));
    expect(writeText).toHaveBeenLastCalledWith("pasted diagnostic bundle");
    const tray = screen.getByRole("textbox", { name: "Operations copy tray" });
    await user.clear(tray);
    expect(screen.getByRole("button", { name: "Copy all" }).disabled).toBe(true);
    await user.type(tray, "edited diagnostic text");
    await user.click(screen.getByRole("button", { name: "Copy all" }));
    expect(writeText).toHaveBeenLastCalledWith("edited diagnostic text");
  });

  test("Operations preserves malformed history and explains memory-only recovery instead of showing a clean bill of health", async () => {
    window.history.replaceState({}, "", "/?workspace=home");
    const raw = '{"private":"do-not-render",broken';
    window.localStorage.setItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY, raw);
    const user = userEvent.setup(); renderDemoShell();
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("button", { name: /Diagnostics console/ }));
    const warning = screen.getByRole("status", { name: "Operations history warning" });
    expect(warning.textContent).toContain("Previously stored data has not been reset");
    expect(warning.textContent).toContain("export them before closing");
    expect(screen.getByRole("button", { name: "Export diagnostics" }).disabled).toBe(false);
    expect(screen.queryByText("do-not-render")).toBeNull();
    expect(window.localStorage.getItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY)).toBe(raw);
    act(() => window.dispatchEvent(new ErrorEvent("error", { message: "New recoverable error" })));
    expect(await screen.findByText("New recoverable error")).toBeTruthy();
    expect(window.localStorage.getItem(DEFAULT_RUNTIME_EVENT_STORAGE_KEY)).toBe(raw);
  });

  test("Operations expands and copies sanitized event details, not only its headline", async () => {
    window.history.replaceState({}, "", "/?workspace=home");
    const ledger = createRuntimeEventLedger({ storage: window.localStorage });
    ledger.append({ projectId: DEMO_PROJECT_ID, generation: 1, adapter: "fixture", source: "mcp", severity: "error",
      eventId: "evt_copy_details_001", message: "Metadata check failed", payload: { code: "MCP_TIMEOUT", durationMs: 2500, token: "private-test-token" } });
    const user = userEvent.setup(); const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderDemoShell();
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("button", { name: /Diagnostics console/ }));
    const row = screen.getByText("Metadata check failed").closest("details");
    await user.click(row.querySelector("summary"));
    expect(within(row).getByLabelText("Details for evt_copy_details_001").textContent).toContain('"durationMs": 2500');
    await user.click(within(row).getByRole("button", { name: "Copy this event" }));
    const copied = writeText.mock.calls.at(-1)[0];
    expect(copied).toContain("MCP_TIMEOUT"); expect(copied).toContain('"durationMs": 2500');
    expect(copied).toContain("[REDACTED]"); expect(copied).not.toContain("private-test-token");
    expect(screen.getByRole("textbox", { name: "Operations copy tray" }).value).toBe(copied);
  });

  test("event selection is separate from disclosure and preserves filtered selections and edited tray text", async () => {
    window.history.replaceState({}, "", "/?workspace=home");
    const ledger = createRuntimeEventLedger({ storage: window.localStorage });
    for (const [id,message] of [["evt_select_one","First selection fixture"],["evt_select_two","Second selection fixture"]]) ledger.append({projectId:DEMO_PROJECT_ID,generation:1,adapter:"fixture",source:"mcp",severity:"error",eventId:id,message,payload:{detail:"Read this full detail"}});
    const user=userEvent.setup();renderDemoShell();
    await user.click(screen.getByRole("button",{name:/Operations/}));
    const first=screen.getByRole("checkbox",{name:"Queue evt_select_one for copying"});
    const detail=first.closest(".diagnostic-row").querySelector("details");
    expect(first.closest("summary")).toBeNull();
    first.focus();await user.keyboard(" ");expect(first.checked).toBe(true);expect(detail.open).toBe(false);
    await user.tab();expect(document.activeElement).toBe(detail.querySelector("summary"));
    // jsdom does not implement the summary's native Enter default action; real-browser proof covers it.
    await user.click(detail.querySelector("summary"));expect(detail.open).toBe(true);expect(first.checked).toBe(true);
    expect(within(detail).getByLabelText("Details for evt_select_one").tabIndex).toBe(0);
    const search=screen.getByRole("textbox",{name:"Search operations events"});
    await user.type(search,"Second selection fixture");await user.click(screen.getByRole("button",{name:"Select visible"}));
    const tray=screen.getByRole("textbox",{name:"Operations copy tray"});
    expect(tray.value).toContain("First selection fixture");expect(tray.value).toContain("Second selection fixture");
    await user.clear(tray);await user.type(tray,"My diagnostic note");
    await user.clear(search);await user.click(screen.getByRole("checkbox",{name:"Queue evt_select_one for copying"}));
    expect(tray.value).toBe("My diagnostic note");
    await user.click(screen.getByRole("button",{name:"Replace tray with selected events"}));
    expect(tray.value).not.toContain("First selection fixture");expect(tray.value).toContain("Second selection fixture");
    const violations=(await axe.run(document.getElementById("operations-panel"),{rules:{"color-contrast":{enabled:false}}})).violations;
    expect(violations.filter(v=>v.id==="nested-interactive")).toEqual([]);
  });

  test("operations resizes with keys and pointer, clamps to the viewport, and stops canceled drags", async () => {
    window.history.replaceState({}, "", "/?workspace=structure");
    const user = userEvent.setup();
    const { unmount } = renderDemoShell();
    await user.click(screen.getByRole("button", { name: /Operations/ }));
    const separator = screen.getByRole("separator", { name: "Resize Operations console" });
    const panel = document.getElementById("operations-panel");
    separator.focus();
    await user.keyboard("{ArrowUp}");
    expect(panel.style.height).toBe("460px");
    await user.keyboard("{Home}");
    expect(panel.style.height).toBe("260px");
    await user.keyboard("{End}");
    expect(Number.parseInt(panel.style.height)).toBe(window.innerHeight - 82);
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 400 });
    fireEvent(window, new Event("resize"));
    expect(panel.style.height).toBe("318px");
    const pointer = (type, y, id = 1) => {
      const event = new Event(type, { bubbles: true });
      Object.assign(event, { button: 0, pointerId: id, clientY: y, isPrimary: true });
      return event;
    };
    fireEvent(separator, pointer("pointerdown", 100));
    fireEvent(window, pointer("pointermove", 200, 2));
    expect(panel.style.height).toBe("318px");
    fireEvent(window, pointer("pointermove", 200));
    expect(panel.style.height).toBe("260px");
    fireEvent(window, pointer("pointercancel", 200));
    fireEvent(window, pointer("pointermove", 50));
    expect(panel.style.height).toBe("260px");
    expect(panel.className).not.toContain("resizing");
    await user.dblClick(separator);
    expect(document.getElementById("operations-panel")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Operations/ }));
    await user.click(screen.getByRole("button", { name: /Operations/ }));
    const newSeparator = screen.getByRole("separator", { name: "Resize Operations console" });
    fireEvent(newSeparator, pointer("pointerdown", 200));
    const removeListener = vi.spyOn(window, "removeEventListener");
    unmount();
    expect(removeListener).toHaveBeenCalledWith("pointermove", expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith("pointercancel", expect.any(Function));
    removeListener.mockRestore();
    Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
  });

  test("clipboard failures select the actual tray text and project changes discard pending pastes", async () => {
    window.history.replaceState({}, "", "/?workspace=structure");
    const user = userEvent.setup();
    let resolvePaste;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: vi.fn().mockRejectedValue(new Error("denied")),
      readText: vi.fn(() => new Promise((resolve) => { resolvePaste = resolve; })),
    } });
    const { registry, demo } = renderDemoShell();
    await user.click(screen.getByRole("button", { name: /Operations/ }));
    const tray = screen.getByRole("textbox", { name: "Operations copy tray" });
    await user.type(tray, "project-specific diagnostic");
    await user.click(screen.getByRole("button", { name: "Copy all" }));
    await waitFor(() => expect(document.activeElement).toBe(tray));
    expect(tray.selectionStart).toBe(0);
    expect(tray.selectionEnd).toBe(tray.value.length);
    await user.click(screen.getByRole("button", { name: "Paste" }));
    act(() => registry.clear());
    expect(screen.getByRole("textbox", { name: "Operations copy tray" }).value).toBe("");
    await act(async () => { resolvePaste("stale text from the old project"); });
    expect(screen.getByRole("textbox", { name: "Operations copy tray" }).value).toBe("");
    act(() => registry.upsert(demo, { activate: true }));
    expect(screen.getByRole("textbox", { name: "Operations copy tray" }).value).toBe("");
  });

  test("copying an event preserves edited notes on success and clipboard denial", async () => {
    window.history.replaceState({}, "", "/?workspace=home");
    createRuntimeEventLedger({ storage: window.localStorage }).append({ projectId: DEMO_PROJECT_ID, generation: 1, adapter: "fixture", source: "mcp", severity: "error", eventId: "evt_copy_notes", message: "Event copy fixture", payload: { detail: "Exact event content" } });
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { registry } = renderDemoShell();
    await user.click(screen.getByRole("button", { name: /Operations/ }));
    const tray = screen.getByRole("textbox", { name: "Operations copy tray" });
    await user.type(tray, "Keep my investigation notes");
    const detail = screen.getByRole("checkbox", { name: "Queue evt_copy_notes for copying" }).closest(".diagnostic-row").querySelector("details");
    await user.click(detail.querySelector("summary"));
    await user.click(within(detail).getByRole("button", { name: "Copy this event" }));
    expect(tray.value).toBe("Keep my investigation notes");
    expect(writeText.mock.calls.at(-1)[0]).toContain("Exact event content");
    writeText.mockRejectedValue(new Error("denied"));
    await user.click(within(detail).getByRole("button", { name: "Copy this event" }));
    const fallback = screen.getByRole("textbox", { name: /Event text — copy manually/ });
    expect(fallback.value).toBe(writeText.mock.calls.at(-1)[0]);
    expect(fallback.readOnly).toBe(true);
    expect(document.activeElement).toBe(fallback);
    expect(fallback.selectionStart).toBe(0); expect(fallback.selectionEnd).toBe(fallback.value.length);
    expect(tray.value).toBe("Keep my investigation notes");
    act(() => registry.clear());
    expect(screen.queryByRole("textbox", { name: /Event text — copy manually/ })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Operations copy tray" }).value).toBe("");
  });

  test("collapsing invalidates pending copy feedback even after reopening", async () => {
    const user = userEvent.setup();
    let rejectCopy;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(() => new Promise((resolve, reject) => { rejectCopy = reject; })) } });
    renderDemoShell();
    await user.click(screen.getByRole("button", { name: /Operations/ }));
    await user.type(screen.getByRole("textbox", { name: "Operations copy tray" }), "Preserved notes");
    await user.click(screen.getByRole("button", { name: "Copy all" }));
    await user.dblClick(screen.getByRole("separator", { name: "Resize Operations console" }));
    await user.click(screen.getByRole("button", { name: /Operations/ }));
    const focus = document.activeElement;
    await act(async () => { rejectCopy(new Error("denied after close")); });
    expect(document.activeElement).toBe(focus);
    expect(screen.queryByText(/Clipboard access was blocked/)).toBeNull();
    expect(screen.getByRole("textbox", { name: "Operations copy tray" }).value).toBe("Preserved notes");
  });

  test("operations exposes the complete delivery pipeline and honest hook status", async () => {
    window.history.replaceState({}, "", "/?workspace=structure");
    const user = userEvent.setup();
    renderDemoShell();
    await user.click(screen.getByRole("button", { name: /Operations/ }));
    await user.click(screen.getByRole("button", { name: "Delivery pipeline" }));
    expect(screen.getByRole("region", { name: "Local to production delivery pipeline" })).toBeTruthy();
    expect(screen.getByText("Local changes")).toBeTruthy();
    expect(screen.getByText("Production")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Hooks & catchers" }));
    expect(screen.getByRole("region", { name: "Hooks tools and security catchers" })).toBeTruthy();
    expect(screen.getByText("Secret & credential catcher")).toBeTruthy();
    expect(screen.getByText("Malware catcher")).toBeTruthy();
    expect(screen.getByText("ClamShield authenticated v2 adapter")).toBeTruthy();
  });

  test("focused phase cards render one owner profile each", () => {
    window.history.replaceState({}, "", "/?workspace=plan&phase=P1");
    const { container } = renderDemoShell();
    container.querySelectorAll(".map-phase-row.focused .map-node-pill").forEach((card) => {
      expect(card.querySelectorAll(".owner-badge")).toHaveLength(1);
    });
  });

  test("the explicit Demo project is labelled and the folder-plus menu opens intake", async () => {
    window.history.replaceState({}, "", "/?workspace=components");
    const user = userEvent.setup(); renderDemoShell();
    await user.click(screen.getByRole("button", { name: "Open project folders" }));
    expect(screen.getByRole("dialog", { name: "Project folders" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Perfect Planner Demo/ }).at(-1).className).toContain("active");
    await user.click(screen.getByRole("button", { name: /Add another project folder/ }));
    expect(screen.getByRole("region", { name: "Strict folder contract workspace" })).toBeTruthy();
  });

  test("default plan surface has no serious or critical axe violations", async () => {
    window.history.replaceState({}, "", "/?workspace=plan"); document.documentElement.lang = "en"; document.title = "Perfect Planner"; renderDemoShell();
    const result = await axe.run(document, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.filter((item) => ["serious", "critical"].includes(item.impact))).toEqual([]);
  });
});
