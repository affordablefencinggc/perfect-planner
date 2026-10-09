// Test helper: a core host on a random loopback port with a throwaway ledger folder.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createCoreHost, type CoreHost } from "./index";

export async function startTestHost(): Promise<{ host: CoreHost; base: string; dir: string; stop: () => Promise<void> }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-core-host-"));
  const h = createCoreHost({ root, bridge: true });
  const s = http.createServer((req, res) => h.middleware(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/core`;
  return {
    host: h,
    base: url,
    dir: root,
    stop: async () => {
      await h.close();
      await new Promise<void>((resolve) => s.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** GET/POST against the test host; returns { status, body }. */
export async function hostCall(base: string, method: "GET" | "POST", route: string, body?: unknown): Promise<{ status: number; body: { ok: boolean; result?: any; code?: string; message?: string } }> {
  const res = await fetch(`${base}${route}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json() };
}
