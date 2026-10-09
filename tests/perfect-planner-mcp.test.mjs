import "./helpers/hermetic-env.mjs";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash } from "node:crypto";

import {
  buildComputerUseBrief,
  inspectRegisteredWorkspaceInventory,
  inspectRegisteredMergeRecovery,
  mapRegisteredWorkspace,
  readRegisteredWorkspaces,
  resolveRegisteredWorkspace,
  searchRegisteredWorkspace,
} from "../mcp/perfectPlannerMcpCore.mjs";
import { registerMergeRecoveryStore, createMergeTransactionIntent } from '../src/node/mergeTransactionStore.mjs';

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const runFile = promisify(execFile);
const verifier = fileURLToPath(new URL("../scripts/verify-perfect-planner-mcp.mjs", import.meta.url));

test("CI MCP fixture uses isolated registration, verifies transport, and never asserts live computer-use", async () => {
  const { stdout } = await runFile(process.execPath, [verifier, "--fixture"], {
    env: { ...process.env, APPDATA: "", PERFECT_PLANNER_REGISTRY_ROOT: "missing-registry",
      PERFECT_PLANNER_WORKSPACE_ID: "unrelated-live-app", PERFECT_PLANNER_COMPUTER_USE_AVAILABLE: "1" },
    timeout: 30_000,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.mode, "fixture");
  assert.match(result.scope, /Synthetic/);
  assert.equal(result.mapped.fileCount, 2);
  assert.equal(result.searched.matchCount, 1);
  assert.equal(result.computerUseBrief.computerUseAvailable, false);
  assert.equal(result.workspaces[0].workspaceId, "smoke-fixture");
  assert.deepEqual([...result.toolNames].sort(), ['planner_prepare_task_draft', 'planner_list_registered_apps', 'planner_map_app', 'planner_search_app', 'planner_git_inventory', 'planner_inspect_recovery', 'planner_prepare_computer_use'].sort());
  assert.ok(result.toolNames.includes('planner_inspect_recovery'));
  assert.equal(result.gitInventory.state, "no-git-marker");
  assert.equal(result.gitInventory.promotionAuthority, false);
  await assert.rejects(access(result.registryRoot), { code: "ENOENT" });
});

test("live MCP verifier uses supplied registration and defaults computer-use to unavailable", async () => {
  const { base, registryRoot } = await fixture();
  try {
    const env = { ...process.env, PERFECT_PLANNER_REGISTRY_ROOT: registryRoot, PERFECT_PLANNER_WORKSPACE_ID: "demo-app" };
    delete env.PERFECT_PLANNER_COMPUTER_USE_AVAILABLE;
    const { stdout } = await runFile(process.execPath, [verifier], { env, timeout: 30_000 });
    const result = JSON.parse(stdout);
    assert.equal(result.mode, "live");
    assert.equal(result.workspaces[0].workspaceId, "demo-app");
    assert.equal(result.computerUseBrief.computerUseAvailable, false);
    await access(registryRoot);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("data-only verification never calls the computer-use briefing tool even with ambient availability", async () => {
  const { stdout } = await runFile(process.execPath, [verifier, "--fixture", "--data-only"], {
    env: { ...process.env, PERFECT_PLANNER_COMPUTER_USE_AVAILABLE: "1" }, timeout: 30_000,
  });
  const result = JSON.parse(stdout);
  assert.deepEqual(result.exercisedTools, ["planner_list_registered_apps", "planner_map_app", "planner_search_app", "planner_git_inventory"]);
  assert.deepEqual(result.computerUseBrief, { skipped: true, reason: "data-only-verification" });
  assert.equal(result.mapped.fileCount, 2);
  assert.equal(result.searched.matchCount, 1);
});

test("live MCP verification fails without a registry instead of silently substituting fixture evidence", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "perfect-planner-mcp-missing-"));
  try {
    await assert.rejects(runFile(process.execPath, [verifier], {
      env: { ...process.env, PERFECT_PLANNER_REGISTRY_ROOT: path.join(base, "missing") },
      timeout: 30_000,
    }), (error) => error.code === 1 && /ENOENT/.test(error.stderr) && error.stdout === "");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), "perfect-planner-mcp-"));
  const registryRoot = path.join(base, "registry");
  const workspaceRoot = path.join(base, "workspace");
  await mkdir(path.join(workspaceRoot, "src", "components"), { recursive: true });
  await mkdir(registryRoot, { recursive: true });
  await writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ scripts: { build: "vite build" }, dependencies: { react: "19.2.0" } }));
  await writeFile(path.join(workspaceRoot, "src", "components", "App.jsx"), "export function App() { return <main>Needle signal</main>; }\n");
  const canonicalRoot = path.resolve(workspaceRoot);
  await writeFile(path.join(registryRoot, "demo-app.json"), JSON.stringify({
    schemaVersion: 1,
    registryRevision: 1,
    workspaceId: "demo-app",
    canonicalRoot,
    rootIdentity: sha256(canonicalRoot),
    access: "metadata-read-only",
  }));
  return { base, registryRoot, workspaceRoot, canonicalRoot };
}

