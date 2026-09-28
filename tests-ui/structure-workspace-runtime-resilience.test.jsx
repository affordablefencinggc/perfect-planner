import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { StructureWorkspace } from "../src/components/StructureWorkspace.jsx";

const ROOT_IDENTITY = "a".repeat(64);
const CENSUS_DIGEST = "b".repeat(64);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function runStep(step, input) {
  if (step instanceof Error) throw step;
  return typeof step === "function" ? step(input) : step;
}

function registrationFor(workspaceId) {
  return {
    authoritative: true,
    access: "metadata-read-only",
    canonicalRoot: "browser://resilience-app",
    registryRevision: 7,
    rootIdentity: ROOT_IDENTITY,
    workspaceId,
  };
}

function censusFor(workspaceId, registryRevision = 7) {
  return {
    authoritative: true,
    contentReturned: false,
    digest: CENSUS_DIGEST,
    fileCount: 2,
    files: [
      { path: "package.json", category: "manifest" },
      { path: "src/main.jsx", category: "source" },
    ],
    generatedEpochMs: Date.parse("2026-09-04T02:00:00.000Z"),
    registryRevision,
    rootIdentity: ROOT_IDENTITY,
    skipped: [],
    totalBytesHashed: 128,
    workspaceId,
  };
}

function createControlledAdapter({
  registrationSteps = [],
  censusSteps = [],
} = {}) {
  let registrationIndex = 0;
  let censusIndex = 0;
  return {
    mode: "browser",
    selectWorkspaceFolder: vi.fn(async () => ({
      authoritative: true,
      selectionState: "selected",
      selectedPath: "browser://resilience-app",
    })),
    registerWorkspaceReadOnly: vi.fn(async (input) => {
      const step =
        registrationSteps[
          Math.min(registrationIndex, registrationSteps.length - 1)
        ];
      registrationIndex += 1;
      return runStep(step ?? registrationFor(input.workspaceId), input);
    }),
    censusRegisteredWorkspace: vi.fn(async (input) => {
      const step = censusSteps[Math.min(censusIndex, censusSteps.length - 1)];
      censusIndex += 1;
      return runStep(
        step ?? censusFor(input.workspaceId, input.registryRevision),
        input,
      );
    }),
  };
}

