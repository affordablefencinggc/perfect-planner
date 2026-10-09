import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StructureWorkspace } from "../src/components/StructureWorkspace.jsx";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: "Local registry unavailable in test mode" }) })));
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const root = "a".repeat(64);
const picked = "browser://picked-app/0123456789abcdef01234567";
const selected = (selectedPath) => ({ authoritative: true, selectionState: "selected", selectedPath });

function adapterWith(overrides = {}) {
  return {
    mode: "browser",
    selectWorkspaceFolder: vi.fn(async () => selected(picked)),
    registerWorkspaceReadOnly: vi.fn(async ({ workspaceId }) => ({ authoritative: true, workspaceId, registryRevision: 1, rootIdentity: root, access: "metadata-read-only" })),
    censusRegisteredWorkspace: vi.fn(async ({ workspaceId, registryRevision }) => ({
      authoritative: true, workspaceId, registryRevision, rootIdentity: root, digest: "b".repeat(64),
      contentReturned: false, fileCount: 2, files: [{ path: "package.json" }, { path: "src/main.jsx" }], skipped: [],
    })),
    ...overrides,
  };
}

describe("one-click folder intake", () => {
  test("one click on Choose app folder registers, scans and captures the project with no other press", async () => {
    const user = userEvent.setup();
    const adapter = adapterWith();
    const onProjectCaptured = vi.fn();
    render(<StructureWorkspace workspaceAdapter={adapter} onProjectCaptured={onProjectCaptured} />);
    await user.click(screen.getByRole("button", { name: "Choose app folder" }));
    await waitFor(() => expect(onProjectCaptured).toHaveBeenCalledTimes(1));
    expect(adapter.registerWorkspaceReadOnly).toHaveBeenCalledTimes(1);
    expect(adapter.registerWorkspaceReadOnly).toHaveBeenCalledWith(expect.objectContaining({ rootPath: picked, explicitUserApproval: true }));
    expect(adapter.censusRegisteredWorkspace).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /Approve read-only analysis/ })).toBeNull();
  });

  test("cancelling the picker registers and reads nothing", async () => {
    const user = userEvent.setup();
    const adapter = adapterWith({ selectWorkspaceFolder: vi.fn(async () => ({ authoritative: true, selectionState: "cancelled" })) });
    const onProjectCaptured = vi.fn();
    render(<StructureWorkspace workspaceAdapter={adapter} onProjectCaptured={onProjectCaptured} />);
    await user.click(screen.getByRole("button", { name: "Choose app folder" }));
    expect(await screen.findByText(/Nothing was registered or read/)).toBeTruthy();
    expect(adapter.registerWorkspaceReadOnly).not.toHaveBeenCalled();
    expect(adapter.censusRegisteredWorkspace).not.toHaveBeenCalled();
    expect(onProjectCaptured).not.toHaveBeenCalled();
  });

  test("Use last folder reconnects the remembered project and then scans it", async () => {
    const user = userEvent.setup();
    const adapter = adapterWith({
      lastFolder: vi.fn(async () => ({ projectId: "proj_last", name: "Looplet" })),
      reconnectRememberedFolder: vi.fn(async () => ({ ...selected("browser://Looplet/abc123"), reconnected: true })),
    });
    const onProjectCaptured = vi.fn();
    render(<StructureWorkspace workspaceAdapter={adapter} onProjectCaptured={onProjectCaptured} />);
    await user.click(await screen.findByRole("button", { name: "Use last folder · Looplet" }));
    expect(adapter.reconnectRememberedFolder).toHaveBeenCalledWith("proj_last");
    await waitFor(() => expect(onProjectCaptured).toHaveBeenCalledTimes(1));
    expect(adapter.registerWorkspaceReadOnly).toHaveBeenCalledWith(expect.objectContaining({ rootPath: "browser://Looplet/abc123", explicitUserApproval: true }));
    expect(adapter.censusRegisteredWorkspace).toHaveBeenCalledTimes(1);
    expect(adapter.selectWorkspaceFolder).not.toHaveBeenCalled();
  });

  test("the launch folder gets a Scan button that selects it and then scans", async () => {
    const user = userEvent.setup();
    const adapter = adapterWith({
      launchFolder: vi.fn(async () => ({ name: "my-launch-app" })),
      selectLaunchFolder: vi.fn(async () => selected("browser://my-launch-app/0123456789abcdef01234567")),
    });
    const onProjectCaptured = vi.fn();
    render(<StructureWorkspace workspaceAdapter={adapter} onProjectCaptured={onProjectCaptured} />);
    await user.click(await screen.findByRole("button", { name: "Scan my-launch-app" }));
    expect(adapter.selectLaunchFolder).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onProjectCaptured).toHaveBeenCalledTimes(1));
    expect(adapter.registerWorkspaceReadOnly).toHaveBeenCalledWith(expect.objectContaining({ rootPath: "browser://my-launch-app/0123456789abcdef01234567", explicitUserApproval: true }));
    expect(adapter.selectWorkspaceFolder).not.toHaveBeenCalled();
  });

  test("autoStartIntakeToken opens the picker once on mount and a remount with the same token does not", async () => {
    const adapter = adapterWith({ selectWorkspaceFolder: vi.fn(async () => ({ authoritative: true, selectionState: "cancelled" })) });
    const first = render(<StructureWorkspace workspaceAdapter={adapter} autoStartIntakeToken={1} />);
    await waitFor(() => expect(adapter.selectWorkspaceFolder).toHaveBeenCalledTimes(1));
    first.unmount();
    render(<StructureWorkspace workspaceAdapter={adapter} autoStartIntakeToken={1} />);
    await screen.findByRole("button", { name: "Choose app folder" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(adapter.selectWorkspaceFolder).toHaveBeenCalledTimes(1);
  });
});