test('recovery stdio tool refuses unconfigured hosts and inspects only registered opaque stores', async t => {
  const f = await recoveryFixture(t);
  const args = { workspace_id: 'demo-app', registry_revision: 1, root_identity: f.request.rootIdentity, catalog_head: null, store_id: null, cursor: null };
  const connect = async configured => {
    const env = { ...process.env, PERFECT_PLANNER_REGISTRY_ROOT: f.registryRoot, PERFECT_PLANNER_RECOVERY_CATALOG_ROOT: configured ? f.catalogRoot : '' };
    const client = new Client({ name: 'recovery-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../mcp/perfectPlannerMcpServer.mjs', import.meta.url))], env, stderr: 'pipe' }));
    t.after(() => client.close()); return client;
  };
  const unavailable = await connect(false);
  const missing = await unavailable.callTool({ name: 'planner_inspect_recovery', arguments: args });
  assert.equal(missing.isError, true); assert.equal(missing.structuredContent.code, 'MCP_RECOVERY_NOT_CONFIGURED');
  const client = await connect(true);
  const call = arguments_ => client.callTool({ name: 'planner_inspect_recovery', arguments: arguments_ });
  const unknown = await call(args);
  assert.equal(unknown.structuredContent.observation.coverage, 'unknown');
  const catalog = await f.register();
  const discovery = await call(args);
  assert.equal(discovery.structuredContent.observation.stores.length, 1);
  const selected = { ...args, catalog_head: catalog.head, store_id: catalog.stores[0].storeId };
  const foreignRoot = path.join(f.base, 'foreign-repository');
  await mkdir(foreignRoot);
  for (const [transactionId, repositoryRoot] of [['own-pending', f.canonicalRoot], ['foreign-pending', foreignRoot]]) {
    await createMergeTransactionIntent({ storeRoot: f.storeRoot, repositoryRoot, repositoryIdentity: sha256(repositoryRoot),
      transactionId, owner: 'fixture-worker', operation: 'merge-rehearsal', baseSha: 'a'.repeat(40), sourceSha: 'b'.repeat(40),
      sourceRef: 'feature', targetRef: 'main', allowedWorktreeRoot: f.worktreeRoot, worktreePath: path.join(f.worktreeRoot, transactionId) });
  }
  const page = await call(selected);
  assert.equal(page.isError, undefined);
  assert.equal(page.structuredContent.observation.status, 'page-observed');
  assert.equal(page.structuredContent.observation.promotionAuthority, false);
  assert.deepEqual(page.structuredContent.observation.page.transactions.map(record => record.transactionId), ['own-pending']);
  assert.equal(page.structuredContent.observation.page.transactions[0].state, 'INTENT_RECORDED');
  assert.equal(JSON.stringify(page).includes('foreign-pending'), false);
  assert.equal(JSON.stringify(page).includes(JSON.stringify(f.storeRoot).slice(1, -1)), false);
  const stale = await call({ ...selected, registry_revision: 99 });
  assert.equal(stale.isError, true); assert.equal(stale.structuredContent.code, 'MCP_RECOVERY_UNAVAILABLE');
  const injected = await call({ ...args, store_root: f.storeRoot });
  assert.equal(injected.isError, true);
  await writeFile(path.join(f.catalogRoot, catalog.repositoryIdentity, '000001.json'), '{PRIVATE_FIXTURE_TEXT');
  const corrupt = await call(selected);
  assert.equal(corrupt.isError, true);
  assert.equal(JSON.stringify(corrupt).includes('PRIVATE_FIXTURE_TEXT'), false);
  assert.equal(JSON.stringify(corrupt).includes(JSON.stringify(f.base).slice(1, -1)), false);
});

