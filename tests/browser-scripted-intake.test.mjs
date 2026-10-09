import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildFolderManifest } from "../scripts/folder-manifest.mjs";
import { SCRIPTED_INTAKE_GLOBAL, installScriptedIntake } from "../src/browser/scriptedIntake.js";
import { resolveWorkspaceAdapter } from "../src/runtime/workspaceAdapter.js";
import { buildWorkspaceDiscovery } from "../src/engine/workspaceDiscoveryEngine.js";
import { createImportedProjectSession } from "../src/project/projectSession.js";
import { createMemoryStorage, createProjectRegistry } from "../src/project/projectRegistry.js";
import { createImportedProjectId } from "../src/project/projectIds.js";
import { scriptedIntakeEnabled } from "../vite.config.mjs";

async function fixtureFolder() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pp-scripted-intake-"));
  const dir = path.join(root, "notes-app");
  const files = {
    "package.json": JSON.stringify({ name: "notes-app", scripts: { dev: "vite", test: "vitest" }, dependencies: { react: "19.0.0" } }),
    ".gitignore": "generated/\n*.log\n",
    "README.md": "# Notes\n",
    "src/main.jsx": "import React from 'react';\nexport default function App() { return null; }\n",
    "src/notes/store.js": "export const notes = [];\n",
    "tests/store.test.js": "import { notes } from '../src/notes/store.js';\n",
    "generated/bundle.js": "// ignored by .gitignore\n",
    "debug.log": "ignored by *.log\n",
    "node_modules/react/index.js": "module.exports = {};\n",
    "big/huge.bin": "x".repeat(4096),
  };
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
    await writeFile(path.join(dir, relative), content);
  }
  return { root, dir };
}

test("scripted intake is off unless explicitly enabled, and only the dev server or a PP_TEST_INTAKE=1 build enables it", () => {
  const runtime = {};
  assert.equal(installScriptedIntake(runtime), null);
  assert.equal(installScriptedIntake(runtime, { enabled: "true" }), null);
  assert.equal(runtime[SCRIPTED_INTAKE_GLOBAL], undefined);
  assert.equal(runtime.showDirectoryPicker, undefined);
  assert.equal(scriptedIntakeEnabled("build", {}), false);
  assert.equal(scriptedIntakeEnabled("build", { PP_TEST_INTAKE: "true" }), false);
  assert.equal(scriptedIntakeEnabled("build", { PP_TEST_INTAKE: "1" }), true);
  assert.equal(scriptedIntakeEnabled("serve", {}), true);
});

test("the release entry only installs scripted intake behind the build-time flag", async () => {
  const main = await readFile(new URL("../src/main.jsx", import.meta.url), "utf8");
  const boot = await readFile(new URL("../src/browser/scriptedIntakeBoot.js", import.meta.url), "utf8");
  assert.match(main.split("\n")[0], /^import "\.\/browser\/scriptedIntakeBoot\.js";$/, "the boot module must run before the workspace adapter is chosen");
  assert.match(boot, /if \(typeof __PP_SCRIPTED_INTAKE__ !== "undefined" && __PP_SCRIPTED_INTAKE__ === true\)/);
  assert.doesNotMatch(main, /installScriptedIntake|__ppTestIntake/);
});

