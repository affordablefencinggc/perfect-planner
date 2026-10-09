import "./helpers/hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryFolderHandleStore, createIndexedDbFolderHandleStore, setFolderHandleStore } from "../src/browser/folderAccess.js";
import { createImportedProjectId } from "../src/project/projectIds.js";
import { createImportedProjectSession, withProjectView } from "../src/project/projectSession.js";
import { recaptureImportedProject } from "../src/project/projectRecapture.js";
import { describeFolderConnection } from "../src/project/folderReconnectModel.js";

let reloadCount = 0;
// A fresh module instance stands in for a page reload: in-memory handles are gone.
async function freshPage(store) {
  setFolderHandleStore(store);
  reloadCount += 1;
  return (await import(`../src/browser/workspaceCensus.js?page=${reloadCount}`)).browserWorkspaceAdapter;
}

// Fake directory handle; `root` stands for the real folder on disk. Different
// handle objects for the same root answer isSameEntry() true, as browsers do.
function folder(name, root, { permission = "granted" } = {}) {
  const calls = [];
  return {
    kind: "directory",
    name,
    root,
    calls,
    async requestPermission(options) { calls.push(options); return typeof permission === "function" ? permission() : permission; },
    async queryPermission() { return "granted"; },
    async isSameEntry(other) { return other?.root === root; },
    async *entries() {
      yield ["README.md", { kind: "file", async getFile() { return new Blob(["hello"]); } }];
    },
  };
}

const runtimeFor = (...picks) => ({ crypto: globalThis.crypto, async showDirectoryPicker() { return picks.shift(); } });

async function chooseAndScan(adapter, handle) {
  const selection = await adapter.selectWorkspaceFolder({ runtime: runtimeFor(handle) });
  const registration = await adapter.registerWorkspaceReadOnly({ workspaceId: "ws_app", rootPath: selection.selectedPath, explicitUserApproval: true });
  const census = await adapter.censusRegisteredWorkspace({ workspaceId: "ws_app", registryRevision: registration.registryRevision, yieldControl: async () => {} });
  return { selection, registration, census };
}

test("choosing the same folder after a reload reuses the project instead of creating a new one", async () => {
  const store = createMemoryFolderHandleStore();
  const first = await chooseAndScan(await freshPage(store), folder("app", "disk:/app"));
  assert.equal(first.census.authoritative, true);
  const projectId = createImportedProjectId(first.registration.rootIdentity);
  assert.ok(await store.get(projectId), "the folder handle is remembered under the project id");

  const again = await chooseAndScan(await freshPage(store), folder("app", "disk:/app"));
  assert.equal(again.selection.selectedPath, first.selection.selectedPath);
  assert.equal(again.registration.rootIdentity, first.registration.rootIdentity);
  assert.equal(createImportedProjectId(again.registration.rootIdentity), projectId);
  assert.equal((await store.list()).length, 1);

  const other = await chooseAndScan(await freshPage(store), folder("app", "disk:/elsewhere/app"));
  assert.notEqual(other.registration.rootIdentity, first.registration.rootIdentity, "a different folder with the same name stays separate");
  assert.equal((await store.list()).length, 2);
});

test("after a reload the remembered folder reconnects only through a read permission request", async () => {
  const store = createMemoryFolderHandleStore();
  const { registration, selection } = await chooseAndScan(await freshPage(store), folder("app", "disk:/app"));
  const projectId = createImportedProjectId(registration.rootIdentity);

  const reloaded = folder("app", "disk:/app");
  await store.put({ ...(await store.get(projectId)), handle: reloaded });
  const page = await freshPage(store);
  assert.deepEqual({ ...(await page.rememberedFolder(projectId)) }, { remembered: true, open: false, name: "app", savedAt: (await store.get(projectId)).savedAt });
  const stale = await page.censusRegisteredWorkspace({ workspaceId: "ws_app", registryRevision: 1 });
  assert.equal(stale.authoritative, false, "nothing can be read before reconnecting");
  assert.equal(reloaded.calls.length, 0, "loading the page never asks for access");

  const receipt = await page.reconnectRememberedFolder(projectId);
  assert.equal(receipt.selectionState, "selected");
  assert.equal(receipt.selectedPath, selection.selectedPath);
  assert.deepEqual(reloaded.calls[0], { mode: "read" });
  const again = await page.registerWorkspaceReadOnly({ workspaceId: "ws_app", rootPath: receipt.selectedPath, explicitUserApproval: true });
  assert.equal(again.rootIdentity, registration.rootIdentity);
  const census = await page.censusRegisteredWorkspace({ workspaceId: "ws_app", registryRevision: again.registryRevision, yieldControl: async () => {} });
  assert.equal(census.authoritative, true);
  assert.equal((await page.rememberedFolder(projectId)).open, true);
});

