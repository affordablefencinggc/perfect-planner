import test from "node:test";
import assert from "node:assert/strict";
import { createPlannerGitInventoryController, validateGitInventory } from "../src/runtime/plannerGitInventory.js";

const project = (projectId = "project-one") => ({ projectId, generation: 1, kind: "imported", state: "observed", registration: { adapter: "native", access: "metadata-read-only", workspaceId: "workspace-one", registryRevision: 1, rootIdentity: "a".repeat(64) } });
const observation = () => ({ schemaVersion: 1, kind: "git-inventory", state: "observed", localOnly: true, worktrees: [{ path: "C:/fixture", headSha: "b".repeat(40), branchRef: "refs/heads/main", mode: "branch", locked: true, prunable: false, cleanState: "not-inspected", canAutomaticallyDelete: false }], branches: [{ ref: "refs/heads/main", headSha: "b".repeat(40) }], cleanState: "not-inspected", ciState: "not-inspected", productionState: "not-inspected", promotionAuthority: false, canAutomaticallyDelete: false, consistency: "two-matching-reads-not-atomic" });
const wire = (request) => ({ ...request, code: "GIT_OBSERVED", observedAt: 100_000, expiresAt: 130_000, durationMs: 5, observation: observation(), cleanupComplete: true, metadataOnly: true, executionAuthorized: false, computerUse: false });
const options = (extra = {}) => ({ runtime: { __TAURI_INTERNALS__: {} }, now: () => 100_000, requestId: () => "request-one", ...extra });
const request = { schemaVersion: 1, requestId: "request-one", projectId: "project-one", generation: 1, workspaceId: "workspace-one", registryRevision: 1, rootIdentity: "a".repeat(64) };

test("Git controller sends only registered identity and freezes unverified metadata", async () => {
  let captured, original;
  const events = [];
  const c = createPlannerGitInventoryController(options({ onEvent: e => events.push(e), invoke: async (command, args) => { captured = { command, args }; original = wire(args.request); return original; } }));
  c.setProject(project()); await c.check();
  assert.equal(captured.command, "inspect_registered_git_inventory"); assert.deepEqual(captured.args, { request });
  assert.equal(c.getSnapshot().status, "observed");
  assert.deepEqual(events.map(e => e.payload.phase), ["start", "finish"]);
  assert.ok(events.every(e => e.projectId === request.projectId && e.requestId === request.requestId));
  assert.equal(JSON.stringify(events).includes("C:/fixture"), false);
  assert.equal(JSON.stringify(events).includes("refs/heads/main"), false);
  original.observation.worktrees[0].path = "C:/changed";
  assert.equal(c.getSnapshot().result.observation.worktrees[0].path, "C:/fixture");
  assert.equal(c.getSnapshot().result.observation.ciState, "not-inspected"); c.dispose();
});

test("browser, demo, stale and unregistered projects never invoke Git", async () => {
  for (const [runtime, p] of [[{}, project()], [{ __TAURI_INTERNALS__: {} }, { ...project(), kind: "demo" }], [{ __TAURI_INTERNALS__: {} }, { ...project(), state: "stale" }], [{ __TAURI_INTERNALS__: {} }, { ...project(), registration: null }]]) {
    const c = createPlannerGitInventoryController(options({ runtime, invoke: () => assert.fail("must not invoke") }));
    c.setProject(p); await c.check(); assert.equal(c.getSnapshot().canCheck, false); c.dispose();
  }
});

test("wrong identity, stale data, authority expansion and malformed nested data are rejected", () => {
  const mutations = [v => v.generation++, v => v.expiresAt = 99_000, v => v.executionAuthorized = true, v => v.cleanupComplete = false, v => v.observation.ciState = "passed", v => v.observation.worktrees.push(v.observation.worktrees[0]), v => v.observation.branches[0].ref = "refs/heads/bad\ufffd", v => v.observation.extra = true, v => v.observation.worktrees[0].headSha = "short", v => v.observation.worktrees[0].path = "relative/path", v => v.durationMs = 26_000];
  for (const change of mutations) { const v = wire(request); change(v); assert.throws(() => validateGitInventory(v, request, { now: 100_000, startedAt: 100_000 }), /GIT_PROTOCOL_ERROR/); }
});

