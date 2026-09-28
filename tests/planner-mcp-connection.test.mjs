import test from "node:test";
import assert from "node:assert/strict";
import { createPlannerMcpConnectionController, validateBundledMcpObservation } from "../src/runtime/plannerMcpConnection.js";

const runtime = { __TAURI_INTERNALS__: {} };
const project = (id = "pp_one") => ({ projectId: id, generation: 3, kind: "imported", state: "observed", registration: { adapter: "native", access: "metadata-read-only", workspaceId: "workspace-one", registryRevision: 1, rootIdentity: "a".repeat(64) } });
const wire = (request, overrides = {}) => ({ ...request, state: "connected", code: "MCP_CONNECTED", observedAt: 100_000, expiresAt: 130_000, durationMs: 5, service: "perfect-planner-bundled-metadata", protocolVersion: "2025-11-25", capabilities: ["workspace-registration:read"], metadataOnly: true, executionAuthorized: false, computerUse: false, cleanupComplete: true, ...overrides });
const options = (extra = {}) => ({ runtime: { __TAURI_INTERNALS__: {} }, now: () => 100_000, requestId: () => "request-one", ...extra });
const pending = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test("browser/demo/stale/unregistered projects cannot invoke the bundled desktop service", async () => {
  let calls = 0;
  for (const [host, value] of [[{}, project()], [runtime, { ...project(), kind: "demo" }], [runtime, { ...project(), state: "stale" }], [runtime, { ...project(), registration: null }], [runtime, { ...project(), registration: { ...project().registration, adapter: "browser" } }]]) {
    const controller = createPlannerMcpConnectionController(options({ runtime: host, invoke: () => { calls += 1; } }));
    controller.setProject(value);
    await controller.check();
    assert.equal(controller.getSnapshot().status, "unavailable");
    assert.equal(controller.getSnapshot().canCheck, false);
    controller.dispose();
  }
  assert.equal(calls, 0);
});

test("native check sends only exact project binding and publishes metadata-only observation", async () => {
  const events = [];
  let captured;
  const controller = createPlannerMcpConnectionController(options({ onEvent: (event) => events.push(event), invoke: async (command, args) => { captured = { command, args }; return wire(args.request); } }));
  controller.setProject(project());
  await controller.check();
  assert.equal(captured.command, "check_bundled_mcp_connection");
  assert.deepEqual(Object.keys(captured.args.request).sort(), ["schemaVersion", "requestId", "projectId", "generation", "workspaceId", "registryRevision", "rootIdentity"].sort());
  assert.equal(controller.getSnapshot().status, "connected");
  assert.equal(events.length, 2);
  assert.equal(events[1].projectId, "pp_one");
  assert.equal(events[1].payload.code, "MCP_CONNECTED");
  assert.equal(controller.getSnapshot().promotionAuthority, undefined);
  controller.dispose();
});

test("project switch cancels acceptance and records interruption against the original project", async () => {
  const gate = pending(); const events = []; let captured;
  const controller = createPlannerMcpConnectionController(options({ onEvent: (event) => events.push(event), invoke: async (_, args) => { captured = args.request; return gate.promise; } }));
  controller.setProject(project()); const first = controller.check();
  controller.setProject(project("pp_two"));
  await first;
  gate.resolve(wire(captured));
  await Promise.resolve();
  assert.equal(controller.getSnapshot().projectId, "pp_two");
  assert.equal(controller.getSnapshot().status, "idle");
  assert.equal(events.at(-1).projectId, "pp_one");
  assert.equal(events.at(-1).payload.code, "MCP_INTERRUPTED");
  assert.equal(events.some((event) => event.payload.code === "MCP_CONNECTED"), false);
  controller.dispose();
});

test("same-project generation or registration changes invalidate prior connection evidence", async () => {
  const controller = createPlannerMcpConnectionController(options({ invoke: async (_, args) => wire(args.request) }));
  controller.setProject(project()); await controller.check();
  controller.setProject({ ...project(), generation: 4 });
  assert.equal(controller.getSnapshot().status, "idle");
  assert.equal(controller.getSnapshot().observedAt, null);
  await controller.check();
  controller.setProject({ ...project(), generation: 4, registration: { ...project().registration, registryRevision: 2 } });
  assert.equal(controller.getSnapshot().status, "idle");
  controller.dispose();
});

