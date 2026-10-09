import "./helpers/hermetic-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createImportedProjectSession, withProjectState } from "../src/project/projectSession.js";
import { captureOperationDefinitions, selectOperationDefinitions } from "../src/runtime/operationDefinitionObservations.js";

function fixture(id = "first-app", identity = "a".repeat(64)) {
  const paths = [".githooks/pre-commit", ".githooks/pre-push", "scripts/verify-secrets.mjs", ".github/workflows/guardrail-ci.yml"];
  const census = { schemaVersion: 1, available: true, authoritative: true, capabilities: ["workspace-census:read"], contentReturned: false,
    workspaceId: id, rootIdentity: identity, registryRevision: 1, digest: "b".repeat(64), generatedEpochMs: 1000,
    fileCount: paths.length, files: paths.map((path) => ({ path, size: 1, sha256: "c".repeat(64), category: "source", extension: "", modifiedEpochMs: 1000 })),
    skipped: [], summary: { source: paths.length }, totalBytesHashed: paths.length };
  const registration = { workspaceId: id, rootIdentity: identity, registryRevision: 1, canonicalRoot: `C:/fixture/${id}`, access: "metadata-read-only" };
  return { census, project: createImportedProjectSession({ name: id, adapter: "native", registration, census, now: 1000 }) };
}

test("fresh bound census yields only session definition flags, never file paths or execution proof", () => {
  const { project, census } = fixture();
  const observation = captureOperationDefinitions(project, census);
  assert.deepEqual(observation.definitions, { gitHooks: true, secretScanner: true, ciWorkflow: true });
  assert.equal(observation.executionVerified, false);
  assert.equal(selectOperationDefinitions(project, observation), observation);
  assert.equal(JSON.stringify(observation).includes(".githooks"), false);
  assert.equal(project.census.files, undefined);
});

test("cross-project, digest, revision, time, and authority mismatch are rejected", () => {
  const { project, census } = fixture();
  const observation = captureOperationDefinitions(project, census);
  assert.equal(selectOperationDefinitions(fixture("other-app", "d".repeat(64)).project, observation), null);
  assert.equal(selectOperationDefinitions({ ...project, generation: project.generation + 1 }, observation), observation);
  for (const patch of [{ digest: "d".repeat(64) }, { registryRevision: 2 }, { generatedEpochMs: 2000 }, { authoritative: false }, { rootIdentity: "d".repeat(64) }, { workspaceId: "other-app" }]) {
    assert.equal(captureOperationDefinitions(project, { ...census, ...patch }), null);
  }
});

test("new census identity invalidates prior observations even within the same project", () => {
  const { project, census } = fixture();
  const observation = captureOperationDefinitions(project, census);
  assert.equal(selectOperationDefinitions({ ...project, census: { ...project.census, digest: "f".repeat(64) } }, observation), null);
});

test("stale/unavailable projects and reload without memory never show current observations", () => {
  const { project, census } = fixture();
  const observation = captureOperationDefinitions(project, census);
  for (const state of ["stale", "unavailable"]) assert.equal(selectOperationDefinitions(withProjectState(project, state, { now: 2000 }), observation), null);
  assert.equal(selectOperationDefinitions(project, null), null);
  assert.equal(selectOperationDefinitions(project, { ...observation, executionVerified: true }), null);
});

test("duplicate census paths are refused and partial coverage cannot imply missing definitions are absent", () => {
  const { project, census } = fixture();
  assert.equal(captureOperationDefinitions(project, { ...census, files: census.files.map(() => census.files[0]) }), null);
  const partial = { ...census, skipped: [{ path: "vendor", reason: "excluded", size: null }] };
  assert.equal(captureOperationDefinitions(project, partial), null);
  assert.equal(captureOperationDefinitions({ ...project, census: { ...project.census, skippedCount: 1 } }, partial).coverage, "partial");
});
