import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PROJECT_REGISTRY_KEY,
  createMemoryStorage,
  createProjectRegistry,
  resolveProjectRegistryStorage,
} from "../src/project/projectRegistry.js";
import { createImportedProjectSession } from "../src/project/projectSession.js";
import {
  createProjectHistoryState,
  projectHistoryHref,
  readProjectSelection,
  resolveProjectSelection,
} from "../src/project/projectUrl.js";

const at = "2026-09-04T01:00:00.000Z";

function imported({ name, rootIdentity, digest, count, workspace = "home" }) {
  const workspaceId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return createImportedProjectSession({
    name,
    adapter: "native",
    now: at,
    registration: {
      access: "metadata-read-only",
      canonicalRoot: `C:\\private\\${name}`,
      registryRevision: 1,
      rootIdentity,
      workspaceId,
    },
    census: {
      digest,
      fileCount: count,
      generatedEpochMs: Date.parse(at),
      registryRevision: 1,
      rootIdentity,
      skipped: [],
      totalBytesHashed: count * 10,
      workspaceId,
    },
  });
}

test("foundation resilience: corrupt persisted JSON fails to an explicit empty stale state", () => {
  const storage = createMemoryStorage({ [DEFAULT_PROJECT_REGISTRY_KEY]: "{ definitely-not-json" });
  const registry = createProjectRegistry({ storage, now: () => Date.parse(at) });

  assert.equal(registry.getActive(), null);
  assert.equal(registry.getSnapshot().state, "empty");
  assert.equal(registry.getHealth().state, "stale");
  assert.equal(registry.getHealth().persistence, "memory");
  assert.equal(registry.getHealth().reason, "storage-corrupt");
  assert.equal(storage.getItem(DEFAULT_PROJECT_REGISTRY_KEY), null);
});

test("foundation resilience: storage read failure does not fabricate an active project", () => {
  const brokenStorage = {
    getItem() { throw new Error("storage read denied"); },
    removeItem() { throw new Error("storage removal denied"); },
    setItem() { throw new Error("storage write denied"); },
  };
  const registry = createProjectRegistry({ storage: brokenStorage, now: () => Date.parse(at) });

  assert.equal(registry.getSnapshot().activeProjectId, null);
  assert.equal(registry.getSnapshot().projects.length, 0);
  assert.equal(registry.getHealth().state, "stale");
  assert.equal(registry.getHealth().reason, "storage-corrupt");
});

test("foundation resilience: write failure retains the accepted session in memory and reports non-durable truth", () => {
  const brokenStorage = {
    getItem() { return null; },
    removeItem() {},
    setItem() { throw Object.assign(new Error("quota exceeded"), { code: "quota-exceeded" }); },
  };
  const registry = createProjectRegistry({ storage: brokenStorage, now: () => Date.parse(at) });
  const alpha = imported({ name: "Alpha App", rootIdentity: "a".repeat(64), digest: "1".repeat(64), count: 3 });

  registry.upsert(alpha);

  assert.equal(registry.getActive().projectId, alpha.projectId);
  assert.equal(registry.getActive().census.fileCount, 3);
  assert.equal(registry.getHealth().state, "unavailable");
  assert.equal(registry.getHealth().persistence, "memory");
  assert.equal(registry.getHealth().reason, "storage-write-failed");
  assert.equal(registry.getHealth().errorCode, "quota-exceeded");
});