test("refused, missing and unknown folders fail plainly without reading anything", async () => {
  const store = createMemoryFolderHandleStore();
  const denied = folder("app", "disk:/app", { permission: "denied" });
  const { registration } = await chooseAndScan(await freshPage(store), folder("app", "disk:/app"));
  const projectId = createImportedProjectId(registration.rootIdentity);
  await store.put({ ...(await store.get(projectId)), handle: denied });
  let page = await freshPage(store);
  const refused = await page.reconnectRememberedFolder(projectId);
  assert.equal(refused.authoritative, false);
  assert.match(refused.reason, /not allowed/);

  const gone = folder("app", "disk:/app", { permission: () => { throw Object.assign(new Error("gone"), { name: "NotFoundError" }); } });
  await store.put({ ...(await store.get(projectId)), handle: gone });
  page = await freshPage(store);
  assert.match((await page.reconnectRememberedFolder(projectId)).reason, /could not be found/);

  assert.match((await page.reconnectRememberedFolder("pp_unknown_project")).reason, /not remembered/);
  assert.equal((await page.rememberedFolder("pp_unknown_project")).remembered, false);
});

test("without IndexedDB the browser adapter keeps working and simply remembers nothing", async () => {
  assert.equal(createIndexedDbFolderHandleStore({ indexedDB: undefined }), null);
  const page = await freshPage(null);
  const { census, registration } = await chooseAndScan(page, folder("app", "disk:/app"));
  assert.equal(census.authoritative, true);
  const projectId = createImportedProjectId(registration.rootIdentity);
  assert.equal((await page.rememberedFolder(projectId)).open, true, "still open in this tab");
  const reloaded = await freshPage(null);
  assert.equal((await reloaded.rememberedFolder(projectId)).remembered, false, "nothing survives the reload");
});

const root = "a".repeat(64);
function capture(fileCount, digest, generatedAt) {
  return {
    name: "Looplet",
    adapter: "browser",
    registration: { workspaceId: "ws_looplet", registryRevision: 1, rootIdentity: root, access: "metadata-read-only", canonicalRoot: "browser://Looplet/abc" },
    census: { workspaceId: "ws_looplet", registryRevision: 1, rootIdentity: root, digest, fileCount, generatedAt, skipped: [] },
    now: Date.parse(generatedAt),
  };
}

test("a new scan of a saved project becomes its next generation, keeping its place and history", () => {
  const original = withProjectView(createImportedProjectSession(capture(3, "1".repeat(64), "2026-10-01T09:00:00.000Z")), { workspace: "ledger" }, { now: Date.parse("2026-10-01T09:05:00.000Z") });
  const next = recaptureImportedProject(original, capture(5, "2".repeat(64), "2026-10-02T10:00:00.000Z"));
  assert.equal(next.projectId, original.projectId);
  assert.equal(next.generation, original.generation + 1);
  assert.equal(next.createdAt, original.createdAt);
  assert.equal(next.view.workspace, "ledger");
  assert.equal(next.census.fileCount, 5);
  assert.equal(next.census.digest, "2".repeat(64));
  assert.deepEqual(next.authorities, original.authorities);
  assert.equal(next.provenance["project.generation"].sourceRevision, next.generation);

  const firstTime = recaptureImportedProject(null, capture(5, "2".repeat(64), "2026-10-02T10:00:00.000Z"));
  assert.equal(firstTime.generation, 1);
});

test("the saved scan is labelled as the last scan, never as current", () => {
  const project = createImportedProjectSession(capture(12, "1".repeat(64), "2026-10-01T09:30:00.000Z"));
  const reconnect = describeFolderConnection({ project, access: { remembered: true, open: false, name: "Looplet" } });
  assert.equal(reconnect.state, "reconnect");
  assert.equal(reconnect.current, false);
  assert.equal(reconnect.action, "Reconnect folder");
  assert.equal(reconnect.lastScan.text, "Last scan · 2026-10-01 09:30 UTC · 12 files");
  assert.equal(describeFolderConnection({ project, access: { remembered: true, open: true } }).action, "Scan folder again");
  const forgotten = describeFolderConnection({ project, access: { remembered: false } });
  assert.equal(forgotten.state, "choose-again");
  assert.equal(forgotten.action, null);
  assert.equal(describeFolderConnection({ project, access: { remembered: true }, scannedThisVisit: true }), null);
  const native = createImportedProjectSession({ ...capture(1, "1".repeat(64), "2026-10-01T09:30:00.000Z"), adapter: "native" });
  assert.equal(describeFolderConnection({ project: native }), null);
  assert.doesNotMatch(JSON.stringify(reconnect), /receipt|authority|census|digest/i);
});
