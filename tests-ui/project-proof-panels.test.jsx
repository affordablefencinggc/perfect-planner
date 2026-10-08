import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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
  await screen.findByText(/Signed off by Ana Ruiz on .* for this version of the plan/);
  const review = readSection(project.projectId, "review", storage).data;
  expect(review).toMatchObject({ reviewer: "Ana Ruiz", signedAt: "2026-10-08T09:00:00.000Z", taskIds: ["T0001", "T0002"], proofAtSignOff: { complete: 0, total: 2 } });
  expect(deriveWorkRecordReceipt("INT-REVIEW", { sections: { review: readSection(project.projectId, "review", storage) } }).state).toBe("recorded");

  fireEvent.click(screen.getByRole("button", { name: "Open Evidence" }));
  expect(onWorkspace).toHaveBeenCalledWith("evidence");
});
