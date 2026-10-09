// The core host: serves the core loop modules to the app's screens as JSON under
// /api/core/*. Mounted by the Vite dev server (src/node/coreHostVitePlugin.mjs)
// and by the production server (scripts/serve-local.mjs, from the bundle that
// scripts/build-core-host.mjs writes). Loopback, same-origin callers only, and every route
// except /session/claim needs the session cookie of a window opened from a one-time link.
import type { IncomingMessage, ServerResponse } from "node:http";
import { LedgerError } from "../ledger/index";
import { startBridge, ToolError, type Bridge } from "../mcp/index";
import { PeopleError } from "../people/index";
import { asPersonRequest, hostKeys, type HostKeys } from "./keys";
import { excludePrivateFolder, openCoreProject, pinOwnerAfterWrite, projectKey, projectRootFor, type CoreProject, type OwnerKeySource } from "./project";
import { HttpError, Router } from "./router";
import { PersonSessions } from "./session";
import { registerRoutes } from "./routes/index";
import { syncJevPolicy } from "./routes/decisions";

export const CORE_PREFIX = "/api/core";
export { PERSON_COOKIE, CSRF_HEADER } from "./session";
const MAX_BODY = 768 * 1024; // fits a 512 KB photo as base64

export interface CoreHostOptions {
  /** Folder for per-project ledgers when no override is set. */
  root: string;
  /** PP_CORE_PROJECT_ROOT: use this folder's .perfect-planner/ledger for every project key. */
  projectRootOverride?: string;
  /** Request gate (loopback + same origin). Requests it refuses get 403. */
  guard?: (req: IncomingMessage) => boolean;
  /** Start the agent bridge (127.0.0.1) so external agents can check in. Default true. */
  bridge?: boolean;
  /** Signing keys for person and system entries. Default: the OS keychain (PP_CORE_KEYS=memory for throwaway keys). */
  keys?: HostKeys;
  /** Supplies each project's owner key instead of the app's signed pin (core/host/owner.ts). Tests and embedders only. */
  ownerKey?: OwnerKeySource;
}

/** The host's key provider type (kept for callers of the older name). */
export type SigningKeys = HostKeys;
/** PP_CORE_KEYS=memory: throwaway keys for automated runs (CI, the browser journey). Never for real projects. */
export const defaultKeys = hostKeys;

export class CoreHost {
  readonly router = new Router();
  private readonly projects = new Map<string, CoreProject>();
  private readonly bridges = new Map<string, Promise<Bridge>>();
  readonly sessions = new PersonSessions();
  readonly keys: HostKeys;

  constructor(private readonly options: CoreHostOptions) {
    this.keys = options.keys ?? hostKeys();
    registerRoutes(this.router);
    // The person's own window asks for a one-time link for another window (POST, so it needs the
    // window's cookie, CSRF token and Origin). A process without the person's session cannot get one.
    this.router.post("/session/new-window", () => ({ launch: this.issueLaunch() }));
    this.router.get("/status", ({ project }) => ({
      project: project.key,
      ledger: project.ledger.status,
      keys: { description: this.keys.description, ...this.keys.state() },
      owner: { state: project.owner.state, ...(project.owner.reason ? { reason: project.owner.reason } : {}) },
    }));
  }

  /** A one-time launch secret for the app window about to be opened (see session.ts). */
  issueLaunch(): string {
    return this.sessions.issueLaunch();
  }

  /**
   * The desktop shell's launch secret: the starter process puts the same value in
   * PP_CORE_DESKTOP_LAUNCH for this host and for the shell, which hands it to its window
   * over IPC (src-tauri/src/core_launch.rs). Read once and removed from the environment.
   */
  acceptDesktopLaunch(env: NodeJS.ProcessEnv = process.env): boolean {
    const secret = env.PP_CORE_DESKTOP_LAUNCH;
    delete env.PP_CORE_DESKTOP_LAUNCH;
    return typeof secret === "string" && this.sessions.acceptLaunch(secret);
  }

  /**
   * Makes a signing key if it is missing ("person:<id>" or "system"). Called only
   * while handling a request from the person's own window, never for an agent.
   * When the key store is unavailable nothing is made and the ledger refuses the write (NOT_SIGNED).
   */
  ensureKey(principal: string): void {
    this.keys.ensure(principal);
  }

  ensurePersonKey(person: string): void {
    this.ensureKey(`person:${person}`);
  }

  project(key: string): CoreProject {
    let project = this.projects.get(key);
    if (!project) {
      project = openCoreProject(this.options.root, key, this.options.projectRootOverride, this.keys, this.options.ownerKey);
      this.projects.set(key, project);
    }
    return project;
  }

  /**
   * Opens a project for a request: .perfect-planner/ goes into the repo's info/exclude before the
   * ledger's first file (its writer lock) is created, and every request waits until that is done.
   */
  async openProject(key: string): Promise<CoreProject> {
    if (!this.projects.has(key)) await excludePrivateFolder(projectRootFor(this.options.root, key, this.options.projectRootOverride));
    const project = this.project(key);
    await project.ready;
    await syncJevPolicy(project);
    return project;
  }

