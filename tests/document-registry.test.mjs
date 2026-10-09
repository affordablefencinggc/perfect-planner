import "./helpers/hermetic-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectDocumentRegistry, reconcileRegisteredRoots, startDocumentWatcher, startLocalAuthorityHost } from "../src/node/documentRegistry.mjs";
import { createFolderContractMiddleware } from "../src/node/folderContractHttp.mjs";
import { createArchitectureContractMiddleware } from "../src/node/architectureContractStore.mjs";

async function fixture() { const base = await mkdtemp(path.join(os.tmpdir(), "pp-docs-")); const root = path.join(base, "root"); await mkdir(root); return { base, root, registry: path.join(base, "state", "registry.json") }; }

test("first reconciliation creates stable source identities for every readable document", async () => {
  const f = await fixture(); await writeFile(path.join(f.root, "brief.md"), "# Brief\n"); await writeFile(path.join(f.root, "plan.json"), JSON.stringify({ schemaVersion: 1, planId: "PP-X", tasks: [] }));
  const result = await reconcileRegisteredRoots(f.registry, [{ id: "project", path: f.root }], { observedAt: "2026-09-02T00:00:00.000Z" }); assert.equal(result.counts.added, 2); assert.ok(result.registry.sources.every((source) => /^SRC-AUTO-[A-F0-9]{12}$/.test(source.sourceId)));
});

test("unchanged reconciliation creates no duplicates", async () => {
  const f = await fixture(); await writeFile(path.join(f.root, "brief.md"), "one"); const roots = [{ id: "project", path: f.root }]; await reconcileRegisteredRoots(f.registry, roots); const second = await reconcileRegisteredRoots(f.registry, roots); assert.equal(second.counts.total, 1); assert.equal(second.events.length, 0);
});

test("changes append revisions while preserving source identity", async () => {
  const f = await fixture(); const file = path.join(f.root, "brief.md"); const roots = [{ id: "project", path: f.root }]; await writeFile(file, "one"); const first = await reconcileRegisteredRoots(f.registry, roots); await writeFile(file, "two"); const second = await reconcileRegisteredRoots(f.registry, roots); assert.equal(second.events[0].action, "changed"); assert.equal(second.registry.sources[0].sourceId, first.registry.sources[0].sourceId); assert.equal(second.registry.sources[0].revisions.length, 2);
});

test("deletion preserves ledger history and restoration reuses the same source", async () => {
  const f = await fixture(); const file = path.join(f.root, "brief.md"); const roots = [{ id: "project", path: f.root }]; await writeFile(file, "one"); const first = await reconcileRegisteredRoots(f.registry, roots); await rm(file); const deleted = await reconcileRegisteredRoots(f.registry, roots); assert.equal(deleted.registry.sources[0].state, "deleted"); await writeFile(file, "one"); const restored = await reconcileRegisteredRoots(f.registry, roots); assert.equal(restored.events[0].action, "restored"); assert.equal(restored.registry.sources[0].sourceId, first.registry.sources[0].sourceId);
});

test("multiple roots remain distinct and link escapes are recorded as refused", async () => {
  const f = await fixture(); const secondRoot = path.join(f.base, "second"); const outside = path.join(f.base, "outside"); await mkdir(secondRoot); await mkdir(outside); await writeFile(path.join(f.root, "same.md"), "a"); await writeFile(path.join(secondRoot, "same.md"), "b"); await symlink(outside, path.join(f.root, "linked"), process.platform === "win32" ? "junction" : "dir");
  const result = await reconcileRegisteredRoots(f.registry, [{ id: "a", path: f.root }, { id: "b", path: secondRoot }]); assert.equal(result.counts.total, 2); assert.equal(result.counts.refused, 1); assert.notEqual(result.registry.sources[0].sourceId, result.registry.sources[1].sourceId);
});

test("watcher runNow reconciles changes, does not overlap, and stops cleanly", async () => {
  const f = await fixture(); const updates = []; const watcher = startDocumentWatcher(f.registry, [{ id: "project", path: f.root }], { intervalMs: 60_000, onUpdate: (result) => updates.push(result) }); await writeFile(path.join(f.root, "new.md"), "new"); const [first, same] = await Promise.all([watcher.runNow(), watcher.runNow()]); assert.equal(first.generation, same.generation); assert.equal(updates.length, 1); watcher.stop(); assert.equal(watcher.stopped, true); await assert.rejects(() => watcher.runNow(), /stopped/); assert.equal((await inspectDocumentRegistry(f.registry)).sources.length, 1);
});

