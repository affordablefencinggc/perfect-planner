import "./helpers/hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import {
  createProjectEntityId,
  createStableProjectId,
  parseProjectEntityId,
  projectOwnsEntity,
} from "../src/project/projectIds.js";
import {
  createProvenanceRecord,
  selectProjectMetric,
  validateProvenanceRecord,
} from "../src/project/projectProvenance.js";
import {
  createEmptyProjectState,
  createImportedProjectSession,
  validateProjectSession,
  withProjectState,
  withProjectView,
} from "../src/project/projectSession.js";
import {
  createDemoProjectSession,
  demoProjectDescriptor,
  isDemoProject,
} from "../src/demo/demoProject.js";

const observedAt = "2026-09-04T00:00:00.000Z";

function importedSession({ name, root, rootIdentity, digest, fileCount = 1, adapter = "native" }) {
  const workspaceId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return createImportedProjectSession({
    name,
    adapter,
    now: observedAt,
    registration: {
      access: "metadata-read-only",
      canonicalRoot: root,
      registryRevision: 1,
      rootIdentity,
      workspaceId,
    },
    census: {
      digest,
      fileCount,
      generatedEpochMs: Date.parse(observedAt),
      registryRevision: 1,
      rootIdentity,
      skipped: [],
      totalBytesHashed: fileCount * 100,
      workspaceId,
    },
  });
}

test("foundation resilience: entity identities are deterministic and isolated by project", () => {
  const alpha = createStableProjectId("Alpha", "C:/fixtures/alpha");
  const beta = createStableProjectId("Beta", "C:/fixtures/beta");
  const alphaTask = createProjectEntityId(alpha, "task", "B01");
  const betaTask = createProjectEntityId(beta, "task", "B01");

  assert.equal(alphaTask, createProjectEntityId(alpha, "task", "B01"));
  assert.notEqual(alphaTask, betaTask);
  assert.equal(projectOwnsEntity(alpha, alphaTask), true);
  assert.equal(projectOwnsEntity(beta, alphaTask), false);
  assert.deepEqual(parseProjectEntityId(alphaTask), {
    projectId: alpha,
    entityType: "task",
    token: parseProjectEntityId(alphaTask).token,
  });
});

test("foundation resilience: provenance cannot be rebound across projects", () => {
  const alpha = createStableProjectId("Alpha", "C:/fixtures/alpha");
  const beta = createStableProjectId("Beta", "C:/fixtures/beta");
  const record = createProvenanceRecord({
    projectId: alpha,
    field: "census.fileCount",
    state: "authoritative",
    sourceType: "workspace-census",
    sourceId: "alpha-census",
    sourceRevision: 3,
    digest: "a".repeat(64),
    observedAt,
    reason: "census-verified",
  });

  assert.equal(validateProvenanceRecord(record, alpha).projectId, alpha);
  assert.throws(() => validateProvenanceRecord(record, beta), /another project/i);
});

test("foundation resilience: missing metric evidence becomes explicitly unavailable", () => {
  const projectId = createStableProjectId("Alpha", "C:/fixtures/alpha");
  const session = {
    projectId,
    name: "Alpha",
    state: "imported",
    generation: 4,
    updatedAt: observedAt,
    registration: null,
    census: null,
    discovery: null,
    authorities: { architecture: null, folder: null, component: null, plan: null },
    provenance: {},
  };

  const metric = selectProjectMetric(session, "census.fileCount");
  assert.equal(metric.value, null);
  assert.equal(metric.state, "unavailable");
  assert.equal(metric.provenance.projectId, projectId);
  assert.equal(metric.provenance.reason, "provenance-missing");
});

test("foundation resilience: a fresh launch contract has no implicit project", () => {
  assert.deepEqual(createEmptyProjectState(), {
    projectId: null,
    state: "empty",
    project: null,
    reason: "no-project-selected",
  });
});

test("foundation resilience: two imports with the same task labels remain isolated", () => {
  const alpha = importedSession({
    name: "Alpha App",
    root: "C:\\fixtures\\alpha-app",
    rootIdentity: "a".repeat(64),
    digest: "1".repeat(64),
    fileCount: 3,
  });
  const beta = importedSession({
    name: "Beta App",
    root: "C:\\fixtures\\beta-app",
    rootIdentity: "b".repeat(64),
    digest: "2".repeat(64),
    fileCount: 7,
  });

  assert.notEqual(alpha.projectId, beta.projectId);
  assert.equal(alpha.registration.rootLabel, "alpha-app");
  assert.equal(beta.registration.rootLabel, "beta-app");
  assert.equal(alpha.census.fileCount, 3);
  assert.equal(beta.census.fileCount, 7);
  assert.equal(JSON.stringify(alpha).includes("beta-app"), false);
  assert.equal(JSON.stringify(beta).includes("alpha-app"), false);
  assert.notEqual(createProjectEntityId(alpha.projectId, "task", "B01"), createProjectEntityId(beta.projectId, "task", "B01"));
});

