import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PerfectPlannerShell } from "../src/PerfectPlannerShell.jsx";
import { BundledPlannerConnection } from "../src/components/RuntimeConnectionsPanel.jsx";
import { ProjectProvider, useOptionalProject } from "../src/project/ProjectProvider.jsx";
import { createMemoryStorage, createProjectRegistry } from "../src/project/projectRegistry.js";
import { createImportedProjectSession } from "../src/project/projectSession.js";
import { diagnosticSessionFixture } from './diagnosticSessionFixture.js';
let diagnosticSession;

// Controller fixtures test presentation/ownership only, never native transport proof.
const controls = vi.hoisted(() => ({ instances: [], real: false, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args) => controls.invoke(...args) }));
vi.mock("../src/runtime/plannerMcpConnection.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
  createPlannerMcpConnectionController: vi.fn(({ onEvent }) => {
    if (controls.real) return actual.createPlannerMcpConnectionController({ onEvent });
    let snapshot = { status: "unavailable", projectId: null, generation: 0, canCheck: false, reason: "native-runtime-required" };
    const listeners = new Set();
    const controller = {
      getSnapshot: () => snapshot,
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      setProject: vi.fn((project) => {
        const projectId = project?.projectId ?? null;
        const generation = project?.generation ?? 0;
        if (snapshot.projectId === projectId && snapshot.generation === generation) return;
        const canCheck = Boolean(window.__TAURI_INTERNALS__) && project?.registration?.adapter === "native";
        snapshot = { projectId, generation, status: canCheck ? "idle" : "unavailable", canCheck, reason: canCheck ? "connection-not-checked" : "native-runtime-required" };
        listeners.forEach((listener) => listener());
      }),
      check: vi.fn(() => { controller.publish({ ...snapshot, status: "checking", canCheck: false }); }),
      disconnect: vi.fn(() => { controller.publish({ ...snapshot, status: "idle", canCheck: true, observedAt: null, expiresAt: null, reason: "observation-cleared" }); }),
      dispose: vi.fn(() => listeners.clear()),
      publish: (next) => { snapshot = next; listeners.forEach((listener) => listener()); },
      event: onEvent,
    };
    controls.instances.push(controller);
    return controller;
  }),
  };
});

function project(name, identity = "a") {
  return createImportedProjectSession({
    name, adapter: "native", now: "2026-09-05T01:00:00.000Z",
    registration: { access: "metadata-read-only", canonicalRoot: `C:\\fixtures\\${name}`, registryRevision: 1, rootIdentity: identity.repeat(64), workspaceId: name },
    census: { digest: "c".repeat(64), fileCount: 2, generatedEpochMs: 1788560400000, registryRevision: 1, rootIdentity: identity.repeat(64), skipped: [], totalBytesHashed: 0, workspaceId: name },
  });
}
function SwitchProject({ target }) {
  const context = useOptionalProject();
  return <button onClick={() => context.selectProject(target)}>Select second test project</button>;
}
function mountProjects() {
  const first = project("native-first");
  const second = project("native-second", "b");
  const registry = createProjectRegistry({ storage: createMemoryStorage() });
  registry.upsert(first); registry.upsert(second);
  window.history.replaceState({}, "", `/?project=${first.projectId}&workspace=home`);
  diagnosticSession = diagnosticSessionFixture();
  const rendered = render(<ProjectProvider registry={registry} initialUrl={window.location.href}><PerfectPlannerShell diagnosticSession={diagnosticSession} /><SwitchProject target={second.projectId} /></ProjectProvider>);
  return { first, second, ...rendered };
}
async function openPanel(user) {
  await user.click(screen.getByRole("button", { name: "More actions" }));
  await user.click(screen.getByRole("button", { name: /Runtime & connections/ }));
  return screen.findByRole("region", { name: "Bundled planner service" });
}
beforeEach(() => {
  controls.instances.length = 0;
  controls.real = false;
  controls.invoke.mockReset();
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: "unavailable" }) })));
  window.localStorage.clear();
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); window.history.replaceState({}, "", "/");
});

