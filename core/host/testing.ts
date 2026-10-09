// Test helper: a core host on a random loopback port with a throwaway ledger folder.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { MemoryKeyProvider } from "../ledger/index";
import { createCoreHost, type CoreHost } from "./index";
import { HostKeys } from "./keys";

const personCookies = new Map<string, string>();

/** Headers that make a request count as the person's own app window. */
export function personHeaders(base: string): Record<string, string> {
  const cookie = personCookies.get(base);
  return cookie ? { cookie } : {};
}

export async function startTestHost(options: { projectRootOverride?: string } = {}): Promise<{ host: CoreHost; base: string; dir: string; stop: () => Promise<void> }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-core-host-"));
  const h = createCoreHost({ root, bridge: true, ...options, keys: new HostKeys(new MemoryKeyProvider({ autoCreate: false })) });
  const s = http.createServer((req, res) => h.middleware(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/core`;
  personCookies.set(url, h.personCookie());
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

/** GET/POST against the test host as the person (pass asAgent to leave the person cookie off). */
export async function hostCall(base: string, method: "GET" | "POST", route: string, body?: unknown, { asAgent = false }: { asAgent?: boolean } = {}): Promise<{ status: number; body: { ok: boolean; result?: any; code?: string; message?: string } }> {
  const headers: Record<string, string> = { ...(asAgent ? {} : personHeaders(base)), ...(body === undefined ? {} : { "content-type": "application/json" }) };
  const res = await fetch(`${base}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as { ok: boolean; result?: any; code?: string; message?: string } };
}
