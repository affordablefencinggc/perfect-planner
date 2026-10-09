import "./helpers/hermetic-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { startLocalServer } from "../scripts/serve-local.mjs";

const quiet = { warn() {} };

async function fixture() {
  const folder = await mkdtemp(path.join(tmpdir(), "pp-serve-local-"));
  const client = path.join(folder, "client"), root = path.join(folder, "authority");
  await mkdir(path.join(client, "assets"), { recursive: true });
  await writeFile(path.join(client, "index.html"), "<!doctype html><title>Perfect Planner</title><div id=root></div>");
  await writeFile(path.join(client, "assets", "app-abc.js"), "console.log('app');");
  return { folder, client, root };
}

test("production server serves the client, falls back to the app shell, and hosts the saving APIs", async () => {
  const { folder, client, root } = await fixture();
  const host = await startLocalServer({ clientDirectory: client, root, port: 0, logger: quiet });
  const origin = host.url.slice(0, -1);
  try {
    assert.match(host.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const index = await fetch(host.url);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type"), /text\/html/);
    assert.match(await index.text(), /Perfect Planner/);

    const route = await fetch(`${origin}/projects/pp_example/structure`);
    assert.equal(route.status, 200);
    assert.match(await route.text(), /Perfect Planner/);

    const asset = await fetch(`${origin}/assets/app-abc.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type"), /javascript/);
    assert.match(asset.headers.get("cache-control"), /immutable/);
    assert.equal((await fetch(`${origin}/assets/missing.js`)).status, 404);
    assert.notEqual((await fetch(`${origin}/%2e%2e/%2e%2e/package.json`)).status, 200);

    const session = await fetch(`${origin}/api/architecture-contract/session`, { headers: { origin } });
    assert.equal(session.status, 200);
    const body = await session.json();
    assert.equal(body.schemaVersion, 1);
    assert.equal(typeof body.token, "string");

    for (const api of ["/api/collision-authority/session", "/api/folder-contract/session", "/api/component-plans/session", "/api/planning-ledger/session", "/api/task-run-observations/session"]) {
      const response = await fetch(origin + api, { method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}" });
      assert.notEqual(response.status, 404, `${api} must be hosted`);
      await response.arrayBuffer();
    }
    assert.equal((await fetch(`${origin}/api/not-a-real-api`)).status, 404);
  } finally { await host.close(); await rm(folder, { recursive: true, force: true }); }
});

test("a busy port falls through to the next free port", async () => {
  const { folder, client, root } = await fixture();
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const busy = blocker.address().port;
  let host;
  try {
    host = await startLocalServer({ clientDirectory: client, root, port: busy, logger: quiet });
    assert.notEqual(host.port, busy);
    assert.ok(host.port > busy);
    assert.equal((await fetch(host.url)).status, 200);
  } finally { await host?.close(); await new Promise((resolve) => blocker.close(resolve)); await rm(folder, { recursive: true, force: true }); }
});

test("an unbuilt client answers with a plain build hint instead of crashing", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "pp-serve-empty-"));
  const host = await startLocalServer({ clientDirectory: path.join(folder, "missing"), root: path.join(folder, "authority"), port: 0, logger: quiet });
  try {
    const response = await fetch(host.url);
    assert.equal(response.status, 503);
    assert.match(await response.text(), /npm run start/);
  } finally { await host.close(); await rm(folder, { recursive: true, force: true }); }
});

test("the Vite dev server mounts the same saving APIs from the shared composition", async () => {
  const { createServer } = await import("vite");
  const { localAuthorityVitePlugin } = await import("../src/node/localAuthorityHost.mjs");
  const folder = await mkdtemp(path.join(tmpdir(), "pp-serve-vite-"));
  const server = await createServer({ configFile: false, logLevel: "silent", root: folder, plugins: [localAuthorityVitePlugin({ root: path.join(folder, "authority") })], server: { host: "127.0.0.1", port: 0, watch: null }, optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const session = await fetch(`${origin}/api/architecture-contract/session`, { headers: { origin, connection: "close" } });
    assert.equal(session.status, 200);
    const observations = await fetch(`${origin}/api/task-run-observations/session`, { method: "POST", headers: { origin, connection: "close" } });
    assert.notEqual(observations.status, 404);
    await observations.arrayBuffer();
  } finally { await server.close(); await rm(folder, { recursive: true, force: true }); }
});
