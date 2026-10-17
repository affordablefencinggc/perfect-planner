import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startLocalServer } from "../scripts/serve-local.mjs";
import { checkTypedFolder, createLaunchFolderMiddleware, resolveLaunchFolder, systemFolderReason } from "../src/node/launchFolderHost.mjs";

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
  await writeFile(path.join(folder, "src", ".env"), "API_KEY=live\n");
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

  assert.equal((await host.get("/api/launch-folder/file?path=src%2F.env")).status, 403, "credential files are never served");
  assert.equal((await host.get("/api/launch-folder/stat?path=src%2F.env")).status, 403);
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

test("system and credential folders are refused as typed, in both path styles", () => {
  const posix = { platform: "linux", home: "/home/me" };
  for (const bad of ["/", "/etc", "/etc/", "/etc/ssh", "/etc/../etc", "/home", "/home/", "/home/other", "/root", "/var", "/var/www/app", "/usr/local", "/bin", "/sbin", "/lib", "/sys", "/proc", "/proc/self", "/dev", "/boot", "/home/me", "/home/me/.ssh", "/home/me/.aws/x", "/home/me/.gnupg", "/home/me/.config", "/home/me/app/.ssh", "/root/.ssh", "/Users", "/Users/other"]) {
    assert.ok(systemFolderReason(bad, posix), `refuses ${bad}`);
  }
  for (const good of ["/home/me/my-app", "/home/me/code/app", "/tmp/app", "/srv/app", "/opt/app", "/mnt/work/app", "/workspace/app"]) {
    assert.equal(systemFolderReason(good, posix), null, `allows ${good}`);
  }
  const windows = { platform: "win32", home: "C:\\Users\\Me" };
  for (const bad of ["C:\\", "c:/", "C:\\Users", "c:\\users", "C:\\Users\\Other", "C:\\Users\\Me", "C:\\Windows", "c:\\WINDOWS\\System32", "C:\\Program Files", "C:\\Program Files (x86)\\App", "C:\\ProgramData", "D:\\Windows", "C:\\Users\\Me\\.ssh", "C:\\Users\\Me\\.AWS", "C:\\Users\\Me\\AppData\\Roaming", "C:/Users/Me/.gnupg", "C:\\Windows\\..\\Windows"]) {
    assert.ok(systemFolderReason(bad, windows), `refuses ${bad}`);
  }
  for (const good of ["C:\\projects\\my-app", "D:\\work\\app", "C:\\Users\\Me\\code\\app", "c:\\users\\me\\Documents\\app"]) {
    assert.equal(systemFolderReason(good, windows), null, `allows ${good}`);
  }
});

test("a typed folder that is a link into a system folder is refused after the link is followed", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pp-typed-link-"));
  let linked = true;
  try { await symlink("/etc", path.join(dir, "to-etc"), "dir"); } catch { linked = false; }
  if (!linked || process.platform === "win32") return t.skip("links not available");
  const refused = await checkTypedFolder(path.join(dir, "to-etc"));
  assert.match(refused.error ?? "", /system or private/);
  assert.match((await checkTypedFolder(dir)).real ?? "", /pp-typed-link-/);
});

