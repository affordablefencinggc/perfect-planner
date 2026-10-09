import "./helpers/hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { createDemoProjectSession } from "../src/demo/demoProject.js";
import { createProjectEntityId } from "../src/project/projectIds.js";
import { deriveProjectHomeModel } from "../src/project/projectHomeModel.js";
import { createImportedProjectSession, createProjectSession, projectAuthorityKinds, withProjectState } from "../src/project/projectSession.js";

const at = "2026-09-04T10:00:00.000Z";

function discovery({ signals = 0, unanswered = 0 } = {}) {
  const categories = [{ id: "A01", state: "observed", findings: [{ id: "S001" }] }];
  if (signals > 0) categories.push({ id: "A02", state: "signal", findings: Array.from({ length: signals }, (_, index) => ({ id: `S01${index + 3}` })) });
  if (unanswered > 0) categories.push(...Array.from({ length: unanswered }, (_, index) => ({ id: `A${String(index + 3).padStart(2, "0")}`, state: "unanswered", findings: [] })));
  return { categories, counts: { observed: 1, signals, unanswered }, state: "generated", generatedAt: at };
}

function imported(seed, {
  name = `Project ${seed.toUpperCase()}`,
  fileCount = 7,
  skippedCount = 0,
  discovery: discoveryInput = null,
  census = true,
  registryRevision = 3,
} = {}) {
  const rootIdentity = seed.repeat(64);
  const digestCharacter = seed === "a" ? "1" : seed === "b" ? "2" : seed === "c" ? "3" : "4";
  return createImportedProjectSession({
    name,
    adapter: "native",
    now: at,
    registration: {
      access: "metadata-read-only",
      canonicalRoot: `C:\\private\\home-model\\${name}`,
      registryRevision,
      rootIdentity,
      workspaceId: `workspace-${seed}${seed}`,
    },
    census: census ? {
      digest: digestCharacter.repeat(64),
      fileCount,
      generatedEpochMs: Date.parse(at),
      registryRevision,
      rootIdentity,
      skipped: Array.from({ length: skippedCount }, (_, index) => ({ path: `unreadable-${index}`, reason: "permission" })),
      totalBytesHashed: fileCount * 512,
      workspaceId: `workspace-${seed}${seed}`,
    } : null,
    discovery: discoveryInput,
  });
}

function withAuthorities(session, { sessionState = "authoritative", authorityState = "authoritative" } = {}) {
  const entityTypeByAuthority = {
    architecture: "map",
    folder: "folder",
    component: "component",
    plan: "plan",
  };
  const authorities = Object.fromEntries(projectAuthorityKinds.map((kind, index) => [kind, {
    digest: String(index + 5).repeat(64),
    entityId: createProjectEntityId(session.projectId, entityTypeByAuthority[kind], kind),
    recordedAt: at,
    revision: index + 1,
    state: authorityState,
  }]));
  return createProjectSession({
    projectId: session.projectId,
    name: session.name,
    kind: session.kind,
    state: sessionState,
    registration: session.registration,
    census: session.census,
    discovery: session.discovery,
    authorities,
    view: session.view,
    generation: session.generation + 1,
    createdAt: session.createdAt,
    updatedAt: "2026-09-04T10:30:00.000Z",
  });
}

function assertOneAction(model) {
  assert.equal(Array.isArray(model.nextAction), false);
  assert.deepEqual(Object.keys(model.nextAction).sort(), ["id", "label", "reason", "workspace"]);
  assert.ok(model.nextAction.id);
  assert.ok(model.nextAction.label);
}

