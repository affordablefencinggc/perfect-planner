// SEC-2: attacks on the local service, scripted. Every attack has a marker that must never appear: a ledger entry,
// a cookie handed out, a body with the project's data in it, or a 2xx. Four shapes:
// Note: GET /session is not a registered route (404, no body data); the spec named it, the session routes are POST /session/claim and /session/new-window.
//   1. DNS rebinding: a page on evil.test:<port> resolved to 127.0.0.1 sends Host and Origin evil.test:<port>, no cookie.
//   2. A second OS user / any process with no cookie: every route says 401 and returns no data. The token files are
//      owner-only (0600 in a 0700 folder). A real second account that tries to read and write them is attack 2
//      (otheruser.test.ts); it needs root or sudo, so this file asserts the modes and the no-cookie half everywhere.
//   3. A released worker token and the token of a merged task are refused after a restart (the bridge answers 401 with
//      "...from before Perfect Planner restarted (a restart ends every connection)"), and nothing is written. (A token that was never released also dies with the process: by design the token FILE
//      stays; service.test.ts:303 is about the agent id surviving inside one run, so only spent tokens are asserted.)
//   4. A launch secret replayed after a successful claim gets nothing.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bridgeCall } from "../mcp/index";
import { addTask, buildCheckApprove, cleanTemp, dispatchAndApproveTest, git, makeRepo, startWindow, tempDir, type Window } from "./helpers";

afterAll(cleanTemp);
const q = "?project=p";
const SECRET_WORDS = ["Save notes", "Second task", "Planted by a stranger"];

/** Every route the host registered as a concrete path (":name" filled with T-1), plus the session routes. */
function routesOf(win: Window): { method: "GET" | "POST"; path: string }[] {
  const routes = (win.host as unknown as { router: { routes: { method: "GET" | "POST"; pattern: RegExp }[] } }).router.routes;
  const all = routes.map((r) => ({ method: r.method, path: r.pattern.source.replace(/^\^/, "").replace(/\\\/\?\$$/, "").replace(/\(\[\^\/\]\+\)/g, "T-1").replace(/\\(.)/g, "$1") }));
  for (const extra of [{ method: "GET" as const, path: "/session" }, { method: "POST" as const, path: "/session/claim" }]) if (!all.some((r) => r.method === extra.method && r.path === extra.path)) all.push(extra);
  return all;
}

