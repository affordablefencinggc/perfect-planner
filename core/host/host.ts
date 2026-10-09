// The core host: serves the core loop modules to the app's screens as JSON under
// /api/core/*. Mounted by the Vite dev server (src/node/coreHostVitePlugin.mjs)
// and by the production server (scripts/serve-local.mjs, from the bundle that
// scripts/build-core-host.mjs writes). Loopback, same-origin callers only.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { LedgerError } from "../ledger/index";
import { startBridge, ToolError, type Bridge } from "../mcp/index";
import { PeopleError } from "../people/index";
import { openCoreProject, projectKey, type CoreProject } from "./project";
import { HttpError, Router } from "./router";
import { registerRoutes } from "./routes/index";

export const CORE_PREFIX = "/api/core";
/** HttpOnly cookie that marks a request as coming from the person's own app window. */
export const PERSON_COOKIE = "pp_core_person";
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
}

export class CoreHost {
  readonly router = new Router();
  private readonly projects = new Map<string, CoreProject>();
  private readonly bridges = new Map<string, Promise<Bridge>>();
  /** Per-process secret behind the person cookie; never written anywhere. */
  private readonly personSecret = randomBytes(32).toString("base64url");

  constructor(private readonly options: CoreHostOptions) {
    registerRoutes(this.router);
    this.router.get("/status", ({ project }) => ({
      project: project.key,
      ledger: project.ledger.status,
      root: project.root,
    }));
  }

  project(key: string): CoreProject {
    let project = this.projects.get(key);
    if (!project) {
      project = openCoreProject(this.options.root, key, this.options.projectRootOverride);
      this.projects.set(key, project);
    }
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
    // Every write is made in the person's name, so it needs the person cookie the app window
    // received from GET /session. Agents never get it: they act through the MCP tools, where the
    // ledger records them as agents. (A process running as the same OS user can still read what
    // the browser can; this keeps agent HTTP calls and other sites out, it is not a sandbox.)
    if (method === "GET" && path === "/session") {
      if (req.headers["sec-fetch-site"] !== "same-origin" || req.headers["sec-fetch-mode"] === "navigate") {
        return send(403, { ok: false, code: "FORBIDDEN", message: "Open Perfect Planner in its own window to sign in as yourself." });
      }
      res.setHeader("set-cookie", `${PERSON_COOKIE}=${this.personSecret}; HttpOnly; SameSite=Strict; Path=${CORE_PREFIX}`);
      return send(200, { ok: true, result: { person: true } });
    }
    const match = this.router.match(method, path);
    if (match === null) return send(404, { ok: false, code: "NOT_FOUND", message: `Nothing at ${path}.` });
    if (match === "method") return send(405, { ok: false, code: "METHOD", message: `${method} is not allowed on ${path}.` });
    if (method === "POST" && !this.isPerson(req)) {
      return send(401, { ok: false, code: "PERSON_REQUIRED", message: "Only the person using Perfect Planner can do this. Agents act through the MCP tools." });
    }
    try {
      const body = method === "POST" ? await readJson(req) : undefined;
      const project = this.project(projectKey(url.searchParams.get("project")));
      const result = await match.handler({ path, params: match.params, query: url.searchParams, body, project, host: this });
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

  /** True when the request carries this process's person cookie. */
  isPerson(req: IncomingMessage): boolean {
    const cookie = String(req.headers.cookie ?? "");
    const value = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${PERSON_COOKIE}=`))?.slice(PERSON_COOKIE.length + 1);
    if (!value) return false;
    const a = Buffer.from(value);
    const b = Buffer.from(this.personSecret);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** For tests and in-process callers (the desktop shell): the cookie header a person request carries. */
  personCookie(): string {
    return `${PERSON_COOKIE}=${this.personSecret}`;
  }

  async close(): Promise<void> {
    for (const bridge of this.bridges.values()) await (await bridge).close().catch(() => undefined);
    for (const project of this.projects.values()) project.ledger.close();
    this.bridges.clear();
    this.projects.clear();
  }
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