test("empty, Demo, imported, generated, and authoritative sessions select distinct honest stages", () => {
  const empty = deriveProjectHomeModel(null);
  assert.equal(empty.mode, "empty");
  assert.equal(empty.stage.id, "empty");
  assert.equal(empty.summary.census.fileCount, null);
  assert.equal(empty.summary.census.state, "unavailable");
  assert.equal(empty.nextAction.id, "select-project");

  const demo = deriveProjectHomeModel(createDemoProjectSession({ now: at }));
  assert.equal(demo.mode, "demo");
  assert.equal(demo.stage.id, "demo");
  assert.equal(demo.nextAction.id, "select-real-project");
  assert.doesNotMatch(JSON.stringify(demo), /PP-014|B07|3 branches|1 queued/);

  const importedOnly = deriveProjectHomeModel(imported("a"));
  assert.equal(importedOnly.mode, "imported");
  assert.equal(importedOnly.stage.id, "discovery");
  assert.equal(importedOnly.nextAction.id, "generate-discovery");
  assert.equal(importedOnly.summary.discovery.observed, null);
  assert.equal(importedOnly.summary.discovery.state, "unavailable");

  const generatedSession = imported("b", { discovery: discovery() });
  const generated = deriveProjectHomeModel(generatedSession);
  assert.equal(generated.mode, "generated");
  assert.equal(generated.stage.id, "architecture");
  assert.equal(generated.nextAction.id, "generate-architecture-authority");

  const authoritative = deriveProjectHomeModel(withAuthorities(generatedSession));
  assert.equal(authoritative.mode, "authoritative");
  assert.deepEqual(authoritative.stage, { id: "ready", state: "ready", label: "Project status ready" });
  assert.equal(authoritative.blockers.length, 0);
  assert.equal(authoritative.nextAction.id, "open-authoritative-plan");

  [empty, demo, importedOnly, generated, authoritative].forEach(assertOneAction);
});

test("missing census facts remain null and unavailable instead of becoming zero or ready", () => {
  const model = deriveProjectHomeModel(imported("c", { census: false }));
  assert.equal(model.stage.id, "census");
  assert.equal(model.stage.state, "unavailable");
  assert.equal(model.summary.census.fileCount, null);
  assert.equal(model.summary.census.skippedCount, null);
  assert.equal(model.summary.census.digest, null);
  assert.equal(model.summary.census.state, "unavailable");
  assert.ok(model.blockers.some((item) => item.id === "census-missing"));
  assert.equal(model.nextAction.id, "capture-census");
  assert.doesNotMatch(JSON.stringify(model), /C:\\\\private|PP-014|B07/);
});

test("skipped census items block promotion even when every authority says authoritative", () => {
  const incomplete = imported("a", { name: "Incomplete Census", skippedCount: 2, discovery: discovery() });
  const adversarial = withAuthorities(incomplete);
  const model = deriveProjectHomeModel(adversarial);
  assert.equal(model.mode, "authoritative");
  assert.equal(model.stage.id, "census-review");
  assert.equal(model.stage.state, "blocked");
  assert.equal(model.nextAction.id, "resolve-skipped-files");
  assert.ok(model.blockers.some((item) => item.id === "census-skipped-files"));
  assert.notEqual(model.stage.state, "ready");
});

test("discovery signals and unanswered areas block promotion ahead of authoritative receipts", () => {
  const needsReview = imported("b", { name: "Review Signals", discovery: discovery({ signals: 2, unanswered: 1 }) });
  const adversarial = withAuthorities(needsReview);
  const model = deriveProjectHomeModel(adversarial);
  assert.equal(model.stage.id, "discovery-review");
  assert.equal(model.stage.state, "review");
  assert.equal(model.nextAction.id, "review-discovery");
  assert.ok(model.blockers.some((item) => item.id === "discovery-signals-unreviewed"));
  assert.ok(model.blockers.some((item) => item.id === "discovery-questions-unanswered"));
  assert.notEqual(model.stage.state, "ready");
});

test("models are immutable and stay bound to exactly one project and revision", () => {
  const projectA = imported("a", { name: "Isolation Alpha", fileCount: 11, discovery: discovery(), registryRevision: 4 });
  const projectB = imported("b", { name: "Isolation Beta", fileCount: 29, discovery: discovery(), registryRevision: 8 });
  const alpha = deriveProjectHomeModel(projectA);
  const beta = deriveProjectHomeModel(projectB);

  assert.equal(alpha.binding.projectId, projectA.projectId);
  assert.equal(alpha.binding.registryRevision, 4);
  assert.equal(alpha.binding.censusDigest, "1".repeat(64));
  assert.equal(beta.binding.projectId, projectB.projectId);
  assert.equal(beta.binding.registryRevision, 8);
  assert.equal(beta.binding.censusDigest, "2".repeat(64));
  assert.equal(alpha.summary.census.fileCount, 11);
  assert.equal(beta.summary.census.fileCount, 29);
  assert.doesNotMatch(JSON.stringify(alpha), new RegExp(projectB.projectId));
  assert.doesNotMatch(JSON.stringify(alpha), new RegExp("2".repeat(64)));
  assert.doesNotMatch(JSON.stringify(beta), new RegExp(projectA.projectId));
  assert.doesNotMatch(JSON.stringify(beta), new RegExp("1".repeat(64)));
  assert.equal(Object.isFrozen(alpha), true);
  assert.equal(Object.isFrozen(alpha.binding.authorityRevisions), true);
  assert.equal(Object.isFrozen(alpha.blockers), true);
  assert.throws(() => { alpha.stage.state = "ready"; }, TypeError);
});

