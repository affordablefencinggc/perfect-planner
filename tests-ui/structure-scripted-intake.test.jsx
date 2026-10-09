import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StructureWorkspace } from "../src/components/StructureWorkspace.jsx";
import { browserWorkspaceAdapter } from "../src/browser/workspaceCensus.js";
import { SCRIPTED_INTAKE_GLOBAL, installScriptedIntake } from "../src/browser/scriptedIntake.js";
import { setFolderHandleStore, createMemoryFolderHandleStore } from "../src/browser/folderAccess.js";
import { createImportedProjectSession } from "../src/project/projectSession.js";
import { createMemoryStorage, createProjectRegistry } from "../src/project/projectRegistry.js";

const text = (value) => Buffer.from(value).toString("base64");
const manifest = {
  kind: "directory",
  name: "notes-app",
  children: [
    { kind: "file", name: ".gitignore", contentBase64: text("generated/\n") },
    { kind: "file", name: "package.json", contentBase64: text(JSON.stringify({ name: "notes-app", scripts: { dev: "vite" } })) },
    { kind: "directory", name: "generated", children: [{ kind: "file", name: "out.js", contentBase64: text("x") }] },
    { kind: "directory", name: "node_modules", children: [] },
    { kind: "directory", name: "src", children: [{ kind: "file", name: "main.jsx", contentBase64: text("export default null;\n") }] },
  ],
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: "Local registry unavailable in static mode" }) })));
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
  setFolderHandleStore(createMemoryFolderHandleStore());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete globalThis[SCRIPTED_INTAKE_GLOBAL];
  delete globalThis.showDirectoryPicker;
  setFolderHandleStore(undefined);
});

describe("scripted intake through the real Structure buttons", () => {
  test("a queued folder is chosen, approved, scanned with progress and captured as a project", async () => {
    const user = userEvent.setup();
    const control = installScriptedIntake(globalThis, { enabled: true });
    control.queueFolder(manifest);
    const onProjectCaptured = vi.fn();
    render(<StructureWorkspace activeProject={null} workspaceAdapter={browserWorkspaceAdapter} onProjectCaptured={onProjectCaptured} />);

    await user.click(screen.getByRole("button", { name: "Choose app folder" }));
    await waitFor(() => expect(screen.getByPlaceholderText("Choose a folder above").value).toMatch(/^browser:\/\/notes-app\//));
    await user.click(screen.getByRole("button", { name: /Approve read-only analysis/ }));

    await waitFor(() => expect(onProjectCaptured).toHaveBeenCalledTimes(1));
    const captured = onProjectCaptured.mock.calls[0][0];
    expect(captured.adapter).toBe("browser");
    expect(captured.census.files.map((file) => file.path)).toEqual([".gitignore", "package.json", "src/main.jsx"]);
    expect(captured.census.skipped.map((entry) => entry.reason)).toEqual(["ignored-by-gitignore", "generated-or-dependency-directory-excluded"]);
    expect(screen.getByText("3 files indexed")).toBeTruthy();

    const registry = createProjectRegistry({ storage: createMemoryStorage() });
    const project = registry.upsert(createImportedProjectSession(captured), { activate: true });
    expect(project.kind).toBe("imported");
    expect(project.census.fileCount).toBe(3);
  });
});
