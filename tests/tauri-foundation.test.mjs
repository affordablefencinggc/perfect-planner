import { nativeCapabilities, nativeCommands, nativeInvokeHandlers, declaredNativeCommands, declaredNativeHandlers } from '../src/node/tauriCommandContract.mjs';
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readRuntimeSnapshot, validateRuntimeSnapshot } from "../src/native/runtimeSnapshot.js";

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const validSnapshot = () => ({
  schemaVersion: 1,
  commandRevision: 1,
  productName: "Perfect Planner",
  appVersion: "0.1.0",
  runtimeMode: "native-desktop",
  authority: "tauri-read-only",
  platform: "windows",
  capabilities: ["runtime-snapshot:read"],
  staticReleaseAuthoritative: false,
});

test("the static client is explicitly non-authoritative when Tauri is absent", async () => {
  let called = false;
  const result = await readRuntimeSnapshot({ runtime: {}, invoke: async () => { called = true; } });
  assert.equal(called, false);
  assert.deepEqual(result, { available: false, authoritative: false, reason: "native-runtime-unavailable", schemaVersion: 1 });
});

test("the frontend invokes only the versioned runtime snapshot contract", async () => {
  let invocation;
  const result = await readRuntimeSnapshot({
    runtime: { __TAURI_INTERNALS__: {} },
    invoke: async (command, payload) => { invocation = { command, payload }; return validSnapshot(); },
  });
  assert.deepEqual(invocation, { command: "runtime_snapshot", payload: { request: { schemaVersion: 1 } } });
  assert.equal(result.available, true);
  assert.equal(result.authoritative, true);
});

test("unknown fields, versions, authority, and capability expansion fail closed", () => {
  for (const mutate of [
    (value) => { value.extra = true; },
    (value) => { value.schemaVersion = 2; },
    (value) => { value.authority = "browser"; },
    (value) => { value.capabilities.push("filesystem:write"); },
    (value) => { value.staticReleaseAuthoritative = true; },
  ]) {
    const value = validSnapshot();
    mutate(value);
    assert.throws(() => validateRuntimeSnapshot(value));
  }
});

test("the native capabilities grant only bounded intake and app-local collision commands", async () => {
  const config = await readJson("../src-tauri/tauri.conf.json");
  const capability = await readJson("../src-tauri/capabilities/main-read-only.json");
  const collisionCapability = await readJson("../src-tauri/capabilities/main-collision-authority.json");
  const mcpCapability = await readJson("../src-tauri/capabilities/main-bundled-mcp.json");
  const permission = await readJson("../src-tauri/permissions/runtime-snapshot.json");
  const mcpPermission = await readJson("../src-tauri/permissions/bundled-mcp.json");
  const gitPermission = await readJson("../src-tauri/permissions/git-inventory.json");
  const gitCapability = await readJson("../src-tauri/capabilities/main-git-inventory.json");
  const buildScript = await readFile(new URL("../src-tauri/build.rs", import.meta.url), "utf8");
  const nativeSource = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

  assert.deepEqual(config.app.security.capabilities, nativeCapabilities);
  assert.deepEqual(gitPermission.commands, { allow: ["inspect_registered_git_inventory"], deny: [] });
  assert.deepEqual(gitCapability.permissions, ["allow-inspect-registered-git-inventory"]);
  assert.deepEqual(gitCapability.windows, ["main"]);
  assert.deepEqual(gitCapability.platforms, ["windows"]);
  assert.deepEqual(capability.permissions, [
    "allow-runtime-snapshot",
    "allow-select-workspace-folder",
    "allow-register-workspace-read-only",
    "allow-census-registered-workspace",
    "allow-preview-registered-workspace",
  ]);
  assert.deepEqual(permission.commands.allow, ["runtime_snapshot"]);
  assert.deepEqual(permission.commands.deny, []);
  assert.deepEqual(mcpCapability.permissions, ["allow-check-bundled-mcp-connection"]);
  assert.deepEqual(mcpPermission.commands, { allow: ["check_bundled_mcp_connection"], deny: [] });
  assert.equal(JSON.stringify(capability).includes("core:default"), false);
  assert.deepEqual(collisionCapability.permissions, ["allow-collision-authority-inspect", "allow-collision-authority-approve", "allow-collision-authority-commit"]);
  assert.equal(JSON.stringify(collisionCapability.permissions).includes("core:default"), false);
  assert.deepEqual(declaredNativeCommands(buildScript), nativeCommands);
  assert.deepEqual(declaredNativeHandlers(nativeSource), nativeInvokeHandlers);
  assert.doesNotMatch(nativeSource, /std::fs::|std::process::|Command::new|reqwest::/);
});

test("the desktop shell freezes prototypes and carries a strict local-only CSP", async () => {
  const config = await readJson("../src-tauri/tauri.conf.json");
  const security = config.app.security;
  assert.equal(config.app.windows[0].zoomHotkeysEnabled, true);
  assert.equal(security.freezePrototype, true);
  assert.equal(security.dangerousDisableAssetCspModification, false);
  assert.deepEqual(security.assetProtocol, { enable: false, scope: [] });
  assert.deepEqual(security.csp["script-src"], ["'self'"]);
  assert.deepEqual(security.csp["object-src"], ["'none'"]);
  assert.deepEqual(security.csp["base-uri"], ["'none'"]);
  assert.deepEqual(security.csp["form-action"], ["'none'"]);
  assert.deepEqual(security.csp["connect-src"], ["ipc:", "http://ipc.localhost"]);
  assert.equal(JSON.stringify(security.csp).includes("https:"), false);
  assert.equal(security.headers["X-Content-Type-Options"], "nosniff");
  assert.equal(security.headers["Cross-Origin-Opener-Policy"], "same-origin");
  assert.equal(security.headers["Cross-Origin-Resource-Policy"], "same-origin");
});

test("optimized native builds refuse development-URL mode", async () => {
  const nativeSource = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(nativeSource, /#\[cfg\(all\(not\(debug_assertions\), dev\)\)\]\s*compile_error!\("Release builds require embedded assets\./);
});

test("the static Sites package remains separate from native authority", async () => {
  const hosting = await readJson("../.openai/hosting.json");
  const packageJson = await readJson("../package.json");
  assert.deepEqual(hosting, { d1: null, r2: null, static: { directory: "dist/client" } });
  assert.match(packageJson.scripts.build, /prepare-sites-build/);
  assert.doesNotMatch(packageJson.scripts.build, /tauri/);
  assert.match(packageJson.scripts["build:client"], /vite build/);
  assert.doesNotMatch(packageJson.scripts["build:client"], /prepare-sites-build/);
});
