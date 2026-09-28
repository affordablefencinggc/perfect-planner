import assert from "node:assert/strict";
import test from "node:test";

import { createDemoProjectSession, isDemoProject } from "../src/demo/demoProject.js";
import {
  assertProjectEntityId,
  createImportedProjectId,
  createProjectEntityId,
  projectOwnsEntity,
} from "../src/project/projectIds.js";
import { selectProjectMetric } from "../src/project/projectProvenance.js";
import {
  UnsupportedProjectSchemaVersionError,
  createEmptyProjectState,
  createImportedProjectSession,
  migrateProjectSession,
  projectTruthStates,
  validateProjectSession,
  withProjectState,
} from "../src/project/projectSession.js";

const at = "2026-09-04T06:00:00.000Z";

test('registered folder display uses the browser name, never its opaque token or a new identity', () => {
  for (const [canonicalRoot, label] of [['browser://My%20Project/opaque-token-123', 'My Project'], ['C:/repos/native%20literal', 'native%20literal']]) {
    const rootIdentity = 'a'.repeat(64);
    const project = createImportedProjectSession({ name: 'User project name', adapter: 'browser', now: at,
      registration: { access: 'metadata-read-only', canonicalRoot, registryRevision: 1, rootIdentity, workspaceId: 'workspace-label' } });
    assert.equal(project.registration.rootLabel, label);
    assert.equal(project.registration.rootIdentity, rootIdentity);
    assert.equal(project.projectId, createImportedProjectId(rootIdentity));
    assert.equal(project.name, 'User project name');
  }
});

function importedProject(seed = "a", name = "App A") {
  const rootIdentity = seed.repeat(64);
  const digest = (seed === "a" ? "c" : "d").repeat(64);
  return createImportedProjectSession({
    name,
    adapter: "browser",
    registration: {
      access: "metadata-read-only",
      canonicalRoot: `C:\\private\\repos\\${name}`,
      capabilities: ["workspace-census:read"],
      handle: { forbidden: true },
      registryRevision: 1,
      rootIdentity,
      workspaceId: `workspace-${seed}${seed}`,
    },
    census: {
      contentReturned: false,
      digest,
      fileCount: 2,
      files: [
        { path: "package.json", content: "secret source", handle: { forbidden: true } },
        { path: "src/main.jsx", bytes: [1, 2, 3] },
      ],
      generatedEpochMs: Date.parse(at),
      registryRevision: 1,
      rootIdentity,
      skipped: [{ path: "large.bin", reason: "oversized" }],
      totalBytesHashed: 42,
      workspaceId: `workspace-${seed}${seed}`,
    },
    discovery: {
      categories: [{ id: "A01", state: "observed", findings: [{ id: "S001", evidence: ["package.json"], detail: "not persisted" }] }],
      counts: { observed: 1, signals: 0, unanswered: 7 },
      state: "discovering",
    },
    now: Date.parse(at),
  });
}

test("stable project and entity IDs are deterministic and project-scoped", () => {
  const projectA = createImportedProjectId("a".repeat(64));
  const projectB = createImportedProjectId("b".repeat(64));
  assert.equal(projectA, createImportedProjectId("a".repeat(64)));
  assert.notEqual(projectA, projectB);

  const taskA = createProjectEntityId(projectA, "task", "B01-1");
  assert.equal(taskA, createProjectEntityId(projectA, "task", "B01-1"));
  assert.notEqual(taskA, createProjectEntityId(projectB, "task", "B01-1"));
  assert.equal(projectOwnsEntity(projectA, taskA), true);
  assert.equal(projectOwnsEntity(projectB, taskA), false);
  assert.equal(assertProjectEntityId(taskA, { projectId: projectA, entityType: "task" }), taskA);
  assert.throws(() => assertProjectEntityId(taskA, { projectId: projectB }), /another project/);
});

test("imported ProjectSession keeps only redacted metadata and source-backed provenance", () => {
  const session = importedProject();
  const serialized = JSON.stringify(session);

  assert.equal(session.schemaVersion, 1);
  assert.equal(session.kind, "imported");
  assert.equal(session.state, "generated");
  assert.equal(session.registration.rootLabel, "App A");
  assert.equal(session.registration.persistence, "reselect-required");
  assert.equal(session.census.fileCount, 2);
  assert.equal(session.census.skippedCount, 1);
  assert.deepEqual(session.discovery.categories[0].findingIds, ["S001"]);
  assert.doesNotMatch(serialized, /C:\\\\private|package\.json|secret source|forbidden|"files"|"handle"|"content"|"bytes"/);

  const metric = selectProjectMetric(session, "census.fileCount");
  assert.equal(metric.value, 2);
  assert.equal(metric.state, "imported");
  assert.equal(metric.provenance.digest, "c".repeat(64));
  assert.equal(metric.provenance.projectId, session.projectId);
  assert.equal(projectOwnsEntity(session.projectId, metric.provenance.provenanceId), true);
});

test("raw file payloads and unknown session fields cannot enter the persisted schema", () => {
  const session = JSON.parse(JSON.stringify(importedProject()));
  session.files = [{ path: "src/secret.js", content: "secret" }];
  assert.throws(() => validateProjectSession(session), /unknown or missing field/);

  const second = JSON.parse(JSON.stringify(importedProject()));
  second.registration.handle = { unsafe: true };
  assert.throws(() => validateProjectSession(second), /unknown or missing field/);
});

test("empty, demo, imported, generated, authoritative, unavailable, and stale states are explicit", () => {
  assert.deepEqual(projectTruthStates, ["empty", "demo", "imported", "generated", "authoritative", "unavailable", "stale"]);
  assert.deepEqual(createEmptyProjectState(), { projectId: null, state: "empty", project: null, reason: "no-project-selected" });

  const demo = createDemoProjectSession({ now: Date.parse(at) });
  assert.equal(isDemoProject(demo), true);
  assert.equal(selectProjectMetric(demo, "project.state").state, "demo");

  const unavailable = withProjectState(importedProject(), "unavailable", { now: Date.parse(at) + 1_000, reason: "adapter-unavailable" });
  assert.equal(unavailable.state, "unavailable");
  assert.equal(selectProjectMetric(unavailable, "project.state").provenance.reason, "adapter-unavailable");
  const stale = withProjectState(unavailable, "stale", { now: Date.parse(at) + 2_000, reason: "census-changed" });
  assert.equal(stale.state, "stale");
});

test("version zero migrates deterministically and unknown versions fail closed", () => {
  const rootIdentity = "e".repeat(64);
  const projectId = createImportedProjectId(rootIdentity);
  const migrated = migrateProjectSession({
    schemaVersion: 0,
    id: projectId,
    name: "Legacy app",
    mode: "imported",
    adapter: "native",
    persistence: "durable",
    workspaceId: "legacy-workspace",
    registryRevision: 3,
    rootIdentity,
    rootLabel: "Legacy app",
    censusDigest: "f".repeat(64),
    fileCount: 12,
    skippedCount: 2,
    totalBytesHashed: 900,
    generation: 4,
    createdAt: at,
    updatedAt: at,
  });

  assert.equal(migrated.schemaVersion, 1);
  assert.equal(migrated.projectId, projectId);
  assert.equal(migrated.registration.registryRevision, 3);
  assert.equal(migrated.census.fileCount, 12);
  assert.throws(() => migrateProjectSession({ schemaVersion: 99 }), UnsupportedProjectSchemaVersionError);
});
