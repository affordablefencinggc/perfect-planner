import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readGitWorkspaceInventory, parseGitBranches, parseGitWorktrees } from "../src/node/gitWorkspaceInventory.mjs";
import { inspectRegisteredGitWorkspace } from "../mcp/perfectPlannerMcpCore.mjs";

const sha = "a".repeat(40);
const hash = (text) => createHash("sha256").update(text).digest("hex");
const git = (cwd, args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
async function fixture(t, initialized = false) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "pp-git-inventory-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "repo"), registry = path.join(base, "registry");
  await mkdir(root); await mkdir(registry);
  const binding = { registryRevision: 1, rootIdentity: hash(root) };
  const record = { schemaVersion: 1, workspaceId: "inventory-fixture", access: "metadata-read-only", canonicalRoot: root, ...binding };
  const recordPath = path.join(registry, "inventory-fixture.json");
  await writeFile(recordPath, JSON.stringify(record));
  if (initialized) {
    git(root, ["init", "-b", "main"]); git(root, ["config", "user.name", "Inventory Fixture"]); git(root, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(path.join(root, "source.txt"), "baseline\n");
    git(root, ["add", "."]); git(root, ["commit", "-m", "baseline"]);
  }
  return { base, root, registry, binding, record, recordPath };
}
const worktreeText = (root) => `worktree ${root}\0HEAD ${sha}\0branch refs/heads/main\0\0`;
const result = (stdout) => ({ stdout, stderr: "", exit: 0, reason: null, outputComplete: true, cleanupComplete: true, outputBytes: Buffer.byteLength(stdout) });
const fakeGit = (root) => async (_cwd, args) => result(args[0] === "rev-parse" ? root + "\n" : args[0] === "worktree" ? worktreeText(root) : `refs/heads/main\0${sha}\n`);

test("registered local inventory observes real branches, detached and locked worktrees without changing tracked or dirty files", async (t) => {
  const f = await fixture(t, true);
  const linked = path.join(f.base, "linked"), detached = path.join(f.base, "detached");
  git(f.root, ["worktree", "add", "-b", "feature", linked]);
  git(f.root, ["worktree", "add", "--detach", detached]);
  git(f.root, ["worktree", "lock", "--reason", "private reason not returned", linked]);
  await writeFile(path.join(f.root, "source.txt"), "unfinished user work\n");
  await writeFile(path.join(linked, "untracked.txt"), "keep me\n");
  const before = git(f.root, ["status", "--porcelain=v1"]);
  const client = new Client({ name: "git-inventory-fixture", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../mcp/perfectPlannerMcpServer.mjs", import.meta.url))],
    env: { ...process.env, PERFECT_PLANNER_REGISTRY_ROOT: f.registry, PERFECT_PLANNER_COMPUTER_USE_AVAILABLE: "0" }, stderr: "pipe" });
  let value;
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const definition = tools.tools.find((entry) => entry.name === "planner_git_inventory");
    assert.ok(definition);
    assert.deepEqual(Object.keys(definition.inputSchema.properties).sort(), ["registry_revision", "root_identity", "workspace_id"]);
    const stale = await client.callTool({ name: "planner_git_inventory", arguments: { workspace_id: "inventory-fixture", registry_revision: 2, root_identity: f.binding.rootIdentity } });
    assert.equal(stale.isError, true);
    const response = await client.callTool({ name: "planner_git_inventory", arguments: { workspace_id: "inventory-fixture", registry_revision: 1, root_identity: f.binding.rootIdentity } });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    value = response.structuredContent;
  } finally { await client.close(); }
  const observation = value.observation;
  assert.equal(observation.state, "observed");
  assert.deepEqual(observation.branches.map((entry) => entry.ref), ["refs/heads/feature", "refs/heads/main"]);
  assert.equal(observation.worktrees.length, 3);
  assert.equal(observation.worktrees.find((entry) => entry.branchRef === "refs/heads/feature").locked, true);
  assert.equal(observation.worktrees.filter((entry) => entry.mode === "detached").length, 1);
  assert.equal(observation.cleanState, "not-inspected");
  assert.equal(observation.promotionAuthority, false);
  assert.equal(observation.productionState, "not-inspected");
  assert.equal(JSON.stringify(value).includes("private reason"), false);
  assert.equal(git(f.root, ["status", "--porcelain=v1"]), before);
  assert.equal(await readFile(path.join(f.root, "source.txt"), "utf8"), "unfinished user work\n");
  assert.equal(await readFile(path.join(linked, "untracked.txt"), "utf8"), "keep me\n");
});

