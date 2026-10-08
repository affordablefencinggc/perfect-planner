import assert from "node:assert/strict";
import test from "node:test";

import { emptyTaskDraftLedger, updateTaskDraft } from "../src/project/taskDraftLedger.js";
import { agentBrief, buildRunProgress, deriveBuildBoard, nextBuildRecord, resolveApprovedTasks } from "../src/project/projectBuildModel.js";
import { buildProjectIndex, searchProjectIndex } from "../src/project/projectIndexModel.js";
import { receiptDerivers as indexBuild } from "../src/project/receipts/indexBuild.js";
import { ledgerTasksReceipt } from "../src/project/receipts/ledger.js";
import { readTaskDraftPresence, recordTaskDraftPresence } from "../src/project/taskDraftPresence.js";
import { createMemoryStorage } from "../src/project/projectRegistry.js";
import { deriveWorkRecordReceipt } from "../src/project/workRecordReceipts.js";

const binding = { projectId: "pp_index_build", rootIdentity: "a".repeat(64), censusDigest: "b".repeat(64) };
const project = {
  projectId: binding.projectId,
  name: "Shop app",
  census: { digest: binding.censusDigest, fileCount: 120 },
  discovery: { categories: [{ id: "A02", state: "signal", findingIds: ["S013"], findingCount: 1 }] },
  authorities: { architecture: { revision: 2, state: "authoritative" }, folder: null, component: null, plan: null },
};
const base = { description: "", owner: "", acceptance: "", recovery: "", claims: [], dependsOn: [], archived: false };
function ledgerWith(...tasks) {
  return tasks.reduce((ledger, task) => updateTaskDraft(ledger, { id: null, ...base, ...task }, "2026-10-01T00:00:00.000Z"), emptyTaskDraftLedger(binding));
}
const sample = () => ledgerWith(
  { title: "Add checkout page", description: "Build the checkout form", acceptance: "Orders submit without errors", owner: "Sam", claims: [{ path: "src/checkout.jsx", access: "write" }] },
  { title: "Refactor cart", owner: "", claims: [{ path: "src/checkout.jsx", access: "write" }], dependsOn: ["T0001"] },
  { title: "Draft only", owner: "Ann" },
);
const observed = (checkedLedger) => ({ state: "observed", projectId: binding.projectId, revision: 3, checkedLedger });

test("no plan approval means no build cards, never inferred ones", () => {
  const board = deriveBuildBoard({ project, ledger: sample(), sections: {}, planStatus: null });
  assert.equal(board.approval.state, "missing");
  assert.equal(board.cards.length, 0);
  assert.equal(board.waitingDrafts, 3);
});

test("approved tasks become cards with owner, blockers and overlaps from the drafts", () => {
  const ledger = sample();
  const board = deriveBuildBoard({ project, ledger, sections: {}, planStatus: observed(ledger) });
  assert.equal(board.approval.source, "plan-approval");
  assert.equal(board.cards.length, 3);
  const [first, second] = board.cards;
  assert.equal(first.owner, "Sam");
  assert.equal(first.ownerSource, "draft");
  assert.ok(first.blockers.some((item) => item.kind === "collision" && /T0002/.test(item.text)));
  assert.ok(second.blockers.some((item) => item.kind === "owner"));
  assert.ok(second.blockers.some((item) => item.kind === "dependency" && /T0001/.test(item.text)));
  assert.equal(first.status.state, "not-started");
  assert.equal(first.status.recorded, false);
});

test("recorded allocation, resolved collisions, proof and statuses shape the cards", () => {
  const ledger = sample();
  const sections = {
    allocation: { revision: 1, data: { tasks: { T0001: { owner: "Agent One", wave: 1 }, T0002: { owner: "Agent Two", wave: 2 } } } },
    collisions: { revision: 1, data: { collisions: [{ taskIds: ["T0001", "T0002"], paths: ["src/checkout.jsx"], resolution: "serialized", note: "T0001 first" }] } },
    proof: { revision: 1, data: { items: [{ taskId: "T0001", kind: "screenshot", label: "Checkout screenshot" }] } },
    build: { revision: 1, data: { status: { T0001: { state: "done", updatedAt: "2026-10-02T00:00:00.000Z", note: "shipped" } }, approvedTaskIds: ["T0001", "T0002", "T0003"] } },
  };
  const board = deriveBuildBoard({ project, ledger, sections, planStatus: observed(ledger) });
  const [first, second] = board.cards;
  assert.equal(first.owner, "Agent One");
  assert.equal(first.wave, 1);
  assert.equal(first.blockers.length, 0);
  assert.match(first.constraints[0], /Agreed with T0002/);
  assert.deepEqual(first.proof.map((item) => item.label), ["Checkout screenshot"]);
  assert.equal(first.status.state, "done");
  assert.equal(second.blockers.length, 0, "dependency is done and collision resolved");
  assert.equal(board.counts.done, 1);
});

test("a recorded plan approval section takes precedence and a changed ledger is flagged", () => {
  const ledger = sample();
  const recorded = resolveApprovedTasks({ project, ledger, sections: { planAuthority: { revision: 4, data: { approvedTaskIds: ["T0001"] } } }, planStatus: null });
  assert.deepEqual(recorded.taskIds, ["T0001"]);
  const older = ledgerWith({ title: "Add checkout page" });
  const changed = resolveApprovedTasks({ project, ledger, sections: {}, planStatus: observed(older) });
  assert.equal(changed.changed, true);
  assert.deepEqual(changed.taskIds, ["T0001"]);
});

