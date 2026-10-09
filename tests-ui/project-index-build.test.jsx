import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ProjectBuildBoard } from "../src/components/ProjectBuildBoard.jsx";
import { ProjectIndexPanel } from "../src/components/ProjectIndexPanel.jsx";
import { ProjectContext } from "../src/project/ProjectProvider.jsx";
import { emptyTaskDraftLedger, taskDraftBinding, updateTaskDraft } from "../src/project/taskDraftLedger.js";
import { readSection, writeSection } from "../src/project/projectWorkRecords.js";
import { addProofItem } from "../src/project/proofRecords.js";
import { useProjectWorkRecords } from "../src/project/useProjectWorkRecords.js";
import { deriveWorkRecordReceipt } from "../src/project/workRecordReceipts.js";
import { readTaskDraftLink } from "../src/project/taskDraftMap.js";

const project = { projectId: "pp_index_build_ui", name: "Shop app", state: "observed", registration: { rootIdentity: "a".repeat(64) }, census: { digest: "b".repeat(64), fileCount: 42 }, discovery: null, authorities: {} };
const binding = taskDraftBinding(project);
const base = { id: null, description: "", owner: "", acceptance: "", recovery: "", claims: [], dependsOn: [], archived: false };
const ledger = [
  { title: "Add checkout page", description: "Build the checkout form", acceptance: "Orders submit", owner: "Sam", claims: [{ path: "src/checkout.jsx", access: "write" }] },
  { title: "Write cart tests", owner: "Ann", claims: [{ path: "tests/cart.test.js", access: "write" }] },
].reduce((current, task) => updateTaskDraft(current, { ...base, ...task }), emptyTaskDraftLedger(binding));
const store = { read: async () => ledger, subscribe: () => () => {} };
const approved = { planStatuses: { [project.projectId]: { state: "observed", projectId: project.projectId, revision: 2, checkedLedger: ledger } } };

function Live({ Panel, context = approved, onWorkspace = vi.fn() }) {
  const records = useProjectWorkRecords(project.projectId);
  return <ProjectContext.Provider value={context}><Panel project={project} records={records} onWorkspace={onWorkspace} store={store} /></ProjectContext.Provider>;
}

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); });

test("build board waits for an approved plan instead of inventing cards", async () => {
  const onWorkspace = vi.fn();
  render(<Live Panel={ProjectBuildBoard} context={{ planStatuses: {} }} onWorkspace={onWorkspace} />);
  expect(await screen.findByText(/No approved plan yet/)).toBeTruthy();
  expect(screen.queryByRole("article")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Open Plan/ }));
  expect(onWorkspace).toHaveBeenCalledWith("plan");
});

test("a never-approved project is sent to the Plan page even when the planning ledger reports stale", async () => {
  const onWorkspace = vi.fn();
  render(<Live Panel={ProjectBuildBoard} context={{ planStatuses: { [project.projectId]: { state: "stale", projectId: project.projectId } } }} onWorkspace={onWorkspace} />);
  expect(await screen.findByText(/No approved plan yet. Approve the tasks on the Plan page/)).toBeTruthy();
  expect(screen.queryByText(/out of date/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Open Plan/ }));
  expect(onWorkspace).toHaveBeenCalledWith("plan");
});

test("Done is refused inline while something is in the way, and a self-reported Done is not shown as verified", async () => {
  // T0002 loses its owner in Allocation: the saved row wins over the draft owner.
  writeSection(project.projectId, "allocation", { taskIds: ["T0001", "T0002"], assignments: { T0001: { owner: "Sam", wave: 1 }, T0002: { owner: "", wave: 1 } } });
  render(<Live Panel={ProjectBuildBoard} />);
  const second = await screen.findByRole("article", { name: "T0002 Write cart tests" });
  expect(within(second).getByText(/No owner named yet/)).toBeTruthy();
  fireEvent.change(within(second).getByLabelText("Status for T0002"), { target: { value: "done" } });
  expect(within(second).getByRole("alert").textContent).toMatch(/Can’t mark Done while 1 thing is in the way: No owner named yet/);
  expect(within(second).getByRole("button", { name: "Save status" }).disabled).toBe(true);
  expect(within(second).getByText("Unsaved changes")).toBeTruthy();
  expect(readSection(project.projectId, "build")).toBeNull();

  const first = screen.getByRole("article", { name: "T0001 Add checkout page" });
  fireEvent.change(within(first).getByLabelText("Status for T0001"), { target: { value: "done" } });
  fireEvent.click(within(first).getByRole("button", { name: "Save status" }));
  await waitFor(() => expect(within(first).getByText(/Done \(self-reported, no proof yet\)/)).toBeTruthy());
});