test("foundation resilience: two projects, active selection, and independent views survive registry reload", () => {
  const storage = createMemoryStorage();
  const registry = createProjectRegistry({ storage, now: () => Date.parse(at) });
  const alpha = imported({ name: "Alpha App", rootIdentity: "a".repeat(64), digest: "1".repeat(64), count: 3 });
  const beta = imported({ name: "Beta App", rootIdentity: "b".repeat(64), digest: "2".repeat(64), count: 8 });

  registry.upsert(alpha);
  registry.updateView(alpha.projectId, { workspace: "evidence", filterKey: "needs-proof" });
  registry.upsert(beta);
  registry.updateView(beta.projectId, { workspace: "structure", graphMode: "files" });
  registry.setActive(beta.projectId);

  const restored = createProjectRegistry({ storage, now: () => Date.parse(at) });
  assert.deepEqual(restored.getSnapshot().projectOrder, [alpha.projectId, beta.projectId]);
  assert.equal(restored.getSnapshot().activeProjectId, beta.projectId);
  assert.equal(restored.get(alpha.projectId).view.workspace, "evidence");
  assert.equal(restored.get(alpha.projectId).view.filterKey, "needs-proof");
  assert.equal(restored.get(alpha.projectId).census.fileCount, 3);
  assert.equal(restored.get(beta.projectId).view.workspace, "structure");
  assert.equal(restored.get(beta.projectId).view.graphMode, "files");
  assert.equal(restored.get(beta.projectId).census.fileCount, 8);
});

test("foundation resilience: project-aware history round-trips exact route context", () => {
  const storage = createMemoryStorage();
  const registry = createProjectRegistry({ storage, now: () => Date.parse(at) });
  const alpha = imported({ name: "Alpha App", rootIdentity: "a".repeat(64), digest: "1".repeat(64), count: 3 });
  const beta = imported({ name: "Beta App", rootIdentity: "b".repeat(64), digest: "2".repeat(64), count: 8 });
  registry.upsert(alpha);
  registry.upsert(beta);

  const href = projectHistoryHref("http://perfect-planner.local/?workspace=home", {
    projectId: alpha.projectId,
    workspace: "plan",
    phase: "P2",
  });
  const selection = readProjectSelection(href);
  assert.deepEqual(selection, { projectId: alpha.projectId, workspace: "plan", phase: "P2" });
  assert.deepEqual(resolveProjectSelection(registry.getSnapshot(), href), {
    projectId: alpha.projectId,
    workspace: "plan",
    phase: "P2",
    source: "url",
  });
  assert.deepEqual(createProjectHistoryState({ unrelated: true }, selection), {
    unrelated: true,
    perfectPlanner: { projectId: alpha.projectId, workspace: "plan", phase: "P2" },
  });
});

test("foundation resilience: invalid or unknown URL project IDs cannot override registry truth", () => {
  const registry = createProjectRegistry({ storage: createMemoryStorage(), now: () => Date.parse(at) });
  const alpha = imported({ name: "Alpha App", rootIdentity: "a".repeat(64), digest: "1".repeat(64), count: 3 });
  registry.upsert(alpha);

  const invalid = resolveProjectSelection(registry.getSnapshot(), "/?project=PP-014&workspace=evidence");
  const unknown = resolveProjectSelection(registry.getSnapshot(), "/?project=pp_unknown_1234567890&workspace=ledger");
  assert.equal(invalid.projectId, alpha.projectId);
  assert.equal(invalid.source, "registry");
  assert.equal(unknown.projectId, alpha.projectId);
  assert.equal(unknown.source, "registry");
});

test("foundation resilience: unavailable browser storage is reported without throwing", () => {
  const runtime = {};
  Object.defineProperty(runtime, "localStorage", { get() { throw new Error("blocked"); } });
  assert.equal(resolveProjectRegistryStorage(runtime), null);
  const registry = createProjectRegistry({ storage: resolveProjectRegistryStorage(runtime), now: () => Date.parse(at) });
  assert.equal(registry.getHealth().state, "unavailable");
  assert.equal(registry.getHealth().persistence, "memory");
  assert.equal(registry.getSnapshot().state, "empty");
});

test("foundation resilience: redacted persistence never stores the canonical private root path", () => {
  const storage = createMemoryStorage();
  const registry = createProjectRegistry({ storage, now: () => Date.parse(at) });
  registry.upsert(imported({ name: "Alpha App", rootIdentity: "a".repeat(64), digest: "1".repeat(64), count: 3 }));

  const persisted = storage.getItem(DEFAULT_PROJECT_REGISTRY_KEY);
  assert.equal(persisted.includes("C:\\\\private"), false);
  assert.equal(persisted.includes("rootLabel"), true);
  assert.equal(persisted.includes("rootIdentity"), true);
});
