import "./helpers/hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { extractTarMember, hostTriple, RUNTIME, runtimeFor, sha256, verified } from "../scripts/build-desktop-host.mjs";
import { DESKTOP_PORT, desktopHostConfig, readyLine, startDesktopHost } from "../src/node/desktopHost.mjs";

// The four installers the release workflow builds (release.yml matrix) must each get a pinned Node.
const RELEASE_TARGETS = ["x86_64-pc-windows-msvc", "aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-unknown-linux-gnu"];

test("every release target has a pinned, checksummed Node runtime of one version", () => {
  for (const triple of RELEASE_TARGETS) {
    const runtime = runtimeFor(triple);
    assert.match(runtime.sha256, /^[a-f0-9]{64}$/);
    assert.ok(runtime.url.startsWith(`https://nodejs.org/dist/${RUNTIME.version}/`), runtime.url);
    assert.equal(runtime.binary, triple.includes("windows") ? "node.exe" : "node");
  }
  assert.equal(runtimeFor("aarch64-apple-darwin").member, `node-${RUNTIME.version}-darwin-arm64/bin/node`);
  assert.equal(runtimeFor("x86_64-pc-windows-msvc").member, null);
  assert.throws(() => runtimeFor("universal-apple-darwin"), /No bundled Node runtime is pinned/);
});

test("the build machine's own triple is used when Tauri does not name one", () => {
  assert.equal(hostTriple("win32", "x64"), "x86_64-pc-windows-msvc");
  assert.equal(hostTriple("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(hostTriple("linux", "x64"), "x86_64-unknown-linux-gnu");
  assert.throws(() => hostTriple("freebsd", "x64"));
});

test("a download that is not the pinned bytes is refused", () => {
  const bytes = Buffer.from("node");
  assert.equal(verified(bytes, sha256(bytes), "node"), bytes);
  assert.throws(() => verified(Buffer.from("not node"), sha256(bytes), "node"), /does not match its pinned checksum/);
});

test("the node binary is read out of the official tar layout", () => {
  const entry = (name, body, type = "0") => {
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write(body.length.toString(8).padStart(11, "0"), 124, "utf8");
    header.write(type, 156, "utf8");
    const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
    body.copy(padded);
    return Buffer.concat([header, padded]);
  };
  const tar = Buffer.concat([
    entry("node-v1-linux-x64/", Buffer.alloc(0), "5"),
    entry("node-v1-linux-x64/README.md", Buffer.from("readme ".repeat(100))),
    entry("node-v1-linux-x64/bin/node", Buffer.from("ELF binary")),
    Buffer.alloc(1024),
  ]);
  assert.equal(extractTarMember(tar, "node-v1-linux-x64/bin/node").toString(), "ELF binary");
  assert.throws(() => extractTarMember(tar, "node-v1-linux-x64/bin/npm"), /is not in the Node archive/);
});

test("the desktop service finds its bundled files and keeps data out of temp folders", () => {
  const here = path.join("/app", "desktop-host", "core-host");
  const config = desktopHostConfig({ PP_DATA_DIR: "/data" }, here);
  assert.equal(config.clientDirectory, path.join("/app", "desktop-host", "client"));
  assert.equal(config.coreHostBundle, path.join(here, "index.mjs"));
  assert.equal(config.root, path.join(path.resolve("/data"), "PerfectPlannerCleanroom", "authority"));
  assert.equal(config.port, DESKTOP_PORT);
  assert.equal(desktopHostConfig({ PP_PORT: "0" }, here).port, 0);
});

test("the ready line carries the origin and the one-time window link, nothing else", () => {
  const started = { url: "http://127.0.0.1:41730/", launchUrl: () => "http://127.0.0.1:41730/#pp-launch=secret-secret-secret-1" };
  assert.deepEqual(JSON.parse(readyLine(started)), { event: "ready", origin: "http://127.0.0.1:41730", open: "http://127.0.0.1:41730/#pp-launch=secret-secret-secret-1" });
  assert.deepEqual(JSON.parse(readyLine({ url: "http://127.0.0.1:41731/" })), { event: "ready", origin: "http://127.0.0.1:41731", open: "http://127.0.0.1:41731/" });
});

test("the desktop service serves the app on loopback, reports ready once, and stops when the shell lets go", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pp-desktop-host-"));
  try {
    const here = path.join(dir, "core-host");
    mkdirSync(here, { recursive: true });
    mkdirSync(path.join(dir, "client"), { recursive: true });
    writeFileSync(path.join(dir, "client", "index.html"), "<!doctype html><title>Perfect Planner</title>");
    const input = new PassThrough();
    const output = new PassThrough();
    const quiet = { log() {}, info() {}, warn() {}, error() {} };
    let stopped;
    const stoppedOnce = new Promise((resolve) => { stopped = resolve; });
    const env = { PP_PORT: "0", PP_DATA_DIR: path.join(dir, "data") };
    const host = await startDesktopHost({ env, here, input, output, logger: quiet, onStop: stopped });
    const ready = JSON.parse(output.read().toString("utf8"));
    assert.equal(ready.event, "ready");
    assert.match(ready.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(env.PP_NODE_BINARY, process.execPath, "connect lines run the same Node as the service");
    const page = await fetch(`${ready.origin}/tasks`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Perfect Planner/);
    input.end();
    await stoppedOnce;
    await assert.rejects(fetch(`${ready.origin}/`));
    assert.equal(typeof host.stop, "function");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the Tauri bundle ships the desktop host as resources and builds it before bundling", () => {
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  assert.deepEqual(config.bundle.resources, { "../dist/desktop-host": "desktop-host" });
  assert.match(readFileSync(new URL("../src-tauri/build.rs", import.meta.url), "utf8"), /create_dir_all\("\.\.\/dist\/desktop-host"\)/);
  assert.match(config.build.beforeBuildCommand, /build:client/);
  assert.match(config.build.beforeBuildCommand, /build-desktop-host/);
  // The window opens on the local service, so the 170 MB client is not embedded a second time.
  assert.equal(config.build.frontendDist, "splash");
  assert.equal(config.app.windows[0].create, false);
});

test("pages the local service serves run in browser mode; the app's own pages stay native", async () => {
  const { isTauriRuntime } = await import("../src/native/runtimeSnapshot.js");
  const { isNativeWorkspaceRuntime } = await import("../src/native/workspaceCensus.js");
  const { resolveWorkspaceAdapter } = await import("../src/runtime/workspaceAdapter.js");
  const tauri = (href) => ({ __TAURI_INTERNALS__: {}, location: new URL(href), crypto: globalThis.crypto, showDirectoryPicker() {} });
  for (const own of ["tauri://localhost/index.html", "http://tauri.localhost/index.html"]) {
    assert.equal(isTauriRuntime(tauri(own)), true, own);
    assert.equal(resolveWorkspaceAdapter(tauri(own)).mode, "native", own);
  }
  const service = tauri("http://127.0.0.1:41730/tasks");
  assert.equal(isTauriRuntime(service), false);
  assert.equal(isNativeWorkspaceRuntime(service), false);
  // Native commands would be refused on this origin, so intake uses the browser folder picker.
  assert.notEqual(resolveWorkspaceAdapter(service).mode, "native");
  assert.equal(isTauriRuntime({ __TAURI_INTERNALS__: {} }), true, "no location: the existing native contract tests");
});