async function chooseAndApprove(user) {
  await user.click(screen.getByRole("button", { name: "Choose app folder" }));
  await user.click(
    screen.getByRole("button", { name: /Approve read-only analysis/i }),
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: "Local registry unavailable in test mode" }),
    })),
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Structure workspace runtime resilience", () => {
  test("renders adapter progress, exposes cancellation, and never publishes an aborted partial census", async () => {
    const scan = deferred();
    const adapter = createControlledAdapter({
      censusSteps: [(input) => scan.promise],
    });
    const onProjectCaptured = vi.fn();
    const onIntakeSummary = vi.fn();
    const user = userEvent.setup();

    render(
      <StructureWorkspace
        workspaceAdapter={adapter}
        onProjectCaptured={onProjectCaptured}
        onIntakeSummary={onIntakeSummary}
      />,
    );
    await chooseAndApprove(user);
    await waitFor(() =>
      expect(adapter.censusRegisteredWorkspace).toHaveBeenCalledTimes(1),
    );

    const scanInput = adapter.censusRegisteredWorkspace.mock.calls[0][0];
    expect(typeof scanInput.onProgress).toBe("function");
    expect(scanInput.signal).toBeTruthy();
    expect(typeof scanInput.signal.addEventListener).toBe("function");

    await act(async () => {
      await scanInput.onProgress(
        Object.freeze({
          authoritative: false,
          batchSize: 32,
          bytesHashed: 2_048,
          currentPath: "src/components",
          directoriesVisited: 4,
          filesDiscovered: 40,
          filesHashed: 37,
          maxFileBytes: 2_000_000,
          maxFiles: 10_000,
          maxTotalBytes: 256_000_000,
          phase: "scanning",
          reason: null,
          registryRevision: 7,
          schemaVersion: 1,
          skippedCount: 1,
          workspaceId: scanInput.workspaceId,
        }),
      );
    });

    const progress = screen.getByRole("status", {
      name: /(?:Workspace scan|Read-only census) progress/i,
    });
    expect(progress.textContent).toMatch(/37/);
    expect(progress.textContent).toMatch(/40/);
    expect(progress.textContent).toMatch(/4/);
    expect(progress.textContent).toMatch(/src[\\/]components/i);

    scanInput.signal.addEventListener(
      "abort",
      () =>
        scan.resolve({
          available: false,
          authoritative: false,
          reason: "workspace-census-aborted",
          schemaVersion: 1,
          // A defensive UI must ignore partial payload fields whenever authority is false.
          digest: "c".repeat(64),
          fileCount: 37,
          files: [{ path: "partial.js" }],
        }),
      { once: true },
    );
    await user.click(
      screen.getByRole("button", { name: /Cancel (?:indexing|analysis)/i }),
    );

    expect(scanInput.signal.aborted).toBe(true);
    await screen.findByText(/(?:indexing|analysis) cancelled/i);
    expect(onProjectCaptured).not.toHaveBeenCalled();
    expect(onIntakeSummary).not.toHaveBeenCalled();
    expect(screen.queryByText(/37 files indexed/i)).toBeNull();
  });

  test("a thrown registration error becomes explicit UI and diagnostics without starting census", async () => {
    const adapter = createControlledAdapter({
      registrationSteps: [new Error("registration bridge offline")],
    });
    const onDiagnostic = vi.fn();
    const onProjectCaptured = vi.fn();
    const onProjectUnavailable = vi.fn();
    const user = userEvent.setup();

    render(
      <StructureWorkspace
        workspaceAdapter={adapter}
        onDiagnostic={onDiagnostic}
        onProjectCaptured={onProjectCaptured}
        onProjectUnavailable={onProjectUnavailable}
      />,
    );
    await chooseAndApprove(user);

    await screen.findByText(/registration bridge offline/i);
    expect(screen.getByText(/^error$/i)).toBeTruthy();
    expect(onDiagnostic).toHaveBeenCalledWith(
      "workspace",
      "error",
      expect.stringMatching(/registration bridge offline/i),
    );
    expect(onProjectUnavailable).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringMatching(/registration bridge offline/i),
      }),
    );
    expect(adapter.censusRegisteredWorkspace).not.toHaveBeenCalled();
    expect(onProjectCaptured).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /read-only analysis/i }).disabled,
    ).toBe(false);
  });

  test("a thrown census error is retryable and a later success publishes exactly one authoritative project", async () => {
    const adapter = createControlledAdapter({
      censusSteps: [
        new Error("census worker interrupted"),
        ({ workspaceId, registryRevision }) =>
          censusFor(workspaceId, registryRevision),
      ],
    });
    const onDiagnostic = vi.fn();
    const onIntakeSummary = vi.fn();
    const onProjectCaptured = vi.fn();
    const onProjectUnavailable = vi.fn();
    const user = userEvent.setup();

    render(
      <StructureWorkspace
        workspaceAdapter={adapter}
        onDiagnostic={onDiagnostic}
        onIntakeSummary={onIntakeSummary}
        onProjectCaptured={onProjectCaptured}
        onProjectUnavailable={onProjectUnavailable}
      />,
    );
    await chooseAndApprove(user);

    await screen.findByText(/census worker interrupted/i);
    expect(onDiagnostic).toHaveBeenCalledWith(
      "workspace",
      "error",
      expect.stringMatching(/census worker interrupted/i),
    );
    expect(onProjectUnavailable).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringMatching(/census worker interrupted/i),
      }),
    );
    expect(onProjectCaptured).not.toHaveBeenCalled();
    expect(onIntakeSummary).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: /read-only analysis/i }),
    );
    await waitFor(() => expect(onProjectCaptured).toHaveBeenCalledTimes(1));

    expect(adapter.censusRegisteredWorkspace).toHaveBeenCalledTimes(2);
    expect(onIntakeSummary).toHaveBeenCalledTimes(1);
    const project = onProjectCaptured.mock.calls[0][0];
    expect(project.registration.authoritative).toBe(true);
    expect(project.census.authoritative).toBe(true);
    expect(project.registration.rootIdentity).toBe(project.census.rootIdentity);
    expect(project.registration.registryRevision).toBe(
      project.census.registryRevision,
    );
    expect(project.census.digest).toBe(CENSUS_DIGEST);
    expect(project.census.contentReturned).toBe(false);
  });

  test("an authoritative-looking but unsafe census is visibly refused and only a fresh retry may publish", async () => {
    const unsafeCensus = ({ workspaceId, registryRevision }) => ({
      ...censusFor(workspaceId, registryRevision),
      files: [
        { path: "src/main.jsx", category: "source" },
        { path: "src\\main.jsx", category: "source" },
      ],
    });
    const adapter = createControlledAdapter({
      censusSteps: [
        unsafeCensus,
        ({ workspaceId, registryRevision }) =>
          censusFor(workspaceId, registryRevision),
      ],
    });
    const onDiagnostic = vi.fn();
    const onIntakeSummary = vi.fn();
    const onProjectCaptured = vi.fn();
    const onProjectUnavailable = vi.fn();
    const user = userEvent.setup();

    render(
      <StructureWorkspace
        workspaceAdapter={adapter}
        onDiagnostic={onDiagnostic}
        onIntakeSummary={onIntakeSummary}
        onProjectCaptured={onProjectCaptured}
        onProjectUnavailable={onProjectUnavailable}
      />,
    );
    await chooseAndApprove(user);

    const refusal = await screen.findByRole("alert", {
      name: "Folder analysis refused",
    });
    expect(refusal.textContent).toMatch(/duplicate-file-path/i);
    expect(refusal.textContent).toMatch(
      /No files, folders, or inferred architecture were promoted/i,
    );
    expect(screen.getAllByText(/^analysis refused$/i)).toHaveLength(2);
    expect(screen.queryByText(/2 files indexed/i)).toBeNull();
    expect(screen.queryByText(/2 files observed/i)).toBeNull();
    expect(onProjectCaptured).not.toHaveBeenCalled();
    expect(onIntakeSummary).not.toHaveBeenCalled();
    expect(onProjectUnavailable).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringMatching(/duplicate-file-path/i),
      }),
    );
    expect(onDiagnostic).toHaveBeenCalledWith(
      "workspace",
      "error",
      expect.stringMatching(/duplicate-file-path/i),
    );

    await user.click(
      screen.getByRole("button", { name: "Retry read-only analysis" }),
    );
    await waitFor(() => expect(onProjectCaptured).toHaveBeenCalledTimes(1));
    expect(adapter.censusRegisteredWorkspace).toHaveBeenCalledTimes(2);
    expect(onIntakeSummary).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("alert", { name: "Folder analysis refused" }),
    ).toBeNull();
    expect(await screen.findByText(/2 files observed/i)).toBeTruthy();
  });

  test("large folders keep file rows bounded until the user deliberately reveals more", async () => {
    const files = Array.from({ length: 120 }, (_, index) => ({
      path: `root-file-${String(index + 1).padStart(3, "0")}.js`,
      category: "source",
    }));
    const adapter = createControlledAdapter({
      censusSteps: [
        ({ workspaceId, registryRevision }) => ({
          ...censusFor(workspaceId, registryRevision),
          fileCount: files.length,
          files,
          totalBytesHashed: files.length * 64,
        }),
      ],
    });
    const user = userEvent.setup();
    const { container } = render(
      <StructureWorkspace workspaceAdapter={adapter} />,
    );

    await chooseAndApprove(user);
    await screen.findByText(/120 files observed/i);
    expect(
      container.querySelectorAll('.workspace-tree-files [role="listitem"]'),
    ).toHaveLength(12);
    expect(
      screen.getByRole("button", { name: /Show 48 more files/i }),
    ).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: /Show 48 more files/i }),
    );
    expect(
      container.querySelectorAll('.workspace-tree-files [role="listitem"]'),
    ).toHaveLength(60);

    await user.click(
      screen.getByRole("button", { name: /Hide files in resilience-app/i }),
    );
    expect(
      container.querySelectorAll('.workspace-tree-files [role="listitem"]'),
    ).toHaveLength(0);
    expect(
      screen.getByRole("button", { name: /Show 24 more files/i }),
    ).toBeTruthy();
  });

  test("very wide folder trees cap mounted nodes instead of freezing the canvas", async () => {
    const files = Array.from({ length: 1_500 }, (_, index) => ({
      path: `feature-${String(index + 1).padStart(4, "0")}/index.js`,
      category: "source",
    }));
    const adapter = createControlledAdapter({
      censusSteps: [
        ({ workspaceId, registryRevision }) => ({
          ...censusFor(workspaceId, registryRevision),
          fileCount: files.length,
          files,
          totalBytesHashed: files.length * 64,
        }),
      ],
    });
    const user = userEvent.setup();
    const { container } = render(
      <StructureWorkspace workspaceAdapter={adapter} />,
    );

    await chooseAndApprove(user);
    await screen.findByText(/1500 files observed/i);
    await screen.findByText(/View capped at 1,200 nodes/i, {}, { timeout: 15_000 });
    expect(container.querySelectorAll(".workspace-tree-node").length).toBeLessThanOrEqual(1_200);
  });
});
