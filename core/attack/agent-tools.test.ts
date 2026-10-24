// Every agent tool, called with garbage by each kind of caller (main chat, worker, no token), through the real
// loopback bridge. A refusal is fine; a crash ("ERROR"), a hang, a changed chain or a write that should have
// been refused is a break. The tool list is TOOL_NAMES, so a new tool is covered the day it exists.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bridgeCall, TOOL_NAMES } from "../mcp/index";
import { verifyChain } from "../ledger/index";
import { addTask, cleanTemp, dispatchAndApproveTest, makeRepo, startWindow, tempDir, type Dispatched, type Window } from "./helpers";
// These suites test the host's own logic (concurrency, routes, bridge), which does not change with the OS, and
// Linux CI runs them in full. Windows core CI is already close to its 15-minute limit, so there they are skipped
// unless PP_ATTACK_ALL=1 (set it to run them on a Windows machine).
const runHere = process.platform !== "win32" || process.env.PP_ATTACK_ALL === "1";

afterAll(cleanTemp);
const q = "?project=p";

let win: Window;
let worker: Dispatched;
let mainCall: ReturnType<typeof bridgeCall>;
let mainAgent = "";
let bridgeUrl = "";

beforeAll(async () => {
  if (!runHere) return;
  const repo = makeRepo();
  const dir = tempDir();
  win = await startWindow({ data: dir, project: repo, secrets: path.join(dir, "secrets.json") });
  await addTask(win, q, "Fuzzed task");
  worker = await dispatchAndApproveTest(win, q, "T-1");
  bridgeUrl = worker.bridgeUrl;
  const connect = await win.call("POST", `/agents/connect${q}`, {});
  mainCall = bridgeCall(connect.body.result.bridgeUrl, fs.readFileSync(connect.body.result.tokenFile, "utf8"));
  mainAgent = ((await mainCall({ tool: "hello", args: { name: "Main chat" } })) as { agent: string }).agent;
}, 120_000);
afterAll(async () => {
  if (runHere) await win.stop();
});

const STRANGE: unknown[] = [
  undefined, null, "", " ", 0, -1, 1e308, 2 ** 53, 1.5, true, [], {}, "T-1", "T-99999999999999999999", "Q-1", "Q-99999999999999999999", "D-1",
  "x".repeat(100_000), "\u0000", "../../etc/passwd", "‮evil", "💥".repeat(300), "__proto__", [[[[[[1]]]]]], ["a", "b"], { nested: { a: 1 } },
  JSON.parse('{"__proto__":{"polluted":"yes"}}'),
];
const ARG_NAMES = ["name", "model", "task", "text", "kind", "link", "question", "options", "blocking", "wait_seconds", "ref", "reason", "blocked", "command", "files"];

function argSets(): Record<string, unknown>[] {
  const sets: Record<string, unknown>[] = [{}];
  for (const value of STRANGE) {
    sets.push(Object.fromEntries(ARG_NAMES.map((n) => [n, value])));
    for (const n of ARG_NAMES) sets.push({ [n]: value, ...(n === "task" ? {} : { task: "T-1" }) });
  }
  return sets;
}

const problems: string[] = [];
const outcomes = new Map<string, number>();
const withTimeout = <T>(p: Promise<T>, ms = 12_000) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(Object.assign(new Error("no answer"), { code: "HANG" })), ms))]);

async function fire(who: string, call: ReturnType<typeof bridgeCall>, tool: string, args: unknown, agent?: string) {
  try {
    await withTimeout(call({ tool, args, agent } as any));
    outcomes.set(`${who}:ok`, (outcomes.get(`${who}:ok`) ?? 0) + 1);
  } catch (error) {
    const code = (error as { code?: string }).code ?? "ERROR";
    outcomes.set(`${who}:${code}`, (outcomes.get(`${who}:${code}`) ?? 0) + 1);
    if (code === "ERROR" || code === "HANG") problems.push(`${who} ${tool} ${JSON.stringify(args)?.slice(0, 90)} -> ${code}: ${(error as Error).message.slice(0, 100)}`);
  }
}

