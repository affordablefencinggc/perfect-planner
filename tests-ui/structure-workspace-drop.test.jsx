import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { StructureWorkspace } from "../src/components/StructureWorkspace.jsx";

// Component fixtures verify event ordering/state. Actual filesystem drop proof
// is a separate raw-CDP campaign on DANS1.
const receipt = (name) => ({ authoritative: true, selectionState: "selected", selectedPath: `browser://${name}/0123456789abcdef01234567` });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function adapter(overrides = {}) {
  return {
    mode: "browser",
    selectWorkspaceFolder: vi.fn(async () => receipt("picker")),
    selectDroppedWorkspaceFolder: vi.fn(async () => receipt("dropped")),
    registerWorkspaceReadOnly: vi.fn(),
    censusRegisteredWorkspace: vi.fn(),
    ...overrides,
  };
}
const drop = (items) => fireEvent.drop(document.querySelector(".folder-drop-zone"), { dataTransfer: { items } });
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: "Fixture registry unavailable" }) })));
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test("drop captures the directory handle in the drop event and starts the scan with it", async () => {
  const pending = deferred(), handle = { kind: "directory" }, getHandle = vi.fn(() => pending.promise), runtime = adapter();
  render(<StructureWorkspace workspaceAdapter={runtime} />);
  drop([{ kind: "file", getAsFileSystemHandle: getHandle }]);
  expect(getHandle).toHaveBeenCalledTimes(1);
  expect(runtime.registerWorkspaceReadOnly).not.toHaveBeenCalled();
  await act(async () => pending.resolve(handle));
  await waitFor(() => expect(runtime.selectDroppedWorkspaceFolder).toHaveBeenCalledWith(handle));
  await waitFor(() => expect(runtime.registerWorkspaceReadOnly).toHaveBeenCalledTimes(1));
  expect(runtime.registerWorkspaceReadOnly).toHaveBeenCalledWith(expect.objectContaining({ rootPath: receipt("dropped").selectedPath, explicitUserApproval: true }));
});

test("refuses multiple drop items without obtaining any handle", async () => {
  const getHandle = vi.fn(), runtime = adapter();
  render(<StructureWorkspace workspaceAdapter={runtime} />);
  drop([{ kind: "file", getAsFileSystemHandle: getHandle }, { kind: "file", getAsFileSystemHandle: getHandle }]);
  expect(await screen.findByText("Drop exactly one app folder.")).toBeTruthy();
  expect(getHandle).not.toHaveBeenCalled();
  expect(runtime.selectDroppedWorkspaceFolder).not.toHaveBeenCalled();
});

test("unsupported browser drop offers picker instead of trusting a path", async () => {
  const runtime = adapter();
  render(<StructureWorkspace workspaceAdapter={runtime} />);
  drop([{ kind: "file" }]);
  expect(await screen.findByText(/This browser cannot grant folder access by drag-and-drop/)).toBeTruthy();
  expect(runtime.registerWorkspaceReadOnly).not.toHaveBeenCalled();
  expect(runtime.censusRegisteredWorkspace).not.toHaveBeenCalled();
});

test("a late picker cannot overwrite a newer dropped selection", async () => {
  const pending = deferred(), runtime = adapter({ selectWorkspaceFolder: vi.fn(() => pending.promise) });
  render(<StructureWorkspace workspaceAdapter={runtime} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose app folder" }));
  drop([{ kind: "file", getAsFileSystemHandle: () => Promise.resolve({ kind: "directory" }) }]);
  await waitFor(() => expect(runtime.registerWorkspaceReadOnly).toHaveBeenCalledTimes(1));
  expect(runtime.registerWorkspaceReadOnly.mock.calls[0][0].rootPath).toBe(receipt("dropped").selectedPath);
  await act(async () => pending.resolve(receipt("old-picker")));
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(runtime.registerWorkspaceReadOnly).toHaveBeenCalledTimes(1);
  expect(runtime.registerWorkspaceReadOnly.mock.calls.some(([input]) => /old-picker/.test(input.rootPath))).toBe(false);
});

test("failed new selection cannot leave the old folder selected or scanned again", async () => {
  const runtime = adapter();
  render(<StructureWorkspace workspaceAdapter={runtime} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose app folder" }));
  await waitFor(() => expect(runtime.registerWorkspaceReadOnly).toHaveBeenCalledTimes(1));
  drop([{ kind: "file", getAsFileSystemHandle: () => Promise.reject(new Error("Permission lost")) }]);
  expect(await screen.findByText("Permission lost")).toBeTruthy();
  // No folder is set after the failure, so there is no "Scan again" for the old one.
  expect(screen.queryByRole("button", { name: "Scan again" })).toBeNull();
  expect(runtime.registerWorkspaceReadOnly).toHaveBeenCalledTimes(1);
});
