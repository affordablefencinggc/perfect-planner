import "./helpers/hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { confirmProjectReady, digestPlanTasks, notePlanTaskDrift, planApprovalStatus, recordPlanApproval } from "../src/project/planApproval.js";
import { readWorkRecords, writeSection } from "../src/project/projectWorkRecords.js";
import { deriveImportedProjectWorkflowModel } from "../src/project/importedProjectWorkflowModel.js";
import { deriveProjectHomeModel } from "../src/project/projectHomeModel.js";
import { createProjectEntityId } from "../src/project/projectIds.js";
import { createImportedProjectSession, createProjectSession, projectAuthorityKinds } from "../src/project/projectSession.js";

const AT = "2026-10-01T09:00:00.000Z";
const memoryStorage = () => { const map = new Map(); return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: (key) => map.delete(key) }; };
let tick = 0;
const now = () => new Date(Date.parse(AT) + (tick++) * 1000).toISOString();

const task = (id, title, extra = {}) => ({ id, title, description: `${title} description`, owner: "Dana", acceptance: "Works", recovery: "Revert", claims: [{ access: "write", path: `src/${id}.js` }], dependsOn: [], archived: false, ...extra });
const TASKS = [task("T0001", "Add login form"), task("T0002", "Store sessions"), task("T0003", "Old idea", { archived: true })];

function project({ plan = false } = {}) {
  const rootIdentity = "e".repeat(64);
  const base = createImportedProjectSession({
    name: "Plan Approval App",
    adapter: "native",
    now: AT,
    registration: { access: "metadata-read-only", canonicalRoot: "C:\\private\\plan-approval", registryRevision: 4, rootIdentity, workspaceId: "plan-approval" },
    census: { digest: "f".repeat(64), fileCount: 12, generatedEpochMs: Date.parse(AT), registryRevision: 4, rootIdentity, skipped: [], totalBytesHashed: 1024, workspaceId: "plan-approval" },
    discovery: {
      state: "generated", generatedAt: AT, counts: { observed: 8, signals: 0, unanswered: 0 },
      categories: Array.from({ length: 8 }, (_, index) => ({ id: `A${String(index + 1).padStart(2, "0")}`, state: "observed", findings: [{ id: `S${String(index + 1).padStart(3, "0")}` }] })),
    },
  });
  const types = { architecture: "map", folder: "folder", component: "component", plan: "plan" };
  const authorities = Object.fromEntries(projectAuthorityKinds.map((kind, index) => [kind, kind === "plan" && !plan ? null : {
    digest: String(index + 2).repeat(64), entityId: createProjectEntityId(base.projectId, types[kind], kind), recordedAt: AT, revision: index + 1, state: "authoritative",
  }]));
  return createProjectSession({ projectId: base.projectId, name: base.name, kind: base.kind, state: "generated", registration: base.registration, census: base.census, discovery: base.discovery, authorities, generation: base.generation + 1, createdAt: base.createdAt, updatedAt: AT, view: base.view });
}

test("approving snapshots active task ids, titles, count and a SHA-256 of their canonical JSON", async () => {
  const storage = memoryStorage(), session = project();
  const record = await recordPlanApproval(session.projectId, { tasks: TASKS, censusDigest: session.census.digest }, { storage, now });
  assert.equal(record.revision, 1);
  assert.deepEqual(record.data.taskIds, ["T0001", "T0002"]);
  assert.deepEqual(record.data.tasks, [{ id: "T0001", title: "Add login form" }, { id: "T0002", title: "Store sessions" }]);
  assert.equal(record.data.taskCount, 2);
  assert.equal(record.data.source, "local-approval");
  assert.match(record.data.planDigest, /^[0-9a-f]{64}$/);
  assert.equal(record.data.planDigest, await digestPlanTasks(TASKS));
  // Key order does not change the fingerprint; content does.
  assert.equal(await digestPlanTasks([Object.fromEntries(Object.entries(TASKS[0]).reverse()), TASKS[1]]), record.data.planDigest);
  assert.notEqual(await digestPlanTasks([{ ...TASKS[0], title: "Add sign-in form" }, TASKS[1]]), record.data.planDigest);

  // Re-approving identical tasks is not a new revision.
  const again = await recordPlanApproval(session.projectId, { tasks: TASKS, censusDigest: session.census.digest }, { storage, now });
  assert.equal(again.revision, 1);
  await assert.rejects(recordPlanApproval(session.projectId, { tasks: [TASKS[2]] }, { storage, now }), /at least one task/);
});

