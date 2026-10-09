import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StructureWorkspace } from "../src/components/StructureWorkspace.jsx";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: "Local registry unavailable in static mode" }) })));
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Structure workspace intake and connection map", () => {
  test("folder preview stays visible if later content verification fails", async () => {
    const user=userEvent.setup();let finish;
    const onProjectCaptured=vi.fn();
    const workspaceAdapter={
      mode:"native",
      selectWorkspaceFolder:async()=>({authoritative:true,selectionState:"selected",selectedPath:"C:/fixture/Looplet-main"}),
      registerWorkspaceReadOnly:async()=>({authoritative:true,workspaceId:"preview-fixture",registryRevision:1,rootIdentity:"a".repeat(64),access:"metadata-read-only"}),
      previewRegisteredWorkspace:async()=>({available:true,kind:"folder-preview",authoritative:false,contentVerified:false,generatedEpochMs:1,fileCount:1,files:[{path:"src/main.ts"}],skipped:[{path:"output",reason:"gitignore-excluded"}]}),
      censusRegisteredWorkspace:()=>new Promise(resolve=>{finish=resolve;}),
    };
    const {container}=render(<StructureWorkspace workspaceAdapter={workspaceAdapter} onProjectCaptured={onProjectCaptured}/>);
    await user.click(screen.getByRole("button",{name:"Choose app folder"}));
    await user.click(screen.getByRole("button",{name:/Approve read-only analysis/}));
    expect(await screen.findByText(/Folder preview · 1 source-file paths · content not verified/)).toBeTruthy();
    expect(container.querySelector(".workspace-structure-tree")).toBeTruthy();
    expect(onProjectCaptured).not.toHaveBeenCalled();
    await act(async()=>{finish({authoritative:false,reason:"WORKSPACE_CENSUS_BYTE_LIMIT"});});
    expect(screen.getByText(/Folder preview · 1 source-file paths · content not verified/)).toBeTruthy();
    expect(container.querySelector(".workspace-structure-tree")).toBeTruthy();
    expect(onProjectCaptured).not.toHaveBeenCalled();
  });
  test("a completed zero-file census stays blank without claiming indexing never happened", async () => {
    const user = userEvent.setup();
    const workspaceAdapter = {
      selectWorkspaceFolder: vi.fn(async () => ({ authoritative: true, selectionState: "selected", selectedPath: "C:\\test-fixture\\empty-observation" })),
      registerWorkspaceReadOnly: vi.fn(async () => ({ authoritative: true, workspaceId: "empty-observation", registryRevision: 1, rootIdentity: "a".repeat(64), access: "metadata-read-only" })),
      censusRegisteredWorkspace: vi.fn(async () => ({ authoritative: true, workspaceId: "empty-observation", registryRevision: 1, rootIdentity: "a".repeat(64), digest: "b".repeat(64), contentReturned: false, fileCount: 0, files: [], skipped: [{ path: "large.bin", reason: "maximum-file-size-exceeded" }] })),
    };
    render(<StructureWorkspace workspaceAdapter={workspaceAdapter} />);
    await user.click(screen.getByRole("button", { name: "Choose app folder" }));
    await user.click(screen.getByRole("button", { name: /Approve read-only analysis/ }));
    expect(await screen.findByText("No files observed in this folder scan · 1 entries skipped · not proof the folder is empty")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Empty app discovery canvas", exact: true }).textContent).toBe("");
    expect(screen.queryByText(/Empty until a folder is indexed/)).toBeNull();
  });
  const staticWorkspaceAdapter = {
    mode: "native",
    selectWorkspaceFolder: vi.fn(async () => ({ authoritative: false, reason: "native-runtime-unavailable" })),
    registerWorkspaceReadOnly: vi.fn(async () => ({ authoritative: false, reason: "native-runtime-unavailable" })),
    censusRegisteredWorkspace: vi.fn(async () => ({ authoritative: false, reason: "native-runtime-unavailable" })),
  };
  test("shows guarded intake and an honest blank discovery map", async () => {
    render(<StructureWorkspace workspaceAdapter={staticWorkspaceAdapter} />);
    expect(screen.getByRole("region", { name: "Empty app discovery canvas", exact: true }).textContent).toBe("");
    expect(screen.getByRole("button", { name: "hybrid", exact: true }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("heading", { name: "Structure & Connections" })).toBeTruthy();
    expect(screen.getByText("Drop the app folder here")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose app folder" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "App intake progress" }).textContent).toContain("17a");
    expect(screen.getByRole("list", { name: "App intake progress" }).textContent).toContain("Review");
    const map = screen.getByRole("region", { name: "Progressive app discovery map" });
    expect(screen.getByLabelText("Empty app discovery canvas")).toBeTruthy();
    expect(map.querySelector(".workspace-structure-tree")).toBeNull();
    expect(map.textContent).not.toContain("Runtime & framework");
    expect(map.textContent).not.toContain("Data, tenancy & auth");
    expect(map.textContent).not.toContain("GitHub");
    expect(map.textContent).not.toContain("Cloudflare Sites");
  });

  test("indexed metadata grows the map without promoting guesses to facts", async () => {
    const user = userEvent.setup();
    const workspaceAdapter = {
      selectWorkspaceFolder: vi.fn(async () => ({ authoritative: true, selectionState: "selected", selectedPath: "C:\\repos\\sample-app" })),
      registerWorkspaceReadOnly: vi.fn(async () => ({ authoritative: true, workspaceId: "pp-structure-001", registryRevision: 1, rootIdentity: "a".repeat(64), access: "metadata-read-only" })),
      censusRegisteredWorkspace: vi.fn(async () => ({ authoritative: true, workspaceId: "pp-structure-001", registryRevision: 1, rootIdentity: "a".repeat(64), digest: "b".repeat(64), contentReturned: false, fileCount: 4, files: [{ path: "package.json" }, { path: "vite.config.mjs" }, { path: "src/main.jsx" }, { path: ".github/workflows/ci.yml" }], skipped: [] })),
    };
    render(<StructureWorkspace workspaceAdapter={workspaceAdapter} />);
    await user.click(screen.getByRole("button", { name: "Choose app folder" }));
    await user.click(screen.getByRole("button", { name: /Approve read-only analysis/ }));
    const map = screen.getByRole("region", { name: "Progressive app discovery map" });
    await screen.findByText("Vite build configuration", {}, { timeout: 6_000 });
    expect(map.textContent).toContain("Vite build configuration");
    expect(map.textContent).toContain("React-style component files");
    expect(map.textContent).toContain("review signal");
    expect(map.textContent).toContain("Is the app single-tenant or multi-tenant?");
  });

  test("static mode refuses to pretend a local path was registered", async () => {
    const user = userEvent.setup();
    render(<StructureWorkspace workspaceAdapter={staticWorkspaceAdapter} />);
    await user.type(screen.getByPlaceholderText("C:\\projects\\my-app"), "C:\\projects\\sample-app");
    await user.click(screen.getByRole("button", { name: /Approve read-only analysis/ }));
    expect(screen.getByText(/Open the native desktop app/)).toBeTruthy();
  });

  test("folder intake failures are sent to the shared diagnostics console", async () => {
    const user = userEvent.setup();
    const onDiagnostic = vi.fn();
    render(<StructureWorkspace onDiagnostic={onDiagnostic} workspaceAdapter={staticWorkspaceAdapter} />);
    await user.type(screen.getByPlaceholderText("C:\\projects\\my-app"), "C:\\projects\\sample-app");
    await user.click(screen.getByRole("button", { name: /Approve read-only analysis/ }));
    expect(onDiagnostic).toHaveBeenCalledWith("workspace", "error", expect.stringMatching(/native desktop app/i));
    expect(onDiagnostic.mock.calls.filter(([source, severity]) => source === 'workspace' && severity === 'error')).toHaveLength(1);
  });

  test("folder selection reads nothing until the separate approval", async () => {
    const user = userEvent.setup();
    const calls = [];
    const workspaceAdapter = {
      selectWorkspaceFolder: vi.fn(async () => ({ authoritative: true, selectionState: "selected", selectedPath: "C:\\repos\\sample-app" })),
      registerWorkspaceReadOnly: vi.fn(async () => { calls.push("register"); }),
      censusRegisteredWorkspace: vi.fn(async () => { calls.push("census"); }),
    };
    render(<StructureWorkspace workspaceAdapter={workspaceAdapter} />);
    await user.click(screen.getByRole("button", { name: "Choose app folder" }));
    expect(workspaceAdapter.selectWorkspaceFolder).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
    expect(screen.getByDisplayValue("C:\\repos\\sample-app")).toBeTruthy();
    expect(screen.getByText(/Review the path/)).toBeTruthy();
  });
});
