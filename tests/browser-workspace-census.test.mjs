import "./helpers/hermetic-env.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { browserWorkspaceAdapter, isBrowserWorkspacePickerAvailable } from "../src/browser/workspaceCensus.js";

function fileHandle(name, content, lastModified = 1) {
  return {
    kind: "file",
    name,
    async getFile() {
      const bytes = new TextEncoder().encode(content);
      return { size: bytes.byteLength, lastModified, async arrayBuffer() { return bytes.buffer; } };
    },
  };
}

function directoryHandle(name, entries) {
  return {
    kind: "directory",
    name,
    async requestPermission() { return "granted"; },
    async *entries() { for (const entry of entries) yield entry; },
  };
}

test("browser folder picker performs a real bounded metadata census after separate approval", async () => {
  const root = directoryHandle("sample-app", [
    ["package.json", fileHandle("package.json", "{\"scripts\":{}}")],
    ["src", directoryHandle("src", [["main.jsx", fileHandle("main.jsx", "export default null")]])],
    ["node_modules", directoryHandle("node_modules", [["ignored.js", fileHandle("ignored.js", "large generated dependency")]])],
  ]);
  const runtime = { crypto: globalThis.crypto, async showDirectoryPicker() { return root; } };
  assert.equal(isBrowserWorkspacePickerAvailable(runtime), true);
  const selection = await browserWorkspaceAdapter.selectWorkspaceFolder({ runtime });
  assert.match(selection.selectedPath, /^browser:\/\/sample-app\/[a-f0-9]{24}$/);

  const registration = await browserWorkspaceAdapter.registerWorkspaceReadOnly({ workspaceId: "sample-app", rootPath: selection.selectedPath, explicitUserApproval: true });
  assert.equal(registration.authoritative, true);
  assert.equal(registration.access, "metadata-read-only");

  const census = await browserWorkspaceAdapter.censusRegisteredWorkspace({ workspaceId: "sample-app", registryRevision: registration.registryRevision });
  assert.equal(census.authoritative, true);
  assert.equal(census.contentReturned, false);
  assert.equal(census.fileCount, 2);
  assert.deepEqual(census.files.map((file) => file.path), ["package.json", "src/main.jsx"]);
  assert.equal("content" in census.files[0], false);
  assert.deepEqual(census.skipped, [{ path: "node_modules", reason: "generated-or-dependency-directory-excluded", size: null }]);
});

test("browser folder adapter refuses pasted or unapproved folder identities", async () => {
  const result = await browserWorkspaceAdapter.registerWorkspaceReadOnly({ workspaceId: "sample-app", rootPath: "C:\\repos\\sample-app", explicitUserApproval: true });
  assert.equal(result.authoritative, false);
  assert.match(result.reason, /secure browser picker/i);
});

test("a root .git folder is listed as skipped, never opened, and still lets discovery report Git", async () => {
  const { buildWorkspaceDiscovery } = await import("../src/engine/workspaceDiscoveryEngine.js");
  const opened = [];
  const watched = (name, content) => {
    const handle = fileHandle(name, content);
    return { ...handle, async getFile() { opened.push(name); return handle.getFile(); } };
  };
  const gitFolder = directoryHandle(".git", [["config", watched("config", "[remote \"origin\"]\n url = https://user:token@github.com/o/r.git")], ["objects", directoryHandle("objects", [["ab", watched("ab", "blob")]])]]);
  gitFolder.entries = async function* () { opened.push(".git listing"); };
  const root = directoryHandle("git-app", [
    [".git", gitFolder],
    ["package.json", fileHandle("package.json", "{}")],
  ]);
  const runtime = { crypto: globalThis.crypto, async showDirectoryPicker() { return root; } };
  const selection = await browserWorkspaceAdapter.selectWorkspaceFolder({ runtime });
  const registration = await browserWorkspaceAdapter.registerWorkspaceReadOnly({ workspaceId: "git-app", rootPath: selection.selectedPath, explicitUserApproval: true });
  const census = await browserWorkspaceAdapter.censusRegisteredWorkspace({ workspaceId: "git-app", registryRevision: registration.registryRevision });
  assert.equal(census.authoritative, true);
  assert.deepEqual(census.files.map((file) => file.path), ["package.json"]);
  assert.deepEqual(census.skipped, [{ path: ".git", reason: "generated-or-dependency-directory-excluded", size: null }]);
  assert.deepEqual(opened, [], "nothing inside .git is listed or read");
  const git = buildWorkspaceDiscovery(census).categories.find((category) => category.id === "A01").findings.find((item) => item.id === "S003");
  assert.ok(git);
  assert.doesNotMatch(JSON.stringify(git), /token|github\.com/);
});