test("native observations reject wrong identities, expanded authority, expired proof and incomplete cleanup", () => {
  const request = { schemaVersion: 1, requestId: "request-one", projectId: "pp_one", generation: 3, workspaceId: "workspace-one", registryRevision: 1, rootIdentity: "a".repeat(64) };
  for (const change of [{ projectId: "pp_two" }, { generation: 4 }, { rootIdentity: "b".repeat(64) }, { registryRevision: 2 }, { service: "external" }, { protocolVersion: "wrong" }, { capabilities: ["process:execute"] }, { executionAuthorized: true }, { computerUse: true }, { cleanupComplete: false }, { expiresAt: 99_999 }, { expiresAt: 140_000 }, { code: "SECRET_RAW_DETAIL" }, { code: "MCP_TIMEOUT" }, { observedAt: 1 }, { unexpected: true }]) {
    assert.throws(() => validateBundledMcpObservation(wire(request, change), request, { now: 100_000, startedAt: 100_000 }), /MCP_PROTOCOL_ERROR/);
  }
});

test("timeout clears checking and raw native errors never leak into diagnostics", async () => {
  const events = [];
  const controller = createPlannerMcpConnectionController(options({ timeoutMs: 5, onEvent: (event) => events.push(event), invoke: async () => new Promise(() => {}) }));
  controller.setProject(project()); await controller.check();
  assert.equal(controller.getSnapshot().status, "failed");
  assert.equal(controller.getSnapshot().reason, "MCP_TIMEOUT");
  controller.dispose();
  const rejected = createPlannerMcpConnectionController(options({ onEvent: (event) => events.push(event), invoke: async () => { throw new Error("PRIVATE_KEY=must-not-log"); } }));
  rejected.setProject(project()); await rejected.check();
  assert.equal(rejected.getSnapshot().reason, "MCP_SERVICE_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_KEY|must-not-log/);
  rejected.dispose();
});

test("success expires, disconnect only clears observation, and reload has no restored green", async () => {
  const timers = new Map(); let sequence = 0;
  const controller = createPlannerMcpConnectionController(options({ invoke: async (_, args) => wire(args.request), setTimer: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay }); return id; }, clearTimer: (id) => timers.delete(id) }));
  controller.setProject(project()); await controller.check();
  const expiry = [...timers.values()].find((timer) => timer.delay === 30_000);
  assert.ok(expiry); expiry.fn();
  assert.equal(controller.getSnapshot().status, "expired");
  controller.disconnect();
  assert.equal(controller.getSnapshot().status, "idle");
  assert.equal(project().registration.access, "metadata-read-only");
  controller.dispose();
  const fresh = createPlannerMcpConnectionController(options()); fresh.setProject(project());
  assert.equal(fresh.getSnapshot().status, "idle"); fresh.dispose();
});

test("a second click does not start a duplicate probe and malformed response fails closed", async () => {
  const gate = pending(); let calls = 0;
  const controller = createPlannerMcpConnectionController(options({ invoke: async () => { calls += 1; return gate.promise; } }));
  controller.setProject(project()); const first = controller.check();
  await controller.check(); assert.equal(calls, 1);
  gate.resolve({ state: "connected" }); await first;
  assert.equal(controller.getSnapshot().status, "failed");
  assert.equal(controller.getSnapshot().reason, "MCP_PROTOCOL_ERROR");
  controller.dispose();
});

test("unavailable request identity stays a bounded failure instead of an unhandled rejection", async () => {
  const events = []; let calls = 0;
  const controller = createPlannerMcpConnectionController(options({ requestId: () => { throw new Error("private crypto error"); }, onEvent: (event) => events.push(event), invoke: () => { calls += 1; } }));
  controller.setProject(project()); await controller.check();
  assert.equal(controller.getSnapshot().status, "failed");
  assert.equal(controller.getSnapshot().reason, "MCP_REQUEST_INVALID");
  assert.equal(calls, 0);
  assert.equal(events[0].requestId, null);
  assert.doesNotMatch(JSON.stringify(events), /private crypto error/);
  controller.dispose();
});

test("clear and project switches cannot admit a second native check before the first settles", async () => {
  const wait = pending(); let captured; let calls = 0;
  const controller = createPlannerMcpConnectionController(options({ invoke: async (_, { request }) => { calls++; captured = request; return wait.promise; } }));
  controller.setProject(project()); const checking = controller.check();
  controller.disconnect(); await checking;
  controller.setProject(project("pp_two"));
  assert.equal(controller.getSnapshot().canCheck, false);
  await controller.check(); assert.equal(calls, 1);
  wait.resolve(wire(captured)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.getSnapshot().canCheck, true);
  assert.equal(controller.getSnapshot().observedAt, null);
  controller.dispose();
});