test("unsaved build edits ask before the page is left", async () => {
  render(<Live Panel={ProjectBuildBoard} />);
  const card = await screen.findByRole("article", { name: "T0001 Add checkout page" });
  const unload = () => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; };
  expect(unload()).toBe(false);
  fireEvent.change(within(card).getByLabelText("Note for T0001"), { target: { value: "half way" } });
  expect(unload()).toBe(true);
  fireEvent.change(within(card).getByLabelText("Note for T0001"), { target: { value: "" } });
  expect(unload()).toBe(false);
});

test("each approved task gets a card whose status is saved to the project and drives BUILD-RUN", async () => {
  render(<Live Panel={ProjectBuildBoard} />);
  const card = await screen.findByRole("article", { name: "T0001 Add checkout page" });
  expect(within(card).getByText(/Sam/)).toBeTruthy();
  expect(within(card).getByText("None attached yet")).toBeTruthy();
  expect(screen.getByLabelText("Build progress").textContent).toContain("0 of 2 done");
  expect(deriveWorkRecordReceipt("LEDGER-TASKS", null, { project })?.state).toBe("recorded");

  fireEvent.change(within(card).getByLabelText("Status for T0001"), { target: { value: "done" } });
  fireEvent.change(within(card).getByLabelText("Note for T0001"), { target: { value: "Merged locally" } });
  fireEvent.click(within(card).getByRole("button", { name: "Save status" }));
  await waitFor(() => expect(screen.getByLabelText("Build progress").textContent).toContain("1 of 2 done"));
  expect(within(card).getByText("Status saved.")).toBeTruthy();
  const saved = readSection(project.projectId, "build");
  expect(saved.data.status.T0001).toMatchObject({ state: "done", note: "Merged locally" });
  expect(saved.data.approvedTaskIds).toEqual(["T0001", "T0002"]);
  expect(deriveWorkRecordReceipt("BUILD-RUN", { sections: { build: saved } }, { project }).state).toBe("review");

  const second = screen.getByRole("article", { name: "T0002 Write cart tests" });
  fireEvent.change(within(second).getByLabelText("Status for T0002"), { target: { value: "done" } });
  fireEvent.click(within(second).getByRole("button", { name: "Save status" }));
  await waitFor(() => expect(screen.getByLabelText("Build progress").textContent).toContain("2 of 2 done"));
  const all = readSection(project.projectId, "build");
  expect(deriveWorkRecordReceipt("BUILD-RUN", { sections: { build: all } }, { project }).state).toBe("recorded");
});

test("copy brief uses the clipboard and falls back to selectable text", async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  render(<Live Panel={ProjectBuildBoard} />);
  const card = await screen.findByRole("article", { name: "T0001 Add checkout page" });
  fireEvent.click(within(card).getByRole("button", { name: /Copy brief for an agent/ }));
  await waitFor(() => expect(writeText).toHaveBeenCalled());
  expect(writeText.mock.calls[0][0]).toMatch(/Task T0001: Add checkout page[\s\S]*src\/checkout\.jsx[\s\S]*Orders submit[\s\S]*How to report back/);
  expect(await within(card).findByText(/Brief copied/)).toBeTruthy();

  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  fireEvent.click(within(card).getByRole("button", { name: /Copy brief for an agent/ }));
  expect((await within(card).findByLabelText("Brief for T0001")).value).toContain("Task T0001");
});

