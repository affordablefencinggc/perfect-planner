import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ProjectEvidencePanel } from "../src/components/ProjectEvidencePanel.jsx";
import { ProjectIntegrityPanel } from "../src/components/ProjectIntegrityPanel.jsx";
import { useProjectWorkRecords } from "../src/project/useProjectWorkRecords.js";
import { readSection } from "../src/project/projectWorkRecords.js";
import { deriveWorkRecordReceipt } from "../src/project/workRecordReceipts.js";
import { emptyTaskDraftLedger, taskDraftBinding, updateTaskDraft } from "../src/project/taskDraftLedger.js";

const project = { projectId: "pp_proof_panels_ui", name: "My imported app", state: "observed", registration: { rootIdentity: "a".repeat(64) }, census: { digest: "b".repeat(64) } };
const binding = taskDraftBinding(project);
const draft = (title) => ({ id: null, title, description: "", owner: "", acceptance: "", recovery: "", claims: [], dependsOn: [], archived: false });
const ledger = updateTaskDraft(updateTaskDraft(emptyTaskDraftLedger(binding), draft("Add login page")), draft("Store sessions"));
const store = { read: async () => ledger, subscribe: () => () => {} };

function memoryStorage({ full = false } = {}) {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => { if (full) { const error = new Error("full"); error.name = "QuotaExceededError"; throw error; } values.set(key, String(value)); },
  };
}

function Harness({ Panel, storage, ...props }) {
  const records = useProjectWorkRecords(project.projectId, storage);
  return <Panel project={project} records={records} store={store} storage={storage} {...props} />;
}

async function addProof(taskId, { kind, format, value, outcome, merged, by = "Dana" }) {
  fireEvent.click(screen.getByRole("button", { name: `Add proof to ${taskId}` }));
  const form = screen.getByRole("form", { name: `Add proof to ${taskId}` });
  fireEvent.change(within(form).getByLabelText("What are you adding?"), { target: { value: kind } });
  if (format) fireEvent.click(within(form).getByRole("radio", { name: format }));
  if (value != null) fireEvent.change(form.querySelector("textarea, input[type=url]"), { target: { value } });
  if (outcome === "failed") fireEvent.click(within(form).getByLabelText("Failed"));
  if (merged) fireEvent.click(within(form).getByLabelText("These tests ran on the merged code"));
  fireEvent.change(within(form).getByLabelText("Added by"), { target: { value: by } });
  fireEvent.click(within(form).getByRole("button", { name: "Save proof" }));
}

beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });
afterEach(() => cleanup());

