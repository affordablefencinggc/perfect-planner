import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoreHost, type CoreHost } from "./index";
import { startTestHost } from "./testing";

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
    const res = await fetch(`${base}/status?project=demo`);
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.result.project).toBe("demo");
    expect(body.result.ledger.ok).toBe(true);
    expect(body.result.root.startsWith(dir)).toBe(true);
  });

  it("falls back to the default project for unsafe keys", async () => {
    const body = (await (await fetch(`${base}/status?project=${encodeURIComponent("../etc")}`)).json()) as any;
    expect(body.result.project).toBe("default");
  });

  it("answers 404 and 405 in JSON", async () => {
    const missing = await fetch(`${base}/nope`);
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