test("plain folders do not inherit a parent repository or launch Git", async (t) => {
  const f = await fixture(t, true), child = path.join(f.root, "child");
  await mkdir(child);
  const observation = await readGitWorkspaceInventory(child, { gitRunner: () => assert.fail("must not launch") });
  assert.equal(observation.state, "no-git-marker");
  assert.deepEqual(observation.branches, []);
});

test("a new repository with no commits is observed without inventing branch commits", async (t) => {
  const f = await fixture(t);
  git(f.root, ["init", "-b", "main"]);
  const value = await inspectRegisteredGitWorkspace(f.registry, "inventory-fixture", f.binding);
  assert.equal(value.observation.state, "observed");
  assert.deepEqual(value.observation.branches, []);
  assert.equal(value.observation.worktrees[0].headSha, "0".repeat(40));
  assert.equal(value.observation.worktrees[0].branchRef, "refs/heads/main");
});

test("exact registration is required before execution and rechecked after observation", async (t) => {
  const f = await fixture(t, true);
  const refuseRun = () => assert.fail("must not launch");
  await assert.rejects(inspectRegisteredGitWorkspace(f.registry, "inventory-fixture", { ...f.binding, registryRevision: 2 }, { gitRunner: refuseRun }), { code: "MCP_GIT_BINDING_STALE" });
  await assert.rejects(inspectRegisteredGitWorkspace(f.registry, "inventory-fixture", { ...f.binding, rootIdentity: "0".repeat(64) }, { gitRunner: refuseRun }), { code: "MCP_GIT_BINDING_STALE" });
  let calls = 0;
  await assert.rejects(inspectRegisteredGitWorkspace(f.registry, "inventory-fixture", f.binding, { gitRunner: async (...args) => {
    calls++;
    if (calls === 6) await writeFile(f.recordPath, JSON.stringify({ ...f.record, registryRevision: 2 }));
    return fakeGit(f.root)(...args);
  } }), { code: "MCP_REGISTRY_CHANGED" });
});

test("changed observations, unknown output and incomplete commands cannot become inventory", async (t) => {
  const f = await fixture(t, true);
  let reads = 0;
  await assert.rejects(readGitWorkspaceInventory(f.root, { gitRunner: async (cwd, args) => {
    if (args[0] === "worktree" && ++reads === 2) return result(worktreeText(f.root).replace(sha, "b".repeat(40)));
    return fakeGit(f.root)(cwd, args);
  } }), { code: "MCP_GIT_INVENTORY_CHANGED" });
  await assert.rejects(readGitWorkspaceInventory(f.root, { gitRunner: async () => ({ ...result(""), outputComplete: false }) }), { code: "MCP_GIT_COMMAND_FAILED" });
  await assert.rejects(readGitWorkspaceInventory(f.root, { gitRunner: async () => result(path.dirname(f.root) + "\n") }), { code: "MCP_GIT_ROOT_MISMATCH" });
});

