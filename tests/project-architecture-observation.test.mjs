import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryStorage, createProjectRegistry } from "../src/project/projectRegistry.js";
import { createImportedProjectSession } from "../src/project/projectSession.js";
import { createProjectEntityId } from "../src/project/projectIds.js";

const now = Date.parse("2026-09-13T01:00:00Z");
function session(seed = "a") {
  return createImportedProjectSession({ name: "App", adapter: "browser", registration: { access: "metadata-read-only", canonicalRoot: "browser://app", registryRevision: 1, rootIdentity: seed.repeat(64), workspaceId: `workspace-${seed}` }, now });
}
function setup(storage = createMemoryStorage()) {
  const registry = createProjectRegistry({ storage, now: () => now + 100 });
  const project = session(); registry.upsert(project);
  return { registry, project, storage };
}
function observed(project, digest = "b", revision = 1) {
  return { state: "observed", expectedRootIdentity: project.registration.rootIdentity, receipt: { valid: true, planId: project.projectId, head: { contractDigest: digest.repeat(64), revision, registeredAt: new Date(now).toISOString() } } };
}

test("verified observation merges the latest rebased project and survives restart", () => {
  const { registry, project, storage } = setup();
  const other = createProjectRegistry({ storage, now: () => now + 200 });
  other.updateView(project.projectId, { workspace: "ledger" });
  const result = registry.recordArchitectureObservation(project.projectId, observed(project));
  assert.equal(result.persisted, true);
  assert.equal(result.project.view.workspace, "ledger");
  assert.deepEqual(result.project.registration, project.registration);
  assert.deepEqual(result.project.census, project.census);
  assert.equal(result.project.authorities.architecture.state, "authoritative");
  assert.equal(result.project.provenance["authority.architecture"].digest, "b".repeat(64));
  assert.equal(result.project.provenance["authority.architecture"].state, "authoritative");
  assert.deepEqual(createProjectRegistry({ storage }).get(project.projectId), result.project);
});

test("refresh and failure retain exact last-known identity without current-authority claim", () => {
  const { registry, project } = setup();
  registry.recordArchitectureObservation(project.projectId, observed(project));
  for (const state of ["stale", "unavailable"]) {
    const result = registry.recordArchitectureObservation(project.projectId, { state, expectedRootIdentity: project.registration.rootIdentity });
    assert.equal(result.project.authorities.architecture.digest, "b".repeat(64));
    assert.equal(result.project.authorities.architecture.revision, 1);
    assert.equal(result.project.authorities.architecture.state, state);
    assert.equal(result.project.provenance["authority.architecture"].state, state);
  }
});

test("changed architecture stales dependent references and provenance, not unrelated sessions", () => {
  const { registry, project } = setup();
  registry.recordArchitectureObservation(project.projectId, observed(project));
  const current = registry.get(project.projectId);
  const dependencies = Object.fromEntries(["folder", "component", "plan"].map(kind => [kind, { digest: "c".repeat(64), entityId: createProjectEntityId(project.projectId, "source", kind), recordedAt: new Date(now).toISOString(), revision: 1, state: "authoritative" }]));
  registry.upsert({ ...current, authorities: { ...current.authorities, ...dependencies } });
  const other = session("d"); registry.upsert(other);
  const result = registry.recordArchitectureObservation(project.projectId, observed(project, "e", 2));
  for (const kind of Object.keys(dependencies)) {
    assert.equal(result.project.authorities[kind].state, "stale");
    assert.equal(result.project.provenance[`authority.${kind}`].state, "stale");
    assert.equal(result.project.authorities[kind].digest, dependencies[kind].digest);
  }
  assert.deepEqual(registry.get(other.projectId), other);
  assert.equal(registry.getActive().projectId, other.projectId);
});

test("root mismatch, foreign receipt, invalid head and revision regression never mutate", () => {
  const { registry, project } = setup();
  registry.recordArchitectureObservation(project.projectId, observed(project, "b", 2));
  const before = registry.exportRedacted();
  for (const [input, code] of [
    [{ ...observed(project), expectedRootIdentity: "d".repeat(64) }, "architecture-root-mismatch"],
    [{ ...observed(project), receipt: { ...observed(project).receipt, planId: session("d").projectId } }, "architecture-observation-invalid"],
    [{ ...observed(project), receipt: { valid: true, planId: project.projectId, head: {} } }, "architecture-observation-invalid"],
    [observed(project, "b", 1), "architecture-observation-stale"],
    [observed(project, "e", 2), "architecture-observation-stale"],
  ]) {
    assert.throws(() => registry.recordArchitectureObservation(project.projectId, input), error => error.code === code);
    assert.equal(registry.exportRedacted(), before);
  }
});

test("missing verified head is unavailable and persistence failure is distinct from observation failure", () => {
  const { registry, project, storage } = setup();
  registry.recordArchitectureObservation(project.projectId, observed(project));
  const missing = observed(project); missing.receipt.head = null;
  const absent = registry.recordArchitectureObservation(project.projectId, missing);
  assert.equal(absent.project.authorities.architecture.state, "unavailable");
  assert.equal(absent.project.authorities.architecture.digest, "b".repeat(64));
  assert.equal(absent.project.authorities.architecture.revision, observed(project).receipt.head.revision);
  assert.equal(absent.project.provenance["authority.architecture"].reason, "architecture-head-missing");
  storage.setItem = () => { throw new Error("disk unavailable"); };
  const result = registry.recordArchitectureObservation(project.projectId, observed(project));
  assert.equal(result.persisted, false);
  assert.equal(result.persistenceReason, "storage-write-failed");
  assert.equal(result.project.authorities.architecture.digest, "b".repeat(64));
});