test("native disconnected project can initiate the real controller check without capability receipts", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  const user = userEvent.setup(); mountProjects();
  const service = await openPanel(user);
  const button = within(service).getByRole("button", { name: "Check connection" });
  expect(button.disabled).toBe(false);
  await user.click(button);
  expect(controls.instances[0].check).toHaveBeenCalledTimes(1);
  expect(service.getAttribute("aria-busy")).toBe("true");
  expect(within(service).getByRole("button", { name: "Checking connection…" }).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Check MCP read eligibility" }).disabled).toBe(true);
});

test("browser reports unavailable and never starts a native check", async () => {
  const user = userEvent.setup(); mountProjects();
  const service = await openPanel(user);
  expect(within(service).getByRole("button", { name: "Check connection" }).disabled).toBe(true);
  expect(service.textContent).toContain("native runtime required");
  expect(controls.instances[0].check).not.toHaveBeenCalled();
});

test("one-shot result, expiration and disconnect do not grant external MCP capability", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  const user = userEvent.setup(); const { first } = mountProjects();
  const service = await openPanel(user); const controller = controls.instances[0];
  act(() => controller.publish({ projectId: first.projectId, generation: first.generation, status: "connected", canCheck: true, reason: "metadata-access-verified", observedAt: "2026-09-05T01:00:00Z", expiresAt: "2026-09-05T01:00:30Z" }));
  expect(service.textContent).toContain("Connection checked · metadata access verified");
  expect(service.textContent).toContain("helper exits afterward");
  expect(screen.getByRole("button", { name: "Check MCP read eligibility" }).disabled).toBe(true);
  act(() => controller.publish({ ...controller.getSnapshot(), status: "expired", reason: "observation-expired" }));
  expect(service.textContent).toContain("Connection check expired");
  await user.click(within(service).getByRole("button", { name: "Clear result" }));
  expect(controller.disconnect).toHaveBeenCalledTimes(1);
  expect(service.textContent).toContain("Not checked");
  expect(service.textContent).toContain("Your folder stays registered");
});

test("late old-project results stay hidden and errors retain the request's original project and generation", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  const user = userEvent.setup(); const { first, second } = mountProjects();
  await openPanel(user); const controller = controls.instances[0];
  await user.click(screen.getByRole("button", { name: "Select second test project" }));
  act(() => {
    controller.publish({ projectId: first.projectId, generation: first.generation, status: "connected", canCheck: true, reason: "old-project-must-not-paint" });
    controller.event({ projectId: first.projectId, generation: first.generation, requestId: "mcp_request_old", severity: "error", message: "Bundled check timed out for original request.", payload: { code: "timeout" } });
  });
  expect(document.body.textContent).not.toContain("old-project-must-not-paint");
  const ledger = diagnosticSession;
  const originalEvents = ledger.list(first.projectId).filter((event) => event.runId === "mcp_request_old");
  expect(originalEvents).toHaveLength(1);
  expect(originalEvents[0]).toMatchObject({ projectId: first.projectId, generation: first.generation, source: "mcp", severity: "error" });
  expect(ledger.list(second.projectId).filter((event) => event.runId === "mcp_request_old")).toHaveLength(0);
});

test("Operations exposes the same check and selectable actual connection failure event", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  const user = userEvent.setup(); const { first } = mountProjects();
  await user.click(screen.getByRole("button", { name: /Operations/ }));
  await user.click(screen.getByRole("button", { name: /^MCP/ }));
  const service = await screen.findByRole("region", { name: "Bundled planner service" });
  await user.click(within(service).getByRole("button", { name: "Check connection" }));
  const controller = controls.instances[0];
  act(() => {
    controller.publish({ projectId: first.projectId, generation: first.generation, status: "failed", canCheck: true, reason: "native-helper-unavailable" });
    controller.event({ projectId: first.projectId, generation: first.generation, requestId: "mcp_failed_request", severity: "error", message: "Bundled metadata helper unavailable.", payload: { code: "MCP_SERVICE_UNAVAILABLE" } });
  });
  expect(service.textContent).toContain("Connection failed");
  const log = screen.getByRole("log", { name: "MCP events" });
  expect(log.textContent).toContain("Bundled metadata helper unavailable.");
  expect(log.textContent).toContain("MCP_SERVICE_UNAVAILABLE");
  expect(within(log).getAllByRole("checkbox").length).toBeGreaterThan(0);
});