/** A raw request, because fetch will not let a test choose the Host header. */
function raw(base: string, method: string, route: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string; setCookie: boolean }> {
  const url = new URL(base + route);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: url.port, path: url.pathname + url.search, method, headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }) } }, (res) => {
      let text = "";
      res.on("data", (c: Buffer) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text, setCookie: res.headers["set-cookie"] !== undefined }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

// The host's own watcher may note a commit after a restart (commit.observed by system:watcher); nothing else may appear.
const ledgerCount = (win: Window) => win.host.project("p").entries().filter((e) => !(e.type === "commit.observed" && e.actor.kind === "system" && e.actor.id === "watcher")).length;
const code = async (promise: Promise<unknown>): Promise<{ code: string; message: string }> =>
  promise.then(() => ({ code: "OK", message: "" }), (e: { code?: string; message?: string }) => ({ code: e.code ?? "UNREACHABLE", message: e.message ?? "" }));

describe("SEC-2: attacks on the local service", () => {
  let win: Window;
  let repo: string;
  let data: string;
  let port: number;
  let routes: { method: "GET" | "POST"; path: string }[];
  let tokenFile: string;

  beforeAll(async () => {
    data = tempDir();
    repo = makeRepo();
    win = await startWindow({ data, project: repo, secrets: path.join(data, "secrets.json") });
    port = Number(new URL(win.base).port);
    await addTask(win, q, "Save notes");
    const w = await dispatchAndApproveTest(win, q);
    tokenFile = w.tokenFile;
    routes = routesOf(win);
  }, 60_000);
  afterAll(async () => win?.stop());

  it("1. DNS rebinding: Host and Origin evil.test:<port>, no cookie, every route answers 401/403 with no project data and no cookie", async () => {
    expect(routes.length).toBeGreaterThanOrEqual(40);
    expect(routes).toEqual(expect.arrayContaining([{ method: "GET", path: "/tasks" }, { method: "GET", path: "/session" }]));
    const before = ledgerCount(win);
    const evil = `evil.test:${port}`;
    const bad: string[] = [];
    for (const r of routes) {
      for (const origin of [`http://${evil}`, undefined]) {
        const headers: Record<string, string> = { host: evil, "sec-fetch-site": "cross-site" };
        if (origin) headers.origin = origin;
        const res = await raw(win.base, r.method, r.path + q, headers, r.method === "POST" ? JSON.stringify({ title: "Planted by a stranger", launch: "x".repeat(43) }) : undefined);
        const leaked = SECRET_WORDS.some((w) => res.text.includes(w)) || res.text.includes(win.csrf) || res.text.includes(win.cookie.split("=")[1]!);
        if (![401, 403, ...(r.method === "GET" && r.path === "/session" ? [404] : [])].includes(res.status) || res.setCookie || leaked) bad.push(`${r.method} ${r.path} origin=${origin ?? "none"} -> ${res.status}${res.setCookie ? " +cookie" : ""}${leaked ? " LEAK" : ""}`);
      }
    }
    expect(bad).toEqual([]);
    expect(ledgerCount(win)).toBe(before);
  }, 120_000);

  it("1b. rebinding with a launch secret in hand is still refused when Origin does not match the host it names", async () => {
    // The launch secret is the one thing a rebinding page could not know, but the Origin check must hold on its own.
    const launch = win.host.issueLaunch();
    const evil = `evil.test:${port}`;
    const forged = await raw(win.base, "POST", "/session/claim", { host: evil, origin: "http://other.test" }, JSON.stringify({ launch }));
    expect([401, 403]).toContain(forged.status);
    expect(forged.setCookie).toBe(false);
    // The secret was not burned or honoured by the forged call: the real window can still use it exactly once.
    const real = await raw(win.base, "POST", "/session/claim", { host: `127.0.0.1:${port}`, origin: win.origin }, JSON.stringify({ launch }));
    expect(real.status).toBe(200);
  });

  it("2. a process with no cookie (what a second OS user has): 401 on every route, no data, no cookie, ledger unchanged", async () => {
    const before = ledgerCount(win);
    const bad: string[] = [];
    for (const r of routes) {
      for (const headers of [{}, { origin: win.origin }, { origin: win.origin, "x-pp-csrf": win.csrf }, { cookie: "pp_core_person=" + "a".repeat(43), origin: win.origin }]) {
        const res = await raw(win.base, r.method, r.path + q, headers as Record<string, string>, r.method === "POST" ? JSON.stringify({ title: "Planted by a stranger" }) : undefined);
        const leaked = SECRET_WORDS.some((w) => res.text.includes(w)) || res.text.includes(win.csrf);
        if ((res.status !== 401 && !(r.method === "GET" && r.path === "/session" && res.status === 404)) || res.setCookie || leaked) bad.push(`${r.method} ${r.path} ${Object.keys(headers).join("+") || "bare"} -> ${res.status}`);
      }
    }
    expect(bad).toEqual([]);
    expect(ledgerCount(win)).toBe(before);
  }, 120_000);

  it.skipIf(process.platform === "win32")("2b. the token file is owner-only: mode 0600, in a 0700 folder, not readable by group or others", () => {
    expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(tokenFile)).mode & 0o777).toBe(0o700);
  });

  it("3. a released token and a merged task's token are refused after a restart with the restart message, and write nothing", async () => {
    const dirs = { data: tempDir(), repo: makeRepo(), secrets: "" };
    dirs.secrets = path.join(dirs.data, "secrets.json");
    const first = await startWindow({ ...dirs, project: dirs.repo });
    let tokens: { released: string; merged: string };
    let entries: number;
    try {
      await addTask(first, q, "Save notes");
      await addTask(first, q, "Second task");
      // T-1: built, checked, approved and merged. T-2: claimed, then released by the person.
      const merged = await dispatchAndApproveTest(first, q, "T-1");
      const head = await buildCheckApprove(first, q, merged);
      const m = await first.call("POST", `/tasks/T-1/merge${q}`, { commit: head });
      expect(m.status, JSON.stringify(m.body)).toBe(200);
      const released = await dispatchAndApproveTest(first, q, "T-2", { file: "tests/two.check.mjs", source: "process.exit(1);\n", command: "node tests/two.check.mjs" });
      await released.call({ tool: "claim_task", args: { task: "T-2" }, agent: released.agent });
      // Before the restart the live bridge already refuses both spent tokens.
      const rel = await first.call("POST", `/tasks/T-2/release${q}`, { reason: "attack test" });
      expect(rel.status, JSON.stringify(rel.body)).toBe(200);
      expect((await code(released.call({ tool: "report_progress", args: { task: "T-2", text: "still here" }, agent: released.agent }))).code).toBe("UNAUTHORIZED");
      expect((await code(merged.call({ tool: "report_progress", args: { task: "T-1", text: "still here" }, agent: merged.agent }))).code).toBe("UNAUTHORIZED");
      tokens = { released: released.token, merged: merged.token };
    } finally {
      await first.stop();
    }
    const fresh = await startWindow({ ...dirs, project: dirs.repo });
    try {
      const bridge = ((await fresh.call("POST", `/agents/connect${q}`, {})).body.result as { bridgeUrl: string }).bridgeUrl;
      entries = ledgerCount(fresh);
      for (const [name, token] of Object.entries(tokens)) {
        for (const tool of ["hello", "claim_task", "report_progress", "list_tasks"] as const) {
          const outcome = await code(bridgeCall(bridge, token)({ tool, args: tool === "hello" ? { name: "Replayed" } : { task: name === "released" ? "T-2" : "T-1", text: "x" }, agent: "worker-0000" }));
          expect(outcome.code, `${name} ${tool}`).toBe("UNAUTHORIZED");
          expect(outcome.message, `${name} ${tool}`).toMatch(/restart/i);
        }
      }
      expect(ledgerCount(fresh)).toBe(entries);
      expect(fresh.host.project("p").service.listAgents().map((a) => a.name)).not.toContain("Replayed");
      // The merged work is still on main and the released task is still open: the replays changed no state.
      expect(git(dirs.repo, "log", "--format=%s", "-n", "3")).toMatch(/Save notes|Merge|T-1/);
      expect(fresh.host.project("p").service.board().get("T-2")?.owner ?? null).toBeNull();
    } finally {
      await fresh.stop();
    }
  }, 180_000);

  it("4. a launch secret replayed after a successful claim is refused: no cookie, no new session, ledger unchanged", async () => {
    const launch = win.host.issueLaunch();
    const headers = { host: `127.0.0.1:${port}`, origin: win.origin };
    const first = await raw(win.base, "POST", "/session/claim", headers, JSON.stringify({ launch }));
    expect(first.status).toBe(200);
    expect(first.setCookie).toBe(true);
    const before = ledgerCount(win);
    for (const replayHeaders of [headers, { host: `evil.test:${port}`, origin: `http://evil.test:${port}` }]) {
      const again = await raw(win.base, "POST", "/session/claim", replayHeaders, JSON.stringify({ launch }));
      expect(again.status).toBe(401);
      expect(again.setCookie).toBe(false);
      expect(again.text).not.toContain("csrf\":\"");
    }
    expect(win.host.sessions.claim(launch)).toBeNull();
    expect(ledgerCount(win)).toBe(before);
  });
});
