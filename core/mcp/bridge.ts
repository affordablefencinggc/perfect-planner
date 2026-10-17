// The local bridge: agents run in their own processes, but only one Perfect
// Planner process writes the ledger (spec §2.6). The bridge listens on the
// loopback interface only and every request carries the agent's bearer token.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AgentService, ToolError } from "./service";
import type { RemoteCall } from "./server";

const MAX_BODY = 64 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new ToolError("INVALID", "Request is too large."));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const STATUS: Record<string, number> = { UNAUTHORIZED: 401, FORBIDDEN: 403, INVALID: 400, NOT_FOUND: 404, CONFLICT: 409, PAUSED: 423, REFUSED: 422 };

export interface Bridge {
  url: string;
  server: Server;
  close(): Promise<void>;
}

export async function startBridge(service: AgentService, port = 0): Promise<Bridge> {
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      // One call per connection: an agent that thinks for a while between calls would otherwise reuse a socket the host is closing at that very moment (ECONNRESET).
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST" || req.url !== "/call") return send(404, { ok: false, code: "NOT_FOUND", message: "POST /call only." });
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    try {
      const body = JSON.parse(await readBody(req)) as { tool?: unknown; args?: unknown; agent?: unknown };
      const result = await service.call({ token, ...(typeof body.agent === "string" ? { agent: body.agent } : {}) }, String(body.tool ?? ""), body.args ?? {});
      send(200, { ok: true, result });
    } catch (error) {
      if (error instanceof ToolError) return send(STATUS[error.code] ?? 400, { ok: false, code: error.code, message: error.message });
      if (error instanceof SyntaxError) return send(400, { ok: false, code: "INVALID", message: "Body must be JSON." });
      send(500, { ok: false, code: "ERROR", message: "Perfect Planner could not complete the call." });
    }
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: bound } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${bound}`,
    server,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** The agent side: a RemoteCall that reaches the bridge with this agent's token. */
export function bridgeCall(url: string, token: string, fetchImpl: typeof fetch = fetch): RemoteCall {
  return async ({ tool, args, agent }) => {
    const response = await fetchImpl(`${url}/call`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ tool, args, agent }),
    });
    const body = (await response.json().catch(() => null)) as { ok?: boolean; result?: unknown; code?: string; message?: string } | null;
    if (body?.ok) return body.result;
    throw Object.assign(new Error(body?.message ?? `Perfect Planner answered ${response.status}.`), { code: body?.code ?? "ERROR" });
  };
}

/** In-process RemoteCall for the desktop app and tests. */
export function directCall(service: AgentService, token: string): RemoteCall {
  return ({ tool, args, agent }) => service.call({ token, ...(agent ? { agent } : {}) }, tool, args);
}