async function recoveryFixture(t) {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  f.catalogRoot = path.join(f.base, 'recovery-catalog'); f.storeRoot = path.join(f.base, 'custom-transactions'); f.worktreeRoot = path.join(f.base, 'candidates');
  await Promise.all([f.catalogRoot, f.storeRoot, f.worktreeRoot].map(p => mkdir(p)));
  f.request = { registryRevision: 1, rootIdentity: sha256(f.canonicalRoot), catalogHead: null, storeId: null, cursor: null };
  f.inspect = request => inspectRegisteredMergeRecovery(f.registryRoot, f.catalogRoot, 'demo-app', request ?? f.request);
  f.register = () => registerMergeRecoveryStore({ catalogRoot: f.catalogRoot, repositoryRoot: f.canonicalRoot, storeRoot: f.storeRoot, actor: 'fixture-authority', expectedHead: 'GENESIS' });
  return f;
}
test('registered recovery discovery leaves missing catalog unknown and rejects browser path fields', async t => {
  const f = await recoveryFixture(t); const result = await f.inspect();
  assert.equal(result.observation.status, 'unconfigured'); assert.equal(result.observation.coverage, 'unknown');
  assert.equal(result.observation.page, null); assert.equal(result.observation.executionAuthorized, false);
  await assert.rejects(f.inspect({ ...f.request, storeRoot: f.storeRoot }), { code: 'MCP_RECOVERY_REQUEST_INVALID' });
  await assert.rejects(f.inspect({ ...f.request, registryRevision: 2 }), { code: 'MCP_RECOVERY_BINDING_STALE' });
});
test('registered recovery resolves opaque custom-store identity and returns pending journal metadata without paths', async t => {
  const f = await recoveryFixture(t); const catalog = await f.register();
  await createMergeTransactionIntent({ storeRoot: f.storeRoot, repositoryRoot: f.canonicalRoot, repositoryIdentity: sha256(f.canonicalRoot),
    transactionId: 'retained-fixture', owner: 'fixture-worker', operation: 'merge-rehearsal', baseSha: 'a'.repeat(40), sourceSha: 'b'.repeat(40),
    sourceRef: 'feature', targetRef: 'main', allowedWorktreeRoot: f.worktreeRoot, worktreePath: path.join(f.worktreeRoot, 'retained-fixture') });
  const discovered = await f.inspect(); assert.deepEqual(discovered.observation.stores, [{ storeId: catalog.stores[0].storeId }]);
  const result = await f.inspect({ ...f.request, storeId: catalog.stores[0].storeId, catalogHead: catalog.head });
  assert.equal(result.observation.status, 'page-observed'); assert.equal(result.observation.page.transactions[0].transactionId, 'retained-fixture');
  assert.equal(result.observation.page.transactions[0].promotionAuthority, false); assert.equal(result.observation.canAutomaticallyDelete, false);
  assert.equal(JSON.stringify(result).includes(f.base.replaceAll('\\', '\\\\')), false);
  assert.equal(Object.hasOwn(result.workspace, 'canonicalRoot'), false);
});
test('recovery selection refuses stale catalog heads, foreign stores and corrupt coverage', async t => {
  const f = await recoveryFixture(t); const catalog = await f.register();
  const request = { ...f.request, storeId: catalog.stores[0].storeId, catalogHead: catalog.head };
  await assert.rejects(f.inspect({ ...request, catalogHead: '0'.repeat(64) }), { code: 'MCP_RECOVERY_CATALOG_STALE' });
  await assert.rejects(f.inspect({ ...request, storeId: '0'.repeat(64) }), { code: 'MCP_RECOVERY_STORE_UNKNOWN' });
  await writeFile(path.join(f.catalogRoot, catalog.repositoryIdentity, '.pending-interrupted.json'), '{');
  await assert.rejects(f.inspect(request), { code: 'MCP_RECOVERY_UNAVAILABLE' });
});
test('recovery errors omit missing-store paths and malformed catalog contents', async t => {
  const f = await recoveryFixture(t); const catalog = await f.register();
  const verify = error => { assert.equal(error.code, 'MCP_RECOVERY_UNAVAILABLE'); assert.equal(error.cause, undefined); assert.equal(error.message.includes(f.base), false); assert.equal(error.message.includes('PRIVATE_FIXTURE_TEXT'), false); return true; };
  // Delete only this test's empty synthetic store to exercise ENOENT handling.
  await rm(f.storeRoot, { recursive: true });
  await assert.rejects(f.inspect(), verify);
  await mkdir(f.storeRoot);
  await writeFile(path.join(f.catalogRoot, catalog.repositoryIdentity, '000001.json'), '{PRIVATE_FIXTURE_TEXT');
  await assert.rejects(f.inspect(), verify);
});
test('registered recovery snapshots request binding before asynchronous resolution', async t => {
  const f = await recoveryFixture(t); const request = { ...f.request }; const running = f.inspect(request);
  request.registryRevision = 99; request.rootIdentity = '0'.repeat(64);
  const result = await running; assert.equal(result.workspace.registryRevision, 1); assert.equal(result.workspace.rootIdentity, f.request.rootIdentity);
});

