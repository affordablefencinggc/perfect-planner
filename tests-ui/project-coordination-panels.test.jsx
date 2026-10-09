import React from "react";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectCollisionPanel } from "../src/components/ProjectCollisionPanel.jsx";
import { ProjectAllocationPanel } from "../src/components/ProjectAllocationPanel.jsx";
import { useProjectWorkRecords } from "../src/project/useProjectWorkRecords.js";
import { readSection } from "../src/project/projectWorkRecords.js";
import { emptyTaskDraftLedger, taskDraftBinding, updateTaskDraft } from "../src/project/taskDraftLedger.js";
import { deriveWorkRecordReceipt } from "../src/project/workRecordReceipts.js";

afterEach(cleanup);

const project = { projectId: "pp_coord_panels", name: "Coord", state: "observed", registration: { rootIdentity: "a".repeat(64) }, census: { digest: "b".repeat(64) } };
const binding = taskDraftBinding(project);
const task = (title, claims, owner = "") => ({ id: null, title, description: "", owner, acceptance: "", recovery: "", claims: claims.map(([access, path]) => ({ access, path })), dependsOn: [], archived: false });
const ledger = [task("Login form", [["write", "src/auth/login.js"]], "Ana"), task("Session store", [["write", "src/auth"]]), task("Write docs", [])]
  .reduce((current, item) => updateTaskDraft(current, item), emptyTaskDraftLedger(binding));

function memoryStorage() {
  const map = new Map();
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: (key) => map.delete(key) };
}
const store = { read: async () => ledger, subscribe: () => () => {} };
function Harness({ Panel, storage, onWorkspace }) {
  const records = useProjectWorkRecords(project.projectId, storage);
  return <Panel project={project} records={records} store={store} storage={storage} onWorkspace={onWorkspace} />;
}

test("collision panel checks saved tasks, explains overlaps and records a decision", async () => {
  const user = userEvent.setup();
  const storage = memoryStorage();
  render(<Harness Panel={ProjectCollisionPanel} storage={storage} onWorkspace={vi.fn()} />);
  await screen.findByText("Your 3 tasks have not been checked yet.");
  await user.click(screen.getByRole("button", { name: /Check tasks now/ }));

  const card = await screen.findByRole("article", { name: "T0001 and T0002 overlap" });
  expect(within(card).getByText("Must not run at the same time")).toBeTruthy();
  expect(within(card).getByText("src/auth")).toBeTruthy();
  expect(screen.getByText(/T0003 · Write docs/)).toBeTruthy();
  const saved = readSection(project.projectId, "collisions", storage);
  expect(saved.data.uncheckedTaskIds).toEqual(["T0003"]);
  expect(saved.data.evaluatedAt).toBeTruthy();
  expect(deriveWorkRecordReceipt("ALLOC-CLEARANCE", { sections: { collisions: saved } }, { project }).state).toBe("review");

  await user.selectOptions(within(card).getByLabelText("Decision"), "first:T0002");
  await user.click(within(card).getByRole("button", { name: "Mark resolved" }));
  expect(await within(card).findByText(/Decided: Do T0002 · Session store first/)).toBeTruthy();
  const decided = readSection(project.projectId, "collisions", storage);
  expect(decided.revision).toBe(2);
  expect(decided.data.resolutions["T0001|T0002"]).toMatchObject({ choice: "order", first: "T0002" });
  // One task still lists no files, so clearance stays under review rather than recorded.
  expect(deriveWorkRecordReceipt("BUILD-CLEARANCE", { sections: { collisions: decided } }, { project }).state).toBe("review");
});

test("allocation panel saves owners and waves that follow the collision decision", async () => {
  const user = userEvent.setup();
  const storage = memoryStorage();
  const first = render(<Harness Panel={ProjectCollisionPanel} storage={storage} />);
  await user.click(await screen.findByRole("button", { name: /Check tasks now/ }));
  const card = await screen.findByRole("article", { name: "T0001 and T0002 overlap" });
  await user.selectOptions(within(card).getByLabelText("Decision"), "first:T0002");
  await user.click(within(card).getByRole("button", { name: "Mark resolved" }));
  first.unmount();

  render(<Harness Panel={ProjectAllocationPanel} storage={storage} />);
  const owner1 = await screen.findByLabelText("Owner for T0001");
  expect(owner1.value).toBe("Ana");
  expect(screen.getByLabelText("Wave for T0002").value).toBe("1");
  expect(screen.getByLabelText("Wave for T0001").value).toBe("2");
  await user.click(screen.getByRole("button", { name: "Confirm Ledger owner for T0001" }));
  await user.type(screen.getByLabelText("Owner for T0002"), "agent: builder");
  await user.click(screen.getByRole("button", { name: "Save assignments" }));
  expect(await screen.findByText("Saved. 1 task still needs an owner.")).toBeTruthy();

  let records = { sections: { collisions: readSection(project.projectId, "collisions", storage), allocation: readSection(project.projectId, "allocation", storage) } };
  expect(records.sections.allocation.data.assignments.T0002).toEqual({ owner: "agent: builder", wave: 1 });
  expect(deriveWorkRecordReceipt("ALLOC-OWNERS", records, { project }).state).toBe("review");

  await user.type(screen.getByLabelText("Owner for T0003"), "Bo");
  await user.click(screen.getByRole("button", { name: "Save assignments" }));
  await screen.findByText("Saved. Every task has an owner.");
  records = { sections: { ...records.sections, allocation: readSection(project.projectId, "allocation", storage) } };
  expect(deriveWorkRecordReceipt("ALLOC-OWNERS", records, { project })).toMatchObject({ state: "recorded" });
});