test("controller subscription is disposed on unmount", () => {
  const { unmount } = mountProjects(); const controller = controls.instances[0];
  unmount(); expect(controller.dispose).toHaveBeenCalledTimes(1);
});

test("missing registration presents unavailable without a check handler", () => {
  render(<BundledPlannerConnection />);
  expect(screen.getByRole("button", { name: "Check connection" }).disabled).toBe(true);
  expect(screen.getByRole("region", { name: "Bundled planner service" }).textContent).toContain("native folder registration");
});

test("real controller routes the UI request to exact native command and records verified numeric-time observation", async () => {
  controls.real = true;
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  controls.invoke.mockImplementation(async (command, { request }) => ({
    ...request, state: "connected", code: "MCP_CONNECTED", observedAt: Date.now(), expiresAt: Date.now() + 29_000,
    durationMs: 1, service: "perfect-planner-bundled-metadata", protocolVersion: "2025-11-25", capabilities: ["workspace-registration:read"],
    metadataOnly: true, executionAuthorized: false, computerUse: false, cleanupComplete: true,
  }));
  const user = userEvent.setup(); const { first } = mountProjects();
  const service = await openPanel(user);
  await user.click(within(service).getByRole("button", { name: "Check connection" }));
  expect(await within(service).findByText("Connection checked · metadata access verified")).toBeTruthy();
  expect(controls.invoke).toHaveBeenCalledWith("check_bundled_mcp_connection", { request: expect.objectContaining({ projectId: first.projectId, generation: first.generation, workspaceId: first.registration.workspaceId, rootIdentity: first.registration.rootIdentity }) });
  const ledger = diagnosticSession;
  const events = ledger.list(first.projectId).filter((entry) => entry.adapter === "bundled-planner-mcp");
  expect(events.map((entry) => entry.payload.code)).toEqual(["MCP_REQUEST_STARTED", "MCP_CONNECTED"]);
  expect(events[0].runId).toBe(events[1].runId);
  expect(events[1].generation).toBe(first.generation);
});

test("real controller late native response cannot paint success for the next project", async () => {
  controls.real = true;
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  let finish;
  controls.invoke.mockImplementation((command, { request }) => new Promise((resolve) => {
    finish = () => resolve({ ...request, state: "connected", code: "MCP_CONNECTED", observedAt: Date.now(), expiresAt: Date.now() + 29_000,
      durationMs: 1, service: "perfect-planner-bundled-metadata", protocolVersion: "2025-11-25", capabilities: ["workspace-registration:read"], metadataOnly: true, executionAuthorized: false, computerUse: false, cleanupComplete: true });
  }));
  const user = userEvent.setup(); const { first, second } = mountProjects();
  const service = await openPanel(user);
  await user.click(within(service).getByRole("button", { name: "Check connection" }));
  // Switch projects programmatically: a real outside click would (correctly) close the header popover.
  fireEvent.click(screen.getByRole("button", { name: "Select second test project" }));
  const pendingCheck = within(service).getByRole("button", { name: "Check connection" });
  expect(pendingCheck.disabled).toBe(true);
  await user.click(pendingCheck);
  expect(controls.invoke).toHaveBeenCalledTimes(1);
  await act(async () => { finish(); await Promise.resolve(); });
  expect(within(service).getByRole("button", { name: "Check connection" }).disabled).toBe(false);
  expect(document.body.textContent).not.toContain("Connection checked · metadata access verified");
  await waitFor(() => {
    const ledger = diagnosticSession;
    expect(ledger.list(first.projectId).filter((event) => event.payload?.code === "MCP_INTERRUPTED")).toHaveLength(1);
    expect(ledger.list(second.projectId).filter((event) => event.adapter === "bundled-planner-mcp")).toHaveLength(0);
  });
});
