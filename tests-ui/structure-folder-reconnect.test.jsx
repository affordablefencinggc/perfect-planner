import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StructureWorkspace } from "../src/components/StructureWorkspace.jsx";
import { createImportedProjectSession } from "../src/project/projectSession.js";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: "Local registry unavailable in static mode" }) })));
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const root = "a".repeat(64);
const selectedPath = "browser://Looplet/abc123";
const project = createImportedProjectSession({
  name: "Looplet",
  adapter: "browser",
  registration: { workspaceId: "ws_looplet", registryRevision: 1, rootIdentity: root, access: "metadata-read-only", canonicalRoot: selectedPath },
  census: { workspaceId: "ws_looplet", registryRevision: 1, rootIdentity: root, digest: "1".repeat(64), fileCount: 12, generatedAt: "2026-10-01T09:30:00.000Z", skipped: [] },
  now: Date.parse("2026-10-01T09:30:00.000Z"),
});

function adapterWith(overrides = {}) {
  return {
    mode: "browser",
    selectWorkspaceFolder: vi.fn(),
    rememberedFolder: vi.fn(async () => ({ remembered: true, open: false, name: "Looplet" })),
    reconnectRememberedFolder: vi.fn(async () => ({ authoritative: true, selectionState: "selected", selectedPath, reconnected: true })),
    registerWorkspaceReadOnly: vi.fn(async () => ({ authoritative: true, workspaceId: "ws_looplet", registryRevision: 1, rootIdentity: root, access: "metadata-read-only" })),
    censusRegisteredWorkspace: vi.fn(async () => ({ authoritative: true, workspaceId: "ws_looplet", registryRevision: 1, rootIdentity: root, digest: "2".repeat(64), contentReturned: false, fileCount: 0, files: [], skipped: [] })),
    ...overrides,
  };
}

describe("Structure folder reconnect after reload", () => {
  test("labels the saved scan as the last scan and reconnects the same project from a click", async () => {
    const user = userEvent.setup();
    const adapter = adapterWith();
    const onProjectCaptured = vi.fn();
    render(<StructureWorkspace activeProject={project} workspaceAdapter={adapter} onProjectCaptured={onProjectCaptured} />);
    const notice = await screen.findByRole("region", { name: "Folder connection" });
    expect(notice.textContent).toContain("Last scan · 2026-10-01 09:30 UTC · 12 files · not current");
    expect(adapter.rememberedFolder).toHaveBeenCalledWith(project.projectId);
    expect(adapter.reconnectRememberedFolder).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Reconnect folder/ }));
    expect(adapter.reconnectRememberedFolder).toHaveBeenCalledWith(project.projectId);
    await waitFor(() => expect(onProjectCaptured).toHaveBeenCalledTimes(1));
    expect(adapter.registerWorkspaceReadOnly).toHaveBeenCalledWith(expect.objectContaining({ rootPath: selectedPath, explicitUserApproval: true }));
    expect(onProjectCaptured.mock.calls[0][0].registration.rootIdentity).toBe(root);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Folder connection" })).toBeNull());
  });

  test("a refused permission is shown plainly and nothing is read", async () => {
    const user = userEvent.setup();
    const adapter = adapterWith({ reconnectRememberedFolder: vi.fn(async () => ({ authoritative: false, reason: "Folder access was not allowed. Nothing was read." })) });
    render(<StructureWorkspace activeProject={project} workspaceAdapter={adapter} />);
    await user.click(await screen.findByRole("button", { name: /Reconnect folder/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("Folder access was not allowed");
    expect(adapter.registerWorkspaceReadOnly).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Folder connection" }).textContent).toContain("not current");
  });

  test("a folder the browser does not remember asks to choose it again without a reconnect button", async () => {
    const adapter = adapterWith({ rememberedFolder: vi.fn(async () => ({ remembered: false, open: false, name: null })) });
    render(<StructureWorkspace activeProject={project} workspaceAdapter={adapter} />);
    await waitFor(() => expect(screen.getByRole("region", { name: "Folder connection" }).textContent).toContain("does not remember the folder"));
    expect(screen.queryByRole("button", { name: /Reconnect folder/ })).toBeNull();
  });
});