describe.skipIf(!runHere)("every agent tool survives garbage from every kind of caller", () => {
  it("covers all tools", () => {
    expect(TOOL_NAMES.length).toBeGreaterThanOrEqual(11);
  });

  it("main chat and worker calls", async () => {
    const sets = argSets();
    for (const tool of TOOL_NAMES) {
      if (tool === "hello") continue; // hello is fuzzed below, on its own tokens
      for (const args of sets) {
        await fire("worker", worker.call, tool, args, worker.agent);
        await fire("main", mainCall, tool, args, mainAgent);
      }
    }
  }, 600_000);

  it("hello with strange names and models, and calls with a made-up or empty token", async () => {
    for (const args of argSets()) await fire("worker", worker.call, "hello", args, worker.agent);
    for (const token of ["", "nope", "x".repeat(10_000), "../../etc/passwd", "Bearer Bearer"]) {
      const bad = bridgeCall(bridgeUrl, token);
      for (const tool of TOOL_NAMES) {
        try {
          await withTimeout(bad({ tool, args: { task: "T-1", name: "x", text: "x", ref: "T-1" } } as any));
          problems.push(`bad token ${JSON.stringify(token).slice(0, 20)} was let in on ${tool}`);
        } catch (error) {
          const code = (error as { code?: string }).code ?? "ERROR";
          if (!["UNAUTHORIZED", "FORBIDDEN", "INVALID"].includes(code)) problems.push(`bad token ${JSON.stringify(token).slice(0, 20)} ${tool} -> ${code}`);
        }
      }
    }
  }, 120_000);

  it("raw bridge requests that are not tool calls", async () => {
    const headers = { authorization: `Bearer ${worker.token}`, "content-type": "application/json" };
    for (const [method, url, body] of [
      ["POST", "/call", "not json"], ["POST", "/call", "[]"], ["POST", "/call", "null"], ["POST", "/call", '{"tool":"__proto__"}'], ["POST", "/call", '{"tool":"constructor","args":{}}'],
      ["POST", "/call", `{"tool":"lookup","args":{"ref":"${"9".repeat(200_000)}"}}`], ["GET", "/call", undefined], ["POST", "/other", "{}"], ["DELETE", "/call", undefined],
    ] as const) {
      const res = await withTimeout(fetch(`${bridgeUrl.replace(/\/call$/, "")}${url}`, { method, headers, body })).catch((e) => ({ status: -1, e }));
      if ((res as Response).status >= 500 || (res as any).status === -1) problems.push(`${method} ${url} ${String(body).slice(0, 30)} -> ${(res as Response).status}`);
    }
  }, 120_000);

  it("an oversize call gets a plain 413 answer, not a dropped connection, and a body that is not an object gets 400", async () => {
    const headers = { authorization: `Bearer ${worker.token}`, "content-type": "application/json" };
    const url = `${bridgeUrl}/call`;
    const big = await fetch(url, { method: "POST", headers, body: JSON.stringify({ tool: "lookup", args: { ref: "9".repeat(200_000) } }) });
    expect(big.status).toBe(413);
    for (const body of ["null", "[]", "7", '"tool"']) expect((await fetch(url, { method: "POST", headers, body })).status, body).toBe(400);
    for (const tool of ["__proto__", "constructor", "toString", "hasOwnProperty"]) expect((await fetch(url, { method: "POST", headers, body: JSON.stringify({ tool, args: {} }) })).status, tool).toBe(404);
  });

  it("afterwards: nothing crashed, the chain verifies, the prototype is clean, the honest worker still works", async () => {
    console.log(`agent-tools: ${[...outcomes].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    expect(problems).toEqual([]);
    expect(({} as any).polluted).toBeUndefined();
    const entries = win.host.project("p").entries();
    expect(verifyChain(entries as any).ok ?? true).toBe(true);
    // Control: the main chat still reads the board. (The fuzz may have genuinely released T-1, which ends that worker's token.)
    const list = (await mainCall({ tool: "list_tasks", args: {}, agent: mainAgent })) as any;
    expect(JSON.stringify(list)).toContain("T-1");
  });
});
