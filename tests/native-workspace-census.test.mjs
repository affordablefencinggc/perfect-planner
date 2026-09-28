import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  censusRegisteredWorkspace,
  registerWorkspaceReadOnly,
  selectWorkspaceFolder,
  validateWorkspaceCensus,
  validateWorkspacePickerReceipt,
  validateWorkspaceRegistration,
} from "../src/native/workspaceCensus.js";

const hash = (letter) => letter.repeat(64);
const registration = () => ({
  schemaVersion: 1,
  registryRevision: 1,
  workspaceId: "planner_app",
  canonicalRoot: "C:\\repos\\planner-app",
  rootIdentity: hash("a"),
  access: "metadata-read-only",
  idempotent: false,
  capabilities: ["workspace-census:read"],
});
const census = () => ({
  schemaVersion: 1,
  registryRevision: 1,
  workspaceId: "planner_app",
  rootIdentity: hash("a"),
  generatedEpochMs: 1,
  fileCount: 1,
  totalBytesHashed: 12,
  summary: { source: 1 },
  files: [{ path: "src/app.js", extension: "js", category: "source", size: 12, sha256: hash("b"), modifiedEpochMs: 1 }],
  skipped: [{ path: "node_modules", reason: "ignored-directory", size: null }],
  digest: hash("c"),
  contentReturned: false,
  capabilities: ["workspace-census:read"],
});

test("static releases cannot register or census local folders", async () => {
  let calls = 0;
  const invoke = async () => { calls += 1; };
  assert.equal((await registerWorkspaceReadOnly({ runtime: {}, invoke })).available, false);
  assert.equal((await censusRegisteredWorkspace({ runtime: {}, invoke })).available, false);
  assert.equal(calls, 0);
});

test("native folder selection is exact, cancellable, and grants no filesystem scope", async () => {
  const runtime = { __TAURI_INTERNALS__: {} };
  let invocation;
  const selected = await selectWorkspaceFolder({ runtime, invoke: async (command, payload) => {
    invocation = { command, payload };
    return { schemaVersion: 1, commandRevision: 1, selectionState: "selected", selectedPath: "C:\\repos\\planner-app", capabilities: ["workspace-folder-picker:select"] };
  } });
  assert.deepEqual(invocation, { command: "select_workspace_folder", payload: { request: { schemaVersion: 1 } } });
  assert.equal(selected.authoritative, true);
  assert.equal(selected.selectedPath, "C:\\repos\\planner-app");
  assert.equal(validateWorkspacePickerReceipt({ schemaVersion: 1, commandRevision: 1, selectionState: "cancelled", selectedPath: null, capabilities: ["workspace-folder-picker:select"] }).selectionState, "cancelled");
});

test("folder picker receipts refuse schema, state, path, and capability expansion", () => {
  const valid = () => ({ schemaVersion: 1, commandRevision: 1, selectionState: "selected", selectedPath: "C:\\repos\\planner-app", capabilities: ["workspace-folder-picker:select"] });
  for (const mutate of [
    (value) => { value.extra = true; },
    (value) => { value.schemaVersion = 2; },
    (value) => { value.selectionState = "approved"; },
    (value) => { value.selectedPath = "relative/path"; },
    (value) => { value.capabilities.push("filesystem:write"); },
  ]) { const value = valid(); mutate(value); assert.throws(() => validateWorkspacePickerReceipt(value)); }
});

test("native registration and census use exact versioned metadata-only commands", async () => {
  const invocations = [];
  const runtime = { __TAURI_INTERNALS__: {} };
  const registered = await registerWorkspaceReadOnly({ workspaceId: "planner_app", rootPath: "C:\\repos\\planner-app", explicitUserApproval: true, runtime, invoke: async (command, payload) => { invocations.push({ command, payload }); return registration(); } });
  const scanned = await censusRegisteredWorkspace({ workspaceId: "planner_app", registryRevision: 1, runtime, invoke: async (command, payload) => { invocations.push({ command, payload }); return census(); } });
  assert.equal(registered.authoritative, true);
  assert.equal(scanned.authoritative, true);
  assert.deepEqual(invocations, [
    { command: "register_workspace_read_only", payload: { request: { schemaVersion: 1, workspaceId: "planner_app", rootPath: "C:\\repos\\planner-app", explicitUserApproval: true } } },
    { command: "census_registered_workspace", payload: { request: { schemaVersion: 1, workspaceId: "planner_app", registryRevision: 1, maxFiles: 50_000, maxFileBytes: 2_000_000 } } },
  ]);
});

test("receipts reject schema drift, authority expansion, and returned contents", () => {
  for (const mutate of [
    (value) => { value.extra = true; },
    (value) => { value.schemaVersion = 2; },
    (value) => { value.capabilities.push("filesystem:write"); },
    (value) => { value.access = "read-write"; },
  ]) { const value = registration(); mutate(value); assert.throws(() => validateWorkspaceRegistration(value)); }
  for (const mutate of [
    (value) => { value.extra = true; },
    (value) => { value.contentReturned = true; value.files[0].content = "secret"; },
    (value) => { value.files[0].path = "../escape"; },
    (value) => { value.fileCount = 2; },
    (value) => { value.capabilities.push("filesystem:write"); },
  ]) { const value = census(); mutate(value); assert.throws(() => validateWorkspaceCensus(value)); }
});

test("native census failures retain their exact native code and message", async () => {
  const result = await censusRegisteredWorkspace({
    workspaceId: "planner_app",
    registryRevision: 1,
    runtime: { __TAURI_INTERNALS__: {} },
    invoke: async () => {
      throw {
        code: "WORKSPACE_CENSUS_CHANGED_DURING_SCAN",
        message: "workspace changed while the census was running at src/app.js",
      };
    },
  });
  assert.equal(result.available, false);
  assert.equal(result.authoritative, false);
  assert.equal(
    result.reason,
    "WORKSPACE_CENSUS_CHANGED_DURING_SCAN: workspace changed while the census was running at src/app.js",
  );
});

test("native census runs off the command thread behind fixed tree and time ceilings", async () => {
  const source = await readFile(new URL("../src-tauri/src/workspace_census.rs", import.meta.url), "utf8");
  assert.match(source, /MAX_DIRECTORIES_LIMIT:\s*usize\s*=\s*50_000/);
  assert.match(source, /MAX_ENTRIES_LIMIT:\s*usize\s*=\s*250_000/);
  assert.match(source, /MAX_DIRECTORY_DEPTH:\s*usize\s*=\s*64/);
  assert.match(source, /MAX_CENSUS_DURATION:\s*Duration\s*=\s*Duration::from_secs\(120\)/);
  assert.match(source, /pub async fn census_registered_workspace/);
  assert.match(source, /tauri::async_runtime::spawn_blocking/);
  for (const code of [
    "WORKSPACE_CENSUS_DIRECTORY_LIMIT",
    "WORKSPACE_CENSUS_ENTRY_LIMIT",
    "WORKSPACE_CENSUS_DEPTH_LIMIT",
    "WORKSPACE_CENSUS_TIME_LIMIT",
    "WORKSPACE_CENSUS_CHANGED_DURING_SCAN",
  ]) assert.match(source, new RegExp(code));
});