test("status updates are validated and BUILD-RUN is recorded only when every approved task is done", () => {
  const approved = ["T0001", "T0002"];
  assert.throws(() => nextBuildRecord(null, { taskId: "T0009", state: "done", approvedTaskIds: approved }), /approved/);
  assert.throws(() => nextBuildRecord(null, { taskId: "T0001", state: "finished", approvedTaskIds: approved }), /valid status/);
  let data = nextBuildRecord(null, { taskId: "T0001", state: "done", note: " ok ", approvedTaskIds: approved, now: "2026-10-03T00:00:00.000Z" });
  assert.deepEqual(data.status.T0001, { state: "done", updatedAt: "2026-10-03T00:00:00.000Z", note: "ok" });
  assert.equal(indexBuild["BUILD-RUN"]({}), null);
  assert.equal(indexBuild["BUILD-RUN"]({ build: { data } }).state, "review");
  data = nextBuildRecord(data, { taskId: "T0002", state: "done", approvedTaskIds: approved });
  const done = indexBuild["BUILD-RUN"]({ build: { data } });
  assert.equal(done.state, "recorded");
  assert.match(done.detail, /2 of 2/);
  assert.equal(buildRunProgress({ build: { data }, planAuthority: { data: { approvedTaskIds: ["T0001"] } } }).approvalChanged, true);
  assert.equal(indexBuild["BUILD-RUN"]({ build: { data }, planAuthority: { data: { approvedTaskIds: ["T0001"] } } }).state, "stale");
});

test("the agent brief names files, criteria, owner, constraints and how to report proof", () => {
  const ledger = sample();
  const board = deriveBuildBoard({ project, ledger, sections: {}, planStatus: observed(ledger) });
  const brief = agentBrief(board.cards[0], { projectName: "Shop app" });
  assert.match(brief, /Task T0001: Add checkout page/);
  assert.match(brief, /src\/checkout\.jsx \(may change\)/);
  assert.match(brief, /Orders submit without errors/);
  assert.match(brief, /Owner: Sam/);
  assert.match(brief, /same files as T0002/);
  assert.match(brief, /How to report back/);
  const empty = agentBrief(board.cards[2], {});
  assert.match(empty, /No files were named/);
  assert.match(empty, /No acceptance criteria were written/);
});

test("the index searches tasks, areas, saved plans, proof, named files and build notes", () => {
  const sections = {
    proof: { data: { items: [{ taskId: "T0001", label: "Checkout screenshot", kind: "screenshot" }] } },
    build: { data: { status: { T0002: { state: "blocked", note: "waiting on payments api" } } } },
  };
  const index = buildProjectIndex({ project, ledger: sample(), sections });
  assert.equal(index.counts.task, 3);
  assert.equal(index.counts.area, 8);
  assert.equal(index.counts.saved, 1);
  assert.equal(index.counts.proof, 1);
  assert.equal(index.counts.file, 1);
  assert.equal(index.counts.build, 1);
  const first = (query) => searchProjectIndex(index, query)[0];
  assert.equal(first("orders submit").id, "T0001");
  assert.equal(first("orders submit").workspace, "ledger");
  assert.equal(first("framework").workspace, "structure");
  assert.equal(first("blueprint").workspace, "blueprint");
  assert.equal(first("checkout screenshot").workspace, "evidence");
  assert.equal(first("src/checkout.jsx").kind, "file");
  assert.equal(first("payments").workspace, "build");
  assert.deepEqual(searchProjectIndex(index, "  "), []);
  assert.deepEqual(searchProjectIndex(index, "kubernetes"), []);
});

test("INDEX-BUILD needs a census; LEDGER-TASKS needs at least one saved draft for this scan", () => {
  assert.equal(indexBuild["INDEX-BUILD"]({}, { project: { census: null } }), null);
  assert.equal(indexBuild["INDEX-BUILD"]({}, { project }).state, "recorded");
  const storage = createMemoryStorage();
  assert.equal(ledgerTasksReceipt({}, { project }, storage), null);
  recordTaskDraftPresence(project.projectId, emptyTaskDraftLedger(binding), { storage });
  assert.equal(ledgerTasksReceipt({}, { project }, storage), null);
  assert.equal(recordTaskDraftPresence(project.projectId, sample(), { storage }), true);
  assert.equal(recordTaskDraftPresence(project.projectId, sample(), { storage }), false, "unchanged summary is not rewritten");
  assert.equal(readTaskDraftPresence(project.projectId, storage).active, 3);
  const receipt = ledgerTasksReceipt({}, { project }, storage);
  assert.equal(receipt.state, "recorded");
  assert.match(receipt.detail, /3 task drafts active/);
  assert.equal(ledgerTasksReceipt({}, { project: { ...project, census: { digest: "c".repeat(64) } } }, storage).state, "review");
  assert.equal(deriveWorkRecordReceipt("INDEX-BUILD", null, { project }).state, "recorded");
});
