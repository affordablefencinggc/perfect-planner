import "./helpers/hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { browserWorkspaceAdapter } from "../src/browser/workspaceCensus.js";

function directoryHandle(name, marker) {
  return {
    kind: "directory",
    name,
    marker,
    async requestPermission() { return "granted"; },
    async queryPermission() { return "granted"; },
    async isSameEntry(other) { return other?.marker === marker; },
    async *entries() {},
  };
}

test("two distinct browser folders with the same display name keep separate identities", async () => {
  const first = directoryHandle("app", "first-root");
  const second = directoryHandle("app", "second-root");
  const queue = [first, second, first];
  const runtime = {
    crypto: globalThis.crypto,
    async showDirectoryPicker() { return queue.shift(); },
  };

  const firstSelection = await browserWorkspaceAdapter.selectWorkspaceFolder({ runtime });
  const secondSelection = await browserWorkspaceAdapter.selectWorkspaceFolder({ runtime });
  const repeatedFirstSelection = await browserWorkspaceAdapter.selectWorkspaceFolder({ runtime });
  assert.notEqual(firstSelection.selectedPath, secondSelection.selectedPath);
  assert.equal(repeatedFirstSelection.selectedPath, firstSelection.selectedPath);

  const firstRegistration = await browserWorkspaceAdapter.registerWorkspaceReadOnly({
    workspaceId: "same_name_first",
    rootPath: firstSelection.selectedPath,
    explicitUserApproval: true,
  });
  const secondRegistration = await browserWorkspaceAdapter.registerWorkspaceReadOnly({
    workspaceId: "same_name_second",
    rootPath: secondSelection.selectedPath,
    explicitUserApproval: true,
  });
  assert.notEqual(firstRegistration.rootIdentity, secondRegistration.rootIdentity);
});
