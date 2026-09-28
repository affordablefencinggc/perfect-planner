import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildWorkspaceDiscovery, buildWorkspaceStructureTree, workspaceDiscoveryLimits } from "../src/engine/workspaceDiscoveryEngine.js";
import { validateWorkspaceCensus } from "../src/native/workspaceCensus.js";

test("native 10,052-file receipt reaches discovery and structure without truncation", {skip: !process.env.PP_CENSUS_PROOF_OUTPUT}, async () => {
  const receipt = JSON.parse(await readFile(process.env.PP_CENSUS_PROOF_OUTPUT, "utf8"));
  assert.equal(receipt.fileCount, 10_052);
  validateWorkspaceCensus(receipt);
  const discovery = buildWorkspaceDiscovery(receipt);
  const tree = buildWorkspaceStructureTree(receipt);
  assert.equal(discovery.observedFiles, receipt.fileCount);
  assert.equal(tree.state, "ready");
  assert.equal(tree.fileCount, receipt.fileCount);
});

test("map accepts exactly its supported file ceiling and rejects larger input", () => {
  const files = Array.from({length: workspaceDiscoveryLimits.maxFiles}, (_, i) => ({path: `src/file-${i}.js`}));
  assert.equal(buildWorkspaceStructureTree({files}).fileCount, 50_000);
  const refused = buildWorkspaceStructureTree({files: [...files, {path: "src/overflow.js"}]});
  assert.notEqual(refused.state, "ready");
  assert.equal(refused.fileCount, 0);
});
