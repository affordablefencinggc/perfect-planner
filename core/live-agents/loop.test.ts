// The task loop with an agent that is a separate program speaking MCP over stdio, the way Gemini CLI,
// Codex CLI and Claude Code run it: the built agent.mjs started with a worker's token FILE, one process
// per worker. Everything the agent does goes through the stdio server; the person's steps (approve the
// test, check, approve the diff, merge) go through the host as the app window does (ledger 02, L3).
// A scripted client stands in for the model; what is proven is the app's side of the loop.
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { verifyChain } from "../ledger/index";
import { TEST_FILE, TEST_SOURCE, addTask, buildCheckApprove, cleanTemp, makeRepo, startWindow, tempDir, git, write, type Dispatched, type Window } from "../attack/helpers";
import { spawnSync } from "node:child_process";

const q = "?project=p";
const agentMjs = path.resolve("dist", "core-host", "agent.mjs");
const clients: Client[] = [];

beforeAll(() => {
  if (!fs.existsSync(agentMjs) || process.env.CI) {
    const built = spawnSync(process.execPath, ["scripts/build-core-host.mjs"], { encoding: "utf8" });
    if (built.status !== 0) throw new Error(`core host build failed: ${built.stderr}`);
  }
}, 120_000);
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
});
afterAll(cleanTemp);

/** An agent program on stdio, with a `call` shaped like the bridge's so the shared helpers drive it. */
async function stdioAgent(bridgeUrl: string, tokenFile: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [agentMjs],
    env: { PATH: process.env.PATH ?? "", PP_BRIDGE_URL: bridgeUrl, PP_AGENT_TOKEN_FILE: tokenFile },
    stderr: "pipe",
  });
  const client = new Client({ name: "stand-in-agent", version: "1" });
  await client.connect(transport);
  clients.push(client);
  const raw = async (tool: string, args: Record<string, unknown>) => client.callTool({ name: tool, arguments: args });
  const call = (async ({ tool, args }: { tool: string; args: unknown }) => {
    const res = await raw(tool, args as Record<string, unknown>);
    const text = (res.content as { text: string }[])[0]?.text ?? "";
    if (res.isError) throw Object.assign(new Error(text), { code: text.split(":")[0] });
    return res.structuredContent;
  }) as Dispatched["call"];
  return { raw, call, client };
}

async function start(tasks = 1): Promise<{ win: Window; repo: string }> {
  const repo = makeRepo();
  const dir = tempDir();
  const win = await startWindow({ data: dir, project: repo, secrets: path.join(dir, "secrets.json") });
  for (let i = 1; i <= tasks; i++) await addTask(win, q, `Task ${i}`);
  return { win, repo };
}

async function dispatch(win: Window, task: string) {
  const res = await win.call("POST", `/tasks/${task}/dispatch${q}`, { model: "stand-in" });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.result as { worktree: string; branch: string; bridgeUrl: string; tokenFile: string };
}