async function writeRegistration(registryRoot, workspaceId, canonicalRoot, overrides = {}) {
  const record = {
    schemaVersion: 1,
    registryRevision: 1,
    workspaceId,
    canonicalRoot,
    rootIdentity: sha256(canonicalRoot),
    access: "metadata-read-only",
    ...overrides,
  };
  await writeFile(path.join(registryRoot, `${workspaceId}.json`), JSON.stringify(record));
  return record;
}

test("MCP excludes native build output but includes extensionless delivery hooks", async () => {
  const { base, registryRoot, workspaceRoot } = await fixture();
  try {
    await mkdir(path.join(workspaceRoot, "src-tauri", "target-codex", "debug"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "src-tauri", "target-codex", "debug", "generated.json"), "{}");
    await mkdir(path.join(workspaceRoot, ".githooks"));
    await writeFile(path.join(workspaceRoot, ".githooks", "pre-commit"), "# delivery-hook-marker\n");
    await writeFile(path.join(workspaceRoot, ".githooks", "pre-push"), "# delivery-hook-marker\n");
    const map = await mapRegisteredWorkspace(registryRoot, "demo-app", { maxDepth: 5, maxNodes: 50 });
    assert.equal(map.census.fileCount, 4);
    assert.equal(map.structure.truncated, false);
    assert.doesNotMatch(JSON.stringify(map.structure), /target-codex/);
    const search = await searchRegisteredWorkspace(registryRoot, "demo-app", "delivery-hook-marker");
    assert.deepEqual(search.matches.map((match) => match.path).sort(), [".githooks/pre-commit", ".githooks/pre-push"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("registered apps are verified before mapping, search, or computer-use briefing", async () => {
  const { base, registryRoot } = await fixture();
  try {
    const workspaces = await readRegisteredWorkspaces(registryRoot);
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0].workspaceId, "demo-app");

    const map = await mapRegisteredWorkspace(registryRoot, "demo-app", { maxDepth: 4, maxNodes: 50 });
    assert.equal(map.census.fileCount, 2);
    assert.equal(map.discovery.appName, "workspace");
    assert.ok(map.structure.nodeCount >= 3);

    const search = await searchRegisteredWorkspace(registryRoot, "demo-app", "needle");
    assert.equal(search.matchCount, 1);
    assert.equal(search.matches[0].path, "src/components/App.jsx");
    assert.equal(search.matches[0].line, 1);

    const brief = await buildComputerUseBrief(registryRoot, "demo-app", { intent: "Open the mapped app and verify its visible state." });
    assert.equal(brief.authority, "external-explicit-user-request");
    assert.match(brief.plannerBoundary, /does not move the pointer/i);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("one corrupt registry neighbour is isolated without denying healthy projects", async () => {
  const { base, registryRoot } = await fixture();
  try {
    const secondRoot = path.join(base, "second-workspace");
    await mkdir(secondRoot);
    await writeFile(path.join(secondRoot, "README.md"), "# second\n");
    await writeRegistration(registryRoot, "second-app", path.resolve(secondRoot));
    await writeFile(path.join(registryRoot, "broken-app.json"), "{ definitely not json");
    await writeFile(path.join(registryRoot, "BAD.json"), "{}");

    const inventory = await inspectRegisteredWorkspaceInventory(registryRoot);
    assert.deepEqual(inventory.workspaces.map((workspace) => workspace.workspaceId), ["demo-app", "second-app"]);
    assert.equal(inventory.issues.length, 2);
    assert.ok(inventory.issues.every((issue) => issue.reason === "Registry entry was isolated because it did not verify."));

    const mapped = await mapRegisteredWorkspace(registryRoot, "second-app");
    assert.equal(mapped.workspace.workspaceId, "second-app");
    assert.equal(mapped.census.fileCount, 1);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("tampered identities, unknown registration fields, and non-canonical roots are refused", async () => {
  const { base, registryRoot, canonicalRoot } = await fixture();
  try {
    await writeRegistration(registryRoot, "wrong-hash", canonicalRoot, { rootIdentity: "0".repeat(64) });
    await assert.rejects(
      () => resolveRegisteredWorkspace(registryRoot, "wrong-hash"),
      (error) => error.code === "MCP_ROOT_IDENTITY_INVALID",
    );

    await writeRegistration(registryRoot, "extra-field", canonicalRoot, { untrustedPath: canonicalRoot });
    await assert.rejects(
      () => resolveRegisteredWorkspace(registryRoot, "extra-field"),
      (error) => error.code === "MCP_REGISTRY_ENTRY_INVALID",
    );

    const redirected = `${canonicalRoot}${path.sep}src${path.sep}..${path.sep}`;
    await writeRegistration(registryRoot, "redirected", redirected);
    await assert.rejects(
      () => resolveRegisteredWorkspace(registryRoot, "redirected"),
      (error) => error.code === "MCP_ROOT_REDIRECTION_REFUSED",
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("registry and workspace symlink redirection is refused where the filesystem exposes it", async (t) => {
  const { base, registryRoot, canonicalRoot } = await fixture();
  const registryLink = path.join(base, "registry-link");
  const workspaceLink = path.join(base, "workspace-link");
  try {
    try {
      await symlink(registryRoot, registryLink, process.platform === "win32" ? "junction" : "dir");
      await symlink(canonicalRoot, workspaceLink, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`symlink fixture unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      () => readRegisteredWorkspaces(registryLink),
      (error) => ["MCP_DIRECTORY_REFUSED", "MCP_DIRECTORY_REDIRECTION_REFUSED"].includes(error.code),
    );
    await writeRegistration(registryRoot, "linked-app", workspaceLink);
    await assert.rejects(
      () => resolveRegisteredWorkspace(registryRoot, "linked-app"),
      (error) => ["MCP_DIRECTORY_REFUSED", "MCP_DIRECTORY_REDIRECTION_REFUSED"].includes(error.code),
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("map and search enforce one aggregate byte budget across registry and workspace reads", async () => {
  const { base, registryRoot, workspaceRoot } = await fixture();
  try {
    await writeFile(path.join(workspaceRoot, "src", "large.txt"), "x".repeat(4_096));
    for (const action of [
      () => mapRegisteredWorkspace(registryRoot, "demo-app", { maxTotalBytes: 4_000 }),
      () => searchRegisteredWorkspace(registryRoot, "demo-app", "needle", { maxTotalBytes: 4_000 }),
    ]) {
      await assert.rejects(action, (error) => error.code === "MCP_OPERATION_BYTE_LIMIT");
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("pre-aborted and timed-out operations stop with explicit bounded errors", async () => {
  const { base, registryRoot } = await fixture();
  try {
    const controller = new AbortController();
    controller.abort(new Error("caller stopped"));
    await assert.rejects(
      () => mapRegisteredWorkspace(registryRoot, "demo-app", { signal: controller.signal }),
      (error) => error.code === "MCP_OPERATION_CANCELLED",
    );

    await assert.rejects(
      () => mapRegisteredWorkspace(registryRoot, "demo-app", {
        timeoutMs: 10,
        onProgress: () => new Promise((resolve) => setTimeout(resolve, 100)),
      }),
      (error) => error.code === "MCP_OPERATION_TIMEOUT",
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a file changed after it is read fails the entire map instead of publishing mixed evidence", async () => {
  const { base, registryRoot, workspaceRoot } = await fixture();
  try {
    let changed = false;
    await assert.rejects(
      () => mapRegisteredWorkspace(registryRoot, "demo-app", {
        onProgress: async ({ phase, path: relativePath }) => {
          if (!changed && phase === "scan" && relativePath === "package.json") {
            changed = true;
            await writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ scripts: { build: "tampered" } }));
          }
        },
      }),
      (error) => error.code === "MCP_WORKSPACE_CHANGED",
    );
    assert.equal(changed, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a directory changed after enumeration fails the entire search", async () => {
  const { base, registryRoot, workspaceRoot } = await fixture();
  try {
    let changed = false;
    await assert.rejects(
      () => searchRegisteredWorkspace(registryRoot, "demo-app", "needle", {
        onProgress: async ({ phase }) => {
          if (!changed && phase === "scan") {
            changed = true;
            await writeFile(path.join(workspaceRoot, "appeared.txt"), "late arrival\n");
          }
        },
      }),
      (error) => error.code === "MCP_WORKSPACE_CHANGED",
    );
    assert.equal(changed, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a registration changed during a scan is not allowed to rebind the result", async () => {
  const { base, registryRoot, canonicalRoot } = await fixture();
  try {
    let changed = false;
    await assert.rejects(
      () => mapRegisteredWorkspace(registryRoot, "demo-app", {
        onProgress: async ({ phase }) => {
          if (!changed && phase === "scan") {
            changed = true;
            await writeRegistration(registryRoot, "demo-app", canonicalRoot, { registryRevision: 2 });
          }
        },
      }),
      (error) => error.code === "MCP_REGISTRY_CHANGED",
    );
    assert.equal(changed, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
