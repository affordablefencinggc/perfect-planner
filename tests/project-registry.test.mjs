import "./helpers/hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { createImportedProjectId } from "../src/project/projectIds.js";
import {
  DEFAULT_PROJECT_REGISTRY_KEY,
  createMemoryStorage,
  createProjectRegistry,
} from "../src/project/projectRegistry.js";
import { createImportedProjectSession } from "../src/project/projectSession.js";

const baseTime = Date.parse("2026-09-04T07:00:00.000Z");

function session(seed, name, offset = 0) {
  const rootIdentity = seed.repeat(64);
  return createImportedProjectSession({
    name,
    adapter: "native",
    registration: {
      access: "metadata-read-only",
      canonicalRoot: `C:\\repos\\${name}`,
      registryRevision: 1,
      rootIdentity,
      workspaceId: `workspace-${seed}${seed}`,
    },
    census: {
      digest: (seed === "a" ? "c" : "d").repeat(64),
      fileCount: seed === "a" ? 10 : 20,
      files: [{ path: `private-${name}.js`, content: "must not persist" }],
      generatedEpochMs: baseTime + offset,
      registryRevision: 1,
      rootIdentity,
      skipped: [],
      totalBytesHashed: 100,
      workspaceId: `workspace-${seed}${seed}`,
    },
    now: baseTime + offset,
  });
}

test("clean install exposes an explicit empty state without inventing a project", () => {
  const registry = createProjectRegistry({ storage: createMemoryStorage(), now: () => baseTime });
  const snapshot = registry.getSnapshot();
  assert.equal(snapshot.state, "empty");
  assert.equal(snapshot.activeProject, null);
  assert.deepEqual(snapshot.projects, []);
  assert.equal(snapshot.health.persistence, "durable");
});

test("projects A and B retain isolated values, views, and active selection", () => {
  let clock = baseTime;
  const registry = createProjectRegistry({ storage: createMemoryStorage(), now: () => ++clock });
  const appA = registry.upsert(session("a", "App A"));
  const appB = registry.upsert(session("b", "App B"));
  registry.updateView(appA.projectId, { workspace: "structure", graphMode: "files", filterKey: "observed" });

  assert.equal(registry.getSnapshot().activeProjectId, appB.projectId);
  assert.equal(registry.get(appA.projectId).census.fileCount, 10);
  assert.equal(registry.get(appB.projectId).census.fileCount, 20);
  assert.equal(registry.get(appA.projectId).view.workspace, "structure");
  assert.equal(registry.get(appB.projectId).view.workspace, "home");
  registry.setActive(appA.projectId);
  assert.equal(registry.getActive().name, "App A");
  assert.deepEqual(registry.getSnapshot().projectOrder, [appA.projectId, appB.projectId]);
});

// Trial define-05: every page change used to bump the "scan N" counter.
test("view-only changes keep the project generation and persist the view", () => {
  let clock = baseTime;
  const storage = createMemoryStorage();
  const registry = createProjectRegistry({ storage, now: () => ++clock });
  const app = registry.upsert(session("a", "App A"));
  for (const workspace of ["structure", "plan", "ledger", "components", "blueprint"]) registry.updateView(app.projectId, { workspace });
  const after = registry.get(app.projectId);
  assert.equal(after.generation, app.generation);
  assert.equal(after.view.workspace, "blueprint");
  const reloaded = createProjectRegistry({ storage, now: () => ++clock }).get(app.projectId);
  assert.equal(reloaded.generation, app.generation);
  assert.equal(reloaded.view.workspace, "blueprint");
});

test("stale registry instances rebase before writes and reconcile external conflicts", () => {
  let clock = baseTime;
  const shared = createMemoryStorage();
  const first = createProjectRegistry({ storage: shared, now: () => ++clock });
  const second = createProjectRegistry({ storage: shared, now: () => ++clock });
  const appA = first.upsert(session("a", "App A"));
  const appB = second.upsert(session("b", "App B", 100));

  assert.deepEqual(
    second.list().map((project) => project.projectId).sort(),
    [appA.projectId, appB.projectId].sort(),
  );
  assert.equal(first.synchronize(), true);
  assert.deepEqual(
    first.list().map((project) => project.projectId).sort(),
    [appA.projectId, appB.projectId].sort(),
  );

  const isolatedA = createMemoryStorage();
  const isolatedB = createMemoryStorage();
  const left = createProjectRegistry({ storage: isolatedA, now: () => ++clock });
  const right = createProjectRegistry({ storage: isolatedB, now: () => ++clock });
  left.upsert(session("a", "App A"));
  right.upsert(session("b", "App B", 100));
  assert.equal(
    left.synchronize(isolatedB.getItem(DEFAULT_PROJECT_REGISTRY_KEY)),
    true,
  );
  assert.equal(left.getSnapshot().revision, 2);
  assert.deepEqual(
    left.list().map((project) => project.projectId).sort(),
    [appA.projectId, appB.projectId].sort(),
  );
});