test("a real folder goes through the same browser scan and discovery as the picker and becomes a registered project", async (t) => {
  const { root, dir } = await fixtureFolder();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = await buildFolderManifest(dir, { maxFileBytes: 1024 });
  const nodeModules = manifest.children.find((entry) => entry.name === "node_modules");
  assert.deepEqual(nodeModules.children, [], "excluded folders are sent empty, not copied");

  // Same order as the page: the boot module installs the picker before the adapter is resolved.
  const runtime = { crypto: globalThis.crypto };
  const control = installScriptedIntake(runtime, { enabled: true });
  assert.equal(typeof runtime.showDirectoryPicker, "function");
  const adapter = resolveWorkspaceAdapter(runtime);
  assert.equal(adapter.mode, "browser");
  // The manifest crosses a JSON boundary (page.evaluate) exactly as in automation.
  assert.deepEqual(control.queueFolder(JSON.parse(JSON.stringify(manifest))), { name: "notes-app", queued: 1 });

  const selection = await adapter.selectWorkspaceFolder({ runtime });
  assert.equal(selection.selectionState, "selected");
  assert.match(selection.selectedPath, /^browser:\/\/notes-app\/[a-f0-9]{24}$/);
  assert.equal(control.pending(), 0);

  const workspaceId = "ws_notes_app";
  const registration = await adapter.registerWorkspaceReadOnly({ workspaceId, rootPath: selection.selectedPath, explicitUserApproval: true });
  assert.equal(registration.authoritative, true);
  const phases = [];
  const census = await adapter.censusRegisteredWorkspace({ workspaceId, registryRevision: registration.registryRevision, maxFileBytes: 1024, batchSize: 1, progressThrottleMs: 0, onProgress: (progress) => phases.push(progress.phase) });
  assert.equal(census.authoritative, true, census.reason);
  assert.deepEqual(census.files.map((file) => file.path), [".gitignore", "README.md", "package.json", "src/main.jsx", "src/notes/store.js", "tests/store.test.js"]);
  assert.deepEqual(census.skipped, [
    { path: "big/huge.bin", reason: "file-too-large", size: 4096 },
    { path: "debug.log", reason: "ignored-by-gitignore", size: null },
    { path: "generated", reason: "ignored-by-gitignore", size: null },
    { path: "node_modules", reason: "generated-or-dependency-directory-excluded", size: null },
  ]);
  assert.equal(phases[0], "started");
  assert.ok(phases.includes("scanning"));
  assert.ok(phases.includes("verifying"));
  assert.equal(phases.at(-1), "complete");

  const discovery = buildWorkspaceDiscovery(census, { appName: "notes-app" });
  assert.notEqual(discovery.state, "invalid");
  assert.ok(discovery.counts.observed > 0);

  const registry = createProjectRegistry({ storage: createMemoryStorage() });
  const session = createImportedProjectSession({ name: "notes-app", adapter: "browser", persistence: "reselect-required", registration, census, discovery });
  registry.upsert(session, { activate: true });
  const project = registry.get(createImportedProjectId(registration.rootIdentity));
  assert.ok(project, "the scanned folder is a registered project");
  assert.equal(project.kind, "imported");
  assert.equal(project.census.fileCount, 6);
  assert.equal(project.census.skippedCount, 4);
  assert.equal(project.census.digest, census.digest);
  assert.equal(project.discovery.counts.observed, discovery.counts.observed);
});

test("with nothing queued the scripted picker falls back to the real picker, or reports a cancelled pick", async () => {
  const realHandle = { kind: "directory", name: "real", async *entries() {} };
  const withReal = { crypto: globalThis.crypto, async showDirectoryPicker() { return realHandle; } };
  installScriptedIntake(withReal, { enabled: true });
  assert.equal(await withReal.showDirectoryPicker(), realHandle);

  const without = { crypto: globalThis.crypto };
  installScriptedIntake(without, { enabled: true });
  const adapter = resolveWorkspaceAdapter(without);
  const selection = await adapter.selectWorkspaceFolder({ runtime: without });
  assert.equal(selection.selectionState, "cancelled");
});

test("malformed manifests are refused instead of producing a fake folder", () => {
  const control = installScriptedIntake({}, { enabled: true });
  assert.throws(() => control.queueFolder(null), /directory/);
  assert.throws(() => control.queueFolder({ kind: "directory", name: "x", children: [{ kind: "file", name: "../escape" }] }), /Invalid file name/);
  assert.throws(() => control.queueFolder({ kind: "directory", name: "x", children: [{ kind: "file", name: "a" }, { kind: "file", name: "a" }] }), /Duplicate/);
  assert.equal(control.pending(), 0);
});