test("foundation resilience: per-project route history updates one session without mutating another", () => {
  const alpha = importedSession({ name: "Alpha App", root: "C:\\fixtures\\alpha-app", rootIdentity: "a".repeat(64), digest: "1".repeat(64) });
  const beta = importedSession({ name: "Beta App", root: "C:\\fixtures\\beta-app", rootIdentity: "b".repeat(64), digest: "2".repeat(64) });
  const alphaOnEvidence = withProjectView(alpha, { workspace: "evidence", filterKey: "needs-proof" }, { now: "2026-09-04T00:01:00.000Z" });

  assert.equal(alphaOnEvidence.view.workspace, "evidence");
  assert.equal(alphaOnEvidence.view.filterKey, "needs-proof");
  assert.equal(alphaOnEvidence.generation, alpha.generation + 1);
  assert.equal(alpha.view.workspace, "home");
  assert.equal(beta.view.workspace, "home");
  assert.equal(beta.generation, 1);
});

test("foundation resilience: unavailable and stale are explicit, provenance-bound states", () => {
  const imported = importedSession({ name: "Alpha App", root: "C:\\fixtures\\alpha-app", rootIdentity: "a".repeat(64), digest: "1".repeat(64) });
  const unavailable = withProjectState(imported, "unavailable", { now: "2026-09-04T00:02:00.000Z", reason: "folder-permission-lost" });
  const stale = withProjectState(imported, "stale", { now: "2026-09-04T00:03:00.000Z", reason: "census-outdated" });

  assert.equal(unavailable.state, "unavailable");
  assert.equal(unavailable.provenance["project.state"].sourceType, "unavailable");
  assert.equal(unavailable.provenance["project.state"].reason, "folder-permission-lost");
  assert.equal(stale.state, "stale");
  assert.equal(stale.provenance["project.state"].reason, "census-outdated");
  assert.equal(stale.census.digest, imported.census.digest);
});

test("foundation resilience: malformed or cross-project session data fails closed", () => {
  const alpha = importedSession({ name: "Alpha App", root: "C:\\fixtures\\alpha-app", rootIdentity: "a".repeat(64), digest: "1".repeat(64) });
  const betaId = createStableProjectId("Beta", "C:/fixtures/beta");
  const wrongProjectProvenance = structuredClone(alpha);
  wrongProjectProvenance.provenance["census.fileCount"].projectId = betaId;

  assert.throws(() => validateProjectSession({ ...structuredClone(alpha), unexpected: true }), /unknown or missing field/i);
  assert.throws(() => validateProjectSession(wrongProjectProvenance), /another project/i);
});

test("foundation resilience: Demo is explicit and cannot be promoted to imported or authoritative truth", () => {
  const demo = createDemoProjectSession({ now: observedAt });
  const imported = importedSession({ name: "Alpha App", root: "C:\\fixtures\\alpha-app", rootIdentity: "a".repeat(64), digest: "1".repeat(64) });

  assert.equal(isDemoProject(demo), true);
  assert.equal(isDemoProject(imported), false);
  assert.equal(demo.kind, "demo");
  assert.equal(demo.state, "demo");
  assert.match(demoProjectDescriptor.disclosure, /Demonstration fixtures only/i);
  assert.match(demoProjectDescriptor.disclosure, /not.*evidence.*imported app/i);
  assert.throws(() => withProjectState(demo, "authoritative", { now: "2026-09-04T00:04:00.000Z" }), /Demo project state cannot be promoted/i);
});

test("foundation resilience: imported sessions contain no legacy fixture identity", () => {
  const imported = importedSession({ name: "Alpha App", root: "C:\\fixtures\\alpha-app", rootIdentity: "a".repeat(64), digest: "1".repeat(64) });
  const serialized = JSON.stringify(imported);

  assert.equal(serialized.includes("PP-014"), false);
  assert.equal(serialized.includes("PP-CLEANROOM"), false);
  assert.equal(serialized.includes("Local Collaboration Workspace"), false);
  assert.equal(serialized.includes("Perfect Planner Demo"), false);
});