test("one bounded local host runs document watchers and folder/architecture middleware for one clean lifetime", async (t) => {
  const f = await fixture(); const authorityRoot = path.join(f.base, "authority");
  let intervalResolve; const intervalUpdate = new Promise((resolve) => { intervalResolve = resolve; });
  const host = await startLocalAuthorityHost({
    documentWatchers: [{ id: "project", registryPath: f.registry, roots: [{ id: "project", path: f.root }], intervalMs: 250, options: { onUpdate: (result) => { if (result.generation >= 2) intervalResolve(result); } } }],
    middleware: [createArchitectureContractMiddleware({ root: authorityRoot, actor: "danie", token: "architecture-token" }), createFolderContractMiddleware({ root: authorityRoot, actor: "danie", token: "folder-token" })],
  });
  t.after(async () => { await host.close(); await rm(f.base, { recursive: true, force: true }); });
  const local = (url, options = {}) => fetch(url, { ...options, headers: { ...options.headers, origin: host.origin } });
  const health = await local(`${host.origin}/api/local-authority/health`); assert.equal(health.status, 200); const body = await health.json(); assert.equal(body.state, "running"); assert.equal(body.watcherCount, 1); assert.equal(body.mountedMiddleware, 2); assert.equal(body.watchers[0].generation, 1);
  assert.equal((await fetch(`${host.origin}/api/local-authority/health`, { headers: { origin: "https://attacker.invalid" } })).status, 403);
  assert.equal((await fetch(`${host.origin}/api/architecture-contract/session`, { headers: { origin: "https://attacker.invalid" } })).status, 403);
  assert.equal((await local(`${host.origin}/api/architecture-contract/session`)).status, 200); assert.equal((await local(`${host.origin}/api/folder-contract/session`)).status, 200);
  assert.equal((await local(`${host.origin}/api/architecture-contract/inspect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ planId: "PP-HOST" }) })).status, 403);
  const inspected = await local(`${host.origin}/api/architecture-contract/inspect`, { method: "POST", headers: { "content-type": "application/json", "x-pp-architecture-token": "architecture-token" }, body: JSON.stringify({ planId: "PP-HOST" }) }); assert.equal(inspected.status, 200); assert.equal((await inspected.json()).count, 0);
  await writeFile(path.join(f.root, "interval.md"), "interval"); let intervalTimeout; const intervalResult = await Promise.race([intervalUpdate, new Promise((_, reject) => { intervalTimeout = setTimeout(() => reject(new Error("watcher interval did not reconcile")), 2000); })]); clearTimeout(intervalTimeout); assert.equal(intervalResult.generation, 2);
  await writeFile(path.join(f.root, "hosted.md"), "hosted"); const [first, same] = await Promise.all([host.runWatcher("project"), host.runWatcher("project")]); assert.equal(first.generation, 3); assert.equal(same.generation, 3); assert.equal(host.health().watchers[0].generation, 3);
  await rm(f.root, { recursive: true }); await assert.rejects(() => host.runWatcher("project")); assert.equal(host.state, "degraded"); assert.equal((await local(`${host.origin}/api/local-authority/health`)).status, 503); assert.equal((await local(`${host.origin}/api/folder-contract/session`)).status, 503);
  await mkdir(f.root); await writeFile(path.join(f.root, "recovered.md"), "recovered"); assert.equal((await host.runWatcher("project")).generation, 4); assert.equal(host.state, "running"); assert.equal((await local(`${host.origin}/api/local-authority/health`)).status, 200);
  const closed = await host.close(); assert.equal(closed.state, "closed"); await assert.rejects(() => host.runWatcher("project"), /not running/);
});

test("local authority host refuses startup when initial watcher reconciliation cannot prove health", async (t) => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  await assert.rejects(() => startLocalAuthorityHost({ documentWatchers: [{ id: "broken", registryPath: f.registry, roots: [{ id: "missing", path: path.join(f.base, "absent") }] }] }), /startup refused/);
  assert.equal((await inspectDocumentRegistry(f.registry)).generation, 0);
});