test("without the app's login a middleware refuses to choose a folder at all", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "pp-typed-nosession-"));
  const middleware = createLaunchFolderMiddleware({ folder: null });
  const server = http.createServer((req, res) => middleware(req, res, () => { res.statusCode = 418; res.end(); }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/launch-folder/choose`, {
    method: "POST", headers: { "x-pp-launch-folder": "1", "content-type": "application/json" }, body: JSON.stringify({ path: folder }),
  });
  assert.equal(response.status, 401);
});

// The real wiring: serve-local with the bundled core host, so the login is the app's own session.
test("typed folders need the app's session, are checked, and are served only to the session that chose them", async (t) => {
  const bundle = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "dist", "core-host", "index.mjs");
  const built = await import("node:fs").then((fs) => fs.existsSync(bundle));
  if (!built) return t.skip("core host bundle not built (npm run build:core-host)");
  const client = await mkdtemp(path.join(os.tmpdir(), "pp-typed-client-"));
  await writeFile(path.join(client, "index.html"), "<!doctype html><title>x</title>");
  const root = await mkdtemp(path.join(os.tmpdir(), "pp-typed-authority-"));
  const folder = await mkdtemp(path.join(os.tmpdir(), "pp-typed-app-"));
  await writeFile(path.join(folder, "README.md"), "# typed\n");
  await writeFile(path.join(folder, ".env"), "API_KEY=live\n");
  const host = await startLocalServer({ clientDirectory: client, root, port: 0, logger: { warn() {}, log() {} } });
  t.after(() => host.close());
  const origin = host.url.slice(0, -1);
  const claim = async () => {
    const launch = new URL(host.launchUrl()).hash.replace("#pp-launch=", "");
    const response = await fetch(`${origin}/api/core/session/claim`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ launch }) });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie").split(";")[0];
    assert.match(response.headers.get("set-cookie"), /Path=\/api(;|$)/, "the cookie reaches /api/launch-folder too");
    return { cookie, csrf: (await response.json()).result.csrf };
  };
  const headerOnly = { "x-pp-launch-folder": "1" };
  const call = (route, { method = "GET", headers = {}, body } = {}) => fetch(`${origin}/api/launch-folder${route ? `/${route}` : ""}`, { method, headers: { ...headerOnly, ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const person = ({ cookie, csrf }) => ({ cookie, "x-pp-csrf": csrf, origin });

  // The app's header alone is not a login: no choosing, no listing, no reading.
  assert.equal((await call("choose", { method: "POST", body: { path: folder } })).status, 401);
  for (const route of ["", "list?path=", "stat?path=README.md", "file?path=README.md"]) assert.equal((await call(route)).status, 401, `header only: ${route}`);

  const me = await claim();
  // A session without the CSRF token and Origin cannot choose either.
  assert.equal((await call("choose", { method: "POST", headers: { cookie: me.cookie }, body: { path: folder } })).status, 401);
  assert.equal((await call("choose", { method: "POST", headers: { cookie: me.cookie, "x-pp-csrf": me.csrf }, body: { path: folder } })).status, 401, "no Origin");
  assert.equal((await call("choose", { method: "POST", headers: { ...person(me), "x-pp-csrf": "wrong-wrong-wrong-wrong-wrong" }, body: { path: folder } })).status, 401, "wrong token");

  for (const bad of ["/etc", "/etc/passwd", "/home", "/root", "/var", "/proc/self", "/dev", "relative", ""]) {
    assert.equal((await call("choose", { method: "POST", headers: person(me), body: { path: bad } })).status, 400, `refuses ${bad}`);
  }
  assert.equal(await (await call("", { headers: { cookie: me.cookie } })).json().then((v) => v.available), false, "a refused path changes nothing");

  const ok = await call("choose", { method: "POST", headers: person(me), body: { path: `  ${folder}  ` } });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).name, path.basename(folder));
  const listed = await (await call("list?path=", { headers: { cookie: me.cookie } })).json();
  assert.deepEqual(listed.entries.map((e) => e.name).sort(), [".env", "README.md"]);
  assert.equal(await (await call("file?path=README.md", { headers: { cookie: me.cookie } })).text(), "# typed\n");
  assert.equal((await call("file?path=.env", { headers: { cookie: me.cookie } })).status, 403, "credential files are never served");
  assert.equal((await call("file?path=README.md")).status, 401, "header only is refused after a choice too");

  // Another window's session does not get this window's folder.
  const other = await claim();
  assert.equal((await (await call("", { headers: { cookie: other.cookie } })).json()).available, false);
  assert.equal((await call("list?path=", { headers: { cookie: other.cookie } })).status, 404);
});