test("AUTH-PLAN and LEDGER-TASKS derive from the saved approval; absence stays unanswered", async () => {
  const storage = memoryStorage(), session = project();
  const before = deriveImportedProjectWorkflowModel(session, "ledger", readWorkRecords(session.projectId, storage));
  assert.equal(before.requirements.find((item) => item.id === "AUTH-PLAN").state, "unanswered");
  assert.equal(before.requirements.find((item) => item.id === "LEDGER-TASKS").state, "unanswered");

  await recordPlanApproval(session.projectId, { tasks: TASKS, censusDigest: session.census.digest }, { storage, now });
  const records = readWorkRecords(session.projectId, storage);
  const plan = deriveImportedProjectWorkflowModel(session, "plan", records);
  const auth = plan.requirements.find((item) => item.id === "AUTH-PLAN");
  assert.equal(auth.state, "recorded");
  assert.match(auth.detail, /2 tasks approved on this device/);
  assert.equal(plan.pageState, "recorded");
  assert.equal(plan.nextAction.workspace, "collision");
  const ledger = deriveImportedProjectWorkflowModel(session, "ledger", records);
  assert.equal(ledger.requirements.find((item) => item.id === "LEDGER-TASKS").state, "recorded");
  assert.match(ledger.requirements.find((item) => item.id === "LEDGER-TASKS").detail, /T0001 Add login form/);
});

test("changed tasks put the plan back into review until approved again", async () => {
  const storage = memoryStorage(), session = project();
  await recordPlanApproval(session.projectId, { tasks: TASKS, censusDigest: session.census.digest }, { storage, now });
  assert.equal(await notePlanTaskDrift(session.projectId, TASKS, { storage, now }), null, "unchanged tasks write nothing");

  const edited = [{ ...TASKS[0], title: "Add sign-in form" }, TASKS[1]];
  const drift = await notePlanTaskDrift(session.projectId, edited, { storage, now });
  assert.ok(drift.data.tasksChangedAt);
  let records = readWorkRecords(session.projectId, storage);
  const status = planApprovalStatus(session, records);
  assert.equal(status.state, "review");
  assert.match(status.detail, /Tasks changed since approval/);
  const auth = deriveImportedProjectWorkflowModel(session, "collision", records).requirements.find((item) => item.id === "AUTH-PLAN");
  assert.equal(auth.state, "review");
  const home = deriveProjectHomeModel(session, records);
  assert.equal(home.stage.id, "plan");
  assert.equal(home.stage.label, "Tasks changed since approval");
  assert.equal(home.nextAction.workspace, "plan");
  assert.throws(() => confirmProjectReady(session.projectId, { storage, now }), /Tasks changed/);

  // Reverting to exactly the approved tasks clears the flag; approving the edit records a new snapshot.
  await notePlanTaskDrift(session.projectId, TASKS, { storage, now });
  assert.equal(planApprovalStatus(session, readWorkRecords(session.projectId, storage)).state, "recorded");
  await notePlanTaskDrift(session.projectId, edited, { storage, now });
  const reapproved = await recordPlanApproval(session.projectId, { tasks: edited, censusDigest: session.census.digest }, { storage, now });
  assert.equal(reapproved.data.tasksChangedAt, null);
  records = readWorkRecords(session.projectId, storage);
  assert.equal(planApprovalStatus(session, records).state, "recorded");
});

test("a new folder scan or unreadable record never counts as approved", async () => {
  const storage = memoryStorage(), session = project();
  await recordPlanApproval(session.projectId, { tasks: TASKS, censusDigest: "0".repeat(64) }, { storage, now });
  const stale = planApprovalStatus(session, readWorkRecords(session.projectId, storage));
  assert.equal(stale.state, "stale");
  assert.match(stale.detail, /folder scan changed/);
  assert.equal(deriveProjectHomeModel(session, readWorkRecords(session.projectId, storage)).stage.state, "stale");

  writeSection(session.projectId, "planAuthority", { planDigest: "nope" }, { storage, now });
  const records = readWorkRecords(session.projectId, storage);
  assert.equal(planApprovalStatus(session, records).state, "unavailable");
  assert.equal(deriveImportedProjectWorkflowModel(session, "plan", records).requirements.find((item) => item.id === "AUTH-PLAN").state, "unavailable");
  assert.equal(deriveProjectHomeModel(session, records).stage.id, "plan");
});

test("Home reaches promotion, then Ready only after an explicit confirmation", async () => {
  const storage = memoryStorage(), session = project();
  const none = deriveProjectHomeModel(session, readWorkRecords(session.projectId, storage));
  assert.equal(none.stage.id, "plan");
  assert.equal(none.nextAction.id, "approve-plan");
  assert.equal(none.nextAction.workspace, "plan");

  await recordPlanApproval(session.projectId, { tasks: TASKS, censusDigest: session.census.digest }, { storage, now });
  const promotion = deriveProjectHomeModel(session, readWorkRecords(session.projectId, storage));
  assert.equal(promotion.stage.id, "promotion");
  assert.equal(promotion.nextAction.id, "confirm-project-ready");
  assert.equal(promotion.nextAction.label, "Confirm project is ready");
  assert.equal(promotion.nextAction.workspace, null, "confirmation is an action, not a route back to Home");
  assert.equal(promotion.summary.authorities.plan.state, "authoritative");

  const confirmed = confirmProjectReady(session.projectId, { storage, now });
  assert.ok(confirmed.data.confirmedAt);
  const ready = deriveProjectHomeModel(session, readWorkRecords(session.projectId, storage));
  assert.equal(ready.stage.id, "ready");
  assert.equal(ready.blockers.length, 0);

  // Changing the tasks after confirmation drops back to plan review.
  await notePlanTaskDrift(session.projectId, [TASKS[0]], { storage, now });
  assert.equal(deriveProjectHomeModel(session, readWorkRecords(session.projectId, storage)).stage.id, "plan");
});