test("index panel searches saved tasks and opens the matching Ledger task", async () => {
  const onWorkspace = vi.fn();
  render(<Live Panel={ProjectIndexPanel} onWorkspace={onWorkspace} />);
  await waitFor(() => expect(screen.getByLabelText("What is searchable").textContent).toContain("2 tasks"));
  expect(screen.getByText(/count of 42 files, not their names/)).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText(/Search tasks, areas/), { target: { value: "orders submit" } });
  const results = screen.getByRole("list", { name: "Search results" });
  fireEvent.click(within(results).getByRole("button", { name: /Task Add checkout page/ }));
  expect(onWorkspace).toHaveBeenCalledWith("ledger");
  expect(readTaskDraftLink(window.location.href, binding)).toBe("T0001");

  fireEvent.change(screen.getByPlaceholderText(/Search tasks, areas/), { target: { value: "cart.test" } });
  expect(within(screen.getByRole("list", { name: "Search results" })).getByText("tests/cart.test.js")).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText(/Search tasks, areas/), { target: { value: "nothing like this" } });
  expect(screen.getByText(/Nothing in this project matches/)).toBeTruthy();
});

test("index search announces the result count and says when a long paste was cut", async () => {
  render(<Live Panel={ProjectIndexPanel} />);
  await waitFor(() => expect(screen.getByLabelText("What is searchable").textContent).toContain("2 tasks"));
  const input = screen.getByRole("searchbox", { name: "Search this project" });
  fireEvent.change(input, { target: { value: "cart.test" } });
  expect(screen.getByRole("status").textContent).toMatch(/^1 result for “cart\.test”$/);
  fireEvent.change(input, { target: { value: "nothing like this" } });
  expect(screen.getByRole("status").textContent).toMatch(/^0 results/);
  expect(screen.queryByText(/Search uses the first 160 characters/)).toBeNull();
  fireEvent.change(input, { target: { value: "x".repeat(400) } });
  expect(input.value).toHaveLength(160);
  expect(screen.getByText(/Search uses the first 160 characters/)).toBeTruthy();
  fireEvent.change(input, { target: { value: "cart" } });
  expect(screen.queryByText(/Search uses the first 160 characters/)).toBeNull();
});

// Regression (screen tour, 9 Oct 2026): proof saved on the Evidence page is stored
// as { items: { T0001: [...] } }. Build said "None attached yet" and Index counted
// 0 proof items because neither read that shape.
function saveProofLikeEvidencePage() {
  const add = (taskId, item) => {
    const sections = { proof: readSection(project.projectId, "proof") };
    writeSection(project.projectId, "proof", addProofItem(sections, taskId, { id: `P-${taskId}-${item.kind}`, addedAt: "2026-10-09T04:00:00.000Z", addedBy: "Ana", ...item }, null));
  };
  add("T0001", { kind: "screenshot", format: "link", label: "", value: "https://example.com/shot.png" });
  add("T0001", { kind: "test", format: "text", label: "", value: "4 passed", outcome: "passed" });
  add("T0002", { kind: "diff", format: "text", label: "Cart diff", value: "diff --git a b" });
}

test("build cards show proof that was attached on the Evidence page", async () => {
  saveProofLikeEvidencePage();
  render(<Live Panel={ProjectBuildBoard} />);
  const first = await screen.findByRole("article", { name: "T0001 Add checkout page" });
  expect(within(first).getByText("2 attached: Screenshot, Test result")).toBeTruthy();
  expect(within(first).queryByRole("button", { name: /Add proof/ })).toBeNull();
  const second = screen.getByRole("article", { name: "T0002 Write cart tests" });
  expect(within(second).getByText("1 attached: Cart diff")).toBeTruthy();
});

test("index counts and finds proof that was attached on the Evidence page", async () => {
  saveProofLikeEvidencePage();
  const onWorkspace = vi.fn();
  render(<Live Panel={ProjectIndexPanel} onWorkspace={onWorkspace} />);
  await waitFor(() => expect(screen.getByLabelText("What is searchable").textContent).toContain("3 proof items"));
  fireEvent.change(screen.getByPlaceholderText(/Search tasks, areas/), { target: { value: "cart diff" } });
  fireEvent.click(within(screen.getByRole("list", { name: "Search results" })).getByRole("button", { name: /Cart diff/ }));
  expect(onWorkspace).toHaveBeenCalledWith("evidence");
});
