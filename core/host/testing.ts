// Test helper: a core host on a random loopback port with a throwaway ledger folder.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { MemoryKeyProvider, type LedgerEntry } from "../ledger/index";
import { CSRF_HEADER, createCoreHost, type CoreHost } from "./index";
import type { CoreProject } from "./project";
import { HostKeys } from "./keys";

interface PersonWindow {
  host: CoreHost;
  /** Take "Start a new history" automatically when a first write asks for it (default true). */
  autoStart?: boolean;
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

/** A project with no owner key on this device: the app's key store makes no owner key (owner state "unavailable"). */
class UnownedKeys extends HostKeys {
  override ownerKeyFor(): string | undefined {
    return undefined;
  }
}

/**
 * A test host with memory keys. The owner is pinned the way the app does it: on the first write from
 * the person's window (core/host/owner.ts). Pass { owned: false } for a project with no owner key here.
 */
export async function startTestHost({ owned = true, autoStart = true, ...options }: { projectRootOverride?: string; owned?: boolean; autoStart?: boolean } = {}): Promise<{ host: CoreHost; base: string; dir: string; stop: () => Promise<void> }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-core-host-"));
  const inner = new MemoryKeyProvider({ autoCreate: false });
  const h = createCoreHost({ root, bridge: true, ...options, keys: owned ? new HostKeys(inner) : new UnownedKeys(inner) });
  const s = http.createServer((req, res) => h.middleware(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/core`;
  const window: PersonWindow = { host: h, origin: url.replace(/\/api\/core$/, ""), autoStart };
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
      // Windows can hold a just-closed file for a moment (EBUSY); retry rather than fail the test.
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

/** GET/POST against the test host as the person (pass asAgent to leave the person's window credentials off). */
export async function hostCall(base: string, method: "GET" | "POST", route: string, body?: unknown, { asAgent = false }: { asAgent?: boolean } = {}): Promise<{ status: number; body: { ok: boolean; result?: any; code?: string; message?: string } }> {
  const headers: Record<string, string> = { ...(asAgent ? {} : personHeaders(base)), ...(body === undefined ? {} : { "content-type": "application/json" }) };
  const res = await fetch(`${base}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = { status: res.status, body: (await res.json()) as { ok: boolean; result?: any; code?: string; message?: string } };
  // A new project's first write waits for "Start a new history for this folder" (host.ts). Tests that are
  // not about that step take it the way the person would, in their window, then make their call.
  if (result.body.code === "START_HISTORY" && !asAgent && windows.get(base)?.autoStart !== false) {
    const project = new URL(route, "http://local").searchParams.get("project");
    const started = await hostCall(base, "POST", `/owner/start${project ? `?project=${encodeURIComponent(project)}` : ""}`, {});
    if (started.status !== 200) return started;
    return hostCall(base, method, route, body, { asAgent });
  }
  return result;
}

/**
 * Adds a line to what the project reads as if someone wrote it straight into the
 * ledger file: it parses and chains, but no trusted key signed it, so the ledger
 * never marks it verified and isAuthoritative is false for it. Readers must ignore it.
 */
export function forgeEntry(project: CoreProject, entry: Pick<LedgerEntry, "actor" | "type" | "subject" | "summary"> & Partial<LedgerEntry>): LedgerEntry {
  const read = project.entries.bind(project);
  const before = read();
  const forged: LedgerEntry = {
    n: `L-${String(before.length + 1).padStart(6, "0")}`,
    at: new Date().toISOString(),
    evidence: [],
    refs: [],
    prev: before[before.length - 1]?.hash ?? "0".repeat(64),
    hash: "f".repeat(64),
    ...entry,
  };
  project.entries = () => [...read(), forged];
  return forged;
}
