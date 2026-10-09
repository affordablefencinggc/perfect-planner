import "./helpers/hermetic-env.mjs";
import assert from "node:assert/strict";
import { access, lstat, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import worker from "../worker/index.js";
import { requiresBuild } from "./helpers/build-output.mjs";

test("serves existing static assets without a fallback", async () => {
  const calls = [];
  const response = await worker.fetch(new Request("https://example.test/assets/app.js"), {
    ASSETS: {
      fetch: async (request) => {
        calls.push(new URL(request.url).pathname);
        return new Response("asset", { status: 200 });
      },
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["/assets/app.js"]);
});

test("falls back to index.html for an unknown app route", async () => {
  const calls = [];
  const response = await worker.fetch(
    new Request("https://example.test/flow/step-two?source=share", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async (request) => {
          const url = new URL(request.url);
          calls.push(url.pathname + url.search);
          return new Response(url.pathname === "/index.html" ? "app" : "missing", {
            status: url.pathname === "/index.html" ? 200 : 404,
          });
        },
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["/flow/step-two?source=share", "/index.html"]);
});

test("does not turn missing API or write requests into the app shell", async () => {
  for (const request of [
    new Request("https://example.test/api/missing", { headers: { accept: "application/json" } }),
    new Request("https://example.test/flow", { method: "POST", headers: { accept: "text/html" } }),
  ]) {
    let calls = 0;
    const response = await worker.fetch(request, {
      ASSETS: {
        fetch: async () => {
          calls += 1;
          return new Response("missing", { status: 404 });
        },
      },
    });

    assert.equal(response.status, 404);
    assert.equal(calls, 1);
  }
});

test("adds browser security headers and separates mutable pointer caching from immutable evidence", async () => {
  const fetchAsset = async (request) => new Response(new URL(request.url).pathname, { status: 200 });
  const cases = [
    ["/generated/current-generation.json", "no-store, max-age=0"],
    [`/generated/generations/${"a".repeat(64)}/truth-core-report.json`, "public, max-age=31536000, immutable"],
    ["/assets/index-abcdefgh.js", "public, max-age=31536000, immutable"],
    ["/assets/plain.svg", "no-cache"],
  ];
  for (const [pathname, expectedCache] of cases) {
    const response = await worker.fetch(new Request(`https://example.test${pathname}`), { ASSETS: { fetch: fetchAsset } });
    assert.equal(response.headers.get("cache-control"), expectedCache);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  }
});

test("HTML route fallbacks are never cached", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/plan", { headers: { accept: "text/html" } }),
    {
      ASSETS: {
        fetch: async (request) => new Response(new URL(request.url).pathname === "/index.html" ? "app" : "missing", {
          status: new URL(request.url).pathname === "/index.html" ? 200 : 404,
        }),
      },
    },
  );
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
});

test("emits the files required by Sites packaging", { skip: requiresBuild }, async () => {
  await access(new URL("../dist/client/index.html", import.meta.url));
  await access(new URL("../dist/server/index.js", import.meta.url));
  await access(new URL("../dist/.openai/hosting.json", import.meta.url));
  const manifest = JSON.parse(await readFile(new URL("../dist/release-manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.releaseMode, "STATIC_CLIENT_NO_LOCAL_AUTHORITY");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
  const expected = [];
  const stack = [{ absolute: path.join(root, "client"), relative: "client" }];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of await readdir(current.absolute, { withFileTypes: true })) {
      const absolute = path.join(current.absolute, entry.name);
      const relative = `${current.relative}/${entry.name}`.replaceAll("\\", "/");
      const inspected = await lstat(absolute);
      assert.equal(inspected.isSymbolicLink(), false);
      if (inspected.isDirectory()) stack.push({ absolute, relative });
      else if (inspected.isFile()) expected.push(relative);
      else assert.fail(`Special file shipped: ${relative}`);
    }
  }
  expected.push("server/index.js", ".openai/hosting.json");
  expected.sort();
  assert.deepEqual(manifest.artifacts.map((item) => item.path), expected);
  assert.ok(expected.some((item) => /^client\/assets\/.*\.css$/.test(item)));
  assert.ok(expected.includes("client/generated/current-generation.json"));
  const generations = await readdir(path.join(root, "client", "generated", "generations"));
  assert.equal(generations.length, 1);
  let totalBytes = 0;
  for (const artifact of manifest.artifacts) {
    const bytes = await readFile(path.join(root, artifact.path));
    assert.equal(artifact.bytes, bytes.length);
    assert.equal(artifact.sha256, createHash("sha256").update(bytes).digest("hex"));
    totalBytes += bytes.length;
  }
  assert.deepEqual(manifest.totals, { files: manifest.artifacts.length, bytes: totalBytes });
  const { manifestSha256, ...body } = manifest;
  assert.equal(manifestSha256, createHash("sha256").update(JSON.stringify(body)).digest("hex"));
});
