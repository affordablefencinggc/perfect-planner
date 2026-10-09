import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeCall, createAgentMcpServer } from "../../mcp/index";
import { hostCall, startTestHost } from "../testing";
import { icaclsPath } from "../tokenFile";
import { agentEntryPath, setupFor } from "./agents";

let base: string;
let stop: () => Promise<void>;

beforeEach(async () => {
  ({ base, stop } = await startTestHost());
});
afterEach(async () => stop());

const connect = async (body: unknown = {}) => {
  const res = await hostCall(base, "POST", "/agents/connect?project=demo", body);
  expect(res.status).toBe(200);
  const result = res.body.result as { connection: string; person: string; bridgeUrl: string; tokenFile: string; claudeCode: string; lines: Record<string, string>; json: string; agentPath: string };
  return { ...result, token: fs.readFileSync(result.tokenFile, "utf8") };
};

describe("agents routes", () => {
  it("hands out a line with no secret in it: the connect token waits in a file only this user can read", async () => {
    const log = vi.spyOn(console, "log");
    const res = await hostCall(base, "POST", "/agents/connect?project=demo", {});
    const raw = res.body.result;
    expect(raw.token).toBeUndefined();
    const result = await connect();
    expect(result.person).toBe("owner");
    expect(result.bridgeUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(result.token).toMatch(/^pp_c_/);
    if (process.platform !== "win32") expect(fs.statSync(result.tokenFile).mode & 0o077).toBe(0);
    else expect(execFileSync(icaclsPath(), [result.tokenFile], { encoding: "utf8" })).not.toMatch(/Everyone|BUILTIN\\Users|Authenticated Users|\(I\)/i);
    const program = result.agentPath.replace(/agent\.mjs$/, "connect.mjs");
    if (process.platform !== "win32") {
      expect(result.claudeCode).toBe(`node '${program}' --agent claude ${result.bridgeUrl} '${result.tokenFile}'`);
      expect(result.lines).toEqual({
        claude: result.claudeCode,
        gemini: `node '${program}' --agent gemini ${result.bridgeUrl} '${result.tokenFile}'`,
        codex: `node '${program}' --agent codex ${result.bridgeUrl} '${result.tokenFile}'`,
      });
    }
    for (const line of Object.values(result.lines)) expect(line).not.toMatch(/pp_[cw]_/);
    expect(result.agentPath.endsWith(path.join("dist", "core-host", "agent.mjs"))).toBe(true);
    const json = JSON.parse(result.json);
    expect(json.mcpServers["perfect-planner-core"]).toEqual({ command: "node", args: [result.agentPath], env: { PP_BRIDGE_URL: result.bridgeUrl, PP_AGENT_TOKEN_FILE: result.tokenFile } });

    const list = await hostCall(base, "GET", "/agents?project=demo");
    expect(list.body.result.bridge.url).toBe(result.bridgeUrl);
    expect(list.body.result.agents).toEqual([]);
    if (process.platform !== "win32") expect(list.body.result.skillLine).toBe(`node '${program}' --skill-only`);
    expect(list.body.result.connections).toEqual(expect.arrayContaining([expect.objectContaining({ id: result.connection, person: "owner", revoked: false })]));
    expect(JSON.stringify(list.body)).not.toContain(result.token);
    for (const call of log.mock.calls) expect(JSON.stringify(call)).not.toContain(result.token);
  });

  it("disconnecting deletes the connection's token file", async () => {
    const { connection, tokenFile } = await connect();
    expect((await hostCall(base, "POST", "/agents/revoke?project=demo", { connection })).status).toBe(200);
    expect(fs.existsSync(tokenFile)).toBe(false);
  });

  it("full loop: connect, hello through the bridge over MCP, then GET agents shows the main chat", async () => {
    const { bridgeUrl, token, connection } = await connect();
    const server = createAgentMcpServer(bridgeCall(bridgeUrl, token));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test-agent", version: "1.0.0" });
    await client.connect(clientSide);
    const hello = await client.callTool({ name: "hello", arguments: { name: "Claude Code", model: "claude-opus" } });
    expect(hello.isError).toBeFalsy();
    expect((hello.structuredContent as { role: string }).role).toBe("main");

    const list = (await hostCall(base, "GET", "/agents?project=demo")).body.result;
    expect(list.agents).toHaveLength(1);
    expect(list.agents[0]).toMatchObject({ name: "Claude Code", model: "unverified:claude-opus", role: "main", person: "owner", connection });
    expect(typeof list.agents[0].connectedAt).toBe("string");
    expect(list.agents[0]).not.toHaveProperty("token");
    expect(list.connections[0].agent).toBe(list.agents[0].id);

    // A second agent on a fresh connect token is not the main chat.
    const second = await connect();
    const res = await fetch(`${second.bridgeUrl}/call`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${second.token}` }, body: JSON.stringify({ tool: "hello", args: { name: "Codex" } }) });
    expect(((await res.json()) as { result: { role: string } }).result.role).toBe("observer");
    await client.close();
  });

  it("revokes a connection so its token stops working", async () => {
    const { bridgeUrl, token, connection } = await connect();
    const call = bridgeCall(bridgeUrl, token);
    await call({ tool: "hello", args: { name: "Agent" } });
    const revoked = await hostCall(base, "POST", "/agents/revoke?project=demo", { connection });
    expect(revoked.body.result).toEqual({ connection, revoked: true });
    await expect(call({ tool: "hello", args: { name: "Agent" } })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const list = (await hostCall(base, "GET", "/agents?project=demo")).body.result;
    expect(list.agents[0].revoked).toBe(true);
    expect(list.connections[0].revoked).toBe(true);
  });

  it("revokes by agent id and refuses unknown or missing targets", async () => {
    const { bridgeUrl, token, connection } = await connect();
    const hello = (await bridgeCall(bridgeUrl, token)({ tool: "hello", args: { name: "Agent" } })) as { agent: string };
    expect((await hostCall(base, "POST", "/agents/revoke?project=demo", { agent: hello.agent })).body.result.connection).toBe(connection);
    expect((await hostCall(base, "POST", "/agents/revoke?project=demo", { connection: "C-nope" })).status).toBe(404);
    expect((await hostCall(base, "POST", "/agents/revoke?project=demo", {})).status).toBe(400);
  });

  it("refuses a bad person name", async () => {
    const res = await hostCall(base, "POST", "/agents/connect?project=demo", { person: "../x" });
    expect(res.status).toBe(400);
  });
});

describe("agent entry path", () => {
  it("uses agent.mjs next to the bundle, or dist/core-host in a checkout", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-agent-entry-"));
    const bundle = path.join(dir, "dist", "core-host");
    fs.mkdirSync(bundle, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    expect(agentEntryPath(path.join(dir, "core", "host", "routes", "agents.ts"))).toEqual({ path: path.join(bundle, "agent.mjs"), built: false });
    fs.writeFileSync(path.join(bundle, "agent.mjs"), "");
    expect(agentEntryPath(path.join(bundle, "index.mjs"))).toEqual({ path: path.join(bundle, "agent.mjs"), built: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("quotes paths so the shell cannot run anything hidden in them", () => {
    expect(setupFor("http://127.0.0.1:1", "/t/$(x)/c.token", "/a b/it's/agent.mjs", "linux").claudeCode).toBe("node '/a b/it'\\''s/connect.mjs' --agent claude http://127.0.0.1:1 '/t/$(x)/c.token'");
    expect(setupFor("http://127.0.0.1:1", "C:\\t\\c.token", "C:\\a b\\agent.mjs", "win32").claudeCode).toBe("node 'C:\\a b\\connect.mjs' --agent claude http://127.0.0.1:1 'C:\\t\\c.token'");
  });
});

// The real stdio entry, when it has been built (node scripts/build-core-host.mjs).
const built = agentEntryPath(path.resolve("core/host/routes/agents.ts"));
describe.skipIf(!built.built)("built stdio agent", () => {
  it("answers MCP initialize and tools/call hello over stdio", async () => {
    const { bridgeUrl, tokenFile } = await connect();
    const child = spawn(process.execPath, [built.path], { env: { ...process.env, PP_BRIDGE_URL: bridgeUrl, PP_AGENT_TOKEN_FILE: tokenFile }, stdio: ["pipe", "pipe", "pipe"] });
    const replies = new Map<number, any>();
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) {
          const msg = JSON.parse(line);
          if (typeof msg.id === "number") replies.set(msg.id, msg);
        }
      }
    });
    const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    const wait = async (id: number) => {
      for (let i = 0; i < 200 && !replies.has(id); i++) await new Promise((r) => setTimeout(r, 25));
      return replies.get(id);
    };
    try {
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stdio-test", version: "1" } } });
      expect((await wait(1))?.result?.serverInfo?.name).toBe("perfect-planner-core");
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "hello", arguments: { name: "Stdio agent", model: "test-model" } } });
      const hello = await wait(2);
      expect(hello?.result?.structuredContent?.role).toBe("main");
      const list = (await hostCall(base, "GET", "/agents?project=demo")).body.result;
      expect(list.agents).toEqual([expect.objectContaining({ name: "Stdio agent", model: "unverified:test-model", role: "main" })]);
    } finally {
      child.kill();
    }
  });
});
