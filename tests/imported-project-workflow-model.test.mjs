import "./helpers/hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { deriveImportedProjectWorkflowModel } from "../src/project/importedProjectWorkflowModel.js";
import { workflowNextAction } from "../src/project/workflowNextAction.js";
import { assessCompletion } from "../src/engine/proofEngine.js";
import { ownerSummary } from "../src/project/integritySummary.js";
import { createProjectEntityId } from "../src/project/projectIds.js";
import { createImportedProjectSession, createProjectSession, projectAuthorityKinds, withProjectState } from "../src/project/projectSession.js";

const AT = "2026-09-04T11:00:00.000Z";

function importedProject({ completeDiscovery = false, skipped = 0 } = {}) {
  const rootIdentity = "a".repeat(64);
  return createImportedProjectSession({
    name: "Customer Atlas",
    adapter: "native",
    now: AT,
    registration: {
      access: "metadata-read-only",
      canonicalRoot: "C:\\private\\customers\\Customer Atlas",
      registryRevision: 6,
      rootIdentity,
      workspaceId: "customer-atlas",
    },
    census: {
      digest: "b".repeat(64),
      fileCount: 463,
      generatedEpochMs: Date.parse(AT),
      registryRevision: 6,
      rootIdentity,
      skipped: Array.from({ length: skipped }, (_, index) => ({ path: `hidden-${index}`, reason: "permission" })),
      totalBytesHashed: 8192,
      workspaceId: "customer-atlas",
    },
    discovery: completeDiscovery
      ? {
          state: "generated",
          generatedAt: AT,
          counts: { observed: 8, signals: 0, unanswered: 0 },
          categories: Array.from({ length: 8 }, (_, index) => ({ id: `A${String(index + 1).padStart(2, "0")}`, state: "observed", findings: [{ id: `S${String(index + 1).padStart(3, "0")}` }] })),
        }
      : {
          state: "generated",
          generatedAt: AT,
          counts: { observed: 1, signals: 1, unanswered: 6 },
          categories: [
            { id: "A01", state: "observed", findings: [{ id: "S001" }] },
            { id: "A02", state: "signal", findings: [{ id: "S013" }] },
          ],
        },
  });
}

function withAuthorities(session, { includePlan = true } = {}) {
  const entityTypes = { architecture: "map", folder: "folder", component: "component", plan: "plan" };
  const authorities = Object.fromEntries(projectAuthorityKinds.map((kind, index) => [kind, !includePlan && kind === "plan" ? null : {
    digest: String(index + 2).repeat(64),
    entityId: createProjectEntityId(session.projectId, entityTypes[kind], kind),
    recordedAt: AT,
    revision: index + 1,
    state: "authoritative",
  }]));
  return createProjectSession({
    projectId: session.projectId,
    name: session.name,
    kind: session.kind,
    state: includePlan ? "authoritative" : "generated",
    registration: session.registration,
    census: session.census,
    discovery: session.discovery,
    authorities,
    generation: session.generation + 1,
    createdAt: session.createdAt,
    updatedAt: "2026-09-04T11:01:00.000Z",
    view: session.view,
  });
}

test("an imported Plan is an explicit question set rather than Demo work", () => {
  const model = deriveImportedProjectWorkflowModel(importedProject(), "plan");

  assert.equal(model.copy.title, "Planning intake");
  assert.equal(model.pageState, "unanswered");
  assert.equal(model.questions.length, 8);
  assert.equal(model.questions.find((item) => item.id === "A01").state, "recorded");
  assert.equal(model.questions.find((item) => item.id === "A02").state, "review");
  assert.equal(model.questions.find((item) => item.id === "A08").state, "unanswered");
  assert.equal(model.requirements.find((item) => item.id === "REC-DISCOVERY").state, "review");
  assert.equal(model.requirements.find((item) => item.id === "AUTH-PLAN").state, "unanswered");
  assert.equal(model.nextAction.workspace, "structure");
  assert.doesNotMatch(JSON.stringify(model), /B01|Build Agent|Perfect Planner sample|P80|3 branches/);
  assert.doesNotMatch(JSON.stringify(model), /C:\\private/);
});

test("downstream pages never turn absent operational receipts into confident zeros", () => {
  const project = withAuthorities(importedProject({ completeDiscovery: true }));
  const collision = deriveImportedProjectWorkflowModel(project, "collision");
  const allocation = deriveImportedProjectWorkflowModel(project, "allocation");
  const build = deriveImportedProjectWorkflowModel(project, "build");
  const evidence = deriveImportedProjectWorkflowModel(project, "evidence");
  const integrity = deriveImportedProjectWorkflowModel(project, "integrity");

  assert.equal(collision.requirements.find((item) => item.id === "COL-EVALUATION").state, "unanswered");
  assert.match(collision.requirements.find((item) => item.id === "COL-EVALUATION").detail, /not been checked/);
  assert.equal(allocation.requirements.find((item) => item.id === "ALLOC-OWNERS").state, "unanswered");
  assert.equal(build.requirements.find((item) => item.id === "BUILD-RUN").state, "unanswered");
  assert.equal(evidence.requirements.find((item) => item.id === "PROOF-SCREENSHOT").state, "unanswered");
  assert.equal(integrity.requirements.find((item) => item.id === "INT-MERGED").state, "unanswered");
  for (const model of [collision, allocation, build, evidence, integrity]) {
    assert.equal(model.pageState, "unanswered");
    assert.doesNotMatch(JSON.stringify(model), /0 collisions|0 owners|0 builds|proof complete/i);
  }
});

