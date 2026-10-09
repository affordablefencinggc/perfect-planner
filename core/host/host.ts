// The core host: serves the core loop modules to the app's screens as JSON under
// /api/core/*. Mounted by the Vite dev server (src/node/coreHostVitePlugin.mjs)
// and by the production server (scripts/serve-local.mjs, from the bundle that
// scripts/build-core-host.mjs writes). Loopback, same-origin callers only.
import type { IncomingMessage, ServerResponse } from "node:http";
import { LedgerError } from "../ledger/index";
import { startBridge, ToolError, type Bridge } from "../mcp/index";
import { PeopleError } from "../people/index";
import { openCoreProject, projectKey, type CoreProject } from "./project";
import { HttpError, Router } from "./router";
import { registerRoutes } from "./routes/index";

export const CORE_PREFIX = "/api/core";
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
    const match = this.router.match(method, path);
    if (match === null) return send(404, { ok: false, code: "NOT_FOUND", message: `Nothing at ${path}.` });
    if (match === "method") return send(405, { ok: false, code: "METHOD", message: `${method} is not allowed on ${path}.` });
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