test("Evidence lists every task and saves screenshots, links and test output as proof", async () => {
  const storage = memoryStorage();
  const readImage = vi.fn(async () => ({ dataUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" }));
  render(<Harness Panel={ProjectEvidencePanel} storage={storage} readImage={readImage} />);
  expect(await screen.findByText("Add login page")).toBeTruthy();
  expect(screen.getByText("Store sessions")).toBeTruthy();
  expect(screen.getByText(/Covering 2 tasks from the Ledger/)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Add proof to T0001" }));
  const form = screen.getByRole("form", { name: "Add proof to T0001" });
  const file = new File(["fake"], "login-screen.png", { type: "image/png" });
  fireEvent.change(within(form).getByLabelText("Screenshot image"), { target: { files: [file] } });
  await waitFor(() => expect(within(form).getByAltText("Screenshot preview")).toBeTruthy());
  fireEvent.change(within(form).getByLabelText("Added by"), { target: { value: "Dana" } });
  fireEvent.click(within(form).getByRole("button", { name: "Save proof" }));
  await screen.findByText("Proof saved to T0001.");
  expect(screen.getByAltText("login-screen").getAttribute("src")).toMatch(/^data:image\/jpeg/);
  expect(readImage).toHaveBeenCalledWith(file);

  await addProof("T0001", { kind: "diff", format: "Link", value: "https://git.example.test/pr/12" });
  await addProof("T0001", { kind: "test", value: "12 passed", merged: true });
  const saved = readSection(project.projectId, "proof", storage);
  expect(saved.data.items.T0001.map((item) => item.kind)).toEqual(["screenshot", "diff", "test"]);
  expect(saved.data.items.T0001[2]).toMatchObject({ outcome: "passed", merged: true, addedBy: "Dana" });
  expect(saved.data.scope.taskIds).toEqual(["T0001", "T0002"]);
  expect(screen.getByText("Screenshot: added")).toBeTruthy();

  const sections = { proof: saved };
  expect(deriveWorkRecordReceipt("PROOF-SCREENSHOT", { sections }).state).toBe("review");
  expect(deriveWorkRecordReceipt("INT-MERGED", { sections }).state).toBe("recorded");

  fireEvent.click(screen.getByRole("button", { name: "Remove Code change" }));
  // Removal asks first (proverel-11): nothing is deleted until confirmed.
  expect(readSection(project.projectId, "proof", storage).data.items.T0001).toHaveLength(3);
  fireEvent.click(within(screen.getByRole("group", { name: "Remove Code change?" })).getByRole("button", { name: "Yes, remove" }));
  await waitFor(() => expect(readSection(project.projectId, "proof", storage).data.items.T0001).toHaveLength(2));
});

test("Evidence rejects incomplete proof and explains a full browser store", async () => {
  render(<Harness Panel={ProjectEvidencePanel} storage={memoryStorage({ full: true })} />);
  await screen.findByText("Add login page");
  await addProof("T0002", { kind: "note", value: "", by: "Dana" });
  expect(screen.getByRole("alert").textContent).toMatch(/Add the proof itself/);
  fireEvent.change(document.querySelector(".proof-form textarea"), { target: { value: "Checked by hand" } });
  fireEvent.click(screen.getByRole("button", { name: "Save proof" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/storage for this project is full, so nothing was saved/));
});

test("Integrity summarises proof per task and records a named sign-off for this plan version", async () => {
  const storage = memoryStorage();
  const onWorkspace = vi.fn();
  render(<Harness Panel={ProjectIntegrityPanel} storage={storage} onWorkspace={onWorkspace} now={() => "2026-10-08T09:00:00.000Z"} />);
  await screen.findByText(/T0001/);
  expect(screen.getByText("0 of 2 tasks have complete proof.")).toBeTruthy();
  expect(screen.getByText(/File conflicts between tasks have not been checked yet/)).toBeTruthy();
  expect(screen.getByText(/0 of 2 task drafts name an owner/)).toBeTruthy();
  expect(screen.getAllByText("No proof")).toHaveLength(3);
  expect(screen.getByText("No one has signed off this plan yet.")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Sign off this plan version" }));
  await waitFor(() => expect(screen.getByText(/Enter the reviewer's name/)).toBeTruthy());
  fireEvent.change(screen.getByLabelText("Reviewer name"), { target: { value: "Ana Ruiz" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign off this plan version" }));
  await screen.findByText("Sign-off saved.");
  const signedLine = document.querySelector(".integrity-signoff .proof-warn");
  // Unapproved drafts with no proof are recorded honestly, not as a clean pass (proverel-08).
  expect(signedLine.textContent).toMatch(/Signed off by Ana Ruiz on .* for this version of the plan, but no plan was approved and only 0 of 2 tasks were fully proven/);
  const review = readSection(project.projectId, "review", storage).data;
  expect(review).toMatchObject({ reviewer: "Ana Ruiz", signedAt: "2026-10-08T09:00:00.000Z", taskIds: ["T0001", "T0002"], proofAtSignOff: { complete: 0, total: 2 } });
  const receipt = deriveWorkRecordReceipt("INT-REVIEW", { sections: { review: readSection(project.projectId, "review", storage) } }, { project });
  expect(receipt.state).toBe("review");
  expect(receipt.detail).toMatch(/no plan was approved and only 0 of 2 tasks were fully proven/);

  fireEvent.click(screen.getByRole("button", { name: "Open Evidence" }));
  expect(onWorkspace).toHaveBeenCalledWith("evidence");
});

function liveStore(initial) {
  let current = initial;
  const listeners = new Set();
  return {
    read: async () => current,
    subscribe: (_binding, listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    replace(next) { current = next; for (const listener of listeners) listener(); },
  };
}

test("a task edit after sign-off makes the panel and the sign-off receipt agree it is stale (proverel-03)", async () => {
  const storage = memoryStorage();
  const live = liveStore(ledger);
  render(<Harness Panel={ProjectIntegrityPanel} storage={storage} store={live} now={() => "2026-10-08T09:00:00.000Z"} />);
  await screen.findByText(/T0001/);
  fireEvent.change(screen.getByLabelText("Reviewer name"), { target: { value: "Ana Ruiz" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign off this plan version" }));
  await screen.findByText("Sign-off saved.");
  const records = () => ({ sections: { review: readSection(project.projectId, "review", storage) } });
  expect(deriveWorkRecordReceipt("INT-REVIEW", records(), { project }).state).toBe("review");

  const [first] = ledger.tasks;
  await act(async () => { live.replace(updateTaskDraft(ledger, { ...first, title: "Add login page with SSO" })); });
  await screen.findByText(/the plan has changed since/);
  const receipt = deriveWorkRecordReceipt("INT-REVIEW", records(), { project });
  expect(receipt.state).toBe("stale");
  expect(receipt.detail).not.toMatch(/for this plan version/);
});

test("signing off again asks first and keeps the earlier sign-off (proverel-06)", async () => {
  const storage = memoryStorage();
  render(<Harness Panel={ProjectIntegrityPanel} storage={storage} now={() => "2026-10-08T09:00:00.000Z"} />);
  await screen.findByText(/T0001/);
  fireEvent.change(screen.getByLabelText("Reviewer name"), { target: { value: "Ana Ruiz" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign off this plan version" }));
  await screen.findByText("Sign-off saved.");
  fireEvent.change(screen.getByLabelText("Reviewer name"), { target: { value: "Bo Chen" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign off again" }));
  expect(readSection(project.projectId, "review", storage).data.reviewer).toBe("Ana Ruiz");
  expect(screen.getByRole("alert").textContent).toMatch(/replaces the sign-off by Ana Ruiz/);
  fireEvent.click(screen.getByRole("button", { name: "Yes, replace the sign-off" }));
  const saved = readSection(project.projectId, "review", storage).data;
  expect(saved.reviewer).toBe("Bo Chen");
  expect(saved.earlier).toHaveLength(1);
  expect(saved.earlier[0]).toMatchObject({ reviewer: "Ana Ruiz" });
  expect(screen.getByText("Earlier sign-offs (1)")).toBeTruthy();
});

test("names with text-direction overrides are refused and over-long notes show a counter and an error (proverel-04, 09)", async () => {
  const storage = memoryStorage();
  render(<Harness Panel={ProjectIntegrityPanel} storage={storage} />);
  await screen.findByText(/T0001/);
  fireEvent.change(screen.getByLabelText("Reviewer name"), { target: { value: "Ana‮ziur" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign off this plan version" }));
  await screen.findByText(/hidden control or text-direction characters/);
  expect(readSection(project.projectId, "review", storage)).toBeNull();

  fireEvent.change(screen.getByLabelText("Reviewer name"), { target: { value: "Ana" } });
  const notes = screen.getByLabelText("Notes (optional)");
  expect(notes.getAttribute("maxLength")).toBeNull();
  fireEvent.change(notes, { target: { value: "n".repeat(4001) } });
  expect(screen.getByText("4,001 / 4,000 characters")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Sign off this plan version" }));
  await screen.findByText(/Notes are limited to 4,000 characters/);
  expect(readSection(project.projectId, "review", storage)).toBeNull();
});

test("Evidence: waived tasks are not complete, forms stay open per task, long text is refused, screenshots open in-app (proverel-02, 07, 09, 10, 22)", async () => {
  const storage = memoryStorage();
  const readImage = vi.fn(async () => ({ dataUrl: "data:image/png;base64,iVBORw0KGgo=" }));
  render(<Harness Panel={ProjectEvidencePanel} storage={storage} readImage={readImage} />);
  await screen.findByText("Add login page");

  // 10: opening a second form keeps what was typed in the first; the first field is focused; Esc closes a clean form only.
  fireEvent.click(screen.getByRole("button", { name: "Add proof to T0001" }));
  const first = screen.getByRole("form", { name: "Add proof to T0001" });
  await waitFor(() => expect(document.activeElement).toBe(within(first).getByLabelText("What are you adding?")));
  fireEvent.change(within(first).getByLabelText("What are you adding?"), { target: { value: "note" } });
  fireEvent.change(first.querySelector("textarea"), { target: { value: "Typed and kept" } });
  fireEvent.click(screen.getByRole("button", { name: "Add proof to T0002" }));
  expect(screen.getByRole("form", { name: "Add proof to T0001" }).querySelector("textarea").value).toBe("Typed and kept");
  fireEvent.keyDown(first.querySelector("textarea"), { key: "Escape" });
  expect(screen.queryByRole("form", { name: "Add proof to T0001" })).toBeTruthy();
  fireEvent.keyDown(within(screen.getByRole("form", { name: "Add proof to T0002" })).getByLabelText("What are you adding?"), { key: "Escape" });
  expect(screen.queryByRole("form", { name: "Add proof to T0002" })).toBeNull();

  // 09: no silent truncation; a counter and a validator error instead.
  const area = first.querySelector("textarea");
  expect(area.getAttribute("maxLength")).toBeNull();
  fireEvent.change(area, { target: { value: "x".repeat(20_001) } });
  expect(within(first).getByText(/20,001 \/ 20,000 characters/)).toBeTruthy();
  fireEvent.change(within(first).getByLabelText("Added by"), { target: { value: "Dana" } });
  fireEvent.click(within(first).getByRole("button", { name: "Save proof" }));
  expect(within(first).getByRole("alert").textContent).toMatch(/limited to 20,000 characters/);
  fireEvent.click(within(first).getByRole("button", { name: "Cancel" }));

  // 07: three "not needed" reasons make a task waived, never complete.
  for (const covers of ["screenshot", "diff", "test"]) {
    fireEvent.click(screen.getByRole("button", { name: "Add proof to T0002" }));
    const form = screen.getByRole("form", { name: "Add proof to T0002" });
    fireEvent.change(within(form).getByLabelText("What are you adding?"), { target: { value: "skip" } });
    fireEvent.change(within(form).getByLabelText("Which proof is not needed?"), { target: { value: covers } });
    fireEvent.change(form.querySelector("textarea"), { target: { value: "Config only" } });
    fireEvent.change(within(form).getByLabelText("Added by"), { target: { value: "Dana" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save proof" }));
    await screen.findByText("Proof saved to T0002.");
  }
  const tally = document.querySelector(".proof-tally");
  expect(within(tally).getByText("Waived").nextSibling.textContent).toBe("1");
  expect(within(tally).getByText("Complete").nextSibling.textContent).toBe("0");
  expect(document.querySelector(".proof-task.status-waived")).toBeTruthy();
  expect(deriveWorkRecordReceipt("INT-PROOF", { sections: { proof: readSection(project.projectId, "proof", storage) } }).state).toBe("review");

  // 22: an untitled item does not repeat its kind; 02: the thumbnail opens an in-app viewer.
  fireEvent.click(screen.getByRole("button", { name: "Add proof to T0001" }));
  const shot = screen.getByRole("form", { name: "Add proof to T0001" });
  fireEvent.change(within(shot).getByLabelText("Screenshot image"), { target: { files: [new File(["x"], "home.png", { type: "image/png" })] } });
  await waitFor(() => expect(within(shot).getByAltText("Screenshot preview")).toBeTruthy());
  fireEvent.change(within(shot).getByLabelText("Short title (optional)"), { target: { value: "" } });
  fireEvent.change(within(shot).getByLabelText("Added by"), { target: { value: "Dana" } });
  fireEvent.click(within(shot).getByRole("button", { name: "Save proof" }));
  await screen.findByText("Proof saved to T0001.");
  const header = screen.getByRole("button", { name: "Remove Screenshot" }).closest("header");
  expect(header.textContent).not.toMatch(/Screenshot.*Screenshot/);
  fireEvent.click(screen.getByRole("button", { name: "View screenshot full size" }));
  const viewer = screen.getByRole("dialog", { name: "Screenshot" });
  expect(viewer.querySelector("img").getAttribute("src")).toMatch(/^data:image\/png/);
  await waitFor(() => expect(document.activeElement).toBe(within(viewer).getByRole("button", { name: "Close" })));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});
