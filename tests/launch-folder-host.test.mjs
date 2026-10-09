import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLaunchFolderMiddleware, resolveLaunchFolder } from "../src/node/launchFolderHost.mjs";

async function serve(folder) {
  const middleware = createLaunchFolderMiddleware({ folder });
  const server = http.createServer((req, res) => middleware(req, res, () => { res.statusCode = 418; res.end(); }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (url, headers = { "x-pp-launch-folder": "1" }) => fetch(`${base}${url}`, { headers });
  return { get, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("launch folder resolves explicit path, then PP_FOLDER, then INIT_CWD", () => {
  assert.equal(resolveLaunchFolder({ argv: ["/apps/one"], env: { PP_FOLDER: "/apps/two" }, cwd: "/" }), path.resolve("/apps/one"));
  assert.equal(resolveLaunchFolder({ argv: ["--build"], env: { PP_FOLDER: "/apps/two", INIT_CWD: "/apps/three" }, cwd: "/" }), path.resolve("/apps/two"));
  assert.equal(resolveLaunchFolder({ argv: [], env: { INIT_CWD: "/apps/three" }, cwd: "/" }), path.resolve("/apps/three"));
});

test("launch folder lists, stats and reads files read-only inside the folder", async (t) => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "pp-launch-outside-"));
  await writeFile(path.join(outside, "secret.txt"), "secret");
  const folder = await mkdtemp(path.join(os.tmpdir(), "pp-launch-"));
  await mkdir(path.join(folder, "src"));
  await writeFile(path.join(folder, "src", "main.js"), "export {};\n");
  let linked = true;
  try { await symlink(outside, path.join(folder, "escape"), "dir"); } catch { linked = false; }
  const host = await serve(folder);
  t.after(() => host.close());

  const info = await (await host.get("/api/launch-folder")).json();
  assert.equal(info.available, true);
  assert.equal(info.name, path.basename(folder));

  const root = await (await host.get("/api/launch-folder/list?path=")).json();
  assert.deepEqual(root.entries, [{ name: "src", kind: "directory" }]);
  const stat = await (await host.get("/api/launch-folder/stat?path=src%2Fmain.js")).json();
  assert.equal(stat.size, 11);
  assert.equal(await (await host.get("/api/launch-folder/file?path=src%2Fmain.js")).text(), "export {};\n");

  assert.equal((await host.get("/api/launch-folder/file?path=..%2Fsecret.txt")).status, 404);
  assert.equal((await host.get("/api/launch-folder/file?path=src%5C..%5C..%5Csecret.txt")).status, 404);
  if (linked) assert.equal((await host.get("/api/launch-folder/file?path=escape%2Fsecret.txt")).status, 404);
  assert.equal((await host.get("/api/launch-folder", {})).status, 403, "requires the same-page header");
});

test("launch folder reports unavailable when there is no folder", async (t) => {
  const host = await serve(path.join(os.tmpdir(), "pp-launch-missing-does-not-exist"));
  t.after(() => host.close());
  assert.deepEqual(await (await host.get("/api/launch-folder")).json(), { available: false });
});