  /** The loopback bridge for a project, started on first use. */
  bridge(project: CoreProject): Promise<Bridge> {
    let bridge = this.bridges.get(project.key);
    if (!bridge) {
      bridge = startBridge(project.service);
      this.bridges.set(project.key, bridge);
    }
    return bridge;
  }

  get bridgeEnabled(): boolean {
    return this.options.bridge !== false;
  }

  /** Connect-style middleware. Calls next() for anything outside /api/core. */
  middleware = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void): void => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== CORE_PREFIX && !url.pathname.startsWith(`${CORE_PREFIX}/`)) return next();
    this.handle(req, res, url).catch(next);
  };

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify(body));
    };
    if (this.options.guard && !this.options.guard(req)) return send(403, { ok: false, code: "FORBIDDEN", message: "Only this app, on this computer, can use these APIs." });
    const path = url.pathname.slice(CORE_PREFIX.length) || "/";
    const method = (req.method ?? "GET").toUpperCase();
    // The app window claims its one-time launch secret here (session.ts). Nothing else hands out the cookie.
    if (path === "/session/claim") {
      if (method !== "POST") return send(405, { ok: false, code: "METHOD", message: "POST only." });
      let body: unknown;
      try { body = await readJson(req); } catch { body = {}; }
      const claimed = sameOriginRequest(req) ? this.sessions.claim((body as { launch?: unknown })?.launch) : null;
      if (!claimed) return send(401, { ok: false, code: "LAUNCH_REQUIRED", message: "Open Perfect Planner from a one-time link. This window cannot show or change anything until then." });
      res.setHeader("set-cookie", this.sessions.setCookieHeader(claimed.cookie, CORE_PREFIX));
      return send(200, { ok: true, result: { csrf: claimed.csrf } });
    }
    const match = this.router.match(method, path);
    if (match === null) return send(404, { ok: false, code: "NOT_FOUND", message: `Nothing at ${path}.` });
    if (match === "method") return send(405, { ok: false, code: "METHOD", message: `${method} is not allowed on ${path}.` });
    // Every write is made in the person's name: it needs the window's cookie, CSRF token and Origin.
    // Agents never have them; they act through the MCP tools, where the ledger records them as agents.
    if (method === "POST" && !this.sessions.isPerson(req)) {
      return send(401, { ok: false, code: "PERSON_REQUIRED", message: "Only the person using Perfect Planner, in a window opened from its launcher, can do this. Agents act through the MCP tools." });
    }
    // Every read needs the window's session cookie too. Origin and sec-fetch-site headers are not
    // proof: any local process can send them. Agents read through the MCP bridge with their own tokens.
    if (method !== "POST" && !this.sessions.hasSession(req)) {
      return send(401, { ok: false, code: "PERSON_REQUIRED", message: "Open Perfect Planner from a one-time link to see this project. This window has no session, so it cannot show or change anything." });
    }
    try {
      const body = method === "POST" ? await readJson(req) : undefined;
      const project = await this.openProject(projectKey(url.searchParams.get("project")));
      const call = () => match.handler({ path, params: match.params, query: url.searchParams, body, project, host: this });
      // A person's POST may make their signing key on first use (keys.ts); nothing else can.
      const result = await (method === "POST" ? asPersonRequest(call) : call());
      // A new project's owner is pinned only after a write from the person's own window.
      if (method === "POST") pinOwnerAfterWrite(this.options.root, project, this.keys);
      send(200, { ok: true, result: result ?? null });
    } catch (error) {
      if (error instanceof HttpError) return send(error.status, { ok: false, code: error.code, message: error.message });
      const named = error as { code?: string; message?: string };
      if (error instanceof LedgerError || error instanceof ToolError || error instanceof PeopleError) {
        return send(422, { ok: false, code: String(named.code ?? "REFUSED"), message: named.message ?? "Refused." });
      }
      send(500, { ok: false, code: "ERROR", message: named?.message ? `Perfect Planner could not complete that: ${named.message}` : "Perfect Planner could not complete that." });
    }
  }

  async close(): Promise<void> {
    for (const bridge of this.bridges.values()) await (await bridge).close().catch(() => undefined);
    // Wait for the git runs started at open (exclude, protection) so none outlives the host in the project folder.
    for (const project of this.projects.values()) await Promise.allSettled([project.ready, project.protection]);
    for (const project of this.projects.values()) project.ledger.close();
    this.bridges.clear();
    this.projects.clear();
  }
}

function sameOriginRequest(req: IncomingMessage): boolean {
  const { origin, host } = req.headers;
  return typeof origin === "string" && typeof host === "string" && (origin === `http://${host}` || origin === `https://${host}`);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "TOO_LARGE", "That request is too large."));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, "INVALID", "The request body must be JSON."));
      }
    });
    req.on("error", reject);
  });
}

export function createCoreHost(options: CoreHostOptions): CoreHost {
  return new CoreHost(options);
}