test("disposing and recreating the view preserves pending native admission", async () => {
  const host = { __TAURI_INTERNALS__: {} }; const wait = pending(); let captured; let calls = 0;
  const invoke = async (_, { request }) => { calls++; captured = request; return wait.promise; };
  const first = createPlannerMcpConnectionController(options({ runtime: host, invoke }));
  first.setProject(project()); const checking = first.check(); first.dispose(); await checking;
  const second = createPlannerMcpConnectionController(options({ runtime: host, invoke }));
  second.setProject(project()); assert.equal(second.getSnapshot().canCheck, false);
  await second.check(); assert.equal(calls, 1);
  wait.resolve(wire(captured)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(second.getSnapshot().canCheck, true);
  assert.equal(second.getSnapshot().status, "idle");
  second.dispose();
});

test("timeout quarantine survives clear, project switches, remount and late success", async () => {
  const host = { __TAURI_INTERNALS__: {} }; const wait = pending(); let captured; let calls = 0;
  const invoke = async (_, { request }) => { calls++; captured = request; return wait.promise; };
  const first = createPlannerMcpConnectionController(options({ runtime: host, timeoutMs: 5, invoke }));
  first.setProject(project()); await first.check();
  assert.equal(first.getSnapshot().canCheck, false);
  first.disconnect(); first.setProject(project("pp_two")); await first.check(); first.dispose();
  const second = createPlannerMcpConnectionController(options({ runtime: host, invoke }));
  second.setProject(project()); assert.equal(second.getSnapshot().canCheck, false);
  wait.resolve(wire(captured)); await new Promise(resolve => setImmediate(resolve));
  await second.check(); assert.equal(calls, 1);
  assert.equal(second.getSnapshot().canCheck, false);
  assert.equal(second.getSnapshot().observedAt, null);
  second.dispose();
});

test("interruption retains its independent deadline and records uncertain cleanup in the original project", async () => {
  const events = []; const host = { __TAURI_INTERNALS__: {} }; const timers = new Map(); let sequence = 0;
  const controller = createPlannerMcpConnectionController(options({ runtime: host, onEvent: e => events.push(e), invoke: () => new Promise(() => {}), setTimer: fn => { timers.set(++sequence, fn); return sequence; }, clearTimer: id => timers.delete(id) }));
  controller.setProject(project()); const checking = controller.check();
  controller.setProject(project("pp_two")); await checking;
  assert.equal(timers.size, 1);
  [...timers.values()][0](); await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.getSnapshot().canCheck, false);
  assert.equal(controller.getSnapshot().reason, "MCP_CLEANUP_FAILED");
  assert.equal(events.filter(e => e.payload.code === "MCP_CLEANUP_FAILED").length, 1);
  assert.ok(events.every(e => e.projectId === "pp_one"));
  assert.equal(timers.size, 0);
  controller.dispose();
});

test("explicit incomplete cleanup blocks retry while verified failed cleanup permits another check", async () => {
  for (const cleanupComplete of [true, false]) {
    let calls = 0;
    const controller = createPlannerMcpConnectionController(options({ invoke: async (_, { request }) => { calls++; return wire(request, { state: "failed", code: "MCP_SERVICE_UNAVAILABLE", expiresAt: 100_000, cleanupComplete }); } }));
    controller.setProject(project()); await controller.check();
    assert.equal(controller.getSnapshot().canCheck, cleanupComplete);
    await controller.check(); assert.equal(calls, cleanupComplete ? 2 : 1);
    controller.dispose();
  }
});

test("a completed view stays disabled if another view immediately acquires native admission", async () => {
  const host = { __TAURI_INTERNALS__: {} }; const wait = pending(); let calls = 0; let secondRequest; let secondRun;
  const first = createPlannerMcpConnectionController(options({ runtime: host, invoke: async (_, { request }) => { calls++; return wire(request); } }));
  const second = createPlannerMcpConnectionController(options({ runtime: host, invoke: async (_, { request }) => { calls++; secondRequest = request; return wait.promise; } }));
  first.setProject(project()); second.setProject(project());
  second.subscribe(() => { if (calls === 1 && second.getSnapshot().canCheck) secondRun = second.check(); });
  await first.check();
  assert.equal(calls, 2);
  assert.equal(first.getSnapshot().canCheck, false);
  wait.resolve(wire(secondRequest)); await secondRun;
  assert.equal(first.getSnapshot().canCheck, true);
  first.dispose(); second.dispose();
});
