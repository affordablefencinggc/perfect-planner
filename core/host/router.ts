// The tiny router the core host uses. Each screen owns one route module under
// routes/ and registers its handlers here; handlers return plain JSON values.
import type { CoreHost } from "./host";
import type { CoreProject } from "./project";

export type Method = "GET" | "POST";

export interface RouteRequest {
  /** Path after /api/core, e.g. "/planning". */
  path: string;
  /** Captured ":name" segments. */
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  project: CoreProject;
  host: CoreHost;
}

export type Handler = (req: RouteRequest) => unknown | Promise<unknown>;

/** Thrown by handlers to answer with a status and a plain-language message. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface Route {
  method: Method;
  pattern: RegExp;
  names: string[];
  handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];

  get(path: string, handler: Handler): this {
    return this.add("GET", path, handler);
  }

  post(path: string, handler: Handler): this {
    return this.add("POST", path, handler);
  }

  private add(method: Method, path: string, handler: Handler): this {
    const names: string[] = [];
    const source = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:([a-zA-Z]+)/g, (_m, name: string) => {
      names.push(name);
      return "([^/]+)";
    });
    this.routes.push({ method, pattern: new RegExp(`^${source}/?$`), names, handler });
    return this;
  }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | "method" | null {
    let wrongMethod = false;
    for (const route of this.routes) {
      const m = route.pattern.exec(path);
      if (!m) continue;
      if (route.method !== method) {
        wrongMethod = true;
        continue;
      }
      const params: Record<string, string> = {};
      route.names.forEach((name, i) => (params[name] = decodeURIComponent(m[i + 1] ?? "")));
      return { handler: route.handler, params };
    }
    return wrongMethod ? "method" : null;
  }
}