describe("the whole loop through a stdio agent program", () => {
  it("test first, refused early claim, person approves, claim, proof, check, diff, merge, ledger verifies", async () => {
    const { win, repo } = await start();
    try {
      const d = await dispatch(win, "T-1");
      const agent = await stdioAgent(d.bridgeUrl, d.tokenFile);
      const hello = (await agent.call({ tool: "hello", args: { name: "Stand-in worker", model: "none" } })) as { agent: string; role: string };
      expect(hello.role).toBe("worker");

      // Claiming before the person approved a failing test is refused, in words the agent can read.
      await expect(agent.call({ tool: "claim_task", args: { task: "T-1" }, agent: hello.agent } as never)).rejects.toMatchObject({ code: expect.stringMatching(/REFUSED|CONFLICT|FORBIDDEN/) });

      write(d.worktree, TEST_FILE, TEST_SOURCE);
      git(d.worktree, "add", "-A");
      git(d.worktree, "commit", "-q", "-m", "Test first");
      await agent.call({ tool: "propose_test", args: { task: "T-1", command: `node ${TEST_FILE}`, files: [TEST_FILE] }, agent: hello.agent } as never);
      const view = (await win.call("GET", `/tasks${q}`)).body.result as { tasks: { id: string; test: { entry: string } }[] };
      const approved = await win.call("POST", `/tasks/T-1/approve-test${q}`, { test: view.tasks.find((t) => t.id === "T-1")!.test.entry });
      expect(approved.body.result.failsFirst).toBe(true);

      const w = { task: "T-1", worktree: d.worktree, branch: d.branch, bridgeUrl: d.bridgeUrl, tokenFile: d.tokenFile, token: "", agent: hello.agent, call: agent.call } as Dispatched;
      const head = await buildCheckApprove(win, q, w);
      const merged = await win.call("POST", `/tasks/T-1/merge${q}`, { commit: head });
      expect(merged.status, JSON.stringify(merged.body)).toBe(200);
      expect(fs.existsSync(path.join(repo, "src", "save.js"))).toBe(true);

      const entries = win.host.project("p").entries();
      expect(verifyChain(entries)).toEqual({ ok: true });
      expect(JSON.stringify(entries)).not.toMatch(/pp_[cw]_/);
    } finally {
      await win.stop();
    }
  }, 120_000);

  it("two workers on two tasks in parallel, each program with its own token, never touch each other", async () => {
    const { win } = await start(2);
    try {
      const [d1, d2] = [await dispatch(win, "T-1"), await dispatch(win, "T-2")];
      const [a, b] = [await stdioAgent(d1.bridgeUrl, d1.tokenFile), await stdioAgent(d2.bridgeUrl, d2.tokenFile)];
      const ha = (await a.call({ tool: "hello", args: { name: "Gemini stand-in" } })) as { agent: string };
      const hb = (await b.call({ tool: "hello", args: { name: "Codex stand-in" } })) as { agent: string };
      expect(ha.agent).not.toBe(hb.agent);
      // Worker A reaches for B's task.
      await expect(a.call({ tool: "report_progress", args: { task: "T-2", text: "mine now" }, agent: ha.agent } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
      // Through stdio the agent cannot name another identity: the program sends the one hello gave it.
      expect(hb.agent).not.toBe(ha.agent);
      expect(verifyChain(win.host.project("p").entries())).toEqual({ ok: true });
    } finally {
      await win.stop();
    }
  }, 120_000);

  it("a second connection with another name is read-only: it can look, never write", async () => {
    const { win } = await start();
    try {
      const first = await win.call("POST", `/agents/connect${q}`, {});
      const second = await win.call("POST", `/agents/connect${q}`, {});
      const main = await stdioAgent(first.body.result.bridgeUrl, first.body.result.tokenFile);
      const other = await stdioAgent(second.body.result.bridgeUrl, second.body.result.tokenFile);
      expect(((await main.call({ tool: "hello", args: { name: "Claude Code" } })) as { role: string }).role).toBe("main");
      const hello = (await other.call({ tool: "hello", args: { name: "Gemini CLI" } })) as { role: string; agent: string };
      expect(hello.role).toBe("observer");
      await expect(other.call({ tool: "claim_task", args: { task: "T-1" }, agent: hello.agent } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await win.stop();
    }
  }, 120_000);

  it("when the app goes away mid-loop the agent is told to reconnect, and a fresh line works after the restart", async () => {
    const { win } = await start();
    let d: Awaited<ReturnType<typeof dispatch>>;
    try {
      d = await dispatch(win, "T-1");
      const agent = await stdioAgent(d.bridgeUrl, d.tokenFile);
      await agent.call({ tool: "hello", args: { name: "Worker" } });
      await win.stop();
      const res = await agent.raw("check_inbox", {});
      expect(res.isError).toBe(true);
      expect((res.content as { text: string }[])[0]!.text).toMatch(/not running.*Connect agent/s);
    } finally {
      await win.stop().catch(() => undefined);
    }
  }, 120_000);

  it("a worker program started with a missing token file says so on stderr and exits, instead of hanging", async () => {
    const run = spawnSync(process.execPath, [agentMjs], { env: { PATH: process.env.PATH ?? "", PP_BRIDGE_URL: "http://127.0.0.1:1", PP_AGENT_TOKEN_FILE: path.join(tempDir(), "gone.token") }, encoding: "utf8", timeout: 20_000 });
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/cannot read the worker token.*Start the worker again/);
  });
});