test("a session-level plan authority without a saved approval still needs approval before readiness", () => {
  const session = project({ plan: true });
  const home = deriveProjectHomeModel(session, null);
  assert.equal(home.stage.id, "promotion");
  assert.equal(home.nextAction.id, "approve-plan");
  assert.equal(home.nextAction.workspace, "plan");
});

test("Next honest action never routes to the page that is already open", async () => {
  const storage = memoryStorage(), session = project();
  const workspaces = ["plan", "collision", "allocation", "build", "evidence", "integrity", "ledger", "index"];
  for (const records of [null, readWorkRecords(session.projectId, storage)]) {
    for (const workspace of workspaces) {
      const { nextAction } = deriveImportedProjectWorkflowModel(session, workspace, records);
      assert.notEqual(nextAction.workspace, workspace, `${workspace} routes to itself`);
      if (nextAction.workspace === null) assert.ok(nextAction.target, `${workspace} in-page action names its target`);
    }
  }
  const plan = deriveImportedProjectWorkflowModel(session, "plan", null).nextAction;
  assert.deepEqual([plan.workspace, plan.target, plan.label], [null, "AUTH-PLAN", "Review Plan approval"]);
  const collision = deriveImportedProjectWorkflowModel(session, "collision", null).nextAction;
  assert.deepEqual([collision.workspace, collision.target], ["plan", "AUTH-PLAN"]);

  await recordPlanApproval(session.projectId, { tasks: TASKS, censusDigest: session.census.digest }, { storage, now });
  const afterApproval = deriveImportedProjectWorkflowModel(session, "allocation", readWorkRecords(session.projectId, storage)).nextAction;
  assert.deepEqual([afterApproval.workspace, afterApproval.target], ["collision", "ALLOC-CLEARANCE"]);
});

test("the person's plan approval and the ledger-bound saved-plan check have distinct, consistent wording (gap 17)", async () => {
  const { savedPlanCheckText, SAVED_PLAN_CHECK_ACTION } = await import("../src/project/planApproval.js");
  const storage = memoryStorage(), session = project();
  assert.equal(SAVED_PLAN_CHECK_ACTION, "Run saved-plan check");
  // Nothing approved: never "not checked" as if a check were the missing piece.
  const none = savedPlanCheckText({ check: null, approval: planApprovalStatus(session, readWorkRecords(session.projectId, storage)) });
  assert.equal(none.text, "No plan approved yet. Approve the plan on the Plan page first.");
  // Approved by the person, check not run: says so plainly.
  await recordPlanApproval(session.projectId, { tasks: TASKS, censusDigest: session.census.digest }, { storage, now });
  const approval = planApprovalStatus(session, readWorkRecords(session.projectId, storage));
  for (const check of [null, { state: "stale", projectId: session.projectId, reason: "ledger-context-changed" }]) {
    const copy = savedPlanCheckText({ check, approval });
    assert.equal(copy.text, "Plan approved. Run the saved-plan check to lock it to this exact Ledger.");
    assert.equal(copy.approvedByYou, true);
    assert.doesNotMatch(copy.text, /not checked/i);
  }
  assert.match(savedPlanCheckText({ check: null, approval }).explainer, /^Saved-plan check:/);
  assert.match(savedPlanCheckText({ check: null, approval }).explainer, /never runs/);
  // A passed check is named the same way everywhere.
  const passed = savedPlanCheckText({ check: { state: "observed", revision: 3, ledgerRevision: 7 }, approval, checked: true });
  assert.equal(passed.text, "Saved-plan check passed: planning approval revision 3 matches this exact saved Ledger (revision 7). Planning only; nothing was run.");
  // A check that ran but could not match the current records keeps the approval and says what is missing.
  const notMatched = savedPlanCheckText({ check: { state: "stale", projectId: session.projectId, rootIdentity: session.registration.rootIdentity }, approval });
  assert.match(notMatched.text, /^Plan approved\. The saved-plan check could not lock it/);
  const noLedgerApproval = savedPlanCheckText({ check: { state: "missing" }, approval });
  assert.match(noLedgerApproval.text, /^Plan approved\./);
  assert.match(savedPlanCheckText({ check: { state: "refreshing" }, approval }).text, /Running the saved-plan check/);
});