test("inventory parsers reject partial, duplicate, unsupported and oversized records", () => {
  const root = path.resolve("inventory");
  const text = worktreeText(root);
  assert.equal(parseGitWorktrees(text)[0].branchRef, "refs/heads/main");
  const stale = parseGitWorktrees(text.replace("\0\0", "\0prunable private stale reason\0\0"))[0];
  assert.equal(stale.prunable, true);
  assert.equal(stale.canAutomaticallyDelete, false);
  assert.equal(JSON.stringify(stale).includes("private stale reason"), false);
  for (const input of [text.slice(0, -1), text + text, text.replace("branch refs/heads/main", "unknown value"), text.replace(sha, "short"), text.replace("refs/heads/main", "refs/heads/lossy\ufffd")]) assert.throws(() => parseGitWorktrees(input), { code: "MCP_GIT_OUTPUT_INVALID" });
  const branch = `refs/heads/main\0${sha}\n`;
  for (const input of [branch.slice(0, -1), branch + branch, `refs/tags/a\0${sha}\n`, `refs/heads/lossy\ufffd\0${sha}\n`]) assert.throws(() => parseGitBranches(input), { code: "MCP_GIT_OUTPUT_INVALID" });
  assert.throws(() => parseGitBranches(Array.from({ length: 501 }, (_, i) => `refs/heads/b${i}\0${sha}\n`).join("")), { code: "MCP_GIT_INVENTORY_LIMIT" });
});

test("the aggregate process-output bound stops further Git commands", async (t) => {
  const f = await fixture(t, true);
  let calls = 0;
  await assert.rejects(readGitWorkspaceInventory(f.root, { gitRunner: async (...args) => {
    calls++;
    return { ...await fakeGit(f.root)(...args), outputBytes: 1024 * 1024 };
  } }), { code: "MCP_GIT_INVENTORY_LIMIT" });
  assert.equal(calls, 2);
});

test("one running inventory admits no overlapping Git request and cancellation releases admission after work settles", async (t) => {
  const f = await fixture(t, true), controller = new AbortController();
  let release, entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const request = inspectRegisteredGitWorkspace(f.registry, "inventory-fixture", f.binding, { signal: controller.signal, gitRunner: async () => { entered(); await held; return result(f.root + "\n"); } });
  await ready;
  await assert.rejects(inspectRegisteredGitWorkspace(f.registry, "inventory-fixture", f.binding), { code: "MCP_GIT_BUSY" });
  controller.abort(); release();
  await assert.rejects(request, { code: "MCP_OPERATION_CANCELLED" });
  const next = await inspectRegisteredGitWorkspace(f.registry, "inventory-fixture", f.binding, { gitRunner: fakeGit(f.root) });
  assert.equal(next.observation.state, "observed");
});

test("unconfirmed helper cleanup blocks later inventory calls instead of launching more processes", async (t) => {
  const f = await fixture(t, true);
  await assert.rejects(inspectRegisteredGitWorkspace(f.registry, "inventory-fixture", f.binding, { gitRunner: async () => ({ ...result(""), cleanupComplete: false }) }), { code: "MCP_GIT_PROCESS_UNCERTAIN" });
  await assert.rejects(inspectRegisteredGitWorkspace(f.registry, "inventory-fixture", f.binding, { gitRunner: () => assert.fail("must not launch") }), { code: "MCP_GIT_PROCESS_UNCERTAIN" });
});

test("thrown preflight cleanup uncertainty also closes admission", async (t) => {
  const f = await fixture(t, true);
  const isolatedCore = await import("../mcp/perfectPlannerMcpCore.mjs?thrown-preflight-uncertainty");
  const inspect = isolatedCore.inspectRegisteredGitWorkspace;
  await assert.rejects(inspect(f.registry, "inventory-fixture", f.binding, { gitRunner: async () => {
    throw Object.assign(new Error("git-process-cleanup-uncertain"), { code: "GIT_PROCESS_UNCERTAIN", cleanupComplete: false });
  } }), { code: "MCP_GIT_PROCESS_UNCERTAIN" });
  await assert.rejects(inspect(f.registry, "inventory-fixture", f.binding, { gitRunner: () => assert.fail("must not launch") }), { code: "MCP_GIT_PROCESS_UNCERTAIN" });
});