test("the Ledger and Index expose current project receipts plus their missing authorities", () => {
  const project = withAuthorities(importedProject({ completeDiscovery: true }), { includePlan: false });
  const ledger = deriveImportedProjectWorkflowModel(project, "ledger");
  const index = deriveImportedProjectWorkflowModel(project, "index");

  assert.equal(ledger.requirements.find((item) => item.id === "REC-CENSUS").state, "recorded");
  assert.equal(ledger.requirements.find((item) => item.id === "AUTH-PLAN").state, "unanswered");
  assert.equal(ledger.requirements.find((item) => item.id === "LEDGER-TASKS").state, "unanswered");
  // The project search is computed from current records, so it exists once a folder census does.
  assert.equal(index.requirements.find((item) => item.id === "INDEX-BUILD").state, "recorded");
  assert.equal(index.questions.length, 8);
  assert.equal(index.binding.projectId, project.projectId);
  assert.equal(index.binding.censusDigest, project.census.digest);
});

test("stale and unavailable project state overrides previously recorded receipts", () => {
  const current = withAuthorities(importedProject({ completeDiscovery: true }));
  const stale = withProjectState(current, "stale", { now: "2026-09-04T11:02:00.000Z", reason: "folder-changed" });
  const unavailable = withProjectState(current, "unavailable", { now: "2026-09-04T11:03:00.000Z", reason: "access-revoked" });

  const staleModel = deriveImportedProjectWorkflowModel(stale, "plan");
  const unavailableModel = deriveImportedProjectWorkflowModel(unavailable, "ledger");
  const unavailableCollision = deriveImportedProjectWorkflowModel(unavailable, "collision");
  assert.equal(staleModel.pageState, "stale");
  assert.ok(staleModel.requirements.every((item) => item.state === "stale"));
  assert.equal(unavailableModel.pageState, "unavailable");
  assert.ok(unavailableModel.requirements.every((item) => item.state === "unavailable"));
  assert.ok(unavailableCollision.requirements.every((item) => item.state === "unavailable"));
});

test("rejects unsupported routes and Demo sessions instead of falling back", () => {
  const project = importedProject();
  assert.throws(() => deriveImportedProjectWorkflowModel(project, "release"), /Unsupported imported-project workspace/);
  assert.throws(() => deriveImportedProjectWorkflowModel({ ...project, kind: "demo", state: "demo" }, "plan"));
});

test("proof pages with no tasks send people to plan tasks instead of a dead end (proverel-21)", () => {
  const open = [{ id: "PROOF-SCREENSHOT", label: "Screenshots", state: "unanswered", detail: "No screenshot has been added for any task yet." }];
  assert.deepEqual(
    { label: workflowNextAction("evidence", open, { taskCount: 0 }).label, workspace: workflowNextAction("evidence", open, { taskCount: 0 }).workspace },
    { label: "Plan tasks in Ledger", workspace: "ledger" },
  );
  assert.equal(workflowNextAction("integrity", [{ id: "INT-PROOF", label: "Proof", state: "unanswered" }], { taskCount: 0 }).workspace, "ledger");
  // Unknown or non-zero task counts keep the original routing.
  assert.equal(workflowNextAction("evidence", open).label, "Review Screenshots");
  assert.equal(workflowNextAction("evidence", open, { taskCount: 2 }).label, "Review Screenshots");
  // An earlier requirement owned by another page still wins.
  assert.equal(workflowNextAction("evidence", [{ id: "REC-CENSUS", label: "Scan", state: "unanswered" }, ...open], { taskCount: 0 }).workspace, "structure");
});

test("counts read as English for one and for zero (proverel-23)", () => {
  const model = deriveImportedProjectWorkflowModel(importedProject(), "ledger");
  const discovery = model.requirements.find((item) => item.id === "REC-DISCOVERY");
  assert.match(discovery.detail, /1 review signal ·/);
  assert.ok(assessCompletion({ items: [], openGates: 1 }).reasons.includes("1 collision gate remains open"));
  assert.ok(assessCompletion({ items: [], openGates: 2 }).reasons.includes("2 collision gates remain open"));
  assert.equal(ownerSummary(null, [], { tasks: [] }).text, "Owners are not assigned in Allocation yet.");
  assert.equal(ownerSummary(null, ["T0001"], { tasks: [{ id: "T0001", owner: "" }] }).text, "Owners are not assigned in Allocation yet. The task draft does not name an owner.");
});
