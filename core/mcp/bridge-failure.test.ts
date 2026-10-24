// What an agent sees when the app is closed, restarted or broken (ledger 02, L4).
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { bridgeCall } from "./bridge";

const servers: Array<{ close(): void }> = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function serve(handler: Parameters<typeof createServer>[1], port = 0) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

const hello = { tool: "hello" as const, args: { name: "A" } };

describe("bridgeCall when the app is not there", () => {
  it("says the app is not running, after one retry, and never leaks 'fetch failed'", async () => {
    const port = await serve((_q, r) => r.end());
    servers.pop()!.close();
    const started = Date.now();
    const error = await bridgeCall(`http://127.0.0.1:${port}`, "pp_w_x", fetch, 20)(hello).catch((e: Error & { code?: string }) => e);
    expect(error).toMatchObject({ code: "UNAVAILABLE" });
    expect((error as Error).message).toMatch(/not running.*Connect agent/);
    expect((error as Error).message).not.toMatch(/fetch failed/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  it("finds the app when it comes up during the retry wait", async () => {
    const probe = await serve((_q, r) => r.end());
    servers.pop()!.close();
    const call = bridgeCall(`http://127.0.0.1:${probe}`, "pp_w_x", fetch, 150)(hello);
    setTimeout(() => void serve((_q, r) => r.end(JSON.stringify({ ok: true, result: { agent: "A-1" } })), probe), 30);
    await expect(call).resolves.toEqual({ agent: "A-1" });
  });
});

describe("bridgeCall when the app answers badly", () => {
  it("turns an HTML 502 into one plain sentence", async () => {
    const port = await serve((_q, r) => {
      r.writeHead(502, { "content-type": "text/html" });
      r.end("<html>Bad gateway at /Users/me/secret</html>");
    });
    const error = (await bridgeCall(`http://127.0.0.1:${port}`, "t")(hello).catch((e: Error) => e)) as Error;
    expect(error.message).toMatch(/internal problem/);
    expect(error.message).not.toMatch(/html|secret/i);
  });

  it("tells the agent a restart ended its connection on a bare 401", async () => {
    const port = await serve((_q, r) => {
      r.writeHead(401);
      r.end();
    });
    await expect(bridgeCall(`http://127.0.0.1:${port}`, "t")(hello)).rejects.toMatchObject({ code: "UNAUTHORIZED", message: expect.stringMatching(/restarted.*new line/) });
  });

  it("keeps the app's own refusal text and code", async () => {
    const port = await serve((_q, r) => {
      r.writeHead(422);
      r.end(JSON.stringify({ ok: false, code: "REFUSED", message: "Test not approved." }));
    });
    await expect(bridgeCall(`http://127.0.0.1:${port}`, "t")(hello)).rejects.toMatchObject({ code: "REFUSED", message: "Test not approved." });
  });

  it("never sends a write twice once the app has received it (a dropped reply is not retried)", async () => {
    let received = 0;
    const port = await serve((req, res) => {
      received++;
      req.on("data", () => {});
      req.on("end", () => res.destroy()); // the app got it, then the connection died
    });
    const error = (await bridgeCall(`http://127.0.0.1:${port}`, "t", fetch, 10)({ tool: "report_progress", args: { task: "T-1", text: "x" } }).catch((e: Error) => e)) as Error & { code?: string };
    expect(received).toBe(1);
    expect(error.code).toBe("UNAVAILABLE");
    expect(error.message).toMatch(/check_inbox/);
  });
});
