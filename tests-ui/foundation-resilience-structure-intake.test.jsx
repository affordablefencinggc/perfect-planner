import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { StructureWorkspace } from "../src/components/StructureWorkspace.jsx";
import { createImportedProjectSession } from "../src/project/projectSession.js";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: "Local registry unavailable in test mode" }) })));
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("foundation resilience Structure intake bridge", () => {
  test("an approved read-only census emits one project capture bound to the same receipt", async () => {
    const rootIdentity = "a".repeat(64);
    const digest = "b".repeat(64);
    const onProjectCaptured = vi.fn();
    const onProjectUnavailable = vi.fn();
    const adapter = {
      mode: "native",
      selectWorkspaceFolder: vi.fn(async () => ({ authoritative: true, selectionState: "selected", selectedPath: "C:\\repos\\alpha-app" })),
      registerWorkspaceReadOnly: vi.fn(async ({ workspaceId }) => ({
        authoritative: true,
        access: "metadata-read-only",
        canonicalRoot: "C:\\repos\\alpha-app",
        registryRevision: 4,
        rootIdentity,
        workspaceId,
      })),
      censusRegisteredWorkspace: vi.fn(async ({ workspaceId, registryRevision }) => ({
        authoritative: true,
        contentReturned: false,
        digest,
        fileCount: 2,
        files: [{ path: "package.json" }, { path: "src/main.jsx" }],
        generatedEpochMs: Date.parse("2026-09-04T01:00:00.000Z"),
        registryRevision,
        rootIdentity,
        skipped: [],
        totalBytesHashed: 200,
        workspaceId,
      })),
    };
    const user = userEvent.setup();
    render(<StructureWorkspace workspaceAdapter={adapter} onProjectCaptured={onProjectCaptured} onProjectUnavailable={onProjectUnavailable} />);

    await user.click(screen.getByRole("button", { name: "Choose app folder" }));

    await waitFor(() => expect(onProjectCaptured).toHaveBeenCalledTimes(1));
    const capture = onProjectCaptured.mock.calls[0][0];
    expect(capture.name).toBe("alpha-app");
    expect(capture.adapter).toBe("native");
    expect(capture.persistence).toBe("durable");
    expect(capture.registration.workspaceId).toBe(capture.census.workspaceId);
    expect(capture.registration.registryRevision).toBe(capture.census.registryRevision);
    expect(capture.registration.rootIdentity).toBe(capture.census.rootIdentity);
    expect(capture.census.digest).toBe(digest);
    expect(capture.census.fileCount).toBe(2);
    expect(capture.discovery.schemaVersion).toBe(1);
    const session = createImportedProjectSession({ ...capture, now: "2026-09-04T01:00:00.000Z" });
    expect(session.discovery.censusDigest).toBe(digest);
    expect(session.census.digest).toBe(digest);
    expect(onProjectUnavailable).not.toHaveBeenCalled();
  });

  test("registration failure emits unavailable truth and never emits an imported project", async () => {
    const onProjectCaptured = vi.fn();
    const onProjectUnavailable = vi.fn();
    const adapter = {
      mode: "native",
      selectWorkspaceFolder: vi.fn(async () => ({ authoritative: true, selectionState: "selected", selectedPath: "C:\\repos\\missing-app" })),
      registerWorkspaceReadOnly: vi.fn(async () => ({ authoritative: false, reason: "native-runtime-unavailable" })),
      censusRegisteredWorkspace: vi.fn(),
    };
    const user = userEvent.setup();
    render(<StructureWorkspace workspaceAdapter={adapter} onProjectCaptured={onProjectCaptured} onProjectUnavailable={onProjectUnavailable} />);

    await user.click(screen.getByRole("button", { name: "Choose app folder" }));

    await waitFor(() => expect(onProjectUnavailable).toHaveBeenCalledTimes(1));
    expect(onProjectUnavailable.mock.calls[0][0].reason).toMatch(/native desktop app/i);
    expect(onProjectCaptured).not.toHaveBeenCalled();
    expect(adapter.censusRegisteredWorkspace).not.toHaveBeenCalled();
    expect(screen.getByText(/Static preview remains safely read-only/i)).toBeTruthy();
  });

  test("census failure preserves registration provenance but refuses project capture", async () => {
    const rootIdentity = "c".repeat(64);
    const onProjectCaptured = vi.fn();
    const onProjectUnavailable = vi.fn();
    const adapter = {
      mode: "browser",
      selectWorkspaceFolder: vi.fn(async () => ({ authoritative: true, selectionState: "selected", selectedPath: "browser://alpha-app" })),
      registerWorkspaceReadOnly: vi.fn(async ({ workspaceId }) => ({
        authoritative: true,
        access: "metadata-read-only",
        canonicalRoot: "browser://alpha-app",
        registryRevision: 1,
        rootIdentity,
        workspaceId,
      })),
      censusRegisteredWorkspace: vi.fn(async () => ({ authoritative: false, reason: "Browser folder approval has expired. Choose the folder again." })),
    };
    const user = userEvent.setup();
    render(<StructureWorkspace workspaceAdapter={adapter} onProjectCaptured={onProjectCaptured} onProjectUnavailable={onProjectUnavailable} />);

    await user.click(screen.getByRole("button", { name: "Choose app folder" }));

    await waitFor(() => expect(onProjectUnavailable).toHaveBeenCalledTimes(1));
    expect(onProjectUnavailable.mock.calls[0][0].registration.rootIdentity).toBe(rootIdentity);
    expect(onProjectUnavailable.mock.calls[0][0].reason).toMatch(/approval has expired/i);
    expect(onProjectCaptured).not.toHaveBeenCalled();
  });
});