test("stale and unavailable session states override fully authoritative underlying receipts", () => {
  const ready = withAuthorities(imported("c", { name: "Adversarial State", discovery: discovery() }));
  assert.equal(deriveProjectHomeModel(ready).stage.state, "ready");

  const staleSession = withProjectState(ready, "stale", { now: "2026-09-04T11:00:00.000Z", reason: "census-outdated" });
  const stale = deriveProjectHomeModel(staleSession);
  assert.equal(stale.mode, "stale");
  assert.deepEqual(stale.stage, { id: "stale", state: "stale", label: "Project evidence stale" });
  assert.equal(stale.nextAction.id, "refresh-project-evidence");
  assert.equal(stale.summary.census.state, "stale");
  assert.equal(stale.summary.authorities.plan.state, "stale");
  assert.ok(stale.blockers.some((item) => item.id === "project-stale"));

  const unavailableSession = withProjectState(ready, "unavailable", { now: "2026-09-04T11:00:00.000Z", reason: "adapter-unavailable" });
  const unavailable = deriveProjectHomeModel(unavailableSession);
  assert.equal(unavailable.mode, "unavailable");
  assert.deepEqual(unavailable.stage, { id: "unavailable", state: "unavailable", label: "Project record unavailable" });
  assert.equal(unavailable.nextAction.id, "restore-project-authority");
  assert.equal(unavailable.summary.census.state, "unavailable");
  assert.equal(unavailable.summary.authorities.plan.state, "unavailable");
  assert.ok(unavailable.blockers.some((item) => item.id === "project-unavailable"));
  assertOneAction(stale);
  assertOneAction(unavailable);
});

test("Home reads saved collision decisions: open overlaps block, decided ones do not, a pending split stays open", async () => {
  const { emptyTaskDraftLedger, updateTaskDraft } = await import("../src/project/taskDraftLedger.js");
  const { buildCollisionRecord, createResolution } = await import("../src/project/taskCoordination.js");
  const ready = withAuthorities(imported("c", { name: "Overlap Home", discovery: discovery() }));
  const binding = { projectId: ready.projectId, rootIdentity: ready.registration.rootIdentity, censusDigest: ready.census.digest };
  const task = (title, path) => ({ id: null, title, description: "", owner: "", acceptance: "", recovery: "", claims: [{ access: "write", path }], dependsOn: [], archived: false });
  const ledger = [task("A", "src/x.js"), task("B", "src/x.js"), task("C", "src/y.js"), task("D", "src/y.js")].reduce((value, item) => updateTaskDraft(value, item, at), emptyTaskDraftLedger(binding));
  const record = buildCollisionRecord({ ledger, censusDigest: binding.censusDigest, now: at });
  const records = (data) => ({ sections: { collisions: { revision: 1, recordedAt: at, data } } });
  const [first, second] = record.collisions;

  const open = deriveProjectHomeModel(ready, records(record));
  const blocker = open.blockers.find((item) => item.id === "collisions-undecided");
  assert.ok(blocker);
  assert.match(blocker.reason, /2 of 2 overlaps still need a decision/);
  assert.equal(open.summary.overlaps.total, 2);
  assert.equal(open.summary.overlaps.decided, 0);

  const oneSplit = { ...record, resolutions: { [first.key]: createResolution(first, "order", first.tasks[0]), [second.key]: createResolution(second, "split") } };
  const pending = deriveProjectHomeModel(ready, records(oneSplit));
  const splitBlocker = pending.blockers.find((item) => item.id === "collisions-undecided");
  assert.match(splitBlocker.reason, /1 of 2 overlaps still needs a decision/);
  assert.match(splitBlocker.reason, /Split chosen: edit the file scopes of T0003 or T0004 so they no longer overlap/);

  const decided = { ...record, resolutions: { [first.key]: createResolution(first, "order", first.tasks[0]), [second.key]: createResolution(second, "accept") } };
  const clear = deriveProjectHomeModel(ready, records(decided));
  assert.equal(clear.blockers.some((item) => item.id === "collisions-undecided"), false);
  assert.equal(clear.summary.overlaps.decided, 2);
  assert.equal(clear.summary.overlaps.text, "2 overlaps decided");

  assert.equal(deriveProjectHomeModel(ready).summary.overlaps.state, "unavailable");
});