test("switching projects suppresses old results and retains admission until native settlement", async () => {
  let release, calls = 0;
  const c = createPlannerGitInventoryController(options({ invoke: (_command, args) => { calls++; return new Promise(resolve => { release = () => resolve(wire(args.request)); }); } }));
  c.setProject(project()); const pending = c.check();
  c.setProject(project("project-two")); await c.check(); assert.equal(calls, 1);
  release(); await pending;
  assert.equal(c.getSnapshot().result, null); assert.equal(c.getSnapshot().canCheck, true); c.dispose();
});

test("expiry removes evidence instead of leaving stale branches displayed", async () => {
  const timers = [];
  const c = createPlannerGitInventoryController(options({ invoke: async (_cmd, args) => wire(args.request), setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimer: () => {} }));
  c.setProject(project()); await c.check(); timers.find(t => t.ms === 30_000).fn();
  assert.equal(c.getSnapshot().status, "expired"); assert.equal(c.getSnapshot().result, null); c.dispose();
});

test("timeout and cleanup uncertainty prevent retries even after project switches", async () => {
  for (const mode of ["timeout", "uncertain", "rejected"]) {
    let timer, calls = 0;
    const c = createPlannerGitInventoryController(options({ setTimer: fn => { timer = fn; return 1; }, clearTimer: () => {}, invoke: async (_cmd, args) => { calls++; if (mode === "timeout") return new Promise(() => {}); if (mode === "rejected") throw new Error("private native details"); return { ...wire(args.request), code: "GIT_CLEANUP_UNCERTAIN", observation: null, expiresAt: 100_000, cleanupComplete: false }; } }));
    c.setProject(project()); const p = c.check(); if (mode === "timeout") timer(); await p;
    c.setProject(project("project-two")); await c.check(); assert.equal(calls, 1); assert.equal(c.getSnapshot().canCheck, false); assert.equal(c.getSnapshot().result, null); c.dispose();
  }
});

test("closing and reopening Operations retains admission until the original native call settles", async () => {
  const runtime = { __TAURI_INTERNALS__: {} };
  let resolve, calls = 0;
  const invoke = (_cmd, args) => { calls++; return new Promise(done => { resolve = () => done(wire(args.request)); }); };
  const first = createPlannerGitInventoryController(options({ runtime, invoke }));
  first.setProject(project()); const pending = first.check(); first.dispose();
  const reopened = createPlannerGitInventoryController(options({ runtime, invoke }));
  reopened.setProject(project()); await reopened.check();
  assert.equal(calls, 1); assert.equal(reopened.getSnapshot().canCheck, false);
  resolve(); await pending;
  assert.equal(reopened.getSnapshot().canCheck, true);
  assert.equal(reopened.getSnapshot().result, null, "old panel results must not populate a new panel");
  reopened.dispose();
});

test("uncertain cleanup survives disposal and cannot be cleared by a late successful response", async () => {
  const runtime = { __TAURI_INTERNALS__: {} };
  let timeout, release, calls = 0;
  const invoke = (_cmd, args) => { calls++; return new Promise(done => { release = () => done(wire(args.request)); }); };
  const first = createPlannerGitInventoryController(options({ runtime, invoke, setTimer: fn => { timeout = fn; return 1; }, clearTimer: () => {} }));
  first.setProject(project()); const pending = first.check(); first.dispose();
  const reopened = createPlannerGitInventoryController(options({ runtime, invoke })); reopened.setProject(project());
  timeout(); await pending; release(); await Promise.resolve();
  assert.equal(reopened.getSnapshot().status, "failed");
  assert.equal(reopened.getSnapshot().canCheck, false); assert.equal(reopened.getSnapshot().result, null);
  reopened.dispose();
  const again = createPlannerGitInventoryController(options({ runtime, invoke })); again.setProject(project("project-two"));
  await again.check(); assert.equal(calls, 1); assert.equal(again.getSnapshot().canCheck, false); again.dispose();
});
