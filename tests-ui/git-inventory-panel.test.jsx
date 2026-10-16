import React from "react";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import GitInventoryPanel from "../src/components/GitInventoryPanel.jsx";

afterEach(cleanup);
const runtime = { __TAURI_INTERNALS__: {} };
const project = { projectId: "project-one", generation: 1, kind: "imported", state: "observed", registration: { adapter: "native", access: "metadata-read-only", workspaceId: "workspace-one", registryRevision: 1, rootIdentity: "a".repeat(64) } };
const wire = (request) => { const now = Date.now(); return { ...request, code: "GIT_OBSERVED", observedAt: now, expiresAt: now + 30_000, durationMs: 1, metadataOnly: true, executionAuthorized: false, computerUse: false, cleanupComplete: true, observation: { schemaVersion: 1, kind: "git-inventory", state: "observed", localOnly: true, worktrees: [{ path: "C:/fixture", headSha: "b".repeat(40), branchRef: "refs/heads/main", mode: "branch", locked: true, prunable: true, cleanState: "not-inspected", canAutomaticallyDelete: false }], branches: [{ ref: "refs/heads/main", headSha: "b".repeat(40) }], cleanState: "not-inspected", ciState: "not-inspected", productionState: "not-inspected", promotionAuthority: false, canAutomaticallyDelete: false, consistency: "two-matching-reads-not-atomic" } }; };

test("explicit inspection displays selectable worktrees and copies the exact observation without mutation controls", async () => {
  const invoke = vi.fn(async (_command, args) => wire(args.request)); const copy = vi.fn();
  render(<GitInventoryPanel activeProject={project} runtime={runtime} invoke={invoke} onCopy={copy} />);
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Inspect local Git" }));
  await screen.findByRole("table");
  expect(screen.getByText("C:/fixture")).toBeTruthy();
  expect(screen.getByText(/not permission to delete/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Copy observation" }));
  expect(JSON.parse(copy.mock.calls[0][0]).observation.productionState).toBe("not-inspected");
  expect(screen.queryByRole("button", { name: /merge|delete|push/i })).toBeNull();
});

test("switching project removes old rows and copy action", async () => {
  const invoke = vi.fn(async (_command, args) => wire(args.request));
  const view = render(<GitInventoryPanel activeProject={project} runtime={runtime} invoke={invoke} />);
  fireEvent.click(screen.getByRole("button", { name: "Inspect local Git" })); await screen.findByRole("table");
  view.rerender(<GitInventoryPanel activeProject={{ ...project, projectId: "project-two" }} runtime={runtime} invoke={invoke} />);
  expect(screen.queryByText("C:/fixture")).toBeNull(); expect(screen.queryByRole("button", { name: "Copy observation" })).toBeNull();
  expect(invoke).toHaveBeenCalledTimes(1);
});

test("a view change (generation bump) keeps the displayed observation", async () => {
  const invoke = vi.fn(async (_command, args) => wire(args.request));
  const view = render(<GitInventoryPanel activeProject={project} runtime={runtime} invoke={invoke} />);
  fireEvent.click(screen.getByRole("button", { name: "Inspect local Git" })); await screen.findByRole("table");
  view.rerender(<GitInventoryPanel activeProject={{ ...project, generation: 2 }} runtime={runtime} invoke={invoke} />);
  expect(screen.getByText("C:/fixture")).toBeTruthy(); expect(screen.getByRole("button", { name: "Copy observation" })).toBeTruthy();
});

test("a failed first inspection tells the user to reload, not about a previous request", async () => {
  const failingRuntime = { __TAURI_INTERNALS__: {} };
  const invoke = vi.fn(async () => { throw new Error("rejected"); });
  render(<GitInventoryPanel activeProject={project} runtime={failingRuntime} invoke={invoke} />);
  fireEvent.click(screen.getByRole("button", { name: "Inspect local Git" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Reload Perfect Planner to try again/));
  expect(screen.getByRole("status").textContent).not.toMatch(/Previous request|Reconcile/);
  expect(screen.getByRole("button", { name: "Inspect local Git" }).disabled).toBe(true);
});

test("static browser explains the missing native capability and never invokes it", async () => {
  const invoke = vi.fn(); render(<GitInventoryPanel activeProject={project} runtime={{}} invoke={invoke} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Inspect local Git" }).disabled).toBe(true));
  expect(screen.getByRole("status").textContent).toMatch(/desktop app/); expect(invoke).not.toHaveBeenCalled();
});
