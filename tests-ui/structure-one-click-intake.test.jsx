import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SKIP_SCAN_APPROVAL_KEY, StructureWorkspace } from "../src/components/StructureWorkspace.jsx";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: "Local registry unavailable in test mode" }) })));
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.removeItem(SKIP_SCAN_APPROVAL_KEY); });

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

describe("folder intake with an adjacent approval", () => {
  test("Choose app folder then the adjacent Approve read-only scan registers, scans and captures the project", async () => {
    const user = userEvent.setup();
    const adapter = adapterWith();
    const onProjectCaptured = vi.fn();
    render(<StructureWorkspace workspaceAdapter={adapter} onProjectCaptured={onProjectCaptured} />);
    await user.click(screen.getByRole("button", { name: "Choose app folder" }));
    expect(adapter.registerWorkspaceReadOnly).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Approve read-only scan" }));
    await waitFor(() => expect(onProjectCaptured).toHaveBeenCalledTimes(1));
    expect(adapter.registerWorkspaceReadOnly).toHaveBeenCalledTimes(1);
    expect(adapter.registerWorkspaceReadOnly).toHaveBeenCalledWith(expect.objectContaining({ rootPath: picked, explicitUserApproval: true }));
    expect(adapter.censusRegisteredWorkspace).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Approve read-only scan" })).toBeNull();
  });

  test("with the skip-approval setting on, picking the folder starts the scan", async () => {
    const user = userEvent.setup();
    const adapter = adapterWith();
    const onProjectCaptured = vi.fn();
    render(<StructureWorkspace workspaceAdapter={adapter} onProjectCaptured={onProjectCaptured} skipScanApproval />);
    await user.click(screen.getByRole("button", { name: "Choose app folder" }));
    await waitFor(() => expect(onProjectCaptured).toHaveBeenCalledTimes(1));
    expect(adapter.registerWorkspaceReadOnly).toHaveBeenCalledWith(expect.objectContaining({ rootPath: picked, explicitUserApproval: true }));
  });

  test("the skip-approval setting is read from local storage and is off by default", async () => {
    const user = userEvent.setup();
    localStorage.setItem(SKIP_SCAN_APPROVAL_KEY, "1");
    const adapter = adapterWith();
    render(<StructureWorkspace workspaceAdapter={adapter} />);
    await user.click(screen.getByRole("button", { name: "Choose app folder" }));
    await waitFor(() => expect(adapter.registerWorkspaceReadOnly).toHaveBeenCalledTimes(1));
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

  test("a picker that fails before any folder is chosen reads as not started, not a red error", async () => {
    const user = userEvent.setup();
    for (const selectWorkspaceFolder of [
      vi.fn(async () => { throw new Error("org.freedesktop.portal.Desktop was not provided by any .service files"); }),
      vi.fn(async () => ({ authoritative: false, reason: "dialog not found" })),
    ]) {
      const adapter = adapterWith({ selectWorkspaceFolder });
      const view = render(<StructureWorkspace workspaceAdapter={adapter} />);
      await user.click(screen.getByRole("button", { name: "Choose app folder" }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent.trim()).not.toBe("");
      expect(alert.className).not.toContain("is-error");
      const badge = view.container.querySelector(".intake-state");
      expect(badge.textContent.trim()).toBe("not started");
      expect(badge.classList.contains("error")).toBe(false);
      expect(adapter.registerWorkspaceReadOnly).not.toHaveBeenCalled();
      view.unmount();
    }
  });

  test("Use last folder reconnects the remembered project and scans it after approval", async () => {
    const user = userEvent.setup();
    const adapter = adapterWith({
      lastFolder: vi.fn(async () => ({ projectId: "proj_last", name: "Looplet" })),
      reconnectRememberedFolder: vi.fn(async () => ({ ...selected("browser://Looplet/abc123"), reconnected: true })),
    });
    const onProjectCaptured = vi.fn();
    render(<StructureWorkspace workspaceAdapter={adapter} onProjectCaptured={onProjectCaptured} />);
    await user.click(await screen.findByRole("button", { name: "Use last folder · Looplet" }));
    expect(adapter.reconnectRememberedFolder).toHaveBeenCalledWith("proj_last");
    expect(adapter.registerWorkspaceReadOnly).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Approve read-only scan" }));
    await waitFor(() => expect(onProjectCaptured).toHaveBeenCalledTimes(1));
    expect(adapter.registerWorkspaceReadOnly).toHaveBeenCalledWith(expect.objectContaining({ rootPath: "browser://Looplet/abc123", explicitUserApproval: true }));
    expect(adapter.censusRegisteredWorkspace).toHaveBeenCalledTimes(1);
    expect(adapter.selectWorkspaceFolder).not.toHaveBeenCalled();
  });

  test("the launch folder gets a button that selects it and scans after approval", async () => {
    const user = userEvent.setup();
    const adapter = adapterWith({
      launchFolder: vi.fn(async () => ({ name: "my-launch-app" })),
      selectLaunchFolder: vi.fn(async () => selected("browser://my-launch-app/0123456789abcdef01234567")),
    });
    const onProjectCaptured = vi.fn();
    render(<StructureWorkspace workspaceAdapter={adapter} onProjectCaptured={onProjectCaptured} />);
    await user.click(await screen.findByRole("button", { name: "Use launch folder · my-launch-app" }));
    expect(adapter.selectLaunchFolder).toHaveBeenCalledTimes(1);
    await user.click(await screen.findByRole("button", { name: "Approve read-only scan" }));
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

  test("a window with no folder picker opens a typed or pasted folder path and still waits for the adjacent approval", async () => {
    const user = userEvent.setup();
    const typed = "browser://notes-app/0123456789abcdef01234567";
    const adapter = adapterWith({
      selectWorkspaceFolder: vi.fn(async () => ({ available: false, authoritative: false, reason: "browser-folder-picker-unavailable" })),
      selectTypedFolder: vi.fn(async () => selected(typed)),
      launchFolder: vi.fn(async () => ({ name: "notes-app", path: "/home/you/notes-app" })),
    });
    const onProjectCaptured = vi.fn();
    render(<StructureWorkspace workspaceAdapter={adapter} onProjectCaptured={onProjectCaptured} />);
    await user.click(screen.getByRole("button", { name: "Choose app folder" }));
    expect(await screen.findByText(/no folder picker. Type or paste the folder path below/)).toBeTruthy();
    await user.type(await screen.findByLabelText(/type or paste the folder path/i), "/home/you/notes-app");
    await user.click(screen.getByRole("button", { name: "Use this folder" }));
    expect(adapter.selectTypedFolder).toHaveBeenCalledWith("/home/you/notes-app");
    expect(adapter.registerWorkspaceReadOnly).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Approve read-only scan" }));
    await waitFor(() => expect(onProjectCaptured).toHaveBeenCalledTimes(1));
    expect(adapter.registerWorkspaceReadOnly).toHaveBeenCalledWith(expect.objectContaining({ rootPath: typed, explicitUserApproval: true }));
  });

  test("a typed path the service refuses says why and reads nothing", async () => {
    const user = userEvent.setup();
    const adapter = adapterWith({
      selectTypedFolder: vi.fn(async () => ({ available: false, authoritative: false, reason: "That is your home folder. Choose your app's own folder." })),
      launchFolder: vi.fn(async () => ({ name: "x", path: "/x" })),
    });
    render(<StructureWorkspace workspaceAdapter={adapter} />);
    await user.type(await screen.findByLabelText(/type or paste the folder path/i), "/home/you");
    await user.click(screen.getByRole("button", { name: "Use this folder" }));
    expect(await screen.findByText(/That is your home folder/)).toBeTruthy();
    expect(adapter.registerWorkspaceReadOnly).not.toHaveBeenCalled();
  });
});
