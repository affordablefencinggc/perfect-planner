import "./helpers/hermetic-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { authorizeNativeOperation, compileNativeCapabilityPolicy, nativeOperationHash } from "../src/engine/nativeCapabilityPolicy.js";

const root = path.resolve("C:/repos/perfect-planner-cleanroom");
const base = { planId: "PP-014", taskId: "T11", mode: "interactive" };
const request = (capability, target, extra = {}) => ({ capability, target, planId: base.planId, taskId: base.taskId, ...extra });
const confirmation = (policy, operation, now = 1000) => ({ approved: true, explicitGesture: true, actor: "danie", operationHash: nativeOperationHash(policy, operation), expiresAt: new Date(now + 60_000).toISOString() });

test("policies are deny-by-default and reject unknown or wildcard grants", () => {
  assert.throws(() => compileNativeCapabilityPolicy({ ...base, defaultDecision: "allow" }), /deny-by-default/);
  assert.throws(() => compileNativeCapabilityPolicy({ ...base, grants: [{ capability: "device.teleport", devices: ["phone"] }] }), /Unknown/);
  assert.throws(() => compileNativeCapabilityPolicy({ ...base, grants: [{ capability: "filesystem.read", roots: ["*"] }] }), /wildcards/);
});

test("ungranted capabilities and mismatched work identities fail closed", () => {
  const policy = compileNativeCapabilityPolicy({ ...base, grants: [{ capability: "filesystem.read", roots: [root] }] });
  assert.equal(authorizeNativeOperation(policy, request("network.request", "https://github.com"), { now: 1000 }).allowed, false);
  assert.match(authorizeNativeOperation(policy, { ...request("filesystem.read", path.join(root, "README.md")), taskId: "T12" }, { now: 1000 }).reasons[0], /identity/);
});

test("filesystem grants contain paths and writes require exact fresh confirmation", () => {
  const policy = compileNativeCapabilityPolicy({ ...base, grants: [{ capability: "filesystem.read", roots: [root] }, { capability: "filesystem.write", roots: [root] }] });
  assert.equal(authorizeNativeOperation(policy, request("filesystem.read", path.join(root, "README.md")), { now: 1000 }).allowed, true);
  assert.equal(authorizeNativeOperation(policy, request("filesystem.read", path.resolve(root, "..", "outside.md")), { now: 1000 }).allowed, false);
  const write = request("filesystem.write", path.join(root, "proof.json"));
  assert.equal(authorizeNativeOperation(policy, write, { now: 1000 }).allowed, false);
  assert.equal(authorizeNativeOperation(policy, write, { now: 1000, confirmation: confirmation(policy, write) }).allowed, true);
});

test("process execution forbids shells, inline evaluation, and shell mode", () => {
  const policy = compileNativeCapabilityPolicy({ ...base, grants: [{ capability: "process.execute", executables: [process.execPath] }] });
  assert.equal(authorizeNativeOperation(policy, request("process.execute", process.execPath, { args: ["tests/run.mjs"], shell: false }), { now: 1000 }).allowed, true);
  assert.equal(authorizeNativeOperation(policy, request("process.execute", process.execPath, { args: ["-e", "bad"], shell: false }), { now: 1000 }).allowed, false);
  assert.equal(authorizeNativeOperation(policy, request("process.execute", process.execPath, { args: [], shell: true }), { now: 1000 }).allowed, false);
});

test("network grants require exact HTTPS hosts with no embedded credentials", () => {
  const policy = compileNativeCapabilityPolicy({ ...base, grants: [{ capability: "network.request", hosts: ["api.github.com"] }] });
  assert.equal(authorizeNativeOperation(policy, request("network.request", "https://api.github.com/repos"), { now: 1000 }).allowed, true);
  assert.equal(authorizeNativeOperation(policy, request("network.request", "http://api.github.com/repos"), { now: 1000 }).allowed, false);
  assert.equal(authorizeNativeOperation(policy, request("network.request", "https://evil.api.github.com/repos"), { now: 1000 }).allowed, false);
});

test("secrets remain opaque handles and plaintext-looking fields are refused", () => {
  const policy = compileNativeCapabilityPolicy({ ...base, grants: [{ capability: "secret.use", providers: ["review-a"] }] });
  assert.equal(authorizeNativeOperation(policy, request("secret.use", "secret://provider/review-a", { providerId: "review-a" }), { now: 1000 }).allowed, true);
  assert.equal(authorizeNativeOperation(policy, request("secret.use", "secret://provider/review-a", { providerId: "review-a", apiKey: "leak" }), { now: 1000 }).allowed, false);
});

test("device control is impossible in autopilot even with a configured grant", () => {
  const policy = compileNativeCapabilityPolicy({ ...base, mode: "autopilot", grants: [{ capability: "device.control", devices: ["phone-1"] }] });
  const operation = request("device.control", "phone-1", { action: "open" });
  const result = authorizeNativeOperation(policy, operation, { now: 1000, confirmation: confirmation(policy, operation) });
  assert.equal(result.allowed, false); assert.match(result.reasons[0], /forbidden during autopilot/);
});

test("human confirmation is operation-bound, actor-bound, and expires", () => {
  const policy = compileNativeCapabilityPolicy({ ...base, grants: [{ capability: "screen.capture", surfaces: ["app-main"] }] });
  const operation = request("screen.capture", "app-main", { action: "capture" });
  assert.equal(authorizeNativeOperation(policy, operation, { now: 1000, confirmation: { ...confirmation(policy, operation), operationHash: "forged" } }).allowed, false);
  assert.equal(authorizeNativeOperation(policy, operation, { now: 1000, confirmation: confirmation(policy, operation) }).allowed, true);
  assert.equal(authorizeNativeOperation(policy, operation, { now: 70_000, confirmation: confirmation(policy, operation) }).allowed, false);
});
