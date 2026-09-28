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

test("captures the directory handle in the drop event and never auto-approves", async () => {
  const pending = deferred(), handle = { kind: "directory" }, getHandle = vi.fn(() => pending.promise), runtime = adapter();
  render(<StructureWorkspace workspaceAdapter={runtime} />);
  drop([{ kind: "file", getAsFileSystemHandle: getHandle }]);
  expect(getHandle).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: /Approve read-only analysis/ }).disabled).toBe(true);
  await act(async () => pending.resolve(handle));
  await waitFor(() => expect(runtime.selectDroppedWorkspaceFolder).toHaveBeenCalledWith(handle));
  expect(screen.getByPlaceholderText("Choose a folder above").value).toBe(receipt("dropped").selectedPath);
  expect(runtime.registerWorkspaceReadOnly).not.toHaveBeenCalled();
  expect(runtime.censusRegisteredWorkspace).not.toHaveBeenCalled();
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
  render(<StructureWorkspace workspaceAdapter={adapter()} />);
  drop([{ kind: "file" }]);
  expect(await screen.findByText(/This browser cannot grant folder access by drag-and-drop/)).toBeTruthy();
  expect(screen.getByRole("button", { name: /Approve read-only analysis/ }).disabled).toBe(true);
});

test("a late picker cannot overwrite a newer dropped selection", async () => {
  const pending = deferred(), runtime = adapter({ selectWorkspaceFolder: vi.fn(() => pending.promise) });
  render(<StructureWorkspace workspaceAdapter={runtime} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose app folder" }));
  drop([{ kind: "file", getAsFileSystemHandle: () => Promise.resolve({ kind: "directory" }) }]);
  await waitFor(() => expect(screen.getByPlaceholderText("Choose a folder above").value).toBe(receipt("dropped").selectedPath));
  await act(async () => pending.resolve(receipt("old-picker")));
  expect(screen.getByPlaceholderText("Choose a folder above").value).toBe(receipt("dropped").selectedPath);
});

test("failed new selection cannot leave the old folder approved for analysis", async () => {
  const runtime = adapter();
  render(<StructureWorkspace workspaceAdapter={runtime} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose app folder" }));
  await waitFor(() => expect(screen.getByPlaceholderText("Choose a folder above").value).toBe(receipt("picker").selectedPath));
  drop([{ kind: "file", getAsFileSystemHandle: () => Promise.reject(new Error("Permission lost")) }]);
  expect(await screen.findByText("Permission lost")).toBeTruthy();
  expect(screen.getByPlaceholderText("Choose a folder above").value).toBe("");
  expect(screen.getByRole("button", { name: /Approve read-only analysis/ }).disabled).toBe(true);
});