test("redacted sessions serialize and reload with project order, route, and active selection intact", () => {
  let clock = baseTime;
  const storage = createMemoryStorage();
  const first = createProjectRegistry({ storage, now: () => ++clock });
  const appA = first.upsert(session("a", "App A"));
  const appB = first.upsert(session("b", "App B", 100));
  first.updateView(appB.projectId, { workspace: "components", phase: "P2" });
  first.setActive(appA.projectId);

  const raw = storage.getItem(DEFAULT_PROJECT_REGISTRY_KEY);
  assert.ok(raw);
  assert.doesNotMatch(raw, /private-App|must not persist|"files"|"content"|canonicalRoot|C:\\\\repos/);

  const second = createProjectRegistry({ storage, now: () => ++clock });
  assert.equal(second.getSnapshot().activeProjectId, appA.projectId);
  assert.deepEqual(second.getSnapshot().projectOrder, [appA.projectId, appB.projectId]);
  assert.equal(second.get(appB.projectId).view.workspace, "components");
  assert.equal(second.get(appB.projectId).view.phase, "P2");
});

test("corrupt storage recovers to an honest empty in-memory registry", () => {
  const storage = createMemoryStorage({ [DEFAULT_PROJECT_REGISTRY_KEY]: "{not-json" });
  const registry = createProjectRegistry({ storage, now: () => baseTime });
  assert.equal(registry.getSnapshot().state, "empty");
  assert.equal(registry.getHealth().state, "stale");
  assert.equal(registry.getHealth().reason, "storage-corrupt");
  assert.equal(registry.getHealth().persistence, "memory");
  // Saved projects are never deleted: the unreadable value is retained and backed up.
  assert.equal(storage.getItem(DEFAULT_PROJECT_REGISTRY_KEY), "{not-json");
  assert.equal(registry.unreadableBackupKey, `${DEFAULT_PROJECT_REGISTRY_KEY}.unreadable-${new Date(baseTime).toISOString()}`);
  assert.equal(storage.getItem(registry.unreadableBackupKey), "{not-json");
});

test("write quota failures keep a usable memory fallback and disclose non-durability", () => {
  const storage = {
    getItem() { return null; },
    removeItem() {},
    setItem() {
      const error = new Error("quota reached");
      error.name = "QuotaExceededError";
      error.code = "quota-exceeded";
      throw error;
    },
  };
  const registry = createProjectRegistry({ storage, now: () => baseTime });
  const appA = registry.upsert(session("a", "App A"));
  assert.equal(registry.getActive().projectId, appA.projectId);
  assert.equal(registry.getHealth().state, "unavailable");
  assert.equal(registry.getHealth().persistence, "memory");
  assert.equal(registry.getHealth().reason, "storage-write-failed");
  assert.equal(registry.getHealth().errorCode, "quota-exceeded");

  const reloaded = createProjectRegistry({ storage, now: () => baseTime });
  assert.equal(reloaded.getSnapshot().state, "empty");
});

test("registry schema zero migrates, while future schema data is rejected without deletion", () => {
  const rootIdentity = "e".repeat(64);
  const projectId = createImportedProjectId(rootIdentity);
  const legacy = {
    schemaVersion: 0,
    revision: 2,
    activeProjectId: projectId,
    projectOrder: [projectId],
    projects: [{
      schemaVersion: 0,
      id: projectId,
      name: "Legacy",
      mode: "imported",
      adapter: "native",
      persistence: "durable",
      workspaceId: "legacy-workspace",
      registryRevision: 1,
      rootIdentity,
      rootLabel: "Legacy",
      censusDigest: "f".repeat(64),
      fileCount: 3,
      skippedCount: 0,
      generation: 1,
      createdAt: new Date(baseTime).toISOString(),
      updatedAt: new Date(baseTime).toISOString(),
    }],
    updatedAt: new Date(baseTime).toISOString(),
  };
  const storage = createMemoryStorage({ [DEFAULT_PROJECT_REGISTRY_KEY]: JSON.stringify(legacy) });
  const migrated = createProjectRegistry({ storage, now: () => baseTime });
  assert.equal(migrated.getSnapshot().schemaVersion, 1);
  assert.equal(migrated.getActive().name, "Legacy");
  assert.equal(migrated.getHealth().reason, "schema-migrated");
  assert.equal(JSON.parse(storage.getItem(DEFAULT_PROJECT_REGISTRY_KEY)).schemaVersion, 1);

  const futureRaw = JSON.stringify({ schemaVersion: 77, important: "keep me" });
  const futureStorage = createMemoryStorage({ [DEFAULT_PROJECT_REGISTRY_KEY]: futureRaw });
  const rejected = createProjectRegistry({ storage: futureStorage, now: () => baseTime });
  assert.equal(rejected.getSnapshot().state, "empty");
  assert.equal(rejected.getHealth().reason, "schema-version-unsupported");
  assert.equal(futureStorage.getItem(DEFAULT_PROJECT_REGISTRY_KEY), futureRaw);
});

test("unreadable registry backups survive later saves and are not duplicated on reload", () => {
  const storage = createMemoryStorage({ [DEFAULT_PROJECT_REGISTRY_KEY]: "{still-broken" });
  const first = createProjectRegistry({ storage, now: () => baseTime });
  const again = createProjectRegistry({ storage, now: () => baseTime + 5000 });
  assert.equal(again.unreadableBackupKey, first.unreadableBackupKey);
  again.upsert(session("a", "App A"));
  assert.equal(storage.getItem(first.unreadableBackupKey), "{still-broken");
  const backups = [...Array(storage.length).keys()].map((i) => storage.key(i)).filter((key) => key.includes(".unreadable-"));
  assert.equal(backups.length, 1);
  assert.equal(createProjectRegistry({ storage, now: () => baseTime + 9000 }).getActive().name, "App A");
});
