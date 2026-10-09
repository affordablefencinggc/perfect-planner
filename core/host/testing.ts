// Test helper: a core host on a random loopback port with a throwaway ledger folder.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { MemoryKeyProvider } from "../ledger/index";
import { CSRF_HEADER, createCoreHost, type CoreHost } from "./index";
import { HostKeys } from "./keys";

interface PersonWindow {
  host: CoreHost;
  origin: string;
  cookie?: string;
  csrf?: string;
}

const windows = new Map<string, PersonWindow>();

/** The host behind a test base URL. */
export function hostOf(base: string): CoreHost {
  const window = windows.get(base);
  if (!window) throw new Error(`no test host at ${base}`);
  return window.host;
}

/** Headers that make a request count as the person's own app window: cookie, CSRF token and Origin. */
export function personHeaders(base: string): Record<string, string> {
  const window = windows.get(base);
  if (!window?.cookie || !window.csrf) return {};
  return { cookie: window.cookie, [CSRF_HEADER]: window.csrf, origin: window.origin };
}

/** Claims a launch secret the way the app window does, and returns its cookie and CSRF token. */
export async function claimLaunch(base: string, launch: string): Promise<{ status: number; cookie?: string; csrf?: string }> {
  const origin = base.replace(/\/api\/core$/, "");
  const res = await fetch(`${base}/session/claim`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ launch }) });
  const body = (await res.json()) as { result?: { csrf?: string } };
  return { status: res.status, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] || undefined, csrf: body.result?.csrf };
}

export async function startTestHost(options: { projectRootOverride?: string } = {}): Promise<{ host: CoreHost; base: string; dir: string; stop: () => Promise<void> }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-core-host-"));
  const h = createCoreHost({ root, bridge: true, ...options, keys: new HostKeys(new MemoryKeyProvider({ autoCreate: false })) });
  const s = http.createServer((req, res) => h.middleware(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/core`;
  const window: PersonWindow = { host: h, origin: url.replace(/\/api\/core$/, "") };
  windows.set(url, window);
  const claimed = await claimLaunch(url, h.issueLaunch());
  window.cookie = claimed.cookie;
  window.csrf = claimed.csrf;
  return {
    host: h,
    base: url,
    dir: root,
    stop: async () => {
      windows.delete(url);
      await h.close();
      await new Promise<void>((resolve) => s.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** GET/POST against the test host as the person (pass asAgent to leave the person's window credentials off). */
export async function hostCall(base: string, method: "GET" | "POST", route: string, body?: unknown, { asAgent = false }: { asAgent?: boolean } = {}): Promise<{ status: number; body: { ok: boolean; result?: any; code?: string; message?: string } }> {
  const headers: Record<string, string> = { ...(asAgent ? {} : personHeaders(base)), ...(body === undefined ? {} : { "content-type": "application/json" }) };
  const res = await fetch(`${base}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as { ok: boolean; result?: any; code?: string; message?: string } };
}