test("allocation pre-fills Ledger proposed owners but records them only after the person confirms", async () => {
  const user = userEvent.setup();
  const storage = memoryStorage();
  const proposed = [task("Login form", [["write", "a.js"]], "Dana"), task("Session store", [["write", "b.js"]], "Eli"), task("Write docs", [["write", "c.md"]])]
    .reduce((current, item) => updateTaskDraft(current, item), emptyTaskDraftLedger(binding));
  const ledgerStore = { read: async () => proposed, subscribe: () => () => {} };
  function Proposed() {
    const records = useProjectWorkRecords(project.projectId, storage);
    return <ProjectAllocationPanel project={project} records={records} store={ledgerStore} storage={storage} />;
  }
  render(<Proposed />);

  const owner1 = await screen.findByLabelText("Owner for T0001");
  expect(owner1.value).toBe("Dana");
  expect(screen.getByLabelText("Owner for T0002").value).toBe("Eli");
  expect(screen.getByLabelText("Owner for T0003").value).toBe("");
  expect(screen.getByText("From the Ledger: Dana")).toBeTruthy();
  expect(screen.getByText("From the Ledger: Eli")).toBeTruthy();

  // A proposal is not a decision: saving without confirming records no owner.
  await user.click(screen.getByRole("button", { name: "Save assignments" }));
  expect(await screen.findByText(/2 owners from the Ledger were not confirmed, so they were not saved/)).toBeTruthy();
  let saved = readSection(project.projectId, "allocation", storage).data.assignments;
  expect(saved.T0001.owner).toBe("");
  expect(saved.T0002.owner).toBe("");

  await user.click(screen.getByRole("button", { name: "Use Ledger owners for all 2 tasks" }));
  expect(await screen.findByText(/Saved Ledger owners for 2 tasks/)).toBeTruthy();
  saved = readSection(project.projectId, "allocation", storage).data.assignments;
  expect(saved.T0001.owner).toBe("Dana");
  expect(saved.T0002.owner).toBe("Eli");
  expect(saved.T0003.owner).toBe("");
  expect(screen.queryByText("From the Ledger: Dana")).toBeNull();
  expect(screen.queryByRole("button", { name: /Use Ledger owner/ })).toBeNull();
});

test("an owner already allocated is kept instead of the Ledger proposal", async () => {
  const user = userEvent.setup();
  const storage = memoryStorage();
  const proposed = [task("Login form", [["write", "a.js"]], "Dana"), task("Session store", [["write", "b.js"]], "Eli")]
    .reduce((current, item) => updateTaskDraft(current, item), emptyTaskDraftLedger(binding));
  const ledgerStore = { read: async () => proposed, subscribe: () => () => {} };
  function Proposed() {
    const records = useProjectWorkRecords(project.projectId, storage);
    return <ProjectAllocationPanel project={project} records={records} store={ledgerStore} storage={storage} />;
  }
  render(<Proposed />);
  await user.clear(await screen.findByLabelText("Owner for T0002"));
  await user.type(screen.getByLabelText("Owner for T0002"), "agent: builder");
  await user.click(screen.getByRole("button", { name: "Save assignments" }));
  await screen.findByText(/1 owner from the Ledger was not confirmed/);

  await user.click(screen.getByRole("button", { name: "Use the Ledger owner for 1 task" }));
  await screen.findByText(/Saved the Ledger owner for 1 task/);
  const saved = readSection(project.projectId, "allocation", storage).data.assignments;
  expect(saved.T0001.owner).toBe("Dana");
  expect(saved.T0002.owner).toBe("agent: builder");
  expect(screen.getByLabelText("Owner for T0002").value).toBe("agent: builder");
});

test("allocation without an overlap check says so instead of implying clearance", async () => {
  render(<Harness Panel={ProjectAllocationPanel} storage={memoryStorage()} />);
  expect(await screen.findByText(/have not been checked for overlapping files yet/)).toBeTruthy();
  expect(screen.getByText(/Branches and separate working folders are not tracked/)).toBeTruthy();
});
