// The Batch 3 review attack (REVIEW-2026-10-09, #15): a local process that is not the app window
// forges browser headers, gets the person cookie and approves a plan in the person's name.
// None of these steps may work.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostOf, startTestHost } from "./testing";

let base: string;
let stop: () => Promise<void>;
const origin = () => base.replace(/\/api\/core$/, "");
const forged = () => ({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", origin: origin(), "content-type": "application/json" });

beforeEach(async () => ({ base, stop } = await startTestHost()));
afterEach(async () => stop());

describe("a local process cannot act as the person", () => {
  it("cannot get a person cookie by forging same-origin browser headers", async () => {
    for (const path of ["/session", "/session/claim"]) {
      for (const method of ["GET", "POST"]) {
        const res = await fetch(`${base}${path}`, { method, headers: forged(), ...(method === "POST" ? { body: "{}" } : {}) });
        expect(res.headers.get("set-cookie"), `${method} ${path}`).toBeNull();
        expect(res.status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
      }
    }
  });

  it("cannot approve a plan, mint a connect token or decide a card with forged headers", async () => {
    await fetch(`${base}/session`, { headers: forged() });
    for (const route of ["/planning/approve", "/agents/connect", "/decisions/accept", "/mvp/confirm"]) {
      const res = await fetch(`${base}${route}?project=p`, { method: "POST", headers: forged(), body: "{}" });
      expect(res.status, route).toBe(401);
    }
  });

  it("cannot reuse a launch secret the app window already claimed", async () => {
    const host = hostOf(base);
    const launch = host.issueLaunch();
    const first = await fetch(`${base}/session/claim`, { method: "POST", headers: { origin: origin(), "content-type": "application/json" }, body: JSON.stringify({ launch }) });
    expect(first.status).toBe(200);
    const again = await fetch(`${base}/session/claim`, { method: "POST", headers: { origin: origin(), "content-type": "application/json" }, body: JSON.stringify({ launch }) });
    expect(again.status).toBe(401);
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it("needs the CSRF token as well as the cookie", async () => {
    const host = hostOf(base);
    const claim = await fetch(`${base}/session/claim`, { method: "POST", headers: { origin: origin(), "content-type": "application/json" }, body: JSON.stringify({ launch: host.issueLaunch() }) });
    const cookie = (claim.headers.get("set-cookie") ?? "").split(";")[0]!;
    const { result } = (await claim.json()) as { result: { csrf: string } };
    const noCsrf = await fetch(`${base}/planning/start?project=p`, { method: "POST", headers: { cookie, origin: origin(), "content-type": "application/json" }, body: JSON.stringify({ idea: "A notes app that syncs" }) });
    expect(noCsrf.status).toBe(401);
    const wrongOrigin = await fetch(`${base}/planning/start?project=p`, { method: "POST", headers: { cookie, "x-pp-csrf": result.csrf, origin: "http://evil.example", "content-type": "application/json" }, body: JSON.stringify({ idea: "A notes app that syncs" }) });
    expect(wrongOrigin.status).toBe(401);
    const ok = await fetch(`${base}/planning/start?project=p`, { method: "POST", headers: { cookie, "x-pp-csrf": result.csrf, origin: origin(), "content-type": "application/json" }, body: JSON.stringify({ idea: "A notes app that syncs" }) });
    expect(ok.status).toBe(200);
  });
});
