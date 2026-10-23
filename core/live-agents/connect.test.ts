// Every agent's real connect line, run for real against stand-in CLIs, then the registered server
// started the way the agent would start it and checked in over MCP (ledger 02, L1 + L2).
// No key and no model: this proves the app's half of Gemini, Codex and Claude Code offline.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AGENT_KINDS, type AgentKind } from "../host/agentKinds";
import { hostCall, startTestHost } from "../host/testing";
import { fakeAgents, type FakeAgents, type FakeMode } from "./fakeCli";

const posix = process.platform !== "win32"; // the stand-ins are shebang scripts

beforeAll(() => {
  if (posix) {
    // Always rebuild: these tests must run the code in the working tree, never an older dist.
    const built = spawnSync(process.execPath, ["scripts/build-core-host.mjs"], { encoding: "utf8" });
    if (built.status !== 0) throw new Error(`core host build failed: ${built.stderr}`);
  }
}, 120_000);

let base: string;
let stop: () => Promise<void>;
let fakes: FakeAgents;
let work: string;
const made: string[] = [];

beforeEach(async () => {
  ({ base, stop } = await startTestHost());
  fakes = fakeAgents();
  work = fs.mkdtempSync(path.join(os.tmpdir(), "pp-live-work-"));
  made.push(work);
});
afterEach(async () => {
  await stop();
  fakes.cleanup();
});
afterAll(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

async function newLine(agent: AgentKind) {
  const res = await hostCall(base, "POST", "/agents/connect?project=demo", {});
  const result = res.body.result as { lines: Record<AgentKind, string>; bridgeUrl: string; tokenFile: string };
  return { line: result.lines[agent], ...result };
}

function runLine(line: string, mode: FakeMode = "ok", extraEnv: Record<string, string> = {}, timeout = 60_000) {
  return spawnSync("/bin/sh", ["-c", line], {
    cwd: work,
    encoding: "utf8",
    timeout,
    env: { ...process.env, HOME: fakes.home, PATH: `${fakes.bin}${path.delimiter}${process.env.PATH}`, FAKE_CLI_MODE: mode, ...extraEnv },
  });
}

async function helloAsRegistered(agent: AgentKind) {
  const server = fakes.registered(agent, work);
  expect(server, `${agent} recorded no perfect-planner-core server`).toBeTruthy();
  const transport = new StdioClientTransport({ command: server!.command, args: server!.args, env: { ...(process.env as Record<string, string>), ...server!.env }, stderr: "pipe" });
  const client = new Client({ name: `fake-${agent}`, version: "1" });
  await client.connect(transport);
  try {
    const hello = await client.callTool({ name: "hello", arguments: { name: `${agent} stand-in`, model: "none" } });
    const tools = (await client.listTools()).tools.map((t) => t.name);
    return { hello, tools };
  } finally {
    await client.close();
  }
}

describe.runIf(posix)("connect line for each agent, against stand-in CLIs", () => {
  for (const agent of AGENT_KINDS) {
    it(`${agent}: the line registers the server and the registered server checks in as the main chat`, async () => {
      if (agent === "gemini") fakes.trustFolder(work);
      const { line, tokenFile, bridgeUrl } = await newLine(agent);
      const run = runLine(line);
      expect(run.status, run.stderr).toBe(0);
      const server = fakes.registered(agent, work)!;
      expect(server.env).toEqual({ PP_BRIDGE_URL: bridgeUrl, PP_AGENT_TOKEN_FILE: tokenFile });
      expect(JSON.stringify(server)).not.toMatch(/pp_[cw]_/);
      expect(fs.existsSync(path.join(fakes.home, ".agents", "skills", "perfect-planner-connect", "SKILL.md"))).toBe(true);
      const { hello, tools } = await helloAsRegistered(agent);
      expect(hello.isError).toBeFalsy();
      expect((hello.structuredContent as { role: string }).role).toBe("main");
      expect(tools).toEqual(expect.arrayContaining(["hello", "claim_task", "propose_test", "attach_proof", "ask_main", "check_inbox"]));
    }, 60_000);
  }

  it("running the line twice replaces the registration (an app restart gives a new line)", async () => {
    const first = await newLine("claude");
    expect(runLine(first.line).status).toBe(0);
    const second = await newLine("claude");
    expect(runLine(second.line).status).toBe(0);
    expect(fakes.registered("claude", work)!.env.PP_AGENT_TOKEN_FILE).toBe(second.tokenFile);
  });

  it("codex keeps one connection per computer: a second folder replaces the first", async () => {
    const a = await newLine("codex");
    expect(runLine(a.line).status).toBe(0);
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "pp-live-work-b-"));
    made.push(elsewhere);
    const b = await newLine("codex");
    const run = spawnSync("/bin/sh", ["-c", b.line], { cwd: elsewhere, encoding: "utf8", env: { ...process.env, HOME: fakes.home, PATH: `${fakes.bin}${path.delimiter}${process.env.PATH}` } });
    expect(run.status, run.stderr).toBe(0);
    expect(fakes.registered("codex", work)!.env.PP_AGENT_TOKEN_FILE).toBe(b.tokenFile);
  });

  it("gemini in a folder it does not trust stops with the Trust folder step and keeps nothing half-done", async () => {
    const { line } = await newLine("gemini");
    const run = runLine(line);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/does not trust this folder.*Trust folder/s);
    expect(fakes.registered("gemini", work)).toBeUndefined();
    expect(fs.existsSync(path.join(work, ".gemini"))).toBe(false);
  });

  it("gemini keeps its settings file out of git", async () => {
    spawnSync("git", ["init", "-q", work]);
    fakes.trustFolder(work);
    const { line } = await newLine("gemini");
    expect(runLine(line).status).toBe(0);
    expect(spawnSync("git", ["status", "--porcelain"], { cwd: work, encoding: "utf8" }).stdout).toBe("");
  });

  it("a CLI that never answers is stopped with a plain message, not left hanging", async () => {
    const { line } = await newLine("claude");
    const started = Date.now();
    // connect.mjs reads its own timeout from the environment only in tests: see PP_CONNECT_CLI_TIMEOUT_MS.
    const run = runLine(line, "hang", { PP_CONNECT_CLI_TIMEOUT_MS: "800" }, 30_000);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/did not answer in 1 s.*run the line again/s);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 40_000);

  it("a failing add shows the CLI's words with keys and the token path removed, and says what was lost", async () => {
    const first = await newLine("claude");
    expect(runLine(first.line).status).toBe(0);
    const second = await newLine("claude");
    const run = runLine(second.line, "fail", { FAKE_CLI_LEAK: `pp_c_abcdefghijklmnop12345 at ${second.tokenFile}` });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/claude mcp add failed/);
    expect(run.stderr).toContain("[key]");
    expect(run.stderr).toContain("[token file]");
    expect(run.stderr).not.toMatch(/pp_c_abc/);
    expect(run.stderr).not.toContain(second.tokenFile);
    expect(run.stderr).toMatch(/earlier Claude Code connection was removed/);
  });

  it("a read-only settings area names the permissions problem", async () => {
    const { line } = await newLine("codex");
    const run = runLine(line, "readonly-home");
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/permissions problem|read-only/i);
  });

  it("a deleted token file is named before any CLI runs", async () => {
    const { line, tokenFile } = await newLine("claude");
    fs.rmSync(tokenFile);
    const run = runLine(line);
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/token file is gone.*Connect agent again/s);
    expect(fakes.registered("claude", work)).toBeUndefined();
  });

  it("a missing CLI says which one is not installed", async () => {
    const { line } = await newLine("codex");
    const run = spawnSync("/bin/sh", ["-c", line], { cwd: work, encoding: "utf8", env: { ...process.env, HOME: fakes.home, PATH: path.dirname(process.execPath) } });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/Codex CLI.*not installed/);
  });
});
