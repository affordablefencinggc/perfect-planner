import React from "react";
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PerfectPlannerShell } from "../src/PerfectPlannerShell.jsx";
import { ProjectProvider } from "../src/project/ProjectProvider.jsx";
import { createMemoryStorage, createProjectRegistry } from "../src/project/projectRegistry.js";

vi.mock("../src/components/StructureWorkspace.jsx", () => ({
  StructureWorkspace: ({ onProjectCaptured }) => <div>
    <button onClick={() => onProjectCaptured(capture("first-app", "a", true))}>Capture first fixture</button>
    <button onClick={() => onProjectCaptured(capture("second-app", "d", false))}>Capture second fixture</button>
  </div>,
}));

function capture(id, identity, definitions) {
  const paths = definitions ? [".githooks/pre-commit", ".githooks/pre-push", "scripts/verify-secrets.mjs", ".github/workflows/guardrail-ci.yml"] : ["source.js"];
  const rootIdentity = identity.repeat(64);
  return { name: id, adapter: "native", persistence: "durable",
    registration: { workspaceId: id, rootIdentity, registryRevision: 1, canonicalRoot: `C:/fixture/${id}`, access: "metadata-read-only" },
    census: { schemaVersion: 1, available: true, authoritative: true, capabilities: ["workspace-census:read"], contentReturned: false,
      workspaceId: id, rootIdentity, registryRevision: 1, digest: "b".repeat(64), generatedEpochMs: 1000,
      fileCount: paths.length, files: paths.map((path) => ({ path, size: 1, sha256: "c".repeat(64), category: "source", extension: "", modifiedEpochMs: 1000 })),
      skipped: [], summary: { source: paths.length }, totalBytesHashed: paths.length }, now: 1000 };
}

afterEach(() => { cleanup(); window.localStorage.clear(); });

test("fresh intake definitions stay project-scoped and disappear on reload without becoming execution proof", async () => {
  window.history.replaceState({}, "", "/?workspace=structure");
  const registry = createProjectRegistry({ storage: createMemoryStorage() });
  const shell = () => <ProjectProvider registry={registry}><PerfectPlannerShell /></ProjectProvider>;
  const view = render(shell());
  fireEvent.click(await screen.findByRole("button", { name: "Capture first fixture" }));
  const firstId = registry.getActive().projectId;
  expect(registry.getActive().census.files).toBeUndefined();
  fireEvent.click(screen.getByRole("button", { name: /^Operations/ }));
  fireEvent.click(screen.getByRole("button", { name: "Hooks & catchers" }));
  expect(screen.getByText(/Hook definitions observed\. Installation and execution/)).toBeTruthy();
  expect(screen.getByText(/Scanner definition observed; a passing execution receipt is still required/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Delivery pipeline" }));
  // Delivery stages are static cards (they only repeated their own text in a toast).
  const changes = screen.getByText("Local changes").closest("article");
  expect(within(changes).getByText("unavailable")).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "Capture second fixture" }));
  fireEvent.click(screen.getByRole("button", { name: "Hooks & catchers" }));
  expect(screen.queryByText(/Hook definitions observed\. Installation and execution/)).toBeNull();
  act(() => { registry.setActive(firstId); });
  expect(screen.getByText(/Hook definitions observed\. Installation and execution/)).toBeTruthy();
  const generationBeforeNavigation = registry.getActive().generation;
  fireEvent.click(screen.getByRole("button", { name: "Build" }));
  // A page change is not a new scan (define-05): the generation stays put and the observations survive.
  expect(registry.getActive().generation).toBe(generationBeforeNavigation);
  expect(screen.getByText(/Hook definitions observed\. Installation and execution/)).toBeTruthy();
  view.unmount();
  render(shell());
  fireEvent.click(screen.getByRole("button", { name: /^Operations/ }));
  fireEvent.click(screen.getByRole("button", { name: "Hooks & catchers" }));
  expect(screen.queryByText(/Hook definitions observed\. Installation and execution/)).toBeNull();
});
