import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoreHost, type CoreHost } from "./index";
import { claimLaunch, hostCall, hostOf, personHeaders, startTestHost } from "./testing";

let dir: string;
let host: CoreHost;
let base: string;

describe("core host", () => {
  let stop: () => Promise<void>;
  beforeEach(async () => {
    const started = await startTestHost();
    ({ host, base, dir, stop } = started);
  });
  afterEach(async () => stop());

  it("reports ledger status per project", async () => {
    const { status, body } = await hostCall(base, "GET", "/status?project=demo");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.result.project).toBe("demo");
    expect(body.result.ledger.ok).toBe(true);
    expect(body.result.root).toBeUndefined(); // the folder path is not served (Batch 3)
  });

  it("uses the default project only when no name is given, and refuses an unsafe name", async () => {
    expect((await hostCall(base, "GET", "/status")).body.result.project).toBe("default");
    expect((await hostCall(base, "GET", "/status?project=")).body.result.project).toBe("default");
    // A bad name used to become "default", so two different bad names shared one project's ledger (core/host/isolation.test.ts).
    const { status, body } = await hostCall(base, "GET", `/status?project=${encodeURIComponent("../etc")}`);
    expect(status).toBe(400);
    expect(body).toMatchObject({ ok: false, code: "INVALID_PROJECT" });
  });

  it("answers 404 and 405 in JSON", async () => {
    const missing = await fetch(`${base}/nope`, { headers: personHeaders(base) });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as any).code).toBe("NOT_FOUND");
    const wrong = await fetch(`${base}/status`, { method: "POST", body: "{}" });
    expect(wrong.status).toBe(405);
  });

  it("refuses requests its guard rejects", async () => {
    const guarded = createCoreHost({ root: dir, guard: () => false });
    const s = http.createServer((req, res) => guarded.middleware(req, res, () => res.end()));
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/core/status`);
    expect(res.status).toBe(403);
    await guarded.close();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  it("passes other paths through", async () => {
    let passed = false;
    const res = { end() {} } as unknown as http.ServerResponse;
    host.middleware({ url: "/api/other" } as http.IncomingMessage, res, () => { passed = true; });
    expect(passed).toBe(true);
  });
});

describe("person-only writes", () => {
  let stop: () => Promise<void>;
  let url: string;
  beforeEach(async () => {
    const started = await startTestHost();
    url = started.base;
    stop = started.stop;
  });
  afterEach(async () => stop());

  it("refuses a write without the person cookie, so an agent cannot approve a plan or mint a connect token over HTTP", async () => {
    for (const route of ["/planning/approve", "/agents/connect", "/decisions/accept", "/people/members"]) {
      const res = await hostCall(url, "POST", route, {}, { asAgent: true });
      expect(res.status, route).toBe(401);
      expect(res.body.code).toBe("PERSON_REQUIRED");
    }
  });

  it("hands the cookie only to the window holding the one-time launch secret", async () => {
    const plain = await fetch(`${url}/session/claim`, { method: "POST", headers: { origin: url.replace(/\/api\/core$/, ""), "content-type": "application/json" }, body: "{}" });
    expect(plain.status).toBe(401);
    expect(plain.headers.get("set-cookie")).toBeNull();
    const claimed = await claimLaunch(url, hostOf(url).issueLaunch());
    expect(claimed.status).toBe(200);
    expect(claimed.cookie).toMatch(/^pp_core_person=[\w-]{20,}$/);
    expect(claimed.csrf).toMatch(/^[\w-]{20,}$/);
  });

  it("refuses every read without the session cookie, even with forged Origin and sec-fetch-site", async () => {
    const origin = url.replace(/\/api\/core$/, "");
    const forged = { origin, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", referer: `${origin}/` };
    for (const route of ["/status", "/summary", "/plan", "/planning", "/tasks", "/decisions", "/people", "/agents", "/recent", "/verify"]) {
      const res = await fetch(`${url}${route}`, { headers: forged });
      expect(res.status, route).toBe(401);
      const body = (await res.json()) as any;
      expect(body.code, route).toBe("PERSON_REQUIRED");
      expect(body.result).toBeUndefined();
    }
    const claimed = await claimLaunch(url, hostOf(url).issueLaunch());
    const withCookie = await fetch(`${url}/status`, { headers: { ...forged, cookie: claimed.cookie! } });
    expect(withCookie.status).toBe(200);
    expect(((await withCookie.json()) as any).ok).toBe(true);
    const madeUp = await fetch(`${url}/status`, { headers: { ...forged, cookie: "pp_core_person=not-a-real-session-cookie-value" } });
    expect(madeUp.status).toBe(401);
  });

});
