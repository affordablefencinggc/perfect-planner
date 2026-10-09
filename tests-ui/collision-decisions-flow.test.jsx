// Gaps 18 and 21: decisions made on the Collision page flow back to the Plan
// card and the Ledger, and "split" only settles an overlap once the two tasks'
// file scopes stop overlapping.
import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
vi.mock("../src/project/taskFormRecovery.js", async (importOriginal) => { const actual = await importOriginal(), { createMemoryTaskFormRecovery } = await import("./fixtures/memoryTaskFormRecovery.js"); return { ...actual, createTaskFormRecovery: () => createMemoryTaskFormRecovery(actual.appendTaskFormHistory) }; });
import { withMemoryTaskSaveIntents } from "./fixtures/memoryTaskSaveIntents.js";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanApprovalStep } from "../src/components/PlanApprovalStep.jsx";
import { ProjectCollisionPanel } from "../src/components/ProjectCollisionPanel.jsx";
import { TaskDraftLedger } from "../src/components/TaskDraftLedger.jsx";
import { useProjectWorkRecords } from "../src/project/useProjectWorkRecords.js";
import { emptyTaskDraftLedger, taskDraftBinding, updateTaskDraft } from "../src/project/taskDraftLedger.js";

const project = { projectId: "pp_collision_flow", name: "Flow", state: "observed", registration: { rootIdentity: "a".repeat(64) }, census: { digest: "b".repeat(64) } };
const binding = taskDraftBinding(project);
const task = (title, path) => ({ id: null, title, description: `${title} in detail`, owner: "Dana", acceptance: "It works", recovery: "Revert", claims: [{ access: "write", path }], dependsOn: [], archived: false });

function memoryStore(initial) {
  let ledger = initial; const revisions = [initial]; const listeners = new Set();
  return withMemoryTaskSaveIntents({
    read: async () => ledger,
    subscribe: (_binding, fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    saveTask: async (_binding, expected, input) => { if (expected !== ledger.revision) throw new Error("Another window saved a newer revision."); ledger = updateTaskDraft(ledger, input); revisions.push(ledger); listeners.forEach((fn) => fn()); return ledger; },
    history: async () => revisions.map((item) => ({ revision: item.revision, taskCount: item.tasks.length })),
    readRevision: async (_binding, revision) => revisions.find((item) => item.revision === revision),
  });
}

function Pages({ store }) {
  const records = useProjectWorkRecords(project.projectId);
  return <>
    <PlanApprovalStep project={project} records={records} store={store} onWorkspace={vi.fn()} />
    <ProjectCollisionPanel project={project} records={records} store={store} onWorkspace={vi.fn()} />
    <TaskDraftLedger project={project} store={store} />
  </>;
}

const headline = (name) => screen.getByRole("group", { name }).querySelector("summary").textContent;

beforeEach(() => { localStorage.clear(); });
afterEach(cleanup);

test("Plan and Ledger count overlaps as decided once Collision saves a decision; split waits for the scopes to change", async () => {
  const user = userEvent.setup();
  const ledger = [task("Login", "src/x.js"), task("Session", "src/x.js"), task("Store", "src/y.js"), task("Cache", "src/y.js")]
    .reduce((current, item) => updateTaskDraft(current, item), emptyTaskDraftLedger(binding));
  const store = memoryStore(ledger);
  const view = render(<Pages store={store} />);

  await screen.findByRole("heading", { name: "Cache" });
  // Each page reads the saved tasks on its own; wait for Plan and Ledger, not just the Ledger heading.
  await screen.findByRole("group", { name: "Plan overlaps" }); await screen.findByRole("group", { name: "Ledger overlaps" });
  expect(headline("Plan overlaps")).toBe("2 of 2 overlaps still need a decision");
  expect(headline("Ledger overlaps")).toBe("2 of 2 overlaps still need a decision");
  expect(screen.queryByText(/task details? still missing/)).toBeNull();
  expect(screen.queryByText(/Ledger findings must be resolved/)).toBeNull();

  await user.click(screen.getByRole("button", { name: /Check tasks now/ }));
  const first = await screen.findByRole("article", { name: "T0001 and T0002 overlap" });
  await user.selectOptions(within(first).getByLabelText("Decision"), "first:T0001");
  await user.click(within(first).getByRole("button", { name: "Mark resolved" }));
  await within(first).findByText(/Decided: Do T0001 · Login first/);
  expect(headline("Plan overlaps")).toBe("1 of 2 overlaps still needs a decision");
  expect(headline("Ledger overlaps")).toBe("1 of 2 overlaps still needs a decision");

  // Choosing "split" is not a decision yet: the scopes still overlap.
  const second = screen.getByRole("article", { name: "T0003 and T0004 overlap" });
  await user.selectOptions(within(second).getByLabelText("Decision"), "split");
  await user.click(within(second).getByRole("button", { name: "Choose split" }));
  expect(await within(second).findByText(/Split chosen: edit the file scopes of T0003 or T0004 so they no longer overlap\./)).toBeTruthy();
  expect(within(second).queryByText(/^Decided:/)).toBeNull();
  expect(within(second).getByRole("button", { name: /Edit file scopes in Ledger/ })).toBeTruthy();
  expect(headline("Plan overlaps")).toBe("1 of 2 overlaps still needs a decision");
  expect(within(screen.getByRole("group", { name: "Plan overlaps" })).getByText("Split chosen: edit the file scopes of T0003 or T0004 so they no longer overlap.")).toBeTruthy();

  // The user moves T0004 to its own file in the Ledger: the split is now done.
  view.unmount();
  await store.saveTask(binding, ledger.revision, { ...ledger.tasks[3], claims: [{ access: "write", path: "src/cache.js" }] });
  render(<Pages store={store} />);
  await screen.findByRole("heading", { name: "Cache" });
  // Each page reads the saved tasks on its own; wait for Plan and Ledger, not just the Ledger heading.
  await screen.findByRole("group", { name: "Plan overlaps" }); await screen.findByRole("group", { name: "Ledger overlaps" });
  expect(headline("Plan overlaps")).toBe("2 overlaps decided");
  expect(headline("Ledger overlaps")).toBe("2 overlaps decided");
  expect(within(screen.getByRole("group", { name: "Ledger overlaps" })).getByText(/T0003 and T0004: split done/)).toBeTruthy();
});
