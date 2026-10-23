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
        // Answer first, then hang up (see the handler); stop collecting what is still arriving.
        req.removeAllListeners("data");
        req.resume();
        reject(new ToolError("INVALID", "Request is too large."));
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
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST" || req.url !== "/call") return send(404, { ok: false, code: "NOT_FOUND", message: "POST /call only." });
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    try {
      const parsed: unknown = JSON.parse(await readBody(req));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ToolError("INVALID", "Body must be a JSON object with a tool and its args.");
      const body = parsed as { tool?: unknown; args?: unknown; agent?: unknown };
      const result = await service.call({ token, ...(typeof body.agent === "string" ? { agent: body.agent } : {}) }, String(body.tool ?? ""), body.args ?? {});
      send(200, { ok: true, result });
    } catch (error) {
      if (error instanceof ToolError && /too large/.test(error.message)) {
        res.setHeader("connection", "close");
        res.once("finish", () => req.destroy());
        return send(413, { ok: false, code: "INVALID", message: error.message });
      }
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

const NOT_RUNNING = "Perfect Planner is not running. Open the app, then click Connect agent for a fresh line.";

function refused(error: unknown): boolean {
  // fetch wraps the socket error: TypeError("fetch failed") with the code on .cause.
  const code = (error as { cause?: { code?: string }; code?: string })?.cause?.code ?? (error as { code?: string })?.code;
  return code === "ECONNREFUSED" || code === "ENOTFOUND";
}

/**
 * The agent side: a RemoteCall that reaches the bridge with this agent's token. A refused connection
 * never reached the app, so it is tried once more after a short wait (the app may be restarting);
 * anything that did reach the app is never sent twice.
 */
export function bridgeCall(url: string, token: string, fetchImpl: typeof fetch = fetch, retryWaitMs = 500): RemoteCall {
  return async ({ tool, args, agent }) => {
    const send = () =>
      fetchImpl(`${url}/call`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ tool, args, agent }),
      });
    let response: Response;
    try {
      response = await send().catch(async (error: unknown) => {
        if (!refused(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryWaitMs));
        return send();
      });
    } catch (error) {
      throw Object.assign(new Error(refused(error) ? NOT_RUNNING : "Perfect Planner did not answer. If the app is open, try the call again; a write may or may not have been recorded, so check_inbox first."), { code: "UNAVAILABLE" });
    }
    const body = (await response.json().catch(() => null)) as { ok?: boolean; result?: unknown; code?: string; message?: string } | null;
    if (body?.ok) return body.result;
    if (response.status === 401 && !body?.message) throw Object.assign(new Error("Your connection ended (the app restarted). Run the new line from Connect agent."), { code: "UNAUTHORIZED" });
    if (response.status === 401) throw Object.assign(new Error(`${body?.message} If the app restarted, run the new line from Connect agent.`), { code: "UNAUTHORIZED" });
    throw Object.assign(new Error(body?.message ?? (response.status >= 500 ? "Perfect Planner had an internal problem. Nothing was changed that you can rely on; try again or check_inbox." : `Perfect Planner answered ${response.status}.`)), { code: body?.code ?? "ERROR" });
  };
}

/** In-process RemoteCall for the desktop app and tests. */
export function directCall(service: AgentService, token: string): RemoteCall {
  return ({ tool, args, agent }) => service.call({ token, ...(agent ? { agent } : {}) }, tool, args);
}
